export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("已停止", "AbortError");
}

/** Stop waiting immediately. The operation must separately cancel its native
 * work; attaching both handlers also consumes late failures after cancellation. */
export function abortable<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("已停止", "AbortError"));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    try {
      operation().then(
        (value) => {
          cleanup();
          if (signal?.aborted) abort();
          else resolve(value);
        },
        (error) => { cleanup(); reject(error); },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
