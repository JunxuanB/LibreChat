import { createElement } from 'react';
import { createStore, Provider } from 'jotai';
import { RecoilRoot, useRecoilCallback } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EventSubmission, TSubmission, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useEventHandlers from '../useEventHandlers';
import store from '~/store';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, getConversationById: jest.fn() } };
});
jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: 'saved' }),
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: '/c/saved' }),
}));
/** Real atoms behind the names the hook reads, so the submission fence in
 *  `settlePane` evaluates against actual pane state instead of a stub. */
jest.mock('~/store', () => {
  const { atom, atomFamily } = jest.requireActual('recoil');
  return {
    __esModule: true,
    default: {
      abortScroll: atom({ key: 'settle-spec-abort-scroll', default: false }),
      submissionStartFamily: atomFamily({ key: 'settle-spec-start', default: null }),
      submissionByIndex: atomFamily({
        key: 'settle-spec-submission',
        default: null,
      }),
    },
  };
});
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({}) }));
jest.mock('~/Providers', () => ({ useLiveAnnouncer: () => ({ announcePolite: jest.fn() }) }));
jest.mock('~/hooks/Agents', () => ({ useApplyAgentTemplate: () => jest.fn() }));
jest.mock('~/hooks/Chat/useFocusRegeneratedResponse', () => () => jest.fn());
jest.mock('../useContentHandler', () => () => ({
  contentHandler: jest.fn(),
  resetContentHandler: jest.fn(),
}));
jest.mock('../useAttachmentHandler', () => () => jest.fn());
jest.mock('../useStepHandler', () => () => ({
  stepHandler: jest.fn(),
  clearStepMaps: jest.fn(),
  resetSubagentAtoms: jest.fn(),
  resetPtcAtoms: jest.fn(),
  prunePtcTraces: jest.fn(),
  syncStepMessage: jest.fn(),
  cancelPendingDeltaFlush: jest.fn(),
  flushPendingDeltas: jest.fn(),
}));
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider/CodeEnvironments'),
  startupConfigKey: ['startup'],
  queueTitleGeneration: jest.fn(),
  markTitleGenerationProcessed: jest.fn(),
}));
jest.mock('~/utils', () => ({
  logger: { log: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
  setDraft: jest.fn(),
  scrollToEnd: jest.fn(),
  getConversationDraftId: jest.fn(),
  hasRealTitle: () => false,
  withoutListFlags: (value: unknown) => value,
  setDocumentTitle: jest.fn(),
  requestChatFocus: jest.fn(),
  getAllContentText: () => '',
  upsertConvoInAllQueries: jest.fn(),
  updateConvoInAllQueries: jest.fn(),
  removeConvoFromAllQueries: jest.fn(),
  findConversationInInfinite: () => undefined,
  preserveStreamedContentIdentity: (_old: unknown, current: unknown) => current,
  isEmptyContentPart: () => false,
  getPartKeyIndex: jest.fn(),
  CONVERSATION_LIST_KEYS: [],
}));

const user = {
  conversationId: 'saved',
  messageId: 'user',
  parentMessageId: 'root',
  text: 'run',
  isCreatedByUser: true,
} as TMessage;
const response = {
  conversationId: 'saved',
  messageId: 'response',
  parentMessageId: 'user',
  text: 'partial',
  content: [],
  isCreatedByUser: false,
} as TMessage;
const submission = {
  isTemporary: false,
  endpointOption: { endpoint: EModelEndpoint.agents },
  conversation: { conversationId: 'saved', endpoint: EModelEndpoint.agents },
  userMessage: user,
  initialResponse: response,
  messages: [],
} as EventSubmission;

/** The pane's flags must come down when the abort settlement lands for the
 *  submission that still owns the pane, and must NOT come down for one the
 *  pane has already replaced: navigation frees the pane before `/abort`
 *  resolves, so a re-send on the destination owns `isSubmitting` by then. */
describe('post-abort settlement fences on the pane submission', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  async function renderSettleHarness() {
    const jotaiStore = createStore();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        RecoilRoot,
        null,
        createElement(
          Provider,
          { store: jotaiStore },
          createElement(QueryClientProvider, { client: queryClient }, children),
        ),
      );
    const setIsSubmitting = jest.fn();
    const setShowStopButton = jest.fn();
    const setMessages = jest.fn();
    const setConversation = jest.fn();
    const { result } = renderHook(
      () => ({
        handlers: useEventHandlers({
          getMessages: () => [user, response],
          setMessages,
          setCompleted: jest.fn(),
          setConversation,
          setIsSubmitting,
          setShowStopButton,
          newConversation: jest.fn(),
        }),
        setPaneSubmission: useRecoilCallback(
          ({ set }) =>
            (value: TSubmission | null) =>
              set(store.submissionByIndex(0), value),
          [],
        ),
      }),
      { wrapper },
    );
    return {
      setIsSubmitting,
      setShowStopButton,
      setMessages,
      setConversation,
      setPaneSubmission: (value: TSubmission | null) => {
        act(() => result.current.setPaneSubmission(value));
      },
      abort: () =>
        act(async () => {
          await result.current.handlers.abortConversation('saved', submission, [user, response]);
        }),
      finalFromLiveStream: (liveSubmission: typeof submission) =>
        act(async () => {
          result.current.handlers.finalHandler(
            {
              conversation: { conversationId: 'saved' },
              requestMessage: user,
              responseMessage: response,
            },
            liveSubmission,
          );
        }),
      finalFromAbort: (aborted: typeof submission) =>
        act(async () => {
          result.current.handlers.finalHandler(
            {
              conversation: { conversationId: 'saved' },
              requestMessage: user,
              responseMessage: response,
            },
            aborted,
            { fromAbort: true },
          );
        }),
    };
  }

  it('settles while the pane still holds the aborting submission', async () => {
    const harness = await renderSettleHarness();
    harness.setPaneSubmission(submission);

    await harness.abort();

    expect(harness.setIsSubmitting).toHaveBeenCalledWith(false);
    expect(harness.setShowStopButton).toHaveBeenCalledWith(false);
  });

  it('settles after the pane submission was cleared, matching the stop contract', async () => {
    const harness = await renderSettleHarness();
    harness.setPaneSubmission(null);

    await harness.abort();

    expect(harness.setIsSubmitting).toHaveBeenCalledWith(false);
    expect(harness.setShowStopButton).toHaveBeenCalledWith(false);
  });

  it('does not clear the flags of a newer submission that replaced the aborted one', async () => {
    const harness = await renderSettleHarness();
    const replacement = { ...submission, userMessage: { ...user, messageId: 'user-2' } };
    harness.setPaneSubmission(replacement);

    await harness.abort();

    expect(harness.setIsSubmitting).not.toHaveBeenCalledWith(false);
    expect(harness.setShowStopButton).not.toHaveBeenCalledWith(false);
  });

  it('settles after the pane submission became the empty sentinel', async () => {
    const harness = await renderSettleHarness();
    /** What useNewConvo writes on a same-scope new chat: `{}`, which useSSE
     *  already treats as no active submission. Reading it as a replacement
     *  would strand the flags after the abort. */
    harness.setPaneSubmission({} as TSubmission);

    await harness.abort();

    expect(harness.setIsSubmitting).toHaveBeenCalledWith(false);
    expect(harness.setShowStopButton).toHaveBeenCalledWith(false);
  });

  it('settles a live final unconditionally, even for a rebuilt submission object', async () => {
    const harness = await renderSettleHarness();
    /** What useResumableSSE does after `created`: a spread clone of the pane's
     *  submission with replaced message rows, never written back to the atom.
     *  A live terminal for it must still settle the flags. */
    const rebuilt = {
      ...submission,
      userMessage: { ...user, messageId: 'user-server' },
    } as typeof submission;
    harness.setPaneSubmission(submission);

    await harness.finalFromLiveStream(rebuilt);

    expect(harness.setIsSubmitting).toHaveBeenCalledWith(false);
    expect(harness.setShowStopButton).toHaveBeenCalledWith(false);
  });

  it('writes only the departing cache for a stale abort final over a re-sent pane', async () => {
    const harness = await renderSettleHarness();
    /** The user navigated away and sent again: the pane's newer submission owns
     *  the live conversation, so the departed run's abort final must not
     *  replace the pane's messages or conversation state. */
    const replacement = { ...submission, userMessage: { ...user, messageId: 'user-2' } };
    harness.setPaneSubmission(replacement);

    await harness.finalFromAbort(submission);

    expect(harness.setMessages).not.toHaveBeenCalled();
    expect(harness.setConversation).not.toHaveBeenCalled();
    expect(harness.setIsSubmitting).not.toHaveBeenCalledWith(false);
  });
});
