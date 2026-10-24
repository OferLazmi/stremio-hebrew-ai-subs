# Stremio AI Subtitles (Cloudflare Workers)

A Stremio **subtitles addon** that takes the English subtitle Stremio's OpenSubtitles addon already offers, translates it with
**Google Gemini** (Hebrew by default; other languages configurable), **keeps the original timing**, caches the result and shows it
in the subtitle picker as **`עברית - AI`**. It runs entirely on Cloudflare (Workers + KV + one Durable Object class), so it works on every
device logged into your Stremio account without your phone or PC being on.

* Errors are shown as a one-cue subtitle with the reason. **There is no silent fallback** to another engine.
* Hard local budget: **25 new translations per day** (`DAILY_LIMIT`). Cached titles are free and don't count.
* The addon URL contains a private token. Wrong token = `404`.

## Endpoints

| Path | Purpose |
|---|---|
| `/{TOKEN}/manifest.json` | Stremio manifest (`subtitles`, `movie`+`series`, id prefix `tt`) |
| `/{TOKEN}/subtitles/{type}/{id}[/{extra}].json` | Lists one `heb` / `עברית - AI` entry per title (source: `opensubtitles-v3.strem.io`) |
| `/{TOKEN}/translated/{lang}.{base64url(source .srt URL)}.srt` | Translates on first request, then serves from KV |

All responses carry `Access-Control-Allow-Origin: *`.

## Deploy (exact steps)

