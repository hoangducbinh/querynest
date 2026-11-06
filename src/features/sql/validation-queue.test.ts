import { afterEach, expect, it, vi } from "vitest";
import { createValidationQueue } from "./validation-queue";
afterEach(() => vi.useRealTimers());
it("debounces rapid edits and delivers only the latest result", async () => {
  vi.useFakeTimers();
  const schedule = createValidationQueue();
  const old = vi.fn(async () => "old");
  const latest = vi.fn(async () => "latest");
  const result = vi.fn();
  const cancel = schedule(old, result, vi.fn());
  await vi.advanceTimersByTimeAsync(100);
  cancel();
  schedule(latest, result, vi.fn());
  await vi.advanceTimersByTimeAsync(349);
  expect(latest).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(old).not.toHaveBeenCalled();
  expect(result).toHaveBeenCalledExactlyOnceWith("latest");
});
it("starts the latest ready check immediately after a slow request and discards stale results", async () => {
  vi.useFakeTimers();
  const schedule = createValidationQueue();
  let resolve!: (value: string) => void;
  const result = vi.fn();
  const cancel = schedule(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
    result,
    vi.fn(),
  );
  await vi.advanceTimersByTimeAsync(350);
  cancel();
  const latest = vi.fn(async () => "new");
  schedule(latest, result, vi.fn());
  await vi.advanceTimersByTimeAsync(350);
  expect(latest).not.toHaveBeenCalled();
  resolve("stale");
  await vi.advanceTimersByTimeAsync(0);
  expect(latest).toHaveBeenCalledOnce();
  expect(result).toHaveBeenCalledExactlyOnceWith("new");
});
it("recovers after failure and never publishes results after cancellation", async () => {
  vi.useFakeTimers();
  const schedule = createValidationQueue();
  const failure = vi.fn(),
    result = vi.fn();
  schedule(
    async () => {
      throw Error("offline");
    },
    result,
    failure,
  );
  await vi.advanceTimersByTimeAsync(350);
  expect(failure).toHaveBeenCalledOnce();
  const cancel = schedule(async () => "unused", result, failure);
  cancel();
  await vi.advanceTimersByTimeAsync(350);
  expect(result).not.toHaveBeenCalled();
  schedule(async () => "reconnected", result, failure);
  await vi.advanceTimersByTimeAsync(350);
  expect(result).toHaveBeenCalledExactlyOnceWith("reconnected");
});
