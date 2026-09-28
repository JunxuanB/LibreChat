import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page, Response } from '@playwright/test';
import {
  getAccessToken,
  messagesView,
  requestJson,
  selectMockEndpoint,
  uniqueName,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
} from '../helpers';
import { withMongo } from '../db';
import { getE2EUser } from '../../../setup/user';

/**
 * Leaving a conversation that has a classic (Assistants) SSE run in flight
 * tears the pane's submission down and aborts the run. The abort is a round
 * trip, and for its whole duration the pane's in-flight flags used to stay
 * raised on whichever conversation the user had just opened: a stop button and
 * a submitting status for a transcript with nothing running.
 *
 * These specs pin the flags to the switch itself, keep the same-conversation
 * stop contract intact, and fence the late abort settlement away from a newer
 * run started on the destination.
 */
test.describe.configure({ timeout: 180_000 });

const ASSISTANTS_MODEL = 'gpt-4o-mini';

const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop generating' });

/** The Assistants client routes are versioned: `/api/assistants/v2/chat` and
 *  `/api/assistants/v2/abort`. */
const isAssistantsChat = (response: Response) => {
  const { pathname } = new URL(response.url());
  return (
    response.request().method() === 'POST' &&
    pathname.startsWith('/api/assistants/v') &&
    pathname.endsWith('/chat') &&
    response.status() === 200
  );
};

const isAssistantsAbort = (response: Response) => {
  const { pathname } = new URL(response.url());
  return (
    response.request().method() === 'POST' &&
    pathname.startsWith('/api/assistants/v') &&
    pathname.endsWith('/abort')
  );
};

/** Brings the sidebar on screen. Desktop keeps the panel open and renders no
 *  opener at all; a narrow viewport keeps the drawer closed until the header's
 *  opener is used, and nothing inside it is visible or tappable before that.
 *  Which of the two appears first says which layout this is, without paying a
 *  timeout for the one this layout never renders. */
async function openSidebar(page: Page): Promise<void> {
  const historyRegion = page.getByRole('region', { name: 'Chat History' });
  const opener = page.getByRole('button', { name: 'Open sidebar' }).first();
  const appeared = await Promise.race([
    opener.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'opener' as const),
    historyRegion.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'region' as const),
  ]);
  if (appeared === 'opener') {
    await opener.click();
  }
  await expect(historyRegion).toBeVisible({ timeout: 30_000 });
}

/** The Assistants entry opens a submenu whose options are the account's
 *  assistants (loading async), and picking one commits both the endpoint and
 *  the assistant; the send then goes out on the Assistants chat route. */
async function selectAssistantsEndpoint(page: Page, assistantName: string) {
  const trigger = page.getByRole('button', { name: 'Select a model' }).first();
  await trigger.click();
  await page.getByRole('option', { name: 'Assistants', exact: true }).click();
  const assistantOption = page.getByRole('option').filter({ hasText: assistantName }).first();
  await assistantOption.click({ timeout: 15_000 });
  await expect(page.getByRole('option')).toHaveCount(0, { timeout: 10_000 });
}

/** The Assistants endpoint needs an assistant on the account before a new
 *  conversation can send; the fake provider serves the CRUD behind it. Returns
 *  the created assistant's name for the picker. */
async function ensureAssistant(page: Page): Promise<string> {
  const name = `E2E pane settle ${uniqueName('assistant')}`;
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: '/api/assistants/v1',
    token,
    method: 'POST',
    body: { model: ASSISTANTS_MODEL, name, endpoint: 'assistants' },
  });
  return name;
}

/** Sends on the classic Assistants SSE route and returns once the server has
 *  admitted the streamed run. */
async function sendAssistantsMessage(page: Page, text: string): Promise<Response> {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.click();
  await input.fill(text);
  const [response] = await Promise.all([
    page.waitForResponse(isAssistantsChat, { timeout: 30_000 }),
    input.press('Enter'),
  ]);
  return response;
}

/** Starts a slow, cancellable Assistants run and waits until it is visibly
 *  streaming. */
async function startSlowAssistantRun(page: Page, label: string) {
  await sendAssistantsMessage(page, `E2E_SLOW_ASSISTANT:${label}`);
  await expect(stopButton(page)).toBeVisible({ timeout: 15_000 });
}

/** A second conversation with a titled sidebar row, inserted the way the
 *  pinned fixtures seed theirs: rows carry the conversation title, and a
 *  conversation created through the composer keeps "New Chat" for its title
 *  under the mock endpoints (they disable title generation). */
async function seedDestinationChat(page: Page): Promise<{ row: Locator; title: string }> {
  const title = `Destination dest-${Math.random().toString(36).slice(2, 8)}`;
  const conversationId = randomUUID();
  const userEmail = getE2EUser().email;
  const now = new Date();
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) {
      throw new Error(`E2E seed: user "${userEmail}" not found`);
    }
    await db.collection('conversations').insertOne({
      conversationId,
      title,
      user: String(user._id),
      /** A sendable destination: the mock custom endpoint with its model, so
       *  the late-abort scenario can start a real run there. */
      endpoint: 'Mock Provider A',
      model: 'mock-model-a',
      isArchived: false,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
  });

  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await openSidebar(page);
  const row = page.getByTestId('convo-item').filter({ hasText: title }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  return { row, title };
}

/** Opens a new chat on the Assistants endpoint, ready for a slow run. */
async function openAssistantsNewChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  const assistantName = await ensureAssistant(page);
  /** The assistant list query caches its (empty) first answer and does not
   *  refetch on mount, so an assistant created after the page loaded would
   *  not appear in the endpoint's picker. Reload once to mount the queries
   *  against the now-populated list. */
  await page.reload({ timeout: 10_000 });
  await selectAssistantsEndpoint(page, assistantName);
}

