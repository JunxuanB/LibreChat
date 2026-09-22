import { bearerHeaders, expectOk, optionalString, requiredString } from './helpers';
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
    capabilities: ['incremental_sync', 'deletions', 'permissions'],
    fields: [
      { key: 'driveId', label: 'Drive ID', type: 'text', required: true },
      { key: 'folderId', label: 'Folder ID', type: 'text', placeholder: 'root' },
      { key: 'accessToken', label: 'Microsoft access token', type: 'password', secret: true, required: true },
    ],
  },

  async validate(request, context) {
    const driveId = requiredString(request.config, 'driveId');
    await expectOk(
      await context.fetch(`https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}`, {
        headers: bearerHeaders(request),
        signal: request.signal,
      }),
      'SharePoint',
    );
  },

  async sync(request, context) {
    const driveId = requiredString(request.config, 'driveId');
    const folderId = optionalString(request.config, 'folderId') ?? 'root';
    const headers = bearerHeaders(request);
    const changes: KnowledgeSourceChange[] = [];
    let nextUrl: string | undefined = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}/children?$top=200&$select=id,name,webUrl,lastModifiedDateTime,eTag,file,folder,@microsoft.graph.downloadUrl`;
    while (nextUrl) {
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
        const content = await (
          await expectOk(
            await context.fetch(downloadUrl, { signal: request.signal }),
            'SharePoint download',
          )
        ).text();
        changes.push({
          operation: 'upsert',
          item: {
            externalId: item.id,
            title: item.name,
            content,
            mimeType: item.file.mimeType,
            canonicalUrl: item.webUrl,
            revision: item.eTag,
            updatedAt: item.lastModifiedDateTime,
            metadata: { driveId, driveItemId: item.id },
          },
        });
      }
      nextUrl = payload['@odata.nextLink'];
    }
    return { changes, cursor: new Date().toISOString() };
  },
};
