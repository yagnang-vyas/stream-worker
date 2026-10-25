import { Link } from "react-router-dom";
import { useConnection } from "@/lib/connection";
import type { AdminClient } from "@/lib/client";
import { Card, EmptyState } from "./ui";
import type { ReactNode } from "react";

/** Renders children with a live client, or an honest disconnected state. */
export function RequireConnection({ children }: { children: (client: AdminClient) => ReactNode }) {
  const { client, status } = useConnection();
  if (!client) {
    return (
      <Card>
        <EmptyState title={status === "connecting" ? "Connecting…" : "Not connected to an admin API"}>
          <p>
            No live operational data is shown until you connect.{" "}
            <Link className="text-accent underline" to="/connection">
              Open System Connection
            </Link>{" "}
            or try the{" "}
            <Link className="text-accent underline" to="/playground">
              Playground
            </Link>
            , which needs no server.
          </p>
        </EmptyState>
      </Card>
    );
  }
  return <>{children(client)}</>;
}
