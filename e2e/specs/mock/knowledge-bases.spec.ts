import { expect, test } from '@playwright/test';
import { getAccessToken, NEW_CHAT_PATH, requestJson } from './helpers';

type KnowledgeBase = {
  _id: string;
  name: string;
  description: string;
};

type KnowledgeSource = {
  _id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
};

type SourceList = { sources: KnowledgeSource[] };

const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 10_000)}`;

test.describe('knowledge base user lifecycle', () => {
  test.describe.configure({ timeout: 120_000 });

  test('creates and edits in the UI, manages a source through the API, and deletes in the UI', async ({
    page,
  }) => {
    const originalName = uniqueName('E2E Knowledge');
    const editedName = `${originalName} Edited`;
    const sourceName = uniqueName('E2E Website');
    let knowledgeBaseId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH);
      const token = await getAccessToken(page);
      await page.getByTestId('nav-panel-knowledge-bases').click();
      await expect(page.getByLabel('Filter knowledge bases by name')).toBeVisible();
      await page.getByRole('button', { name: 'Create knowledge base' }).click();
      await expect(page).toHaveURL(/\/knowledge\/new$/);

      await page.getByLabel('Name', { exact: true }).fill(originalName);
      await page.getByLabel('Description').fill('Created by the Knowledge Base E2E test');
      const [createResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/knowledge-bases',
        ),
        page.getByRole('button', { name: 'Save' }).click(),
      ]);
      expect(createResponse.status(), await createResponse.text()).toBe(201);
      knowledgeBaseId = ((await createResponse.json()) as KnowledgeBase)._id;
      await expect(page).toHaveURL(new RegExp(`/knowledge/${knowledgeBaseId}$`));
      await expect(page.getByRole('heading', { name: originalName })).toBeVisible();
      await expect(page.getByRole('button', { name: new RegExp(originalName) })).toHaveAttribute(
        'aria-current',
        'page',
      );

      await page.getByRole('button', { name: 'Edit' }).click();
      await expect(page).toHaveURL(new RegExp(`/knowledge/${knowledgeBaseId}/edit$`));
      await page.getByLabel('Name', { exact: true }).fill(editedName);
      const [editResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'PATCH' &&
            new URL(response.url()).pathname === `/api/knowledge-bases/${knowledgeBaseId}`,
        ),
        page.getByRole('button', { name: 'Save' }).click(),
      ]);
      expect(editResponse.ok(), await editResponse.text()).toBeTruthy();
      await expect(page.getByRole('heading', { name: editedName })).toBeVisible();

      const source = await requestJson<KnowledgeSource>(page, {
        path: `/api/knowledge-bases/${knowledgeBaseId}/sources`,
        token,
        method: 'POST',
        body: {
          name: sourceName,
          type: 'website',
          config: { url: 'https://example.com/', maxPages: 1 },
        },
      });
      expect(source).toMatchObject({ name: sourceName, type: 'website' });
      expect(source).not.toHaveProperty('credentials');
      expect(source).not.toHaveProperty('connection');

      const listed = await requestJson<SourceList>(page, {
        path: `/api/knowledge-bases/${knowledgeBaseId}/sources`,
        token,
      });
      expect(listed.sources).toEqual([
        expect.objectContaining({ _id: source._id, name: sourceName }),
      ]);

      const renamedSource = `${sourceName} Renamed`;
      const patched = await requestJson<KnowledgeSource>(page, {
        path: `/api/knowledge-bases/${knowledgeBaseId}/sources/${source._id}`,
        token,
        method: 'PATCH',
        body: { name: renamedSource, config: { maxPages: 2 } },
      });
      expect(patched).toMatchObject({
        _id: source._id,
        name: renamedSource,
        config: { url: 'https://example.com/', maxPages: 2 },
      });

      await requestJson<{ deleted: boolean }>(page, {
        path: `/api/knowledge-bases/${knowledgeBaseId}/sources/${source._id}`,
        token,
        method: 'DELETE',
      });
      expect(
        (
          await requestJson<SourceList>(page, {
            path: `/api/knowledge-bases/${knowledgeBaseId}/sources`,
            token,
          })
        ).sources,
      ).toEqual([]);

      await page.goto(NEW_CHAT_PATH);
      await page.getByRole('button', { name: 'Tools Options' }).click();
      const knowledgeBasesTool = page.getByTestId('tools-menu-knowledge-bases');
      await expect(knowledgeBasesTool).toBeVisible();
      await knowledgeBasesTool.click();
      const quickSelect = page.getByRole('menu', { name: 'Knowledge Bases' });
      await expect(quickSelect).toBeVisible();
      await expect(quickSelect.getByText(/manage knowledge bases/i)).toHaveCount(0);
      await quickSelect.getByRole('menuitemcheckbox', { name: editedName }).click();
      await expect(knowledgeBasesTool).toContainText('1 selected');
      await expect(quickSelect.getByRole('menuitemcheckbox', { name: editedName })).toHaveAttribute(
        'aria-checked',
        'true',
      );

      await page.goto(`/knowledge/${knowledgeBaseId}`);

      page.once('dialog', (dialog) => dialog.accept());
      const [deleteResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'DELETE' &&
            new URL(response.url()).pathname === `/api/knowledge-bases/${knowledgeBaseId}`,
        ),
        page.getByRole('button', { name: 'Delete' }).click(),
      ]);
      expect(deleteResponse.ok(), await deleteResponse.text()).toBeTruthy();
      knowledgeBaseId = undefined;
      await expect(page).toHaveURL(/\/knowledge$/);
      await expect(page.getByRole('button', { name: editedName })).toHaveCount(0);
    } finally {
      if (knowledgeBaseId) {
        const token = await getAccessToken(page);
        await requestJson(page, {
          path: `/api/knowledge-bases/${knowledgeBaseId}`,
          token,
          method: 'DELETE',
        }).catch(() => undefined);
      }
    }
  });
});
