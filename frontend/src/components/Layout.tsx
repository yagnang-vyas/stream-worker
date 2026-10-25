import {
  BookOpen,
  FlaskConical,
  Gauge,
  Layers,
  Menu,
  Moon,
  PlugZap,
  Search,
  Skull,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useConnection } from "@/lib/connection";
import { cn } from "@/lib/cn";
import { Badge, Button } from "./ui";

const NAV = [
  { to: "/", label: "Overview", icon: Gauge, end: true },
  { to: "/queues", label: "Queues", icon: Layers },
  { to: "/jobs", label: "Job Explorer", icon: Search },
  { to: "/dead", label: "Dead Letter Queue", icon: Skull },
  { to: "/playground", label: "Playground", icon: FlaskConical },
  { to: "/connection", label: "System Connection", icon: PlugZap },
  { to: "/docs", label: "Documentation", icon: BookOpen },
];

function readTheme(): "dark" | "light" {
  try {
    return localStorage.getItem("sw-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function ConnectionBadge() {
  const { status } = useConnection();
  const map = {
    connected: ["ok", "Connected"],
    connecting: ["warn", "Connecting"],
    failed: ["bad", "Connection failed"],
    disconnected: ["neutral", "Not connected"],
  } as const;
  const [tone, label] = map[status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Layout() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("sw-theme", theme);
    } catch {
      /* storage unavailable: theme just won't persist */
    }
  }, [theme]);

  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-card focus:p-2">
        Skip to content
      </a>
      <aside
        className={cn(
          "w-60 shrink-0 border-r border-border bg-card md:static md:block",
          open ? "fixed inset-y-0 left-0 z-40 block" : "hidden",
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <span className="font-mono text-sm font-semibold">streamworker</span>
          <Badge tone="accent">console</Badge>
        </div>
        <nav aria-label="Primary" className="space-y-0.5 p-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm",
                  isActive ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60",
                )
              }
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex h-14 items-center justify-between gap-2 border-b border-border px-4">
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden"
            aria-label="Toggle navigation"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <Menu className="h-4 w-4" />
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <ConnectionBadge />
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