You need: Node.js 20+, a Cloudflare account (Free plan is enough), a Gemini API key (https://aistudio.google.com/apikey).

### A. Scripted (recommended)

1. Create a Cloudflare API token (dashboard -> My Profile -> API Tokens -> Create Token -> *Create Custom Token*) with **Account -> Workers Scripts -> Edit** and **Account -> Workers KV Storage -> Edit**. Find your **Account ID** in the dashboard (Workers & Pages -> right sidebar).
2. The account needs a `workers.dev` subdomain (Workers & Pages asks you to pick one the first time you open it).
3. Run:
   ```bash
   cd worker
   export CLOUDFLARE_API_TOKEN=...      # from step 1
   export CLOUDFLARE_ACCOUNT_ID=...     # from step 1
   export GEMINI_API_KEY=...            # Google AI Studio key
   export ACCESS_TOKEN=$(openssl rand -hex 24)   # private token for the addon URL; save it!
   ./deploy.sh
   ```
   The script installs dependencies, creates (or reuses) the KV namespace `stremio-ai-subs-cache`, writes `wrangler.generated.toml` with its id,
   deploys the Worker, sets the secrets `ACCESS_TOKEN` and `GEMINI_API_KEY`, smoke-tests it and prints the install URL.
   `DRY_RUN=1 ./deploy.sh` only validates inputs and bundles the Worker (no Cloudflare calls).

### B. Manual

```bash
cd worker && npm install
npx wrangler login                      # or: export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
npx wrangler kv namespace create CACHE  # copy the printed id into wrangler.toml -> [[kv_namespaces]] id
npx wrangler deploy
npx wrangler secret put ACCESS_TOKEN    # paste e.g. the output of: openssl rand -hex 24
npx wrangler secret put GEMINI_API_KEY
```

### Install in Stremio

`stremio://<worker-name>.<your-subdomain>.workers.dev/<ACCESS_TOKEN>/manifest.json`
(open that link, or paste the `https://...` form into Stremio -> Addons -> search box). Because Stremio addons are tied to your account,
it then appears on all your devices. Pick **`עברית - AI`** in the subtitle menu while playing.

## Configuration (`[vars]` in `wrangler.toml`)

| Var | Default | Meaning |
|---|---|---|
| `GEMINI_MODELS` | `gemini-3.5-flash-lite,gemini-3-flash-preview` | Comma list, preferred first. Later models are used only while earlier ones are 429-paused (or return 404). |
| `RPM_PER_MODEL` / `DEADLINE_SECONDS` | `60` / `900` | Per-model requests/min pacing (use ~12 on the Gemini FREE tier, 60+ on paid) / overall job deadline, after which the job fails with a clear message |
| `TARGET_LANGS` | `he` | Comma list of target languages (`he,ru,es,ar,fr,de,...` - see `LANGS` in `src/config.ts`). One picker entry each |
| `SOURCE_LANG` | `eng` | OpenSubtitles language code to translate from |
| `DAILY_LIMIT` | `25` | New translations/day. Day boundary = midnight in `QUOTA_TZ` (`Asia/Jerusalem`) |
| `BATCH_SIZE` / `BATCHES_PER_STEP` | `200` / `5` | Cues per Gemini request / parallel requests per step (max 6). `maxOutputTokens` is 32768 (200 cues ≈ 7k tokens) and structured-output (`responseSchema`) guarantees valid JSON |
| `WAIT_SECONDS` | `25` | How long the `.srt` request waits for a fresh translation before showing "in progress" |
| `FAIL_COOLDOWN_SECONDS` | `120` | After a failure, re-selecting within this time shows the error again without calling Gemini |
| `CACHE_TTL_DAYS` | `180` | KV cache lifetime |
| `RTL_MARKS` | `on` | Wrap lines of RTL languages in U+200F so punctuation lands on the correct side (**not verified in Stremio's player**; set `off` if it looks odd) |
| `ALLOWED_SOURCE_HOSTS` | `strem.io` | Only `.srt` URLs on these hosts (https) can be translated |
| `MAX_SOURCES` | `1` | How many source subtitles per title get a picker entry (each distinct one can use a translation) |

Secrets: `ACCESS_TOKEN`, `GEMINI_API_KEY`.

## Design

```
Stremio ──GET /subtitles/…json──► Worker ──► opensubtitles-v3.strem.io  (lists English subs)   → one "עברית - AI" entry
Stremio ──GET /translated/….srt─► Worker ─► KV hit?  ── yes ──► SRT (instant)
                                      │ no
                                      ├─ daily budget exhausted? → single-cue "limit reached" SRT
                                      └─ Durable Object (one per language+source URL), driven by alarm() steps:
                                            fetch  : download source .srt, store it
                                            plan   : parse, split into ~80-cue batches (with 3 lines of context)
                                            translate : 4 batches in parallel per step → Gemini generateContent (JSON in / JSON out)
                                            finalize  : re-attach ORIGINAL timing lines, write SRT to KV
                                      the .srt request just waits (wall-clock) for the job; > WAIT_SECONDS → "in progress" cue
```

Why a Durable Object + alarms: the Workers **Free** plan allows 10 ms CPU and 50 subrequests *per invocation*, and Stremio fetches the `.srt` once.
Every `alarm()` is a fresh invocation with fresh limits, progress is persisted in DO SQLite storage after each step (an interrupted step is just retried), and the
Gemini round-trips are I/O wait, which is not CPU time. The HTTP request that triggered the job only waits.

* **Timing is never sent to the model.** Only text goes to Gemini; the original timing lines are re-attached by position, so timing is identical by construction. The model must return the same `i` for every cue; missing/empty cues are re-requested (up to 4 attempts, backoff for 429/5xx), otherwise the job fails visibly.
* **Tags kept:** `<i>`, `<b>`, `<font …>`, `{\an8}` are in the prompt rules; ♪ and speaker dashes are preserved.
* **Daily limit:** KV counter per day (`quota:YYYY-MM-DD`), incremented when a *new* job starts (retries after failures count, cache hits and in-flight jobs don't). KV has no atomic increment; a race could overshoot by one - irrelevant for one user.
* **Errors:** quota, bad key/model, Gemini failure, unparsable source, stalled job (>5 min without progress) all return a one-cue SRT (`no-store`) with the reason. Failures are never cached.
* **Picker entry:** `lang` is the ISO 639-2 code `heb`, `label` is `עברית - AI`, `id` is `stremio-ai-he-<id>`. Stremio's Android app ignores `label` and shows a blank/"und" row for non-ISO `lang` text, so a real code is required. Consequence: on Android it shows as plain "עברית" next to real Hebrew subtitles, and Stremio's *preferred subtitle language = Hebrew* setting can auto-select it, which then requests the `.srt` and starts a translation. A listing request alone never starts a job; the `DAILY_LIMIT` (25/day) is the cap on auto-select cost.
* **Security:** token compared in constant time; wrong/no token → 404 for everything (also if `ACCESS_TOKEN` is unset); only `https` hosts under `ALLOWED_SOURCE_HOSTS` can be fetched.

## Cloudflare Free-plan limits this design relies on (verified Oct 2026 in the Cloudflare docs)

Sources: developers.cloudflare.com/workers/platform/limits/ , /durable-objects/platform/limits/ , /kv/platform/limits/ , /durable-objects/platform/pricing/

| Limit | Free plan | How this addon fits |
|---|---|---|
| Worker CPU per request | 10 ms (I/O wait not counted) | Front Worker does hashing/KV only; the heaviest step (parse ~1,700 cues) measured ≈2-3 ms in Node. |
| Subrequests per invocation | 50 (KV/Cache calls count) | ≤ ~10 per invocation (4 Gemini + a few DO/KV calls) |
| Simultaneous outgoing connections | 6 | `BATCHES_PER_STEP` capped at 6 |
| Wall time | unlimited while client connected; `alarm()` 15 min | .srt request waits ≤ 90 s; alarm steps are seconds |
| Durable Objects | allowed on Free **only with SQLite backend** (`new_sqlite_classes`, used here); 100k req/day, 100k rows written/day | one job ≈ 30 row writes and ~30 DO calls; 25 jobs/day is ≈ 1 % of the limits |
| KV | 100k reads/day, **1,000 writes/day**, 1 write/s per key, 25 MiB values | ≈ 2 writes per new translation |
| Workers requests | 100k/day | far below |

## Honest caveats

* **Not tested against real Gemini or Cloudflare** (no credentials). Gemini was mocked locally; see "Tests". Real-model output quality, real latency (my estimate: **~30-90 s** for the first view of a ~1,700-cue movie), and real free-tier Gemini rate limits (429s are retried, but a very low-RPM key could still fail) are unverified.
* **Stremio's own timeout for the subtitle download is unknown.** If it gives up before the translation is done, the user sees nothing/an error; re-selecting the subtitle later works (job continues and is cached). If this is a problem, a possible improvement is warming the cache from the *listing* request - at the cost of spending translations on titles that are never watched.
* **CPU on Free (measured live, wrangler tail):** front Worker 0-4 ms, DO alarm steps 1-3 ms, DO `wait()` RPC up to 7 ms over a ~57 s wait (event-driven, no polling). No 1102/CPU errors in 3 live translations (391/425/364 cues). 7 ms is under the 10 ms cap but is the tightest number; the $5/month Paid plan removes the risk.
* **RTL rendering** (`RTL_MARKS`) is untested in Stremio's players.
* KV is eventually consistent (up to ~60 s across locations); fine for one user.
* Gemini model names/APIs move quickly. `generateContent` (v1beta) is used; Google now labels it legacy in favour of the Interactions API but still supports it. If a model is retired the addon shows an error naming `GEMINI_MODELS`.
* Gemini free tier may use submitted content to improve Google products; subtitles are not personal data, but be aware (use a billed key to opt out).

## Rate limits / 429 (Phase 4)

* HTTP 429 is a **pause, not a failure**: the Durable Object honours Gemini's `retryDelay` (default 60 s), reschedules its alarm and does not count it against the 4-attempt limit. A `PerDay` quota pauses 6 h (and hits the deadline).
* Pacing: a per-model sliding 60 s window in DO state (`RPM_PER_MODEL`); with the free tier use `RPM_PER_MODEL=12`, `BATCHES_PER_STEP=2`.
* If the first model is paused, the next one in `GEMINI_MODELS` is used.
* The job fails with a clear message after `DEADLINE_SECONDS` (15 min).
* The "in progress" cue is a one-cue SRT served `Cache-Control: no-store` after `WAIT_SECONDS`; the player must re-select the subtitle ~1 minute later.
* Live measurement (paid-tier key, Oct 24 2026): 2,127 cues = 11 batches, 23 Gemini requests (retries for stray-script/partial output), 71 s end to end; 898 cues in 43 s. Max CPU seen 10 ms (DO `wait()` RPC, which also overlaps alarm work) - the free-plan CPU limit is the main residual risk.
* Mock scenarios: `npx tsx test/e2e-rl.mjs <paced|pause|fallback|gone|deadline>`.

## Tests

```bash
npm install
npm test                      # unit tests: SRT parse/serialize round trip (node:test via tsx)
npm run typecheck
# end-to-end against `wrangler dev` with a MOCK Gemini and the REAL OpenSubtitles addon:
cp .dev.vars.example .dev.vars
node test/mock-gemini.mjs &                                 # fake Gemini on :8799 (prefixes cues with "[he] ")
npx wrangler dev --port 8787 --persist-to /tmp/wr --var GEMINI_BASE_URL:http://127.0.0.1:8799 --var DAILY_LIMIT:4 &
npx tsx test/e2e.mjs                                        # needs internet (OpenSubtitles)
# in-progress notice: restart wrangler with --var WAIT_SECONDS:3 and run: npx tsx test/e2e-slow.mjs
```
For a real local run (real Gemini), put your key in `.dev.vars`, run `npx wrangler dev` without `GEMINI_BASE_URL`.

## Files

`wrangler.toml` · `src/index.ts` (router, token, CORS, manifest, listing, .srt endpoint) · `src/job.ts` (Durable Object job) · `src/gemini.ts` (batch translate + retries) ·
`src/srt.ts` · `src/quota.ts` · `src/config.ts` (vars, language table) · `deploy.sh` · `test/*` · `.dev.vars.example`
