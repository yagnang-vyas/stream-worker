import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./errors";

export interface Remote<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  lastSuccess: Date | null;
  refresh: () => void;
}

/**
 * Runs `load` on mount, on `refresh()` and (optionally) every `pollMs`.
 * Each run aborts the previous one; an unmount aborts the in-flight request.
 * `load` must be stable (wrap in useCallback) or the effect re-runs.
 */
export function useRemote<T>(
  load: ((signal: AbortSignal) => Promise<T>) | null,
  pollMs: number | null = null,
): Remote<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastSuccess, setLast] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const inflight = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    if (!load) return;
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    setLoading(true);
    load(ctl.signal).then(
      (d) => {
        if (ctl.signal.aborted) return;
        setData(d);
        setError(null);
        setLast(new Date());
        setLoading(false);
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        setError(e instanceof ApiError ? e : new ApiError("server", "Unexpected error"));
        setLoading(false);
      },
    );
  }, [load]);

  useEffect(() => {
    run();
    return () => inflight.current?.abort();
  }, [run, tick]);

  useEffect(() => {
    if (!pollMs || !load) return;
    const id = setInterval(run, pollMs);
    return () => clearInterval(id);
  }, [pollMs, run, load]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, lastSuccess, refresh };
}
