/** Shapes of the existing StreamWorker admin API (src/streamworker/admin.py). */

/** `QueueStats.to_dict()` plus `name`. Counts describe the *current* state only. */
export interface QueueStatsDto {
  name: string;
  /** XLEN of the stream: ready + pending jobs (acked jobs are deleted). */
  length: number;
  /** Delivered to a consumer, not yet acknowledged. */
  pending: number;
  consumers: number;
  /** Jobs waiting in the delayed sorted set (retries and delayed enqueues). */
  delayed: number;
  dead: number;
  /** Age of the oldest unacknowledged entry, or null when nothing is pending. */
  oldest_pending_age_ms: number | null;
}

/** A dead-letter entry. All values are strings on the wire; `payload` only with include_payload. */
export interface DeadJobDto {
  entry_id: string;
  id?: string;
  task?: string;
  payload?: string;
  attempt?: string;
  max_attempts?: string;
  enqueued_at?: string;
  idempotency_key?: string;
  error_type?: string;
  error_message?: string;
  failed_at?: string;
}

export interface DeadPageDto {
  items: DeadJobDto[];
  /** Pass back as `cursor`; null when the page was not full (no more entries). */
  next_cursor: string | null;
}

export interface RequeueResultDto {
  /** New stream entry id of the requeued job (attempt reset to 1). */
  entry_id: string;
}
