// Minimal MOCK of Gemini's generateContent endpoint, for local testing without an API key.
// It "translates" by prefixing each cue with "[he] " (after any leading markup tags) and returns the
// JSON shape our client expects. It does NOT test real Gemini quality / rate limits / safety behaviour.
import http from "node:http";
// Rate-limit emulation (mode "rl"): each model allows RL.max requests per RL.windowMs; excess -> 429 with retryDelay (like Gemini free tier).
const RL = { max: 3, windowMs: 6000, delay: 3, gone: "" };
const hits = {}; // model -> request timestamps
const sentLog = []; // {t, model, status}
let mode = "ok"; // ok | bad_key | flaky | slow | rl
// ok | bad_key | flaky
let flakyStep = 0;
const stats = { calls: 0, lastModel: null, lastKeyHeader: null, sawSystemPrompt: false, sawSafety: false };
http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/__mode") {
      mode = u.searchParams.get("m"); flakyStep = 0;
      for (const k of ["max", "windowMs", "delay"]) if (u.searchParams.get(k)) RL[k] = Number(u.searchParams.get(k));
      RL.gone = u.searchParams.get("gone") ?? "";
      for (const k in hits) delete hits[k]; sentLog.length = 0;
      return res.end("ok " + mode);
    }
    if (u.pathname === "/__log") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(sentLog)); }
    if (u.pathname === "/__stats") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(stats)); }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      stats.calls++;
      const m = /\/v1beta\/models\/([^/:]+):generateContent/.exec(u.pathname);
      stats.lastModel = m?.[1];
      const model = m?.[1] ?? "?";
      const log = (status) => sentLog.push({ t: Date.now(), model, status });
      if (RL.gone && model === RL.gone) { log(404); res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 404, message: "model not found" } })); }
      if (mode === "rl") {
        const now = Date.now();
        const h = (hits[model] ??= []).filter((t) => now - t < RL.windowMs);
        hits[model] = h;
        if (h.length >= RL.max) {
          log(429);
          res.statusCode = 429;
          return res.end(JSON.stringify({ error: { code: 429, message: `You exceeded your current quota. Please retry in ${RL.delay}.5s.`, status: "RESOURCE_EXHAUSTED",
            details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] },
                      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: `${RL.delay}s` }] } }));
        }
        h.push(now);
      }
      log(200);
      stats.lastKeyHeader = req.headers["x-goog-api-key"] ?? null;
      const j = JSON.parse(body);
      stats.sawSystemPrompt = !!j.systemInstruction?.parts?.[0]?.text;
      stats.sawSafety = Array.isArray(j.safetySettings);
      if (mode === "bad_key") { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } })); }
      if (mode === "flaky") {
        flakyStep++;
        if (flakyStep === 1) { res.statusCode = 429; return res.end(JSON.stringify({ error: { code: 429, message: "quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "2s" }] } })); }
      }
      const input = JSON.parse(j.contents[0].parts[0].text);
      if (mode === "slow") return setTimeout(() => reply(res, input), 1500);
      reply(res, input);
      function reply(res, input) {
      let cues = input.cues.map((c) => ({ i: c.i, t: c.t.replace(/^((?:<[^>]+>|\{[^}]*\})*)/, "$1[he] ") }));
      if (mode === "flaky" && flakyStep === 2) cues = cues.slice(0, -1); // partial output -> client must retry the missing cue
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "```json\n" + JSON.stringify({ cues }) + "\n```" }] }, finishReason: "STOP" }] }));
      }
    });
  })
  .listen(8799, "127.0.0.1", () => console.log("mock gemini on :8799"));
