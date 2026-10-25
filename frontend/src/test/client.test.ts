import { describe, expect, it } from "vitest";
import { AdminClient, isInsecureRemote, normaliseBaseUrl } from "@/lib/client";
import { ApiError } from "@/lib/errors";
import { DEAD, json, mockFetch, QUEUES } from "./helpers";

const make = (handler: Parameters<typeof mockFetch>[0], key = "k-123") => {
  const m = mockFetch(handler);
  return { client: new AdminClient({ baseUrl: "/api", apiKey: key, fetchImpl: m.fetch }), calls: m.calls };
};

describe("AdminClient", () => {
  it("sends X-API-Key as a header, never in the URL, and omits cookies", async () => {
    const { client, calls } = make(() => json({ queues: QUEUES }), "super-secret");
    const queues = await client.listQueues();
    expect(queues[0].name).toBe("emails");
    expect(calls[0].url).toBe("/api/queues");
    expect(calls[0].headers["X-API-Key"]).toBe("super-secret");
    expect(calls.every((c) => !c.url.includes("super-secret"))).toBe(true);
  });

  it("builds the dead-letter query from the real contract", async () => {
    const { client, calls } = make(() => json({ items: DEAD(2), next_cursor: null }));
    await client.listDead("my queue", { limit: 25, cursor: "1-0", includePayload: true });
    expect(calls[0].url).toBe("/api/queues/my%20queue/dead?limit=25&cursor=1-0&include_payload=true");
    await client.listDead("q");
    expect(calls[1].url).toBe("/api/queues/q/dead?limit=50");
  });

  it("maps statuses to typed errors without leaking the key", async () => {
    const cases: [number, string][] = [[401, "auth"], [404, "not_found"], [422, "validation"], [500, "server"]];
    for (const [status, kind] of cases) {
      const { client } = make(() => json({ detail: "x" }, status), "leaky-key");
      const err = await client.getQueue("q").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).kind).toBe(kind);
      expect((err as ApiError).message).not.toContain("leaky-key");
    }
  });

  it("reports network failures and cancellation distinctly", async () => {
    const { client } = make(() => { throw new TypeError("Failed to fetch"); });
    await expect(client.listQueues()).rejects.toMatchObject({ kind: "network" });
    const ctl = new AbortController();
    const slow = make((c) => new Promise((_, rej) => { void c; rej(new DOMException("aborted", "AbortError")); }));
    ctl.abort();
    await expect(slow.client.listQueues(ctl.signal)).rejects.toMatchObject({ kind: "aborted" });
  });

  it("rejects malformed responses", async () => {
    const { client } = make(() => json({ nope: true }));
    await expect(client.listQueues()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("requeue returns the server's entry_id and purge accepts 204", async () => {
    const { client, calls } = make((c) =>
      c.method === "POST" ? json({ entry_id: "1700000009999-0" }) : new Response(null, { status: 204 }),
    );
    expect(await client.requeueDead("q", "1-0")).toEqual({ entry_id: "1700000009999-0" });
    await client.purgeDead("q", "1-0");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/queues/q/dead/1-0/requeue",
      "DELETE /api/queues/q/dead/1-0",
    ]);
  });
});

describe("base URL handling", () => {
  it("accepts same-origin paths and http(s) URLs, trims trailing slashes", () => {
    expect(normaliseBaseUrl("/api/")).toBe("/api");
    expect(normaliseBaseUrl("https://ops.example.com/sw/")).toBe("https://ops.example.com/sw");
  });
  it("rejects credentials, queries and other schemes", () => {
    for (const bad of ["https://u:p@host/api", "https://host/api?key=1", "ftp://host", "not a url", ""]) {
      expect(() => normaliseBaseUrl(bad), bad).toThrow(ApiError);
    }
  });
  it("flags plain http to remote hosts only", () => {
    expect(isInsecureRemote("http://ops.example.com")).toBe(true);
    expect(isInsecureRemote("http://localhost:8000")).toBe(false);
    expect(isInsecureRemote("https://ops.example.com")).toBe(false);
    expect(isInsecureRemote("/api")).toBe(false);
  });
});
