// Rate-limit behaviour. Run with: wrangler dev (vars: GEMINI_MODELS=gem-a[,gem-b], BATCH_SIZE=60, BATCHES_PER_STEP=3, RPM_PER_MODEL=100, WAIT_SECONDS=3, DEADLINE_SECONDS=...) + mock-gemini.
// usage: tsx test/e2e-rl.mjs <scenario>   scenario: pause | fallback | gone | deadline
import assert from "node:assert/strict";
import { parseSrt } from "../src/srt.ts";
const W = "http://127.0.0.1:8787", G = "http://127.0.0.1:8799", TOKEN = "testtoken123";
const scenario = process.argv[2];
const imdb = { paced: "tt0111161", pause: "tt0111161", fallback: "tt0068646", gone: "tt0109830", deadline: "tt0137523" }[scenario];
const q = { paced: "m=rl&max=4&windowMs=60000&delay=40", pause: "m=rl&max=3&windowMs=6000&delay=3", fallback: "m=rl&max=2&windowMs=60000&delay=40", gone: "m=ok&gone=gem-a", deadline: "m=rl&max=0&windowMs=60000&delay=5" }[scenario];
await fetch(`${G}/__mode?${q}`);
const l = await (await fetch(`${W}/${TOKEN}/subtitles/movie/${imdb}.json`)).json();
const path = new URL(l.subtitles[0].url).pathname;
const t0 = Date.now();
let last, first = true, polls = 0;
for (;;) {
  const r = await fetch(W + path); const t = await r.text(); const c = parseSrt(t); polls++;
  if (first) { if (c.length === 1) assert.equal(r.headers.get("cache-control"), "no-store"); console.log("  first response:", JSON.stringify(c[0].text.split("\n").slice(0, 2).join(" | "))); first = false; }
  if (c.length > 1) { last = c; break; }
  if (/failed/.test(c[0].text)) { last = c; break; }
  if (Date.now() - t0 > 180000) throw new Error("timeout");
}
const secs = (Date.now() - t0) / 1000;
const log = await (await fetch(`${G}/__log`)).json();
const by = {}; for (const e of log) { by[e.model] ??= { 200: 0, 429: 0, 404: 0 }; by[e.model][e.status]++; }
console.log(`  ${scenario}: ${last.length} cues in ${secs.toFixed(1)}s, polls=${polls}, mock requests by model:`, JSON.stringify(by));
if (scenario === "deadline") { assert.match(last[0].text, /rate limit kept blocking/); console.log("  ✓ deadline -> clear failure:", JSON.stringify(last[0].text.split("\n")[0])); process.exit(0); }
assert.ok(last.length > 100 && last.every((c) => c.text.includes("[he]")), "all cues translated");
if (scenario === "paced") { assert.equal(by["gem-a"][429], 0, "pacing must avoid 429s"); assert.ok(by["gem-a"][200] <= 12); console.log("  ✓ client-side pacing: zero 429s,", by["gem-a"][200], "requests"); }
if (scenario === "pause") { assert.ok(by["gem-a"][429] >= 1, "saw a 429"); console.log("  ✓ 429s were pauses, job still completed"); }
if (scenario === "fallback") { assert.ok(by["gem-b"]?.[200] >= 1, "fallback model used"); console.log("  ✓ fell back to second model"); }
if (scenario === "gone") { assert.ok(by["gem-b"]?.[200] >= 1 && by["gem-a"][404] >= 1); console.log("  ✓ retired model skipped"); }
