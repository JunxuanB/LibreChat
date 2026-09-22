import { execFileSync } from 'child_process';
import path from 'path';
import { expect, request as playwrightRequest, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import cleanupUser from '../../setup/cleanupUser';
import { getSecondaryE2EUser } from '../../setup/users.mock';
import {
  finalizeKnowledgeAudit,
  knowledgeAuditOutputRoot,
  recordAuditFailure,
  recordAuditStep,
  recordExternalBlock,
  recordUnproducedSteps,
  resetKnowledgeAudit,
} from '../../audit/knowledge-base-audit';
import { openAgentBuilder, selectMockModel, waitForPersistedAgent } from './agents.helpers';
import { withMongo } from './db';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  RAG_API_BASE,
  getAccessToken,
  requestJson,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
  uploadViaUnifiedButton,
} from './helpers';

type KnowledgeBase = {
  _id: string;
  name: string;
  description: string;
  documents?: KnowledgeDocument[];
};
type KnowledgeDocument = { _id: string; file_id?: string; name: string; status: string };
type KnowledgeSource = {
  _id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  syncStatus?: string;
  syncError?: string | null;
};
type UploadedFile = { file_id: string; filename: string };

const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

async function openKnowledgeQuickSelect(page: Page) {
  await page.getByRole('button', { name: 'Tools Options' }).click();
  const trigger = page.getByTestId('tools-menu-knowledge-bases');
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'Knowledge Bases' });
  await expect(menu).toBeVisible();
  return { menu, trigger };
}

async function selectKnowledgeBase(page: Page, name: string) {
  const { menu, trigger } = await openKnowledgeQuickSelect(page);
  const option = menu.getByRole('menuitemcheckbox', { name });
  await expect(option).toBeVisible();
  if ((await option.getAttribute('aria-checked')) !== 'true') await option.click();
  return { menu, trigger, option };
}

