import { ApiError } from "./errors";
import type {
  DeadJobDto,
  DeadPageDto,
  QueueStatsDto,
  RequeueResultDto,
} from "./types";

export interface ClientConfig {
  /** Same-origin path such as "/api", or an absolute URL. Never contains credentials. */
  baseUrl: string;
  /** Held in memory only. Sent solely in the X-API-Key header. */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** Rejects URLs carrying credentials or a query/fragment; returns a normalised base. */
export function normaliseBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) throw new ApiError("validation", "API base URL is required");
  if (value.startsWith("/")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError("validation", "API base URL must be a path like /api or an http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiError("validation", "API base URL must use http or https");
  }
  if (url.username || url.password) {
    throw new ApiError("validation", "Do not put credentials in the URL; use the API key field");
  }
  if (url.search || url.hash) {
    throw new ApiError("validation", "API base URL must not have a query string or fragment");
  }
  return value;
}

export function isInsecureRemote(baseUrl: string): boolean {
  if (baseUrl.startsWith("/")) return false;
  try {
    const u = new URL(baseUrl);
    return u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseStats(v: unknown): QueueStatsDto {
  if (!isRecord(v) || typeof v.name !== "string") throw protocol("queue stats");
  const num = (k: string): number => {
    const x = v[k];
    if (typeof x !== "number") throw protocol(`queue stats field ${k}`);
    return x;
  };
  const age = v.oldest_pending_age_ms;
  if (age !== null && typeof age !== "number") throw protocol("queue stats field oldest_pending_age_ms");
  return {
    name: v.name,
    length: num("length"),
    pending: num("pending"),
    consumers: num("consumers"),
    delayed: num("delayed"),
    dead: num("dead"),
    oldest_pending_age_ms: age,
  };
}

function parseDead(v: unknown): DeadJobDto {
  if (!isRecord(v) || typeof v.entry_id !== "string") throw protocol("dead-letter entry");
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out as unknown as DeadJobDto;
}

const protocol = (what: string) => new ApiError("protocol", `Unexpected response shape (${what})`);

export class AdminClient {
  private readonly base: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ClientConfig) {
    this.base = normaliseBaseUrl(config.baseUrl);
    this.key = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? ((...a) => fetch(...a));
  }

  private async request(
    method: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { "X-API-Key": this.key, Accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
        signal,
      });
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        throw new ApiError("aborted", "Request cancelled");
      }
      throw new ApiError(
        "network",
        "Cannot reach the admin API. Check the URL, that the server is running, and that the " +
          "browser origin is allowed (the admin API sends no CORS headers; use a same-origin proxy).",
      );
    }
    if (res.ok) return res;
    let detail = "";
    try {
      const body: unknown = await res.json();
      if (isRecord(body) && typeof body.detail === "string") detail = body.detail;
      else if (isRecord(body) && Array.isArray(body.detail)) detail = "invalid request parameters";
    } catch {
      /* non-JSON error body */
    }
    switch (res.status) {
      case 401:
        throw new ApiError("auth", "Authentication failed: the API key is missing or invalid", 401);
      case 404:
        throw new ApiError("not_found", detail || "Not found", 404);
      case 422:
        throw new ApiError("validation", detail || "Request rejected as invalid", 422);
      default:
        throw new ApiError("server", `Server error (HTTP ${res.status})${detail ? `: ${detail}` : ""}`, res.status);
    }
  }

  private async json(path: string, signal?: AbortSignal): Promise<unknown> {
    const res = await this.request("GET", path, signal);
    try {
      return await res.json();
    } catch {
      throw protocol("not JSON");
    }
  }

  /** GET /queues */
  async listQueues(signal?: AbortSignal): Promise<QueueStatsDto[]> {
    const body = await this.json("/queues", signal);
    if (!isRecord(body) || !Array.isArray(body.queues)) throw protocol("queues");
    return body.queues.map(parseStats);
  }

  /** GET /queues/{name} */
  async getQueue(name: string, signal?: AbortSignal): Promise<QueueStatsDto> {
    return parseStats(await this.json(`/queues/${encodeURIComponent(name)}`, signal));
  }

  /** GET /queues/{name}/dead. Payloads are returned only when includePayload is true. */
  async listDead(
    name: string,
    opts: { limit?: number; cursor?: string | null; includePayload?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<DeadPageDto> {
    const q = new URLSearchParams();
    q.set("limit", String(opts.limit ?? 50));
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.includePayload) q.set("include_payload", "true");
    const body = await this.json(`/queues/${encodeURIComponent(name)}/dead?${q}`, signal);
    if (!isRecord(body) || !Array.isArray(body.items)) throw protocol("dead page");
    const next = body.next_cursor;
    if (next !== null && typeof next !== "string") throw protocol("next_cursor");
    return { items: body.items.map(parseDead), next_cursor: next };
  }

  /** POST /queues/{name}/dead/{id}/requeue -> {entry_id}. attempt resets to 1 server-side. */
  async requeueDead(name: string, entryId: string, signal?: AbortSignal): Promise<RequeueResultDto> {
    const res = await this.request(
      "POST",
      `/queues/${encodeURIComponent(name)}/dead/${encodeURIComponent(entryId)}/requeue`,
      signal,
    );
    const body: unknown = await res.json().catch(() => null);
    if (!isRecord(body) || typeof body.entry_id !== "string") throw protocol("requeue result");
    return { entry_id: body.entry_id };
  }

  /** DELETE /queues/{name}/dead/{id} -> 204. */
  async purgeDead(name: string, entryId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      "DELETE",
      `/queues/${encodeURIComponent(name)}/dead/${encodeURIComponent(entryId)}`,
      signal,
    );
  }
}
