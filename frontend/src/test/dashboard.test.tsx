import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Connection } from "@/pages/Connection";
import { DeadLetter } from "@/pages/DeadLetter";
import { Overview } from "@/pages/Overview";
import { Queues } from "@/pages/Queues";
import { DEAD, json, mockFetch, QUEUES, renderApp, renderConnected } from "./helpers";

describe("disconnected state", () => {
  it("shows no operational data and makes no requests", () => {
    const m = mockFetch(() => json({}));
    renderApp(<Overview />, m.fetch);
    expect(screen.getByText(/Not connected to an admin API/)).toBeInTheDocument();
    expect(screen.queryByText("emails")).not.toBeInTheDocument();
    expect(m.calls).toHaveLength(0);
  });
});

describe("connection", () => {
  it("authenticates with X-API-Key, then forgets the key on sign-out", async () => {
    const m = mockFetch(() => json({ queues: QUEUES }));
    renderApp(<Connection />, m.fetch);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/API key/), "hunter2");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getAllByText("Connected").length).toBeGreaterThan(0));
    expect(m.calls[0].headers["X-API-Key"]).toBe("hunter2");
    expect(m.calls[0].url).not.toContain("hunter2");
    expect(screen.getByLabelText(/API key/)).toHaveValue(""); // form copy dropped
    expect(JSON.stringify({ ...localStorage })).not.toContain("hunter2");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("hunter2");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
  });

  it("reports an authentication failure clearly", async () => {
    const m = mockFetch(() => json({ detail: "invalid or missing API key" }, 401));
    renderApp(<Connection />, m.fetch);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/API key/), "wrong");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Authentication failed: the API key is missing or invalid/)).toBeInTheDocument();
    expect(screen.queryByText("wrong")).not.toBeInTheDocument();
  });

  it("reports an unreachable server", async () => {
    const m = mockFetch(() => { throw new TypeError("Failed to fetch"); });
    renderApp(<Connection />, m.fetch);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/API key/), "k");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Cannot reach the admin API/)).toBeInTheDocument();
  });

  it("rejects a base URL that carries credentials", async () => {
    const m = mockFetch(() => json({ queues: [] }));
    renderApp(<Connection />, m.fetch);
    const user = userEvent.setup();
    const url = screen.getByLabelText(/API base URL/);
    await user.clear(url);
    await user.type(url, "https://admin:pw@host/api");
    await user.type(screen.getByLabelText(/API key/), "k");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Do not put credentials in the URL/)).toBeInTheDocument();
    expect(m.calls).toHaveLength(0);
  });
});

describe("overview and queues", () => {
  it("shows the real statistics fields and the limitation notice", async () => {
    const m = mockFetch(() => json({ queues: QUEUES }));
    renderConnected(<Overview />, m.fetch);
    const table = await screen.findByRole("table", { name: /Queue statistics/ });
    const emails = within(table).getByRole("row", { name: /emails/ });
    expect(within(emails).getByText("12")).toBeInTheDocument();
    expect(within(emails).getByText("5.4 s")).toBeInTheDocument();
    const orders = within(table).getByRole("row", { name: /orders/ });
    expect(within(orders).getByText("—")).toBeInTheDocument(); // null age
    expect(screen.getByText(/not a job ledger/)).toBeInTheDocument();
    expect(screen.getByText(/Last successful refresh/)).toBeInTheDocument();
    expect(screen.queryByText(/throughput|success rate/i, { selector: "p.font-mono" })).not.toBeInTheDocument();
  });

  it("shows a loading state, then an error with retry, then recovers", async () => {
    let fail = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const m = mockFetch(async () => {
      if (first) { first = false; return json({ queues: QUEUES }); } // connection probe
      await gate;
      return fail ? json({ detail: "x" }, 500) : json({ queues: QUEUES });
    });
    renderConnected(<Queues />, m.fetch);
    expect(await screen.findByRole("status")).toHaveTextContent(/Loading/);
    fail = true;
    await act(async () => { release(); });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Server error \(HTTP 500\)/);
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("surfaces an authentication failure after connecting", async () => {
    let n = 0;
    const m = mockFetch(() => (n++ === 0 ? json({ queues: QUEUES }) : json({ detail: "no" }, 401)));
    renderConnected(<Overview />, m.fetch);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Authentication failed/);
  });

  it("renders an empty state when no queues are registered", async () => {
    const m = mockFetch(() => json({ queues: [] }));
    renderConnected(<Queues />, m.fetch);
    expect(await screen.findByText(/No queues are registered/)).toBeInTheDocument();
  });
});

function deadFetch(opts: { pages?: number; onWrite?: (method: string, url: string) => Response } = {}) {
  const pages = opts.pages ?? 2;
  return mockFetch((c) => {
    if (c.url === "/api/queues") return json({ queues: QUEUES });
    if (c.method !== "GET") return opts.onWrite?.(c.method, c.url) ?? new Response(null, { status: 204 });
    const u = new URL(c.url, "http://x");
    const cursor = u.searchParams.get("cursor");
    const withPayload = u.searchParams.get("include_payload") === "true";
    const page = cursor === null ? 0 : 1;
    const items = DEAD(2, withPayload).map((e) => ({ ...e, entry_id: `${1700000000000 + page * 10 + Number(e.entry_id.split("-")[0]) - 1700000000000}-0`, id: `job-p${page}-${e.id}` }));
    return json({ items, next_cursor: page + 1 < pages ? items[items.length - 1].entry_id : null });
  });
}

