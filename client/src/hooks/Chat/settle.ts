import { useRecoilCallback } from 'recoil';
import store from '~/store';

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
 * Only a real switch settles. Re-entering the same conversation keeps the stop
 * contract, where the flags come down when the abort response lands.
 */
export function useSettlePaneSubmission(index: string | number) {
  return useRecoilCallback(
    ({ snapshot, set }) =>
      (destinationId: string) => {
        const departingId = snapshot
          .getLoadable(store.conversationByIndex(index))
          .valueMaybe()?.conversationId;
        if (departingId == null || departingId === destinationId) {
          return;
        }
        set(store.isSubmittingFamily(index), false);
        set(store.showStopButtonByIndex(index), false);
      },
    [index],
  );
}
