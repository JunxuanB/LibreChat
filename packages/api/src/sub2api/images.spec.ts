import { configSchema } from 'librechat-data-provider';
import { createSub2APIImageFetch } from './images';

const image =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWMQCXhGEmIY1RAwGkoiwzVpAACemEoQZfDkSwAAAABJRU5ErkJggg==';
const model = 'gpt-image-2.5-sunburst';
const config = configSchema.shape.sub2api.parse({ enabled: true });
if (!config) throw new Error('Missing fixture config');

function fixture() {
  const request = jest.fn<Promise<Response>, [string | URL | Request, RequestInit?]>(async () =>
    Response.json({ data: [{ b64_json: image }] }),
  );
  const saveImage = jest.fn(async () => ({ userId: 'owner', file_id: 'image-id' }));
  const fetch = createSub2APIImageFetch({
    request,
    baseURL: 'http://gateway.invalid/v1',
    apiKey: 'fixture-key',
    config: config!,
    saveImage,
  });
  const run = (content: string | Array<object> = '画一只猫', stream = true, signal?: AbortSignal) =>
    fetch('http://gateway.invalid/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        stream,
        messages: [
          { role: 'assistant', content: 'old content' },
          { role: 'user', content },
        ],
      }),
      signal,
    });
  return { request, saveImage, fetch, run };
}

describe('sub2api native image transport', () => {
  it('sends sunburst to Images and returns a saved private image through the chat stream', async () => {
    const f = fixture();
    const response = await f.run();
    const [url, options] = f.request.mock.calls[0];
    expect(url).toBe('http://gateway.invalid/v1/images/generations');
    expect(options?.headers).toEqual({
      Authorization: 'Bearer fixture-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      model,
      prompt: '画一只猫',
      n: 1,
      output_format: 'png',
    });
    expect(f.saveImage).toHaveBeenCalledWith(`data:image/png;base64,${image}`);
    const output = await response.text();
    expect(output).toContain('/api/files/download/owner/image-id');
    expect(output).toContain('data: [DONE]');
    expect(output).not.toContain(image);
  });

  it('uses multipart Edits for uploaded reference images without forwarding chat-only options', async () => {
    const f = fixture();
    await f.run([
      { type: 'text', text: '换成蓝色' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
    ]);
    const [url, options] = f.request.mock.calls[0];
    expect(url).toBe('http://gateway.invalid/v1/images/edits');
    const form = options?.body as FormData;
    expect(form.get('prompt')).toBe('换成蓝色');
    expect(form.get('model')).toBe(model);
    expect(form.get('image[]')).toBeInstanceOf(Blob);
    expect(form.has('temperature')).toBe(false);
  });

  it('never fetches an arbitrary image reference URL', async () => {
    const f = fixture();
    const result = await f.run([
      { type: 'text', text: 'edit' },
      { type: 'image_url', image_url: { url: 'http://private.invalid/image.png' } },
    ]);
    expect(result.status).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('does not disclose provider error payloads or save a failed generation', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(
      Response.json({ error: { message: 'secret fixture-key raw payload' } }, { status: 400 }),
    );
    const result = await f.run();
    expect(result.status).toBe(400);
    expect(await result.text()).not.toContain('fixture-key');
    expect(f.saveImage).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation and never persists a cancelled generation', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.request.mockImplementationOnce(async (_url, options) => {
      controller.abort();
      options?.signal?.throwIfAborted();
      return Response.json({});
    });
    await expect(f.run('cat', true, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.saveImage).not.toHaveBeenCalled();
  });

  it('bounds encoded output and returns normal JSON for non-stream clients', async () => {
    const f = fixture();
    const result = await f.run('cat', false);
    expect((await result.json()).choices[0].message.content).toContain(
      '/api/files/download/owner/image-id',
    );
    f.request.mockResolvedValueOnce(Response.json({ data: [{ b64_json: '!invalid' }] }));
    expect((await f.run()).status).toBe(502);
    expect(f.saveImage).toHaveBeenCalledTimes(1);
  });

  it('leaves non-image models on their original transport', async () => {
    const f = fixture();
    const init = {
      body: JSON.stringify({ model: 'gpt-6', messages: [{ role: 'user', content: 'hello' }] }),
    };
    await f.fetch('http://gateway.invalid/v1/chat/completions', init);
    expect(f.request).toHaveBeenCalledWith('http://gateway.invalid/v1/chat/completions', init);
    expect(f.saveImage).not.toHaveBeenCalled();
  });
});
