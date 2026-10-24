// End-to-end test against `wrangler dev` (http://127.0.0.1:8787) + mock-gemini (:8799) + the REAL OpenSubtitles addon.
import assert from "node:assert/strict";
import { parseSrt } from "../src/srt.ts";
const W = "http://127.0.0.1:8787", G = "http://127.0.0.1:8799", TOKEN = "testtoken123";
const get = async (p, o) => { const r = await fetch(W + p, o); return { r, t: await r.text() }; };
const mode = (m) => fetch(`${G}/__mode?m=${m}`).then((r) => r.text());
const stats = () => fetch(`${G}/__stats`).then((r) => r.json());
const ok = (n) => console.log("  ✓", n);

async function listing(type, id, extra = "") {
  const { r, t } = await get(`/${TOKEN}/subtitles/${type}/${encodeURIComponent(id)}${extra ? "/" + extra : ""}.json`);
  assert.equal(r.status, 200);
  return { r, j: JSON.parse(t) };
}
async function srtFor(type, id) {
  const { j } = await listing(type, id);
  assert.ok(j.subtitles.length >= 1, `no subtitle listed for ${id}`);
  const s = j.subtitles[0];
  const t0 = Date.now();
  const path = new URL(s.url).pathname;
  const { r, t } = await get(path);
  return { s, r, t, secs: (Date.now() - t0) / 1000, path };
}

console.log("basic");
assert.equal((await get("/")).r.status, 200); ok("root 200");
assert.equal((await get("/wrongtoken/manifest.json")).r.status, 404); ok("wrong token -> 404");
assert.equal((await get(`/wrongtoken/subtitles/movie/tt0111161.json`)).r.status, 404); ok("wrong token on subtitles -> 404");
const man = await get(`/${TOKEN}/manifest.json`);
const m = JSON.parse(man.t);
assert.deepEqual(m.resources, ["subtitles"]); assert.deepEqual(m.types, ["movie", "series"]); assert.deepEqual(m.idPrefixes, ["tt"]); assert.deepEqual(m.catalogs, []);
assert.equal(man.r.headers.get("access-control-allow-origin"), "*"); ok("manifest + CORS");
const pre = await fetch(`${W}/${TOKEN}/manifest.json`, { method: "OPTIONS" });
assert.equal(pre.status, 204); ok("OPTIONS preflight");

console.log("listing (real OpenSubtitles)");
const mv = await listing("movie", "tt0111161");
assert.equal(mv.j.subtitles.length, 1);
assert.equal(mv.j.subtitles[0].lang, "heb"); assert.match(mv.j.subtitles[0].id, /^stremio-ai-he-/); assert.equal(mv.j.subtitles[0].label, "עברית - AI");
assert.match(mv.j.subtitles[0].url, new RegExp(`/${TOKEN}/translated/he\\.`)); ok("movie tt0111161 -> 1 entry 'עברית - AI'");
const sr = await listing("series", "tt0944947:1:1", "videoHash=abc&videoSize=123&filename=GoT.S01E01.mkv");
assert.equal(sr.j.subtitles.length, 1); ok("series tt0944947:1:1 (with extra) -> 1 entry");
assert.equal((await listing("movie", "notanid")).j.subtitles.length, 0); ok("bad id -> empty list");

console.log("translation (mock Gemini)");
await mode("ok");
const a = await srtFor("movie", "tt0111161");
assert.equal(a.r.status, 200); assert.match(a.r.headers.get("content-type"), /subrip/);
const src = await (await fetch(decodeURIComponent(Buffer.from(a.path.split(".")[1], "base64url").toString()))).text();
const sc = parseSrt(src).filter((c) => c.text.trim()), tc = parseSrt(a.t);
assert.equal(tc.length, sc.length, "cue count preserved");
assert.ok(sc.every((c, i) => c.timing === tc[i].timing), "timings identical");
assert.ok(tc.every((c) => c.text.replace(/\u200f/g, "").includes("[he] ")), "all cues translated");
const tagged = sc.findIndex((c) => /<i>/.test(c.text)); if (tagged >= 0) assert.ok(/<i>/.test(tc[tagged].text), "tags kept");
assert.ok(tc[0].text.startsWith("\u200f")); 
const st = await stats();
assert.equal(st.lastKeyHeader, "mock-key"); assert.equal(st.lastModel, "gemini-3.5-flash-lite"); assert.ok(st.sawSystemPrompt && st.sawSafety);
ok(`tt0111161: ${tc.length} cues, timings identical, tags kept, ${st.calls} Gemini calls, ${a.secs.toFixed(1)}s, model+key header ok`);
const calls1 = st.calls;
const a2 = await srtFor("movie", "tt0111161");
assert.equal(a2.t, a.t); assert.equal((await stats()).calls, calls1); assert.ok(a2.secs < 3);
assert.match(a2.r.headers.get("cache-control"), /max-age=86400/); ok(`second request served from KV cache: ${a2.secs.toFixed(2)}s, 0 new Gemini calls`);

const b = await srtFor("series", "tt0944947:1:1");
assert.ok(parseSrt(b.t).length > 100 && b.t.includes("[he]")); ok(`tt0944947:1:1 translated (${parseSrt(b.t).length} cues, ${b.secs.toFixed(1)}s)`);

console.log("failure handling");
await mode("bad_key");
const f1 = await srtFor("movie", "tt0068646");
assert.equal(f1.r.status, 200); assert.equal(f1.r.headers.get("cache-control"), "no-store");
let fc = parseSrt(f1.t); assert.equal(fc.length, 1); assert.match(fc[0].text, /AI translation failed/); assert.match(fc[0].text, /API key/);
ok("bad key -> single-cue error SRT: " + JSON.stringify(fc[0].text.split("\n").slice(0, 2)));
const cs = (await stats()).calls;
const f2 = await srtFor("movie", "tt0068646");
assert.match(parseSrt(f2.t)[0].text, /AI translation failed/); assert.equal((await stats()).calls, cs); ok("immediate retry -> cooldown, no new Gemini call, no quota use");

console.log("retry/partial handling");
await mode("flaky"); // 1st call 429, 2nd call partial (last cue missing), then ok
const g = await srtFor("movie", "tt0109830");
let gt = g.t; for (let k = 0; k < 60 && parseSrt(gt).length === 1; k++) { await new Promise((r) => setTimeout(r, 2000)); gt = (await get(g.path)).t; } // 429 is a pause: may take longer than WAIT_SECONDS
const gc = parseSrt(gt); assert.ok(gc.length > 50 && gc.every((c) => c.text.includes("[he]"))); ok(`429 + partial output recovered by retries (${gc.length} cues, ${g.secs.toFixed(1)}s)`);

console.log("daily limit");
await mode("ok");
const l = await srtFor("movie", "tt0137523");
fc = parseSrt(l.t); assert.equal(fc.length, 1); assert.match(fc[0].text, /limit reached/); assert.equal(l.r.headers.get("cache-control"), "no-store");
ok("5th new translation (limit 4) -> clear limit-reached subtitle");
const a3 = await srtFor("movie", "tt0111161"); assert.equal(a3.t, a.t); ok("cached title still works after limit reached");
const before = (await stats()).calls;
for (const id of ["tt0111161", "tt0068646", "tt1375666"]) await listing("movie", id);
assert.equal((await stats()).calls, before); ok("listing requests alone never call Gemini / start a job");
console.log("ALL E2E CHECKS PASSED");
