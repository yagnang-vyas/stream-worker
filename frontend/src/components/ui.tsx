import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, Info, Loader2, XCircle } from "lucide-react";
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

const button = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md border text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "border-transparent bg-accent text-accent-foreground hover:opacity-90",
        outline: "border-border bg-card hover:bg-muted",
        ghost: "border-transparent hover:bg-muted",
        danger: "border-transparent bg-bad text-background hover:opacity-90",
      },
      size: { sm: "h-8 px-2.5", md: "h-9 px-3.5" },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button type="button" className={cn(button({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-card", className)} {...props} />;
}

export function CardHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </div>
  );
}

const badge = cva("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium border", {
  variants: {
    tone: {
      neutral: "border-border bg-muted text-muted-foreground",
      ok: "border-ok/40 bg-ok/10 text-ok",
      warn: "border-warn/40 bg-warn/10 text-warn",
      bad: "border-bad/40 bg-bad/10 text-bad",
      sim: "border-sim/40 bg-sim/10 text-sim",
      accent: "border-accent/40 bg-accent/10 text-accent",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({
  tone,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

export function SimBadge() {
  return <Badge tone="sim">SIMULATED</Badge>;
}

export function Mono({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("font-mono text-xs", className)} {...props} />;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}…
    </span>
  );
}

const banner = {
  info: { icon: Info, cls: "border-accent/40 bg-accent/10" },
  warn: { icon: AlertTriangle, cls: "border-warn/40 bg-warn/10" },
  error: { icon: XCircle, cls: "border-bad/40 bg-bad/10" },
  sim: { icon: Info, cls: "border-sim/40 bg-sim/10" },
} as const;

export function Banner({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: keyof typeof banner;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, cls } = banner[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "note"}
      className={cn("flex gap-2.5 rounded-md border px-3 py-2.5 text-sm", cls, className)}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-muted-foreground [&_strong]:text-foreground">{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export const inputCls =
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm placeholder:text-muted-foreground";

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-card p-5 shadow-xl"
      >
        <h2 className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function JsonBlock({ text, label }: { text: string; label?: string }) {
  return (
    <pre
      aria-label={label}
      className="max-h-64 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs"
    >
      {text}
    </pre>
  );
}
