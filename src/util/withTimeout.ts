/**
 * Time-box a promise. On timeout the underlying promise is abandoned, not
 * cancelled (Baileys' downloadMediaMessage takes no AbortSignal) — the caller's
 * slot frees while the orphan settles in the background; its rejection is
 * swallowed so it can't become an unhandled rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      promise.catch(() => undefined);
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
