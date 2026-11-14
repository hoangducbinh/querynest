import { useCallback, useEffect, useState } from "react";

export interface QueryTiming {
  startedAt: number;
  finishedAt?: number;
}
export function useQueryTimings() {
  const [timings, setTimings] = useState<Record<string, QueryTiming>>({});
  const start = useCallback((tabId: string) => {
    const startedAt = performance.now();
    setTimings((previous) => ({ ...previous, [tabId]: { startedAt } }));
  }, []);
  const finish = useCallback((tabId: string) => {
    const finishedAt = performance.now();
    setTimings((previous) => {
      const timing = previous[tabId];
      return !timing || timing.finishedAt !== undefined
        ? previous
        : { ...previous, [tabId]: { ...timing, finishedAt } };
    });
  }, []);
  const runningTabId = Object.keys(timings).find(
    (tabId) => timings[tabId].finishedAt === undefined,
  );
  return { timings, start, finish, runningTabId };
}

/** Keep timer ticks inside this small component, without repainting the workspace. */
export function QueryTimer({ timing }: { timing?: QueryTiming }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!timing || timing.finishedAt !== undefined) return;
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [timing]);
  const elapsed = timing
    ? Math.max(0, (timing.finishedAt ?? now) - timing.startedAt)
    : 0;
  const seconds = Math.floor(elapsed / 1000);
  const clock = [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return (
    <span
      className="sql-query-timer"
      role="timer"
      aria-label="Query execution time"
      title={
        timing
          ? timing.finishedAt === undefined
            ? "Elapsed time · query running"
            : `Last query · ${clock}`
          : "Query execution time"
      }
    >
      <span>{clock}</span>
    </span>
  );
}
