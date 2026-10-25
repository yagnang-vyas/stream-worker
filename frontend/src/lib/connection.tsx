import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AdminClient, normaliseBaseUrl } from "./client";
import { ApiError, describeError } from "./errors";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "failed";

export interface ConnectionState {
  status: ConnectionStatus;
  baseUrl: string;
  /** Present only while connected. The key itself is never exposed. */
  client: AdminClient | null;
  error: ApiError | null;
  connect: (baseUrl: string, apiKey: string) => Promise<boolean>;
  /** Drops the client (and with it the in-memory key). */
  signOut: () => void;
}

const Ctx = createContext<ConnectionState | null>(null);

export function ConnectionProvider({
  children,
  fetchImpl,
  initialBaseUrl = "/api",
}: {
  children: ReactNode;
  fetchImpl?: typeof fetch;
  initialBaseUrl?: string;
}) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [client, setClient] = useState<AdminClient | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const attempt = useRef(0);

  const connect = useCallback(
    async (url: string, apiKey: string) => {
      const id = ++attempt.current;
      setStatus("connecting");
      setError(null);
      try {
        const normalised = normaliseBaseUrl(url);
        if (!apiKey) throw new ApiError("auth", "Enter the admin API key");
        const c = new AdminClient({ baseUrl: normalised, apiKey, fetchImpl });
        await c.listQueues(); // probe: validates URL, key and response shape
        if (id !== attempt.current) return false;
        setBaseUrl(normalised);
        setClient(c);
        setStatus("connected");
        return true;
      } catch (e) {
        if (id !== attempt.current) return false;
        setClient(null);
        setStatus("failed");
        setError(e instanceof ApiError ? e : new ApiError("server", describeError(e)));
        return false;
      }
    },
    [fetchImpl],
  );

  const signOut = useCallback(() => {
    attempt.current++;
    setClient(null);
    setError(null);
    setStatus("disconnected");
  }, []);

  const value = useMemo(
    () => ({ status, baseUrl, client, error, connect, signOut }),
    [status, baseUrl, client, error, connect, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConnection(): ConnectionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConnection outside ConnectionProvider");
  return v;
}
