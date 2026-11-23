/** The provider took longer than the per-request time budget. Retriable: the next attempt may be faster. */
export class ProviderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`[polystella] the model did not answer within ${timeoutMs / 1000} s`);
    this.name = "ProviderTimeoutError";
  }
}

/**
 * Runs `request` with a signal that also aborts after `timeoutMs`, and stops waiting then even when the
 * request ignores its signal (the Workers AI binding takes none), so the upstream call may keep running.
 */
export async function withRequestTimeout<T>(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  request: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) return request(signal);
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let stopWaiting: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    stopWaiting = () => reject(combined.reason);
    combined.addEventListener("abort", stopWaiting, { once: true });
  });
  try {
    return await Promise.race([request(combined), aborted]);
  } catch (error) {
    if (timeout.aborted && signal?.aborted !== true) throw new ProviderTimeoutError(timeoutMs);
    throw error;
  } finally {
    if (stopWaiting !== undefined) combined.removeEventListener("abort", stopWaiting);
  }
}