test.describe('pane in-flight flags across a conversation switch', () => {
  test('the destination chat is idle for the whole abort window @scenario:pane-settle-navigate-away', async ({
    page,
  }) => {
    const label = uniqueName('navigate-away');
    const { row: destinationRow } = await seedDestinationChat(page);
    await openAssistantsNewChat(page);
    await startSlowAssistantRun(page, label);

    const abortSettled = page.waitForResponse(isAssistantsAbort, { timeout: 20_000 });

    await openSidebar(page);
    await destinationRow.click();

    /** The switch settles the pane well inside the abort's own latency: the
     *  fixture delays the run cancel by 2.5s, so a pane still waiting on the
     *  abort cannot hide within this bound. */
    await expect(stopButton(page)).toBeHidden({ timeout: 2_000 });

    /** The abort request fires after the switch; its status is not the
     *  contract here (a run started on a new chat sends an abortKey the server
     *  rejects, and the server-side disconnect handler still cancels the run).
     */
    await abortSettled;

    /** The destination stays itself: the departed run's streamed chunks never
     *  land in its transcript. */
    await expect(messagesView(page).getByText(/slow-/)).toHaveCount(0);
  });

  test('a new chat opened mid-run is idle immediately @scenario:pane-settle-new-chat', async ({
    page,
  }) => {
    const label = uniqueName('new-chat');
    await openAssistantsNewChat(page);
    await startSlowAssistantRun(page, label);

    const abortSettled = page.waitForResponse(isAssistantsAbort, { timeout: 20_000 });

    /** With the Assistants endpoint active, a new chat is created carrying the
     *  selected assistant, so the destination is an assistant-scoped URL
     *  rather than /c/new; what matters is that the pane left the departing
     *  conversation and reports idle there. */
    const departingUrl = page.url();
    await openSidebar(page);
    await page.getByRole('link', { name: 'New chat' }).first().click();

    await expect(page).not.toHaveURL(departingUrl, { timeout: 10_000 });
    await expect(stopButton(page)).toBeHidden({ timeout: 2_000 });

    await abortSettled;
  });

  test('a send on the destination keeps its own streaming state when the stale abort settles @scenario:pane-settle-late-abort-resend', async ({
    page,
  }) => {
    const label = uniqueName('late-abort');
    const { row: destinationRow } = await seedDestinationChat(page);
    await openAssistantsNewChat(page);
    await startSlowAssistantRun(page, label);

    const abortSettled = page.waitForResponse(isAssistantsAbort, { timeout: 20_000 });

    await openSidebar(page);
    await destinationRow.click();
    await expect(stopButton(page)).toBeHidden({ timeout: 10_000 });

    /** A new run starts on the destination while the old run's abort is still
     *  pending; its stop button belongs to it alone. */
    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.click();
    await input.fill(`E2E_SLOW_REPLY:${label}`);
    const [admission] = await Promise.all([
      page.waitForResponse(
        (response: Response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.startsWith('/api/agents/chat') &&
          !new URL(response.url()).pathname.endsWith('/abort') &&
          response.status() === 200,
        { timeout: 30_000 },
      ),
      input.press('Enter'),
    ]);
    expect(admission.ok()).toBeTruthy();
    await expect(stopButton(page)).toBeVisible({ timeout: 15_000 });

    /** The stale Assistants abort settles mid-stream here (the fixture delays
     *  its cancel); it must not clear the live run's flags. */
    await abortSettled;
    await expect(stopButton(page)).toBeVisible();

    await expect(stopButton(page)).toBeHidden({ timeout: 60_000 });
  });

  test('stopping in the same conversation keeps the abort-owned settlement and a healthy transcript @scenario:pane-settle-stop-unchanged', async ({
    page,
  }) => {
    const label = uniqueName('stop-unchanged');
    await openAssistantsNewChat(page);
    await startSlowAssistantRun(page, label);

    const abortSettled = page.waitForResponse(isAssistantsAbort, { timeout: 20_000 });
    await stopButton(page).click();
    await expect(stopButton(page)).toBeHidden({ timeout: 10_000 });

    await abortSettled;

    /** The pane frees exactly when the abort settles: the next turn sends and
     *  completes on the same conversation and endpoint. */
    await sendAssistantsMessage(page, `E2E_REPLY:${label}`);
    await expect(messagesView(page).getByText(`E2E assistant reply ${label}`)).toBeVisible({
      timeout: 30_000,
    });
  });

  test('leaving a resumable run still leaves the destination idle @scenario:pane-settle-resumable-unchanged', async ({
    page,
  }) => {
    const label = uniqueName('resumable');
    const { row: destinationRow } = await seedDestinationChat(page);

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.click();
    await input.fill(`E2E_SLOW_REPLY:${label}`);
    const [admission] = await Promise.all([
      page.waitForResponse(
        (response: Response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.startsWith('/api/agents/chat') &&
          !new URL(response.url()).pathname.endsWith('/abort') &&
          response.status() === 200,
        { timeout: 30_000 },
      ),
      input.press('Enter'),
    ]);
    expect(admission.ok()).toBeTruthy();
    await expect(stopButton(page)).toBeVisible({ timeout: 15_000 });

    await openSidebar(page);
    await destinationRow.click();

    /** The resumable twin already settles its flags on detach; the destination
     *  stays idle and the departed run's chunks never reach its transcript. */
    await expect(stopButton(page)).toBeHidden({ timeout: 10_000 });
    await expect(messagesView(page).getByText(/chunk-|slow-/)).toHaveCount(0);
  });
});
