/** Debounce edits and run only the latest pending validation after an in-flight check. */
export function createValidationQueue() {
  let running = false;
  let pending: { ready: boolean; run: () => Promise<void> } | undefined;
  const flush = () => {
    if (running || !pending?.ready) return;
    const next = pending;
    pending = undefined;
    running = true;
    void next.run().finally(() => {
      running = false;
      flush();
    });
  };
  return function schedule<T>(
    task: () => Promise<T>,
    success: (result: T) => void,
    failure: () => void,
    delay = 350,
  ) {
    let cancelled = false;
    const entry = {
      ready: false,
      run: async () => {
        if (cancelled) return;
        try {
          const result = await task();
          if (!cancelled) success(result);
        } catch {
          if (!cancelled) failure();
        }
      },
    };
    pending = entry;
    const timer = setTimeout(() => {
      entry.ready = true;
      flush();
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (pending === entry) pending = undefined;
    };
  };
}
