import { AsyncLocalStorage } from 'node:async_hooks';

interface MCPRequestScope {
  signal: AbortSignal;
  failure?: Promise<never>;
}
const requestScopes = new AsyncLocalStorage<MCPRequestScope>();

/** SDK options.signal is not forwarded into transport.send. This signal fences only pre-dispatch work. */
export function getMCPDispatchSignal(): AbortSignal | undefined {
  return requestScopes.getStore()?.signal;
}

/** A known denial must settle admission before a competing SDK deadline can reach its caller. */
export function holdMCPRequestFailure(failure: Promise<never>): void {
  const scope = requestScopes.getStore();
  if (scope) scope.failure ??= failure;
  void failure.catch(() => undefined);
}

/** Autonomous SDK notifications/stream recovery do not inherit a finished caller's cutoff. */
export function outsideMCPRequestScope<T>(operation: () => T): T {
  return requestScopes.exit(operation);
}

/** The MCP SDK retains its abort listener after a response; never give it a long-lived run signal. */
export async function withMCPRequestSignal<T>(
  parent: AbortSignal | undefined,
  request: (signal: AbortSignal | undefined) => Promise<T>,
  bindTransport = false,
): Promise<T> {
  if (!parent && !bindTransport) return request(undefined);
  parent?.throwIfAborted();
  const controller = parent ? new AbortController() : undefined;
  const onAbort = () => controller?.abort(parent?.reason);
  parent?.addEventListener('abort', onAbort, { once: true });
  try {
    if (parent?.aborted) {
      onAbort();
      parent.throwIfAborted();
    }
    if (!bindTransport) return await request(controller?.signal);
    const dispatch = new AbortController();
    const scope: MCPRequestScope = {
      signal: controller ? AbortSignal.any([controller.signal, dispatch.signal]) : dispatch.signal,
    };
    return await requestScopes.run(scope, async () => {
      try {
        const result = await request(controller?.signal);
        if (scope.failure) return await scope.failure;
        return result;
      } catch (error) {
        // Close undispatched work when the SDK times out; already-observed admission is independent.
        dispatch.abort();
        if (scope.failure) return await scope.failure;
        throw error;
      } finally {
        dispatch.abort();
      }
    });
  } finally {
    parent?.removeEventListener('abort', onAbort);
  }
}
