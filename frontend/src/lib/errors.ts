export type ApiErrorKind =
  | "auth" // 401
  | "not_found" // 404
  | "validation" // 422
  | "server" // 5xx / other
  | "network" // fetch failed (offline, CORS, DNS)
  | "protocol" // unexpected response shape
  | "aborted";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : "Unexpected error";
}