describe("dead-letter queue", () => {
  it("paginates with the server-provided cursor and goes back", async () => {
    const m = deadFetch();
    renderConnected(<DeadLetter />, m.fetch, "/dead/emails");
    expect(await screen.findByText("job-p0-job-0")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("job-p1-job-0")).toBeInTheDocument();
    const deadCalls = m.calls.filter((c) => c.url.includes("/dead?"));
    expect(deadCalls[0].url).toBe("/api/queues/emails/dead?limit=50");
    expect(deadCalls[1].url).toMatch(/cursor=1700000000001-0/);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled(); // next_cursor null
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("job-p0-job-0")).toBeInTheDocument();
  });

  it("shows metadata, truncates error messages, and hides payloads by default", async () => {
    const m = deadFetch();
    renderConnected(<DeadLetter />, m.fetch, "/dead/emails");
    await screen.findByText("job-p0-job-0");
    expect(screen.getAllByText("SmtpError").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/…$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/secret@example.com/)).not.toBeInTheDocument();
    expect(m.calls.some((c) => c.url.includes("include_payload"))).toBe(false);
  });

  it("reveals a single payload only on explicit request, and can hide it again", async () => {
    const m = deadFetch();
    renderConnected(<DeadLetter />, m.fetch, "/dead/emails");
    await screen.findByText("job-p0-job-0");
    await userEvent.click(screen.getAllByRole("button", { name: /Reveal payload/ })[0]);
    expect(await screen.findByLabelText(/Payload of 1700000000000-0/)).toHaveTextContent("secret@example.com");
    expect(screen.getAllByLabelText(/Payload of/)).toHaveLength(1); // other rows stay hidden
    expect(m.calls.filter((c) => c.url.includes("include_payload=true"))).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /Hide payload/ }));
    expect(screen.queryByText(/secret@example.com/)).not.toBeInTheDocument();
  });

  it("clears revealed payloads when paging", async () => {
    const m = deadFetch();
    renderConnected(<DeadLetter />, m.fetch, "/dead/emails");
    await screen.findByText("job-p0-job-0");
    await userEvent.click(screen.getAllByRole("button", { name: /Reveal payload/ })[0]);
    await screen.findByLabelText(/Payload of/);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("job-p1-job-0");
    expect(screen.queryByText(/secret@example.com/)).not.toBeInTheDocument();
  });

  it("requeue explains the consequences, needs confirmation, and submits once", async () => {
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const m = mockFetch(async (c) => {
      if (c.url === "/api/queues") return json({ queues: QUEUES });
      if (c.method === "POST") { posts++; await gate; return json({ entry_id: "1700000099999-0" }); }
      return json({ items: DEAD(1), next_cursor: null });
    });
    renderConnected(<DeadLetter />, m.fetch, "/dead/emails");
    await screen.findByText("job-0");
    await userEvent.click(screen.getByRole("button", { name: /Requeue/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/attempt count resets to 1/);
    expect(dialog).toHaveTextContent(/may execute more than once/);
    const confirm = within(dialog).getByRole("button", { name: "Requeue job" });
    expect(confirm).toBeDisabled();
    expect(posts).toBe(0);
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(confirm);
    await userEvent.click(confirm); // repeat click while pending
    await userEvent.click(confirm);
    expect(posts).toBe(1);
    await act(async () => { release(); });
    expect(await screen.findByText(/New stream entry id: 1700000099999-0/)).toBeInTheDocument();
    expect(screen.getByText(/not been confirmed as processed/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("purge requires typing the entry id and never fires automatically", async () => {
    const writes: string[] = [];
    const m = mockFetch((c) => {
      if (c.url === "/api/queues") return json({ queues: QUEUES });
      if (c.method === "DELETE") { writes.push(c.url); return new Response(null, { status: 204 }); }
      return json({ items: DEAD(1), next_cursor: null });
    });
    renderConnected(<DeadLetter />, m.fetch, "/dead/emails");
    await screen.findByText("job-0");
    await userEvent.click(screen.getByRole("button", { name: /Purge/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/permanently deletes/);
    const del = within(dialog).getByRole("button", { name: "Delete entry" });
    expect(del).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Type 1700000000000-0/), "1700000000000-1");
    expect(del).toBeDisabled();
    await userEvent.clear(within(dialog).getByLabelText(/Type 1700000000000-0/));
    await userEvent.type(within(dialog).getByLabelText(/Type 1700000000000-0/), "1700000000000-0");
    expect(writes).toHaveLength(0);
    await userEvent.click(del);
    await waitFor(() => expect(writes).toEqual(["/api/queues/emails/dead/1700000000000-0"]));
    expect(await screen.findByText(/Server deleted dead-letter entry 1700000000000-0 \(HTTP 204\)/)).toBeInTheDocument();
  });

  it("shows the server's error when an action fails and allows retry", async () => {
    const m = mockFetch((c) => {
      if (c.url === "/api/queues") return json({ queues: QUEUES });
      if (c.method === "POST") return json({ detail: "no such dead job" }, 404);
      return json({ items: DEAD(1), next_cursor: null });
    });
    renderConnected(<DeadLetter />, m.fetch, "/dead/emails");
    await screen.findByText("job-0");
    await userEvent.click(screen.getByRole("button", { name: /Requeue/ }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox"));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Requeue job" }));
    expect(await screen.findByText("no such dead job")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Requeue job" })).toBeEnabled();
  });

  it("shows an empty state", async () => {
    const m = mockFetch((c) => (c.url === "/api/queues" ? json({ queues: QUEUES }) : json({ items: [], next_cursor: null })));
    renderConnected(<DeadLetter />, m.fetch, "/dead/emails");
    expect(await screen.findByText("No dead-letter entries")).toBeInTheDocument();
  });
});
