// Builds with sentinel secrets in the environment and fails if any of them (or other
// secret-looking strings) end up in the compiled assets.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SENTINELS = {
  ADMIN_API_KEY: "sentinel-admin-key-8f3a91c2",
  REDIS_URL: "redis://:sentinel-redis-pass-77d1@redis.internal:6379/0",
  VITE_NOT_A_SECRET_PREFIX_CHECK: "sentinel-vite-var-1e5b",
  STREAMWORKER_ADMIN_URL: "http://sentinel-upstream.internal:8000",
};
const out = mkdtempSync(join(tmpdir(), "sw-bundle-"));
try {
  execFileSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], {
    stdio: "pipe",
    env: { ...process.env, ...SENTINELS },
  });
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      statSync(p).isDirectory() ? walk(p) : files.push(p);
    }
  };
  walk(out);
  const forbidden = [
    ...Object.values(SENTINELS).filter((v) => !v.startsWith("VITE")),
    "sentinel-redis-pass",
    "redis://",
    "process.env.ADMIN_API_KEY",
  ];
  const hits = [];
  for (const f of files.filter((f) => /\.(js|css|html|map)$/.test(f))) {
    const text = readFileSync(f, "utf8");
    for (const needle of forbidden) if (text.includes(needle)) hits.push(`${f}: ${needle}`);
  }
  if (hits.length) {
    console.error("Secret-looking strings found in the bundle:\n" + hits.join("\n"));
    process.exit(1);
  }
  console.log(`bundle check passed (${files.length} files scanned)`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
