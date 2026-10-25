import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Playground } from "@/pages/Playground";
import { json, QUEUES, renderConnected } from "./helpers";
import { MemoryRouter } from "react-router-dom";

afterEach(() => vi.unstubAllGlobals());

describe("Playground (Simulation Mode)", () => {
  it("makes no network requests at all while being used", async () => {
    const spy = vi.fn(() => Promise.reject(new Error("network must not be used")));
    vi.stubGlobal("fetch", spy);
    const user = userEvent.setup();
    render(<MemoryRouter><Playground /></MemoryRouter>);
    expect(screen.getAllByText(/runs entirely in your browser/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Simulate enqueue" }));
    for (const tab of ["Lifecycle", "Retry & backoff", "Crash & recovery", "Idempotency", "Dead letter", "Concurrency"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      for (const b of screen.queryAllByRole("button", { name: /Run simulation|Step|Reset scenario/ })) await user.click(b);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("validates JSON and shows errors without creating a job", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Playground /></MemoryRouter>);
    const payload = screen.getByLabelText("JSON payload");
    await user.clear(payload);
    await user.click(payload);
    await user.paste("{not json");
    await user.click(screen.getByRole("button", { name: "Simulate enqueue" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/payload is not valid JSON/);
    expect(screen.getByText("No simulated jobs yet.")).toBeInTheDocument();
  });

  it("enqueues a labelled demo job, then suppresses a duplicate key", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Playground /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "Simulate enqueue" }));
    expect(screen.getByText(/Result for demo-0001 \(simulated\)/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Simulate enqueue" }));
    expect(screen.getByText(/Suppressed: idempotency key "welcome:ada" already exists/)).toBeInTheDocument();
    expect(screen.getAllByText(/demo-0001/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/demo-0002/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear simulated jobs" }));
    expect(screen.getByText("No simulated jobs yet.")).toBeInTheDocument();
  });

  it("walks the crash and recovery flow with the visibility timeout", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Playground /></MemoryRouter>);
    await user.click(screen.getByRole("tab", { name: "Crash & recovery" }));
    await user.selectOptions(screen.getByLabelText("Scenario"), "recovered");
    await user.click(screen.getByRole("button", { name: "Step" })); // deliver
    await user.click(screen.getByRole("button", { name: "Step" })); // crash
    const timeline = screen.getByRole("list", { name: "Simulated event timeline" });
    expect(within(timeline).getByText(/crashed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+30s" }));
    expect(within(timeline).queryByText(/XAUTOCLAIM/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+60s" }));
    expect(within(timeline).getByText(/XAUTOCLAIM by worker-2/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run simulation" }));
    expect(screen.getByLabelText("Side-effect ledger").querySelectorAll("li")).toHaveLength(2);
    expect(screen.getAllByText(/at-least-once/).length).toBeGreaterThan(0);
  });

  it("rejects a visibility timeout that is not above the handler time", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Playground /></MemoryRouter>);
    await user.click(screen.getByRole("tab", { name: "Crash & recovery" }));
    const vis = screen.getByLabelText(/Visibility timeout/);
    await user.clear(vis);
    await user.type(vis, "1");
    expect(screen.getByRole("alert")).toHaveTextContent(/visibility timeout must be greater/);
    expect(screen.getByRole("button", { name: "Run simulation" })).toBeDisabled();
  });

  it("dead-letter lab: exhaust, requeue resets attempt, fix, succeed", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Playground /></MemoryRouter>);
    await user.click(screen.getByRole("tab", { name: "Dead letter" }));
    await user.click(screen.getByRole("button", { name: "Run simulation" }));
    const entry = screen.getByLabelText(/Simulated dead entry sim-/);
    expect(entry).toHaveTextContent("RuntimeError");
    expect(entry).toHaveTextContent("attempt 3/3");
    await user.click(within(entry).getByRole("button", { name: /Requeue/ }));
    expect(screen.getByText("Empty. Run a failing scenario to fill it.")).toBeInTheDocument();
    expect(screen.getAllByText(/attempt 1\/3/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Run simulation" }));
    await user.click(within(screen.getByLabelText(/Simulated dead entry sim-/)).getByRole("button", { name: /Fix handler/ }));
    await user.click(within(screen.getByLabelText(/Simulated dead entry sim-/)).getByRole("button", { name: /Requeue/ }));
    await user.click(screen.getByRole("button", { name: "Run simulation" }));
    expect(screen.getByText("Empty. Run a failing scenario to fill it.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Acknowledged lane" })).getByText(/demo-0001/)).toBeInTheDocument();
  });

  it("reset scenario and clear jobs discard simulated state", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Playground /></MemoryRouter>);
    await user.click(screen.getByRole("tab", { name: "Lifecycle" }));
    await user.click(screen.getByRole("button", { name: "Run simulation" }));
    expect(within(screen.getByRole("region", { name: "Acknowledged lane" })).getByText(/demo-0001/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset scenario" }));
    expect(within(screen.getByRole("region", { name: "Ready lane" })).getByText(/demo-0001/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear simulated jobs" }));
    expect(screen.getByRole("region", { name: "Ready lane" })).not.toHaveTextContent("demo-");
    expect(screen.getByText(/No events yet/)).toBeInTheDocument();
  });

  it("backoff lab validates input and labels samples as simulated", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Playground /></MemoryRouter>);
    await user.click(screen.getByRole("tab", { name: "Retry & backoff" }));
    await user.selectOptions(screen.getByLabelText("Jitter"), "none");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("1.00 – 1.00");
    expect(screen.getAllByText("SIMULATED").length).toBeGreaterThan(0);
    const base = screen.getByLabelText("Base delay (s)");
    await user.clear(base);
    await user.type(base, "0");
    expect(screen.getByRole("alert")).toHaveTextContent(/base delay must be positive/);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("idempotency lab shows suppression, TTL expiry and repeated execution", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Playground /></MemoryRouter>);
    await user.click(screen.getByRole("tab", { name: "Idempotency" }));
    await user.click(screen.getByLabelText(/first handler run crashes/));
    await user.click(screen.getByRole("button", { name: "Enqueue with this key" }));
    await user.click(screen.getByRole("button", { name: "Enqueue with this key" }));
    await user.click(screen.getByRole("button", { name: "Advance past TTL" }));
    await user.click(screen.getByRole("button", { name: "Enqueue with this key" }));
    const attempts = within(screen.getByLabelText("Enqueue attempts")).getAllByRole("listitem");
    expect(attempts.map((a) => /accepted|suppressed/.exec(a.textContent ?? "")?.[0])).toEqual(["accepted", "suppressed", "accepted"]);
    await user.click(screen.getByRole("button", { name: "Run workers" }));
    expect(screen.getAllByText(/side effect applied more than once/).length).toBeGreaterThan(0);
  });

  it("concurrency lab shows out-of-order completion", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Playground /></MemoryRouter>);
    await user.click(screen.getByRole("tab", { name: "Concurrency" }));
    expect(screen.getByTestId("completion-order")).toHaveTextContent("A → B → D → E → F → C");
  });
});

describe("separation of simulated and real data", () => {
  it("resetting the playground leaves the real dashboard data and requests untouched", async () => {
    const calls: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return json({ queues: QUEUES });
    }) as typeof fetch;
    const user = userEvent.setup();
    const { Overview } = await import("@/pages/Overview");
    const { unmount } = renderConnected(<Overview />, f);
    expect(await screen.findByRole("table", { name: /Queue statistics/ })).toBeInTheDocument();
    const before = calls.length;
    unmount();
    renderConnected(<Playground />, f);
    await screen.findByRole("tablist");
    await user.click(screen.getByRole("button", { name: "Reset everything" }));
    await user.click(screen.getByRole("button", { name: "Simulate enqueue" }));
    expect(calls.length).toBe(before + 1); // only the new connection probe, nothing from the playground
    expect(calls.every((c) => c === "/api/queues")).toBe(true);
  });
});
