/** Illustrative model of N workers sharing one queue. Not a benchmark. */
export interface ConcJob {
  id: string;
  durationMs: number;
  /** Fails its first attempt and succeeds on the second, re-entering behind newer jobs. */
  failsOnce?: boolean;
}

export interface Segment {
  worker: number; // 0-based
  jobId: string;
  attempt: number;
  start: number;
  end: number;
  ok: boolean;
}

export interface ConcResult {
  segments: Segment[];
  /** Job ids in order of successful completion. */
  completionOrder: string[];
  makespanMs: number;
}

export function simulateConcurrency(jobs: ConcJob[], workers: number, retryDelayMs: number): ConcResult {
  const segments: Segment[] = [];
  const completionOrder: string[] = [];
  const ready: { job: ConcJob; attempt: number }[] = jobs.map((job) => ({ job, attempt: 1 }));
  const delayed: { job: ConcJob; attempt: number; due: number }[] = [];
  const freeAt = Array.from({ length: Math.max(1, workers) }, () => 0);
  const running: { worker: number; end: number; job: ConcJob; attempt: number }[] = [];
  let now = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    // finish jobs that ended by `now`
    for (const r of running.filter((x) => x.end <= now).sort((a, b) => a.end - b.end)) {
      running.splice(running.indexOf(r), 1);
      const fails = r.job.failsOnce && r.attempt === 1;
      segments.push({ worker: r.worker, jobId: r.job.id, attempt: r.attempt, start: r.end - r.job.durationMs, end: r.end, ok: !fails });
      if (fails) delayed.push({ job: r.job, attempt: 2, due: r.end + retryDelayMs });
      else completionOrder.push(r.job.id);
    }
    for (const d of delayed.filter((x) => x.due <= now).sort((a, b) => a.due - b.due)) {
      delayed.splice(delayed.indexOf(d), 1);
      ready.push({ job: d.job, attempt: d.attempt }); // behind everything already ready
    }
    for (let w = 0; w < freeAt.length && ready.length; w++) {
      if (freeAt[w] <= now && !running.some((r) => r.worker === w)) {
        const next = ready.shift()!;
        const end = now + next.job.durationMs;
        freeAt[w] = end;
        running.push({ worker: w, end, job: next.job, attempt: next.attempt });
      }
    }
    if (!running.length && !ready.length && !delayed.length) break;
    const upcoming = [...running.map((r) => r.end), ...delayed.map((d) => d.due)].filter((t) => t > now);
    if (!upcoming.length) break;
    now = Math.min(...upcoming);
  }
  return { segments, completionOrder, makespanMs: segments.reduce((m, s) => Math.max(m, s.end), 0) };
}
