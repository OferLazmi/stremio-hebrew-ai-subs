import type { Env } from "./config";
import { cfg } from "./config";

function dayKey(env: Env): string {
  const tz = cfg(env).quotaTz;
  // en-CA formats as YYYY-MM-DD
  return `quota:${new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date())}`;
}

export async function quotaUsed(env: Env): Promise<number> {
  return parseInt((await env.CACHE.get(dayKey(env))) ?? "0", 10) || 0;
}

export async function quotaIncrement(env: Env): Promise<number> {
  const used = (await quotaUsed(env)) + 1;
  // Not atomic (KV has no increment). For a single-user addon a rare off-by-one is acceptable.
  await env.CACHE.put(dayKey(env), String(used), { expirationTtl: 3 * 86400 });
  return used;
}