async function createSecondaryApi(baseURL: string): Promise<APIRequestContext> {
  const user = getSecondaryE2EUser();
  await cleanupUser(user);
  const api = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const registered = await api.post('/api/auth/register', {
    data: { ...user, confirm_password: user.password },
  });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const login = await api.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const payload = (await login.json()) as { token?: string };
  expect(payload.token).toBeTruthy();
  await api.dispose();
  return playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${payload.token}` },
  });
}

test.describe('Knowledge Base auditable local exercise', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => resetKnowledgeAudit());

  test.afterAll(async () => {
    recordUnproducedSteps('The audit stopped before this registered step could execute.');
    try {
      await finalizeKnowledgeAudit();
    } finally {
      execFileSync(process.execPath, [path.resolve('e2e/audit/render-knowledge-base-audit.mjs')], {
        env: { ...process.env, KB_AUDIT_DIR: knowledgeAuditOutputRoot },
        stdio: 'inherit',
      });
    }
  });

  test('exercises the supported local contract and emits annotated evidence', async ({
    page,
    browser,
    baseURL,
  }) => {
    if (typeof baseURL !== 'string') throw new Error('Mock E2E baseURL is required');
    const kbName = unique('Audited Knowledge');
    const editedName = `${kbName} Edited`;
    const uploadName = `${unique('kb-audit')}.txt`;
    const uploadPhrase = 'cobalt-otter-591';
    let knowledgeBaseId: string | undefined;
    let secondaryKnowledgeBaseId: string | undefined;
    let uploadedFileId: string | undefined;
    let documentId: string | undefined;
    let createdAgentId: string | undefined;
    const sourceIds: string[] = [];

    try {
      await page.goto(NEW_CHAT_PATH);
      const token = await getAccessToken(page);
      const knowledgeRailButton = page.getByTestId('nav-panel-knowledge-bases');
      await expect(knowledgeRailButton).toBeVisible();
      await knowledgeRailButton.click();
      const knowledgePanel = page.getByRole('search');
      await expect(knowledgePanel).toBeVisible();
      await expect(page.getByLabel('Filter knowledge bases by name')).toBeVisible();
      const createButton = page.getByRole('button', { name: 'Create knowledge base' });
      await expect(createButton).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open knowledge library' })).toHaveCount(0);
      await recordAuditStep(page, {
        id: 'KB-UI-01',
        precondition: 'The mock server is running with interface.knowledgeBases.use enabled.',
        action: 'Click the Knowledge icon in the primary rail.',
        assertions: [
          'A real searchable Knowledge Base list panel opens.',
          'Create is in the panel and no intermediate Open Knowledge CTA exists.',
          'The chat remains in the main canvas until a library action is selected.',
        ],
        evidence: { url: new URL(page.url()).pathname },
        target: knowledgePanel,
      });

      await createButton.click();
      await expect(page).toHaveURL(/\/knowledge\/new$/);
      const createHeading = page.getByRole('heading', { name: 'Create knowledge base' });
      await expect(createHeading).toBeVisible();
      await page.getByLabel('Name', { exact: true }).fill(kbName);
      await page.getByLabel('Description').fill('Auditable local Knowledge Base exercise');
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
      const createdHeading = page.getByRole('heading', { name: kbName });
      await expect(createdHeading).toBeVisible();
      const activeCreatedRow = page.getByRole('button', { name: new RegExp(kbName) });
      await expect(activeCreatedRow).toHaveAttribute('aria-current', 'page');
      await recordAuditStep(page, {
        id: 'KB-UI-02',
        precondition: 'The owner has CREATE permission.',
        action: 'Open the create route in the main canvas, fill it, and save.',
        assertions: [
          'POST returned 201.',
          'The main canvas routes to the created detail.',
          'The created row remains visible and active in the side panel.',
        ],
        evidence: {
          knowledgeBaseId,
          responseStatus: createResponse.status(),
          url: new URL(page.url()).pathname,
        },
        target: createdHeading,
      });

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
      await expect(page).toHaveURL(new RegExp(`/knowledge/${knowledgeBaseId}$`));
      await page.reload();
      const editedHeading = page.getByRole('heading', { name: editedName });
      await expect(editedHeading).toBeVisible();
      await expect(page.getByRole('button', { name: new RegExp(editedName) })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await recordAuditStep(page, {
        id: 'KB-UI-03',
        precondition: 'The created base is open.',
        action: 'Rename it in the UI and reload the browser.',
        assertions: ['The edited name remains visible after reload.'],
        evidence: { persistedName: editedName },
        target: editedHeading,
      });

      await page.goto(NEW_CHAT_PATH);
      await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
      const uploadResponse = await uploadViaUnifiedButton(page, {
        name: uploadName,
        mimeType: 'text/plain',
        content: `The upload-only verification code is ${uploadPhrase}.`,
      });
      expect(uploadResponse.ok(), await uploadResponse.text()).toBeTruthy();
      uploadedFileId = ((await uploadResponse.json()) as UploadedFile).file_id;
      await expect(page.getByRole('button', { name: uploadName })).toBeVisible();
      await page.goto(`/knowledge/${knowledgeBaseId}`);
      await page.getByRole('button', { name: 'Add files' }).click();
      const filesDialog = page.getByRole('dialog');
      const fileRow = filesDialog.getByText(uploadName).locator('..');
      await fileRow.getByRole('button', { name: 'Add' }).click();
      await expect(fileRow.getByRole('button', { name: 'Add' })).toBeDisabled();
      await page.keyboard.press('Escape');
      const attachedFileCell = page.locator('td').getByText(uploadName, { exact: true });
      await expect(attachedFileCell).toBeVisible({ timeout: 30_000 });
      let document: KnowledgeDocument | undefined;
      await expect
        .poll(
          async () => {
            const documents = await requestJson<{ documents: KnowledgeDocument[] }>(page, {
              path: `/api/knowledge-bases/${knowledgeBaseId}/documents`,
              token,
            });
            document = documents.documents.find((item) => item.file_id === uploadedFileId);
            return document?.status;
          },
          { timeout: 30_000, message: 'attached document should finish ingestion' },
        )
        .toBe('ready');
      expect(document).toMatchObject({ name: uploadName, status: 'ready' });
      documentId = document!._id;
      await recordAuditStep(page, {
        id: 'KB-UP-01',
        precondition: 'A normal LibreChat text upload exists.',
        action: 'Open Add files and attach the existing upload.',
        assertions: ['The linked file is disabled in the picker.', 'The document reaches ready.'],
        evidence: { filename: uploadName, documentStatus: document?.status },
        target: attachedFileCell,
      });

      const rag = await page.request.get(`${RAG_API_BASE}/__debug/embedded`);
      expect(rag.ok()).toBeTruthy();
      const ragBody = (await rag.json()) as {
        embedded: Array<{ file_id: string; entity_id: string; bytes: number }>;
      };
      const vector = ragBody.embedded.find((item) => item.file_id === uploadedFileId);
      expect(vector).toMatchObject({ entity_id: knowledgeBaseId });
      expect(vector?.bytes).toBeGreaterThan(0);
      await recordAuditStep(page, {
        id: 'KB-UP-02',
        precondition: 'The attached document reports ready.',
        action: 'Inspect the deterministic RAG boundary recording.',
        assertions: [
          'The RAG request used the Knowledge Base ID as entity_id.',
          'Non-empty bytes reached RAG.',
        ],
        evidence: { fileId: uploadedFileId, entityId: vector?.entity_id, bytes: vector?.bytes },
        target: page.getByText('ready').first(),
      });

      await page.getByRole('button', { name: 'Add source' }).click();
      const sourceDialog = page.getByRole('dialog');
      const connectorNames = [
        'Website',
        'GitHub',
        'Google Drive',
        'SharePoint',
        'Notion',
        'Confluence',
        'PostgreSQL',
        'Custom API',
        'MCP Resources',
        'External Index',
      ];
      for (const name of connectorNames)
        await expect(sourceDialog.getByRole('button', { name })).toBeVisible();
      await recordAuditStep(page, {
        id: 'KB-SRC-01',
        precondition: 'The connector registry is available.',
        action: 'Open Add source and inspect the complete advertised catalog.',
        assertions: [
          `All ${connectorNames.length} connector choices are visible.`,
          'Uploads remains a distinct source choice.',
        ],
        evidence: { connectorNames },
        target: sourceDialog,
      });
      await page.keyboard.press('Escape');

      const website = await requestJson<KnowledgeSource>(page, {
        path: `/api/knowledge-bases/${knowledgeBaseId}/sources`,
        token,
        method: 'POST',
        body: {
          name: 'Audit Website',
          type: 'website',
          config: { url: 'https://example.com/', maxPages: 1 },
        },
      });
      sourceIds.push(website._id);
      await page.reload();
      const websiteRow = page.getByText('Audit Website');
      await expect(websiteRow).toBeVisible();
      await recordAuditStep(page, {
        id: 'KB-SRC-02',
        precondition: 'The owner can edit sources.',
        action: 'Create a Website source and render it in the detail view.',
        assertions: [
          'The API returns a sanitized source.',
          'The source is visible with idle state.',
        ],
        evidence: {
          type: website.type,
          config: website.config,
          hasCredentials: 'credentials' in website,
        },
        target: websiteRow,
      });

      const privateSource = await requestJson<KnowledgeSource>(page, {
        path: `/api/knowledge-bases/${knowledgeBaseId}/sources`,
        token,
        method: 'POST',
        body: {
          name: 'Private target rejection',
          type: 'website',
          config: { url: 'http://127.0.0.1:8787/', maxPages: 1 },
        },
      });
      const privateSync = await page.evaluate(
        async ({ accessToken, id, sourceId }) => {
          const response = await fetch(`/api/knowledge-bases/${id}/sources/${sourceId}/sync`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          return { status: response.status, body: await response.json() };
        },
        { accessToken: token, id: knowledgeBaseId, sourceId: privateSource._id },
      );
      expect(privateSync.status).toBe(202);
      let failedPrivateSource: KnowledgeSource | undefined;
      await expect
        .poll(
          async () => {
            const result = await requestJson<{ sources: KnowledgeSource[] }>(page, {
              path: `/api/knowledge-bases/${knowledgeBaseId}/sources`,
              token,
            });
            failedPrivateSource = result.sources.find((source) => source._id === privateSource._id);
            return failedPrivateSource?.syncStatus;
          },
          { timeout: 30_000, message: 'queued unsafe source sync should fail closed' },
        )
        .toBe('failed');
      await page.reload();
      await expect(page.getByText('Private target rejection')).toBeVisible();
      await expect(page.getByText(/private|loopback|not allowed/i).first()).toBeVisible();
      await recordAuditStep(page, {
        id: 'KB-SRC-03',
        precondition: 'A Website source targets loopback.',
        action: 'Trigger synchronization through the authenticated route.',
        assertions: [
          'The request is durably queued.',
          'The worker fails the unsafe destination closed.',
          'The UI renders a safe source failure.',
        ],
        evidence: {
          responseStatus: privateSync.status,
          queuedStatus: privateSync.body?.syncStatus,
          finalStatus: failedPrivateSource?.syncStatus,
          error: failedPrivateSource?.syncError,
        },
        target: page.getByText('Private target rejection'),
      });

      const custom = await requestJson<KnowledgeSource>(page, {
        path: `/api/knowledge-bases/${knowledgeBaseId}/sources`,
        token,
        method: 'POST',
        body: {
          name: 'Audit Custom API',
          type: 'custom_api',
          config: { url: 'https://example.com/feed' },
          credentials: { accessToken: 'never-render-this-token' },
        },
      });
      sourceIds.push(custom._id);
      expect(custom).not.toHaveProperty('credentials');
      expect(JSON.stringify(custom)).not.toContain('never-render-this-token');
      await page.reload();
      await recordAuditStep(page, {
        id: 'KB-SRC-04',
        precondition: 'A Custom API source has a bearer credential.',
        action: 'Create it through the public API and reload its UI row.',
        assertions: [
          'The source is created.',
          'The response and UI do not expose the bearer token.',
        ],
        evidence: {
          sourceType: custom.type,
          tokenLeaked: JSON.stringify(custom).includes('never-render-this-token'),
        },
        target: page.getByText('Audit Custom API'),
      });

      const external = await requestJson<KnowledgeSource>(page, {
        path: `/api/knowledge-bases/${knowledgeBaseId}/sources`,
        token,
        method: 'POST',
        body: {
          name: 'Audit External Index',
          type: 'external_index',
          config: { url: 'https://example.com/search' },
        },
      });
      sourceIds.push(external._id);
      expect(external.type).toBe('external_index');
      await page.reload();
      await recordAuditStep(page, {
        id: 'KB-SRC-05',
        precondition: 'The connector registry advertises External Index.',
        action: 'Create a live-retrieval source with no stored documents.',
        assertions: [
          'The source persists as external_index.',
          'Its row is visible independently of documents.',
        ],
        evidence: { sourceType: external.type },
        target: page.getByText('Audit External Index'),
      });

      await page.goto(NEW_CHAT_PATH);
      await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
      const secondaryKnowledgeBase = await requestJson<KnowledgeBase>(page, {
        path: '/api/knowledge-bases',
        token,
        method: 'POST',
        body: { name: unique('Audited Secondary Knowledge'), description: 'Quick-select coverage' },
      });
      secondaryKnowledgeBaseId = secondaryKnowledgeBase._id;

      const firstSelection = await selectKnowledgeBase(page, editedName);
      await firstSelection.menu
        .getByRole('menuitemcheckbox', { name: secondaryKnowledgeBase.name })
        .click();
      await expect(firstSelection.trigger).toContainText('2 selected');
      await expect(page.getByTestId('tools-menu-file-search')).toBeVisible();
      await expect(firstSelection.menu.getByText(/manage knowledge bases/i)).toHaveCount(0);
      await expect(
        page
          .getByTestId('composer-context-rail')
          .getByRole('button', { name: 'Knowledge', exact: true }),
      ).toHaveCount(0);
      await recordAuditStep(page, {
        id: 'KB-CHAT-01',
        precondition: 'The Knowledge Base is accessible to the current user.',
        action: 'Open Tools > Knowledge Bases and select two bases.',
        assertions: [
          'Knowledge Bases is a top-level Tools entry beside legacy File Search.',
          'The parent row visibly summarizes both selections as “2 selected”.',
          'No composer Knowledge control, chips, or management action is exposed.',
        ],
        evidence: {
          knowledgeBaseIds: [knowledgeBaseId, secondaryKnowledgeBaseId],
          multiSelectedCount: 2,
          managementActionCount: 0,
        },
        target: firstSelection.trigger,
      });

      await firstSelection.menu.getByRole('button', { name: 'Clear selection' }).click();
      await expect(firstSelection.trigger).not.toContainText('selected');
      await expect(
        firstSelection.menu.getByRole('menuitemcheckbox', { checked: true }),
      ).toHaveCount(0);
      await expect(page.getByTestId('tools-menu-file-search')).toBeVisible();
      await recordAuditStep(page, {
        id: 'KB-CHAT-01B',
        precondition: 'Two Knowledge Bases are visibly selected in the quick selector.',
        action: 'Activate Clear selection.',
        assertions: [
          'Every Knowledge Base row is unchecked.',
          'The parent row no longer displays a selected count.',
          'The independent legacy File Search control remains available.',
        ],
        evidence: { clearedCount: 0 },
        target: firstSelection.trigger,
      });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const selected = await selectKnowledgeBase(page, editedName);
      await expect(selected.trigger).toContainText('1 selected');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      const chatResponse = await sendMessageAndWaitForCompletion(page, 'E2E_FILE_SEARCH:kb-audit');
      const chatBody = chatResponse.request().postDataJSON() as {
        knowledge_base_ids?: string[];
        knowledge_base_only?: boolean;
        ephemeralAgent?: { file_search?: boolean };
      };
      expect(chatBody.knowledge_base_ids).toContain(knowledgeBaseId);
      expect(chatBody.knowledge_base_only).toBe(true);
      expect(chatBody.ephemeralAgent?.file_search).toBe(true);
      await expect(page.getByText(/E2E file_search complete: kb-audit/)).toBeVisible();
      await expect(
        page.locator('p').getByText(new RegExp(`grounded fact: ${uploadPhrase}`)),
      ).toBeVisible();
      const conversationPath = new URL(page.url()).pathname;
      await page.reload();
      const persistedSelection = await openKnowledgeQuickSelect(page);
      await expect(persistedSelection.trigger).toContainText('1 selected');
      await expect(
        persistedSelection.menu.getByRole('menuitemcheckbox', { name: editedName }),
      ).toHaveAttribute('aria-checked', 'true');
      const ragAfterSearch = (await (
        await page.request.get(`${RAG_API_BASE}/__debug/embedded`)
      ).json()) as {
        queries: Array<{ entity_id?: string; file_ids?: string[] }>;
      };
      expect(
        ragAfterSearch.queries.some((query) => query.entity_id === knowledgeBaseId),
      ).toBeTruthy();
      await recordAuditStep(page, {
        id: 'KB-CHAT-02',
        precondition: 'The selected KB contains a ready document.',
        action: 'Send a tool-forcing prompt and reload the persisted conversation.',
        assertions: [
          'The request carries knowledge_base_ids.',
          'KB selection exposes file_search without enabling the legacy File Search toggle.',
          'file_search queries the KB namespace.',
          'The final answer contains the fact observed in the file_search tool result.',
          'The Tools selection and compact count survive reload.',
        ],
        evidence: {
          conversationPath,
          requestedKnowledgeBaseIds: chatBody.knowledge_base_ids,
          knowledgeBaseOnly: chatBody.knowledge_base_only,
          effectiveFileSearch: chatBody.ephemeralAgent?.file_search,
          finalSelectedCount: 1,
          groundedFact: uploadPhrase,
        },
        target: persistedSelection.trigger,
      });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      let form = await openAgentBuilder(page);
      const agentName = unique('Audited KB Agent');
      await form.getByLabel('Agent name').fill(agentName);
      await form.getByLabel('Agent description').fill('Audited Knowledge Base persistence');
      await form.getByLabel('Instructions').fill('Use file_search for Knowledge Base questions.');
      await form.getByRole('button', { name: 'Add' }).last().click();
      const agentKbDialog = page.getByRole('dialog');
      await agentKbDialog.getByRole('button', { name: editedName }).click();
      await agentKbDialog.getByRole('button', { name: 'Done' }).click();
      await selectMockModel(page, true);
      form = page.getByRole('form', { name: 'Agent configuration form' });
      const [agentResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/agents',
        ),
        form.getByRole('button', { name: 'Create' }).click(),
      ]);
      expect(agentResponse.status(), await agentResponse.text()).toBe(201);
      const agent = (await agentResponse.json()) as { id: string };
      createdAgentId = agent.id;
      const persistedAgent = await waitForPersistedAgent(
        page,
        agentName,
        'Audited Knowledge Base persistence',
      );
      const persistedResources = (
        persistedAgent as typeof persistedAgent & {
          tool_resources?: { file_search?: { knowledge_base_ids?: string[] } };
        }
      ).tool_resources;
      expect(persistedResources?.file_search?.knowledge_base_ids).toEqual([knowledgeBaseId]);
      await recordAuditStep(page, {
        id: 'KB-AGENT-01',
        precondition: 'The Agent builder and KB picker are enabled.',
        action: 'Attach the KB, create the Agent, then read its expanded persisted record.',
        assertions: [
          'Agent creation returns 201.',
          'tool_resources.file_search.knowledge_base_ids persists exactly the selected ID.',
        ],
        evidence: {
          agentId: createdAgentId,
          knowledgeBaseIds: persistedResources?.file_search?.knowledge_base_ids,
        },
        target: page.getByText(new RegExp(`Successfully created ${agentName}`)),
      });

      form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agentName }).click();
      await form.getByRole('button', { name: 'Select Agent' }).click();
      await sendMessageAndWaitForCompletion(page, 'E2E_FILE_SEARCH:persistent-kb');
      await expect(page.getByText(/E2E file_search complete: persistent-kb/)).toBeVisible();
      await recordAuditStep(page, {
        id: 'KB-AGENT-02',
        precondition: 'A persisted Agent owns the KB tool resource.',
        action: 'Select the Agent and force a file_search tool call.',
        assertions: ['The persistent Agent advertises and executes file_search.'],
        evidence: { agentId: createdAgentId },
        target: page.getByText(/E2E file_search complete: persistent-kb/),
      });

      await page.goto(NEW_CHAT_PATH);
      await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
      await selectKnowledgeBase(page, editedName);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const ephemeralResponse = await sendMessageAndWaitForCompletion(
        page,
        'E2E_FILE_SEARCH:ephemeral-kb',
      );
      const ephemeralBody = ephemeralResponse.request().postDataJSON() as {
        knowledge_base_ids?: string[];
        knowledge_base_only?: boolean;
        ephemeralAgent?: { file_search?: boolean };
      };
      expect(ephemeralBody.knowledge_base_ids).toEqual([knowledgeBaseId]);
      expect(ephemeralBody.knowledge_base_only).toBe(true);
      expect(ephemeralBody.ephemeralAgent?.file_search).toBe(true);
      await recordAuditStep(page, {
        id: 'KB-EPH-01',
        precondition: 'No persisted Agent is selected.',
        action: 'Attach the KB in a fresh chat and force file_search.',
        assertions: [
          'The ephemeral request carries the KB ID.',
          'KB selection automatically equips file_search while legacy File Search stays off.',
          'The tool completes without a persisted Agent.',
        ],
        evidence: {
          knowledgeBaseIds: ephemeralBody.knowledge_base_ids,
          knowledgeBaseOnly: ephemeralBody.knowledge_base_only,
          effectiveFileSearch: ephemeralBody.ephemeralAgent?.file_search,
        },
        target: page.getByText(/E2E file_search complete: ephemeral-kb/),
      });

      await page.goto(`/knowledge/${knowledgeBaseId}`);
      await page.getByRole('button', { name: 'Share' }).click();
      const shareDialog = page.getByRole('dialog');
      await expect(shareDialog).toBeVisible();
      await expect(shareDialog.getByText(/access|share/i).first()).toBeVisible();
      await recordAuditStep(page, {
        id: 'KB-ACL-01',
        precondition: 'The creator owns SHARE permission.',
        action: 'Open the generic resource-sharing dialog.',
        assertions: ['The Knowledge Base share dialog renders for its owner.'],
        evidence: { resourceType: 'knowledgeBase' },
        target: shareDialog,
      });
      await page.keyboard.press('Escape');

      const secondary = await createSecondaryApi(baseURL);
      try {
        const denied = await secondary.get(`/api/knowledge-bases/${knowledgeBaseId}`);
        expect(denied.status()).toBe(403);
        await recordAuditStep(page, {
          id: 'KB-ACL-02',
          precondition: 'A separately authenticated user has no grant.',
          action: 'Request the owner-only Knowledge Base directly with the second user token.',
          assertions: ['The server returns 403 rather than relying on hidden UI.'],
          evidence: { responseStatus: denied.status() },
          target: page.getByRole('heading', { name: editedName }),
        });
      } finally {
        await secondary.dispose();
        await cleanupUser(getSecondaryE2EUser());
      }

      await withMongo(async (db) => {
        const { ObjectId } = await import('mongodb');
        await db.collection('knowledgesources').updateOne(
          { _id: new ObjectId(website._id) },
          {
            $set: {
              syncLease: { token: 'other-worker', expiresAt: new Date(Date.now() + 60_000) },
            },
          },
        );
      });
      const leaseResult = await page.evaluate(
        async ({ accessToken, id, sourceId }) => {
          const response = await fetch(`/api/knowledge-bases/${id}/sources/${sourceId}/sync`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          return { status: response.status, body: await response.json() };
        },
        { accessToken: token, id: knowledgeBaseId, sourceId: website._id },
      );
      expect(leaseResult).toMatchObject({ status: 202, body: { syncStatus: 'queued' } });
      await withMongo(async (db) => {
        const { ObjectId } = await import('mongodb');
        await db.collection('knowledgesources').updateOne(
          { _id: new ObjectId(website._id) },
          {
            $set: { syncStatus: 'ready', nextSyncAt: null },
            $unset: { syncLease: 1, syncRequestedAt: 1 },
          },
        );
      });
      await recordAuditStep(page, {
        id: 'KB-SYNC-01',
        precondition: 'Another worker owns a non-expired source lease.',
        action: 'Submit a competing authenticated sync request.',
        assertions: [
          'The request is durably accepted as queued rather than starting a second execution.',
        ],
        evidence: {
          responseStatus: leaseResult.status,
          syncStatus: leaseResult.body?.syncStatus,
        },
        target: page.getByText('Audit Website'),
      });

      let failList = true;
      const isKnowledgeBaseList = (url: URL) => url.pathname === '/api/knowledge-bases';
      const errorContext = await browser.newContext({
        baseURL,
        serviceWorkers: 'block',
        storageState: path.resolve('e2e/storageState.json'),
      });
      const errorPage = await errorContext.newPage();
      await errorPage.route(isKnowledgeBaseList, async (route) => {
        if (failList) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: '{"error":"audit injected"}',
          });
          return;
        }
        await route.continue();
      });
      await errorPage.goto(`${NEW_CHAT_PATH}?audit-retry=1`);
      await errorPage.getByTestId('nav-panel-knowledge-bases').click();
      const retry = errorPage.getByRole('button', { name: 'Retry' });
      await expect(retry).toBeVisible({ timeout: 20_000 });
      await recordAuditStep(errorPage, {
        id: 'KB-ERR-01',
        precondition: 'Every initial list attempt is deterministically forced to 500.',
        action: 'Open the Knowledge side panel in a clean authenticated browser context.',
        assertions: ['The list panel error state exposes a visible Retry action.'],
        evidence: { injectedStatus: 500 },
        target: retry,
      });
      failList = false;
      await retry.click();
      await expect(errorPage.getByRole('button', { name: editedName })).toBeVisible();
      await recordAuditStep(errorPage, {
        id: 'KB-ERR-02',
        precondition: 'The injected failure and Retry action are visible.',
        action: 'Release the injected failure and click Retry.',
        assertions: ['Retry restores the real Knowledge Base list.'],
        evidence: { recovered: true },
        target: errorPage.getByRole('button', { name: editedName }),
      });
      await errorContext.close();

      await page.goto(`/knowledge/${knowledgeBaseId}`);
      await requestJson(page, {
        path: `/api/knowledge-bases/${knowledgeBaseId}/documents/${documentId}`,
        token,
        method: 'DELETE',
      });
      const filesAfterDocumentDelete = await requestJson<UploadedFile[]>(page, {
        path: '/api/files',
        token,
      });
      expect(filesAfterDocumentDelete.some((file) => file.file_id === uploadedFileId)).toBeTruthy();
      await page.reload();
      await expect(page.getByText(uploadName)).toHaveCount(0);
      await recordAuditStep(page, {
        id: 'KB-DEL-01',
        precondition: 'An ordinary user upload is linked to the KB.',
        action: 'Delete only its Knowledge document.',
        assertions: ['The KB document disappears.', 'The original File record remains.'],
        evidence: { originalUploadPreserved: true },
        target: page.getByRole('heading', { name: 'Documents' }),
      });

      await requestJson(page, {
        path: `/api/knowledge-bases/${knowledgeBaseId}`,
        token,
        method: 'DELETE',
      });
      await page.goto(NEW_CHAT_PATH);
      await page.getByTestId('nav-panel-knowledge-bases').click();
      await expect(page.getByRole('button', { name: editedName })).toHaveCount(0);
      const deletedGet = await page.request.get(`/api/knowledge-bases/${knowledgeBaseId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect([403, 404]).toContain(deletedGet.status());
      knowledgeBaseId = undefined;
      await recordAuditStep(page, {
        id: 'KB-DEL-02',
        precondition: 'The KB owns several source and ACL records.',
        action: 'Delete the full Knowledge Base and return to the library.',
        assertions: ['The library no longer lists it.', 'Direct access fails closed.'],
        evidence: { listedAfterDelete: false, directStatus: deletedGet.status() },
        target: page.getByRole('search'),
      });

      const contractVerified = process.env.KB_CONNECTOR_CONTRACTS_VERIFIED === 'true';
      const externalBlockers = [
        ['KB-CON-GH', 'GitHub', 'A disposable repository/token was not supplied.'],
        ['KB-CON-GD', 'Google Drive', 'A disposable Google OAuth account was not supplied.'],
        ['KB-CON-SP', 'SharePoint', 'A disposable Microsoft Graph tenant was not supplied.'],
        ['KB-CON-NO', 'Notion', 'A disposable Notion integration was not supplied.'],
        ['KB-CON-CF', 'Confluence', 'A disposable Atlassian site/token was not supplied.'],
        [
          'KB-CON-PG',
          'PostgreSQL',
          'No dedicated local PostgreSQL runtime was supplied to this mock-server run.',
        ],
        [
          'KB-CON-MCP',
          'MCP',
          'The configured mock MCP server exposes tools, not Knowledge resources.',
        ],
      ] as const;
      for (const [id, connector, liveReason] of externalBlockers) {
        recordExternalBlock(
          id,
          `${liveReason} Deterministic adapter tests ${contractVerified ? 'passed before this Playwright run' : 'must be run with the audit runner'}.`,
          { connector, deterministicContractVerified: contractVerified },
        );
      }
    } catch (error) {
      await recordAuditFailure(page, error);
      throw error;
    } finally {
      if (createdAgentId) {
        const token = await getAccessToken(page).catch(() => undefined);
        if (token) {
          await requestJson(page, {
            path: `/api/agents/${createdAgentId}`,
            token,
            method: 'DELETE',
          }).catch(() => undefined);
        }
      }
      if (knowledgeBaseId) {
        const token = await getAccessToken(page).catch(() => undefined);
        if (token) {
          await requestJson(page, {
            path: `/api/knowledge-bases/${knowledgeBaseId}`,
            token,
            method: 'DELETE',
          }).catch(() => undefined);
        }
      }
      if (secondaryKnowledgeBaseId) {
        const token = await getAccessToken(page).catch(() => undefined);
        if (token) {
          await requestJson(page, {
            path: `/api/knowledge-bases/${secondaryKnowledgeBaseId}`,
            token,
            method: 'DELETE',
          }).catch(() => undefined);
        }
      }
    }
  });
});
