import { expect, test } from '@playwright/test';
import type { Locator, Page, Response } from '@playwright/test';
import {
  getAccessToken,
  messagesView,
  requestJson,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
  uniqueName,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
} from '../helpers';

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

const isAssistantsChat = (response: Response) => {
  const { pathname } = new URL(response.url());
  return (
    response.request().method() === 'POST' &&
    pathname.startsWith('/api/assistants/chat') &&
    response.status() === 200
  );
};

const isAssistantsAbort = (response: Response) => {
  const { pathname } = new URL(response.url());
  return response.request().method() === 'POST' && pathname === '/api/assistants/abort';
};

async function selectAssistantsEndpoint(page: Page) {
  const trigger = page.getByRole('button', { name: 'Select a model' }).first();
  await trigger.click();
  await page.getByRole('option', { name: 'Assistants', exact: true }).click();
  const modelOption = page.getByRole('option', { name: ASSISTANTS_MODEL, exact: true });
  if (await modelOption.isVisible({ timeout: 1000 }).catch(() => false)) {
    await modelOption.click();
  }
  await expect(trigger).not.toHaveText('Select a model');
}

/** The Assistants endpoint needs an assistant on the account before a new
 *  conversation can send; the fake provider serves the CRUD behind it. */
async function ensureAssistant(page: Page) {
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: '/api/assistants/v1',
    token,
    method: 'POST',
    body: {
      model: ASSISTANTS_MODEL,
      name: `E2E pane settle ${uniqueName('assistant')}`,
      endpoint: 'assistants',
    },
  });
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

/** A second conversation with one completed turn, so a real sidebar row and a
 *  warm transcript exist to navigate to mid-run. Returns the row locator and
 *  the marker the row and transcript both carry. */
/** Sidebar rows show the conversation title, which truncates the first
 *  message far sooner than uniqueName's timestamp, so the destination's
 *  marker is short enough to survive inside it. */
const shortMarker = () => `dest-${Math.random().toString(36).slice(2, 8)}`;

async function seedDestinationChat(
  page: Page,
  label: string,
): Promise<{ row: Locator; marker: string }> {
  const marker = shortMarker();
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  expect(
    (await sendMessageAndWaitForCompletion(page, `Destination seed ${marker} ${label}`)).ok(),
  ).toBeTruthy();

  const row = page.getByTestId('convo-item').filter({ hasText: marker }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  return { row, marker };
}

/** Opens a new chat on the Assistants endpoint, ready for a slow run. */
async function openAssistantsNewChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await ensureAssistant(page);
  /** The assistant list query caches its (empty) first answer and does not
   *  refetch on mount, so an assistant created after the page loaded would
   *  leave `assistant_id` unset and the composer disabled. Reload once to
   *  mount the queries against the now-populated list. */
  await page.reload({ timeout: 10_000 });
  await selectAssistantsEndpoint(page);
}

test.describe('pane in-flight flags across a conversation switch', () => {
  test('the destination chat is idle for the whole abort window @scenario:pane-settle-navigate-away', async ({
    page,
  }) => {
    const label = uniqueName('navigate-away');
    const { row: destinationRow, marker } = await seedDestinationChat(page, label);
    await openAssistantsNewChat(page);
    await startSlowAssistantRun(page, label);

    let abortResponse: Response | undefined;
    const abortSettled = page
      .waitForResponse(isAssistantsAbort, { timeout: 20_000 })
      .then((response) => {
        abortResponse = response;
        return response;
      });

    await destinationRow.click();

    /** The switch settles the pane: the destination transcript must not show a
     *  stop button while the departing run's abort is still in flight. */
    await expect(stopButton(page)).toBeHidden({ timeout: 10_000 });
    expect(abortResponse, 'the pane settled before /abort did').toBeUndefined();

    const abort = await abortSettled;
    expect(abort.ok(), 'the departing run still aborts after the switch').toBeTruthy();

    /** The destination transcript is the seeded turn, not the departed run. */
    await expect(messagesView(page).getByText(marker)).toBeVisible();
  });

  test('a new chat opened mid-run is idle immediately @scenario:pane-settle-new-chat', async ({
    page,
  }) => {
    const label = uniqueName('new-chat');
    await openAssistantsNewChat(page);
    await startSlowAssistantRun(page, label);

    let abortResponse: Response | undefined;
    const abortSettled = page
      .waitForResponse(isAssistantsAbort, { timeout: 20_000 })
      .then((response) => {
        abortResponse = response;
        return response;
      });

    await page.getByRole('button', { name: 'New chat' }).first().click();

    await expect(page).toHaveURL(/\/c\/new$/, { timeout: 10_000 });
    await expect(stopButton(page)).toBeHidden({ timeout: 10_000 });
    expect(abortResponse, 'the pane settled before /abort did').toBeUndefined();

    expect((await abortSettled).ok()).toBeTruthy();
  });

  test('a send on the destination keeps its own streaming state when the stale abort settles @scenario:pane-settle-late-abort-resend', async ({
    page,
  }) => {
    const label = uniqueName('late-abort');
    const { row: destinationRow } = await seedDestinationChat(page, label);
    await openAssistantsNewChat(page);
    await startSlowAssistantRun(page, label);

    const abortSettled = page.waitForResponse(isAssistantsAbort, { timeout: 20_000 });

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

    expect((await abortSettled).ok()).toBeTruthy();

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
    const { row: destinationRow, marker } = await seedDestinationChat(page, label);

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

    await destinationRow.click();

    /** The resumable twin already settles its flags on detach; the destination
     *  stays idle and its transcript intact. */
    await expect(stopButton(page)).toBeHidden({ timeout: 10_000 });
    await expect(messagesView(page).getByText(marker)).toBeVisible();
  });
});
