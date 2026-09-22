import { bearerHeaders, expectOk, readResponseContent, requiredString } from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange } from './types';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  md5Checksum?: string;
}

const googleExports: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'text/plain',
    extension: '.txt',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'text/csv',
    extension: '.csv',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
};

export const googleDriveConnector: KnowledgeConnector = {
  manifest: {
    type: 'google_drive',
    name: 'Google Drive',
    description: 'Index files from a Google Drive folder.',
    category: 'app',
    setup: 'manual_credentials',
    capabilities: [],
    fields: [
      { key: 'folderId', label: 'Folder ID', type: 'text', required: true },
      {
        key: 'accessToken',
        label: 'OAuth access token',
        type: 'password',
        secret: true,
        required: true,
        help: 'Paste a valid Google OAuth token. This preview does not refresh expired tokens automatically.',
      },
    ],
  },

  async validate(request, context) {
    const folderId = requiredString(request.config, 'folderId');
    await expectOk(
      await context.fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType`,
        {
          headers: bearerHeaders(request),
          signal: request.signal,
        },
      ),
      'Google Drive',
    );
  },

  async sync(request, context) {
    const folderId = requiredString(request.config, 'folderId');
    const headers = bearerHeaders(request);
    const changes: KnowledgeSourceChange[] = [];
    let pageToken: string | undefined;
    const seenPageTokens = new Set<string>();
    let pageCount = 0;
    do {
      pageCount += 1;
      if (pageCount > 1000) throw new Error('Google Drive pagination exceeds 1000 pages');
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) {
          throw new Error('Google Drive pagination repeated a page token');
        }
        seenPageTokens.add(pageToken);
      }
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set(
        'q',
        `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      );
      url.searchParams.set(
        'fields',
        'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,md5Checksum)',
      );
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const payload = (await (
        await expectOk(
          await context.fetch(url, { headers, signal: request.signal }),
          'Google Drive',
        )
      ).json()) as { files?: DriveFile[]; nextPageToken?: string };
      for (const file of payload.files ?? []) {
        if (file.mimeType === 'application/vnd.google-apps.folder') continue;
        const exportType = googleExports[file.mimeType];
        if (file.mimeType.startsWith('application/vnd.google-apps.') && !exportType) continue;
        const contentUrl = exportType
          ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportType.mimeType)}`
          : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
        const contentResponse = await expectOk(
          await context.fetch(contentUrl, { headers, signal: request.signal }),
          'Google Drive',
        );
        const mimeType =
          exportType?.mimeType ??
          contentResponse.headers.get('content-type')?.split(';')[0] ??
          file.mimeType;
        const content = await readResponseContent(contentResponse, mimeType);
        changes.push({
          operation: 'upsert',
          item: {
            externalId: file.id,
            title: `${file.name}${exportType?.extension ?? ''}`,
            ...content,
            mimeType,
            canonicalUrl: file.webViewLink,
            revision: file.md5Checksum ?? file.modifiedTime,
            updatedAt: file.modifiedTime,
            metadata: { driveFileId: file.id },
          },
        });
      }
      pageToken = payload.nextPageToken;
    } while (pageToken);
    return { changes, cursor: new Date().toISOString(), snapshot: true };
  },
};
