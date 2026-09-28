import { useRecoilCallback } from 'recoil';
import store from '~/store';

export type PaneDestination = {
  conversationId: string;
  chatProjectId?: string | null;
};

/**
 * Settles a pane's in-flight flags when navigation switches that pane to a
 * different conversation.
 *
 * Classic-SSE teardown (Assistants endpoints) keeps `isSubmitting` and
 * `showStopButton` raised until the asynchronous `/abort` request settles, so
 * without this the destination conversation inherits a turn that is not
 * running there: the stop button shows, and every `isSubmitting` consumer
 * reports the unrelated transcript as live. The resumable twin settles the
 * same flags in its own effect cleanup; this is the equivalent for the
 * navigation seams that tear a classic submission down.
 *
 * Call this at the moment the switch commits, not when the navigation starts:
 * a first visit whose record is still fetching keeps the departing composer
 * on screen, and settling early would unblock submits into the departing
 * conversation for the whole fetch window.
 *
 * Only a real switch settles. Re-entering the same scope keeps the stop
 * contract, where the flags come down when the abort response lands; two
 * `new` drafts are the same scope only when their project scope matches.
 */
export function useSettlePaneSubmission(index: string | number) {
  return useRecoilCallback(
    ({ snapshot, set }) =>
      (destination: PaneDestination) => {
        const departing = snapshot.getLoadable(store.conversationByIndex(index)).valueMaybe();
        const departingId = departing?.conversationId;
        if (departingId == null) {
          return;
        }
        if (
          departingId === destination.conversationId &&
          (departing?.chatProjectId ?? null) === (destination.chatProjectId ?? null)
        ) {
          return;
        }
        set(store.isSubmittingFamily(index), false);
        set(store.showStopButtonByIndex(index), false);
      },
    [index],
  );
}
