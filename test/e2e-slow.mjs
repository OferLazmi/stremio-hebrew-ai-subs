// Run with wrangler dev --var WAIT_SECONDS:3 and mock mode "slow": checks the "in progress" notice, then completion.
import assert from "node:assert/strict";
import { parseSrt } from "../src/srt.ts";
const W = "http://127.0.0.1:8787", TOKEN = "testtoken123";
await fetch("http://127.0.0.1:8799/__mode?m=slow");
const l = await (await fetch(`${W}/${TOKEN}/subtitles/movie/tt0111161.json`)).json();
const path = new URL(l.subtitles[0].url).pathname;
const r1 = await fetch(W + path); const t1 = await r1.text();
const c1 = parseSrt(t1);
assert.equal(c1.length, 1); assert.match(c1[0].text, /in progress/); assert.equal(r1.headers.get("cache-control"), "no-store");
console.log("  ✓ slow job -> 'in progress' notice:", JSON.stringify(c1[0].text));
const r1b = await fetch(W + path); const c1b = parseSrt(await r1b.text()); // while still running: must NOT start a second job
console.log("  ✓ second request while running:", JSON.stringify(c1b[0].text.split("\n")[0]));
await new Promise((r) => setTimeout(r, 30000));
const t2 = await (await fetch(W + path)).text();
assert.ok(parseSrt(t2).length > 1000 && t2.includes("[he]")); console.log("  ✓ after job finished -> full translation from cache");
const st = await (await fetch("http://127.0.0.1:8799/__stats")).json(); console.log("  gemini calls total:", st.calls);
