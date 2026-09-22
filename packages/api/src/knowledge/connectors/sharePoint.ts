import {
  bearerHeaders,
  expectOk,
  optionalString,
  readResponseContent,
  requiredString,
  safeFetch,
  sameOriginUrl,
} from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange } from './types';

interface GraphDriveItem {
  id: string;
  name: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  eTag?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  '@microsoft.graph.downloadUrl'?: string;
}

export const sharePointConnector: KnowledgeConnector = {
  manifest: {
    type: 'sharepoint',
    name: 'SharePoint',
    description: 'Index files from a SharePoint document library folder.',
    category: 'app',
    setup: 'manual_credentials',
    capabilities: [],
    fields: [
      { key: 'driveId', label: 'Drive ID', type: 'text', required: true },
      {
        key: 'folderId',
        label: 'Folder ID',
        type: 'text',
        placeholder: 'root',
      },
      {
        key: 'accessToken',
        label: 'Microsoft access token',
        type: 'password',
        secret: true,
        required: true,
        help: 'Paste a valid Microsoft Graph token. This preview does not refresh expired tokens automatically.',
      },
    ],
  },

  async validate(request, context) {
    const driveId = requiredString(request.config, 'driveId');
    await expectOk(
      await context.fetch(
        `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}`,
        {
          headers: bearerHeaders(request),
          signal: request.signal,
        },
      ),
      'SharePoint',
    );
  },

  async sync(request, context) {
    const driveId = requiredString(request.config, 'driveId');
    const folderId = optionalString(request.config, 'folderId') ?? 'root';
    const headers = bearerHeaders(request);
    const changes: KnowledgeSourceChange[] = [];
    const graphOrigin = new URL('https://graph.microsoft.com');
    let nextUrl: URL | undefined = new URL(
      `/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}/children?$top=200&$select=id,name,webUrl,lastModifiedDateTime,eTag,file,folder,@microsoft.graph.downloadUrl`,
      graphOrigin,
    );
    const seenPages = new Set<string>();
    let pageCount = 0;
    while (nextUrl) {
      pageCount += 1;
      if (pageCount > 1000) throw new Error('SharePoint pagination exceeds 1000 pages');
      if (seenPages.has(nextUrl.toString())) {
        throw new Error('SharePoint pagination repeated a page');
      }
      seenPages.add(nextUrl.toString());
      const payload = (await (
        await expectOk(
          await context.fetch(nextUrl, { headers, signal: request.signal }),
          'SharePoint',
        )
      ).json()) as { value?: GraphDriveItem[]; '@odata.nextLink'?: string };
      for (const item of payload.value ?? []) {
        if (!item.file) continue;
        const downloadUrl = item['@microsoft.graph.downloadUrl'];
        if (!downloadUrl) continue;
        const contentResponse = await expectOk(
          await safeFetch(
            context,
            downloadUrl,
            { signal: request.signal },
            'SharePoint download URL',
          ),
          'SharePoint download',
        );
        const mimeType =
          item.file.mimeType ?? contentResponse.headers.get('content-type')?.split(';')[0];
        const content = await readResponseContent(contentResponse, mimeType);
        changes.push({
          operation: 'upsert',
          item: {
            externalId: item.id,
            title: item.name,
            ...content,
            mimeType,
            canonicalUrl: item.webUrl,
            revision: item.eTag,
            updatedAt: item.lastModifiedDateTime,
            metadata: { driveId, driveItemId: item.id },
          },
        });
      }
      nextUrl = payload['@odata.nextLink']
        ? sameOriginUrl(payload['@odata.nextLink'], graphOrigin, 'SharePoint pagination URL')
        : undefined;
    }
    return { changes, cursor: new Date().toISOString(), snapshot: true };
  },
};
