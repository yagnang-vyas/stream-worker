import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { ConnectionProvider } from "@/lib/connection";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

type Handler = (call: Call) => Response | Promise<Response>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fetch double that records calls and answers from `handler`. */
export function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const QUEUES = [
  { name: "emails", length: 12, pending: 3, consumers: 2, delayed: 4, dead: 2, oldest_pending_age_ms: 5400 },
  { name: "orders", length: 0, pending: 0, consumers: 1, delayed: 0, dead: 0, oldest_pending_age_ms: null },
];

export const DEAD = (n: number, withPayload = false) =>
  Array.from({ length: n }, (_, i) => ({
    entry_id: `${1700000000000 + i}-0`,
    id: `job-${i}`,
    task: "send_email",
    attempt: "5",
    max_attempts: "5",
    enqueued_at: "1700000000000",
    error_type: "SmtpError",
    error_message: "boom ".repeat(60),
    failed_at: "1700000005000",
    ...(withPayload ? { payload: '{"to":"secret@example.com"}' } : {}),
  }));

export function renderApp(ui: ReactElement, fetchImpl: typeof fetch, route = "/") {
  return render(
    <ConnectionProvider fetchImpl={fetchImpl}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </ConnectionProvider>,
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { useConnection } from "@/lib/connection";

function Connect({ children, apiKey }: { children: ReactNode; apiKey: string }) {
  const { connect, status } = useConnection();
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!started) {
      setStarted(true);
      void connect("/api", apiKey);
    }
  }, [started, connect, apiKey]);
  return status === "connected" ? <>{children}</> : <p>connecting for test…</p>;
}

/** Renders `ui` after connecting through the real provider (probe call included). */
export function renderConnected(ui: ReactElement, fetchImpl: typeof fetch, route = "/", apiKey = "test-key") {
  return renderApp(<Connect apiKey={apiKey}>{ui}</Connect>, fetchImpl, route);
}
