import { cfg, langInfo, ISO3, type Env } from "./config";
import { quotaIncrement, quotaUsed } from "./quota";
import { noticeSrt } from "./srt";
export { TranslationJob } from "./job";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
};

function json(body: unknown, cache = "public, max-age=300", status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });
}
function srt(body: string, cache: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS, "content-type": "application/x-subrip; charset=utf-8", "cache-control": cache },
  });
}
const notFound = () => new Response("Not found", { status: 404, headers: CORS });

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

const b64urlEncode = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function b64urlDecode(s: string): string {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(p), (ch) => ch.charCodeAt(0)));
}
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function manifest(env: Env) {
  const c = cfg(env);
  const names = c.targetLangs.map((l) => langInfo(l)[0]).join(", ");
  return {
    id: "community.ai-translated-subtitles",
    version: "1.0.0",
    name: `AI Subtitles (${names})`,
    description: `Translates existing subtitles with Google Gemini (${c.model}) and keeps the original timing. Results are cached; limited to ${c.dailyLimit} new translations per day.`,
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { configurable: false },
  };
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function handleSubtitles(env: Env, origin: string, token: string, segs: string[]): Promise<Response> {
  const c = cfg(env);
  const type = segs[2];
  const id = decodeURIComponent(segs[3] ?? "").replace(/\.json$/, "");
  const extra = segs[4] ? decodeURIComponent(segs[4]).replace(/\.json$/, "") : "";
  if (!["movie", "series"].includes(type) || !/^tt\d+(:\d+:\d+)?$/.test(id)) return json({ subtitles: [] });

  const base = `${c.osBase}/subtitles/${type}/${encodeURIComponent(id)}`;
  let list: any[] = [];
  for (const u of extra ? [`${base}/${extra}.json`, `${base}.json`] : [`${base}.json`]) {
    const data = await fetchJson(u);
    list = (data?.subtitles ?? []).filter((s: any) => s?.lang === c.sourceLang && typeof s?.url === "string");
    if (list.length) break;
  }
  list = list.filter((s) => allowedSource(c.allowedHosts, s.url)).slice(0, c.maxSources);

  const subtitles = [];
  for (const s of list) {
    for (const lang of c.targetLangs) {
      const label = langInfo(lang)[1];
      subtitles.push({
        id: `stremio-ai-${lang}-${s.id ?? (await sha256Hex(s.url)).slice(0, 12)}`,
        // A real ISO 639-2 code: Android ignores `label` and shows "und"/blank for non-ISO text.
        // Listing never starts a job; only a request for the .srt does (and that is capped by DAILY_LIMIT).
        lang: ISO3[lang] ?? lang,
        label,
        url: `${origin}/${token}/translated/${lang}.${b64urlEncode(s.url)}.srt`,
      });
    }
  }
  // listing changes rarely; keep short so quota/"no source" states refresh
  return json({ subtitles }, "public, max-age=600");
}

function allowedSource(allowed: string[], url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return allowed.some((a) => h === a || h.endsWith("." + a));
  } catch {
    return false;
  }
}

const notice = (title: string, detail: string, cache = "no-store") => srt(noticeSrt(`${title}\n${detail}`), cache);

async function handleTranslated(env: Env, ctx: ExecutionContext, req: Request, file: string): Promise<Response> {
  const c = cfg(env);
  const m = /^([a-z]{2,3})\.([A-Za-z0-9_-]+)\.srt$/.exec(file);
  if (!m || !c.targetLangs.includes(m[1])) return notFound();
  const lang = m[1];
  let srtUrl: string;
  try {
    srtUrl = b64urlDecode(m[2]);
  } catch {
    return notFound();
  }
  if (!allowedSource(c.allowedHosts, srtUrl)) return notFound();
  if (req.method === "HEAD") return srt("", "no-store");

  const cacheKey = `srt:v1:${lang}:${await sha256Hex(srtUrl)}`;
  const hit = await env.CACHE.get(cacheKey);
  if (hit) return srt(hit, "public, max-age=86400");

  const stub = env.TRANSLATION_JOB.get(env.TRANSLATION_JOB.idFromName(`${lang}:${srtUrl}`));
  let job = await stub.status();
  if (job.status === "done") {
    const r = await stub.result();
    if (r) return srt(r, "public, max-age=86400");
  }
  if (job.status !== "running") {
    if (job.status === "failed" && Date.now() - (job.finishedAt ?? 0) < c.failCooldownSeconds * 1000) {
      return notice("AI translation failed", `${job.error}\nSelect the subtitle again in about ${c.failCooldownSeconds}s to retry.`);
    }
    // a new job is needed -> check the daily budget first
    const used = await quotaUsed(env);
    if (used >= c.dailyLimit) {
      return notice(
        "AI translation limit reached",
        `Daily limit of ${c.dailyLimit} new translations used (${used}/${c.dailyLimit}).\nAlready translated titles still work. Try again tomorrow.`,
      );
    }
    const r = await stub.start({ srtUrl, lang, cacheKey });
    if (r.started) await quotaIncrement(env);
    job = r.job;
  }
  job = await stub.wait(c.waitSeconds * 1000);
  if (job.status === "done") {
    const done = (await stub.result()) ?? (await env.CACHE.get(cacheKey));
    if (done) return srt(done, "public, max-age=86400");
    return notice("AI translation failed", "The translation finished but the result could not be read back from storage. Select the subtitle again.");
  }
  if (job.status === "failed") {
    return notice("AI translation failed", `${job.error}\nSelect the subtitle again in about ${c.failCooldownSeconds}s to retry.`);
  }
  const [d, t] = job.parts ?? [0, 0];
  return notice(
    "AI translation in progress",
    `${Math.round(job.progress * 100)}% done${t ? ` (part ${d}/${t})` : ""}${job.paused ? " - waiting for the free Gemini rate limit" : ""}.\n` +
      `This is not an error. A full movie takes about 1-3 minutes.\n` +
      `Switch subtitles off and select this one again in ~1 minute.`,
  );
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response("Stremio AI subtitles addon. Install with your private URL: <this-host>/<token>/manifest.json\n", { headers: CORS });
    }
    const segs = url.pathname.split("/").slice(1); // ["token", "manifest.json"] ...
    // Fail closed: no token configured or wrong token -> 404
    if (!env.ACCESS_TOKEN || !safeEqual(decodeURIComponent(segs[0] ?? ""), env.ACCESS_TOKEN)) return notFound();
    const token = segs[0];
    try {
      if (segs.length === 2 && segs[1] === "manifest.json") return json(manifest(env), "public, max-age=3600");
      if (segs[1] === "subtitles" && (segs.length === 4 || segs.length === 5)) return await handleSubtitles(env, url.origin, token, segs);
      if (segs[1] === "translated" && segs.length === 3) return await handleTranslated(env, ctx, req, segs[2]);
    } catch (e: any) {
      console.error("unhandled", e?.message);
      if (segs[1] === "translated") return notice("AI translation failed", `Unexpected addon error: ${e?.message ?? e}`);
      return json({ subtitles: [] }, "no-store");
    }
    return notFound();
  },
} satisfies ExportedHandler<Env>;
