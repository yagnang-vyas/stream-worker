import { nextRandom } from "./rng";

/** Mirrors streamworker.backoff.ExponentialBackoff (seconds). */
export type Jitter = "full" | "equal" | "none";

export interface BackoffConfig {
  base: number;
  cap: number;
  jitter: Jitter;
}

const MAX_EXPONENT = 62;

export function validateBackoff(c: BackoffConfig): string[] {
  const errors: string[] = [];
  if (!(c.base > 0)) errors.push("base delay must be positive");
  if (!(c.cap > 0)) errors.push("maximum delay must be positive");
  if (!["full", "equal", "none"].includes(c.jitter)) errors.push(`unknown jitter mode "${c.jitter}"`);
  return errors;
}

/** `min(cap, base * 2 ** (attempt - 1))` — the un-jittered delay after the given failed attempt. */
export function ceiling(c: Pick<BackoffConfig, "base" | "cap">, attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, MAX_EXPONENT);
  return Math.min(c.cap, c.base * 2 ** exponent);
}

/** Bounds of the jittered delay for an attempt, per the Python implementation. */
export function bounds(c: BackoffConfig, attempt: number): { min: number; max: number } {
  const max = ceiling(c, attempt);
  if (c.jitter === "full") return { min: 0, max };
  if (c.jitter === "equal") return { min: max / 2, max };
  return { min: max, max };
}

/** Maps a uniform sample u in [0,1) onto the jitter range (Python: rng.uniform). */
export function delayFor(c: BackoffConfig, attempt: number, u: number): number {
  const { min, max } = bounds(c, attempt);
  return min + u * (max - min);
}

export interface RetryRow {
  /** The failed attempt this delay follows (1-based). */
  attempt: number;
  ceiling: number;
  min: number;
  max: number;
  /** Simulated sample (labelled as such in the UI). */
  delay: number;
  nextAttempt: number;
}

/**
 * Retry schedule for a job that fails every attempt: a delay follows each failed attempt
 * except the last, which is dead-lettered. Samples are simulated from a seeded PRNG.
 */
export function retrySchedule(c: BackoffConfig, maxAttempts: number, seed: number): RetryRow[] {
  let state = seed >>> 0;
  const rows: RetryRow[] = [];
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    const r = nextRandom(state);
    state = r.state;
    const b = bounds(c, attempt);
    rows.push({
      attempt,
      ceiling: b.max,
      min: b.min,
      max: b.max,
      delay: delayFor(c, attempt, r.value),
      nextAttempt: attempt + 1,
    });
  }
  return rows;
}
