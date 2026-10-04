import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { configSchema } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ImageConfig = NonNullable<z.infer<typeof configSchema>['sub2api']>;
type SavedImage = { file_id: string; userId: string };

interface ImageDependencies {
  request: Fetch;
  baseURL: string;
  apiKey: string;
  config: ImageConfig;
  saveImage?: (dataURL: string) => Promise<SavedImage>;
}

const partSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }) }),
]);
const chatSchema = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  messages: z.array(
    z.object({ role: z.string(), content: z.union([z.string(), z.array(partSchema)]).nullable() }),
  ),
});
const imageResponseSchema = z.object({
  data: z
    .array(z.object({ b64_json: z.string().min(1) }))
    .min(1)
    .max(1),
});

function failure(status: number, code: string): Response {
  return Response.json(
    { error: { message: code, code, type: 'image_generation_error' } },
    { status },
  );
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error('SUB2API_IMAGE_EMPTY');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('SUB2API_IMAGE_TOO_LARGE');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel();
  }
}

/** Keep the existing chat persistence/stream contract while calling the native Images API. */
export function createSub2APIImageFetch(deps: ImageDependencies): Fetch {
  const base = deps.baseURL.replace(/\/$/, '');
  return async (input, init) => {
    const signal = AbortSignal.any([
      ...(init?.signal ? [init.signal] : []),
      ...(input instanceof Request ? [input.signal] : []),
      AbortSignal.timeout(deps.config.imageTimeoutMs),
    ]);
    try {
      let url: string;
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.href;
      else url = input.url;
      if (new URL(url).pathname !== `${new URL(base).pathname}/chat/completions`) {
        return deps.request(input, init);
      }
      if (!deps.saveImage) return failure(503, 'SUB2API_IMAGE_STORAGE_UNAVAILABLE');
      let body = '';
      if (typeof init?.body === 'string') body = init.body;
      else if (input instanceof Request) body = await input.clone().text();
      const parsed = chatSchema.safeParse(JSON.parse(body || '{}'));
      if (!parsed.success) return failure(400, 'SUB2API_IMAGE_INVALID_REQUEST');
      const chat = parsed.data;
      if (!deps.config.imageModelPrefixes.some((prefix) => chat.model.startsWith(prefix))) {
        return deps.request(input, init);
      }
      const message = [...chat.messages].reverse().find((entry) => entry.role === 'user');
      const parts =
        typeof message?.content === 'string'
          ? [{ type: 'text' as const, text: message.content }]
          : (message?.content ?? []);
      const prompt = parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      if (!prompt.trim()) return failure(400, 'SUB2API_IMAGE_PROMPT_REQUIRED');
      const images = parts.filter((part) => part.type === 'image_url');
      let payload: string | FormData;
      const headers: Record<string, string> = { Authorization: `Bearer ${deps.apiKey}` };
      if (images.length) {
        const form = new FormData();
        form.append('model', chat.model);
        form.append('prompt', prompt);
        form.append('n', '1');
        for (const [index, part] of images.entries()) {
          const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(
            part.image_url.url,
          );
          if (!match) return failure(400, 'SUB2API_IMAGE_REFERENCE_INVALID');
          const bytes = Buffer.from(match[2], 'base64');
          if (bytes.length > deps.config.imageMaxBytes)
            return failure(413, 'SUB2API_IMAGE_TOO_LARGE');
          form.append(
            'image[]',
            new Blob([bytes], { type: match[1] }),
            `reference-${index}.${match[1].split('/')[1]}`,
          );
        }
        payload = form;
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify({ model: chat.model, prompt, n: 1, output_format: 'png' });
      }
      const response = await deps.request(
        `${base}/images/${images.length ? 'edits' : 'generations'}`,
        {
          method: 'POST',
          headers,
          body: payload,
          signal,
          redirect: 'error',
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return failure(response.status, `SUB2API_IMAGE_PROVIDER_${response.status}`);
      }
      const result = imageResponseSchema.parse(
        JSON.parse(
          await readBounded(response, Math.ceil((deps.config.imageMaxBytes * 4) / 3) + 65536),
        ),
      );
      signal.throwIfAborted();
      const encoded = result.data[0].b64_json;
      if (
        !/^[a-zA-Z0-9+/=]+$/.test(encoded) ||
        Buffer.from(encoded, 'base64').length > deps.config.imageMaxBytes
      ) {
        return failure(502, 'SUB2API_IMAGE_RESPONSE_INVALID');
      }
      const saved = await deps.saveImage(`data:image/png;base64,${encoded}`);
      const imagePath = `/api/files/download/${saved.userId}/${saved.file_id}`;
      const content = `![image.png](${imagePath})`;
      const completion = {
        id: `chatcmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model: chat.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      };
      if (!chat.stream) return Response.json({ ...completion, object: 'chat.completion' });
      const chunk = {
        ...completion,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
      };
      const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
      ) {
        throw new DOMException('Image request cancelled or timed out', 'AbortError');
      }
      return failure(502, 'SUB2API_IMAGE_UNAVAILABLE');
    }
  };
}

/** Bind the existing storage adapter; no credentials or image bytes enter chat text. */
export function createSub2APIImageSaver(deps: {
  req: ServerRequest;
  saveImage: (
    dataURL: string,
    options: { req: ServerRequest; filename: string; endpoint: string; context: string },
  ) => Promise<{ file_id: string }>;
}): (dataURL: string) => Promise<SavedImage> {
  return async (dataURL) => {
    if (!deps.req.user?.id) throw new Error('SUB2API_IMAGE_OWNER_REQUIRED');
    const file = await deps.saveImage(dataURL, {
      req: deps.req,
      filename: 'generated.png',
      endpoint: 'sub2api',
      context: 'image_generation',
    });
    return { file_id: file.file_id, userId: deps.req.user.id };
  };
}
