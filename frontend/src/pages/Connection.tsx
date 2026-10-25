import { useState, type FormEvent } from "react";
import { ConnectionBadge } from "@/components/Layout";
import { Banner, Button, Card, CardHeader, Field, inputCls } from "@/components/ui";
import { isInsecureRemote } from "@/lib/client";
import { useConnection } from "@/lib/connection";

export function Connection() {
  const { status, baseUrl, error, connect, signOut } = useConnection();
  const [url, setUrl] = useState(baseUrl);
  const [key, setKey] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = await connect(url, key);
    if (ok) setKey(""); // the client now holds the key in memory; drop the form copy
  }

  return (
    <>
      <h1 className="text-xl font-semibold">System Connection</h1>
      <Card>
        <CardHeader title="Admin API">
          <ConnectionBadge />
        </CardHeader>
        <form onSubmit={onSubmit} className="space-y-4 p-4">
          <Field
            label="API base URL"
            htmlFor="base-url"
            hint="A same-origin path such as /api (recommended) or an absolute http(s) URL. No credentials in the URL."
          >
            <input
              id="base-url"
              className={`${inputCls} font-mono`}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
            />
          </Field>
          {isInsecureRemote(url) && (
            <Banner tone="warn" title="Plain HTTP to a remote host">
              <p>The API key would travel unencrypted. Use HTTPS outside local development.</p>
            </Banner>
          )}
          <Field
            label="API key (X-API-Key)"
            htmlFor="api-key"
            hint="Kept in memory only: never written to storage or the URL, and gone on reload or sign-out."
          >
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              className={`${inputCls} font-mono`}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          {error && (
            <Banner tone="error" title={error.kind === "auth" ? "Authentication failed" : "Could not connect"}>
              <p>{error.message}</p>
            </Banner>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={status === "connecting"}>
              {status === "connecting" ? "Connecting…" : "Connect"}
            </Button>
            {status === "connected" && (
              <Button onClick={signOut}>Sign out</Button>
            )}
          </div>
        </form>
      </Card>
      <Banner tone="info" title="About this connection">
        <ul className="list-disc space-y-1 pl-4">
          <li>The admin API uses one shared API key. It has no per-user roles, and this console adds none.</li>
          <li>
            The admin API sends no CORS headers, so the browser must reach it same-origin (a reverse proxy or the
            dev-server proxy). See the Documentation page.
          </li>
          <li>Without a connection, the dashboard stays empty. It never fills in sample data; use the Playground to explore.</li>
        </ul>
      </Banner>
    </>
  );
}
