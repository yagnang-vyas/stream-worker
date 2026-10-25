import { Link } from "react-router-dom";
import type { ApiError } from "@/lib/errors";
import { Banner, Button } from "./ui";

export function ErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const title =
    error.kind === "auth"
      ? "Authentication failed"
      : error.kind === "network"
        ? "Admin API unreachable"
        : "Request failed";
  return (
    <Banner tone="error" title={title}>
      <p>{error.message}</p>
      <div className="flex gap-2 pt-1">
        {onRetry && (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
        {error.kind === "auth" && (
          <Link className="text-accent underline" to="/connection">
            Re-enter API key
          </Link>
        )}
      </div>
    </Banner>
  );
}
