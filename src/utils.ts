import { writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function resolveExpiry(duration?: string): string {
  const d = duration ?? "2h";
  const m = d.match(/^(\d+)(m|h|d)$/);
  if (m) {
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]!;
    return new Date(Date.now() + parseInt(m[1]) * ms).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(d) && !isNaN(new Date(d).getTime())) {
    return d;
  }
  return new Date(Date.now() + 2 * 3_600_000).toISOString();
}

export function isExpiredTimestamp(ts: string): boolean {
  const t = new Date(ts).getTime();
  if (isNaN(t)) return true;
  return t < Date.now();
}

export function isAfterCutoff(ts: string, cutoffMs: number): boolean {
  const t = new Date(ts).getTime();
  if (isNaN(t)) return false;
  return t > Date.now() - cutoffMs;
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 5_000;

export function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = filePath + ".lock";
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (true) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch {
      if (existsSync(lockPath)) {
        try {
          const { mtimeMs } = require("node:fs").statSync(lockPath);
          if (Date.now() - mtimeMs > LOCK_STALE_MS) {
            try { unlinkSync(lockPath); } catch {}
            continue;
          }
        } catch {}
      }
      if (Date.now() > deadline) {
        try { unlinkSync(lockPath); } catch {}
        break;
      }
      const waitUntil = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < waitUntil) {}
    }
  }

  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}
