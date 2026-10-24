# Stremio Hebrew AI Subtitles (Cloudflare Worker + Gemini)

A [Stremio](https://www.stremio.com) addon that adds an **AI-translated Hebrew subtitle** to any movie or series that has an English subtitle.

It takes the English subtitle that Stremio already offers, translates the **text only** with Google Gemini, re-attaches the **original timing**, caches the result, and shows it in the player's subtitle menu. Other target languages are a one-line config change.

It runs entirely on **Cloudflare Workers** (Free plan is enough), so once installed it works on **every device signed in to your Stremio account** (phone, TV, desktop) without your own computer or phone being on.

> **Cost and privacy in one paragraph.** You bring your own Gemini API key and your own Cloudflare account. Cloudflare Free is $0. A Gemini key on the free tier is $0 but is rate limited (see [Gemini key](#2-get-a-gemini-api-key)); a billed key costs a small amount per movie. The addon URL contains a private token, so keep it to yourself: anyone who has the URL can spend your Gemini quota. A hard cap of **25 new translations per day** limits the damage either way.

---

## How it looks to the user

1. Play a movie or episode in Stremio (any stream).
2. Open the subtitles menu, tap **עברית** (Hebrew), and choose the entry named **AI Subtitles (Hebrew)**. On Android, Stremio ignores custom labels, so it shows as plain Hebrew next to real Hebrew subtitles; the AI one is the entry listed under this addon.
3. The **first** time for a title, a one-line message appears: *"AI translation in progress … not an error"*. A full movie takes about **1 to 3 minutes**. Turn subtitles off and select it again after about a minute.
4. Done. The full Hebrew subtitle plays. The result is cached for 180 days, so every device (and everyone using your addon) gets it instantly afterwards.
5. If you see *"AI translation failed"*, wait about 2 minutes and select it again. Failures are never cached.

---

## Install it yourself (about 10 minutes)

You need: a **Cloudflare account** (free), a **Google account** for the Gemini key, **Node.js 20 or newer**, and `git`.

### 1. Get the code

```bash
git clone https://github.com/OferLazmi/stremio-hebrew-ai-subs.git
cd stremio-hebrew-ai-subs
```

(If the repo is private, ask the owner for access first.)

### 2. Get a Gemini API key

1. Open <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key** and copy it. Keep it secret.
3. Pick the tier:
   * **Free tier (no billing).** Works, but Google limits it to roughly **15 requests per minute per model**. Set `RPM_PER_MODEL = "12"` and `BATCHES_PER_STEP = "2"` in `wrangler.toml` before deploying. A movie then takes a few minutes the first time. Google may use free-tier content to improve its products (subtitles are not personal data).
   * **Billed tier (recommended).** Attach a billing account to the key's project in AI Studio ("Set up billing" on the key). Rate limits are much higher, and a full movie translates in roughly 1 minute. Cost is per use and small (a movie is about 10 to 25 requests on a cheap model). Google is moving AI Studio accounts to prepaid credits, so you may be asked to buy credits (minimum $5) instead of paying afterwards.

### 3. Create a Cloudflare API token

1. Sign up or log in at <https://dash.cloudflare.com>.
2. Open **Workers & Pages** once. If it asks you to choose a `workers.dev` subdomain, pick one (this is part of your final addon URL).
3. Find your **Account ID** (Workers & Pages page, right-hand sidebar).
4. Go to **My Profile → API Tokens → Create Token → Create Custom Token** and give it exactly these permissions:
   * **Account → Workers Scripts → Edit**
   * **Account → Workers KV Storage → Edit**
   * **Account → Account Settings → Read**
5. Copy the token.

### 4. Deploy

```bash
export CLOUDFLARE_API_TOKEN=...             # from step 3
export CLOUDFLARE_ACCOUNT_ID=...            # from step 3
export GEMINI_API_KEY=...                   # from step 2
export ACCESS_TOKEN=$(openssl rand -hex 24) # private token for your addon URL
echo "$ACCESS_TOKEN"                        # save it somewhere safe!
./deploy.sh
```

The script installs dependencies, creates (or reuses) a KV namespace named `stremio-ai-subs-cache`, deploys the Worker, stores `ACCESS_TOKEN` and `GEMINI_API_KEY` as Worker secrets, runs a smoke test, and prints your install URL:

```
https://stremio-he-subs.<your-subdomain>.workers.dev/<ACCESS_TOKEN>/manifest.json
```

Useful: `DRY_RUN=1 ./deploy.sh` only validates inputs and bundles the Worker, without calling Cloudflare.

<details>
<summary>Manual deploy instead of the script</summary>

```bash
npm install
npx wrangler login                      # or export CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
npx wrangler kv namespace create CACHE  # copy the printed id into wrangler.toml -> [[kv_namespaces]] id
npx wrangler deploy
npx wrangler secret put ACCESS_TOKEN    # e.g. output of: openssl rand -hex 24
npx wrangler secret put GEMINI_API_KEY
```
</details>

### 5. Add the addon to Stremio

Stremio addons belong to your account, so install once and it appears on all your devices.

* **Any platform (works everywhere):** open Stremio → **Addons** → type or paste your full `https://…/manifest.json` URL into the search box at the top → **Install**.
* **Desktop shortcut:** open `stremio://stremio-he-subs.<your-subdomain>.workers.dev/<ACCESS_TOKEN>/manifest.json` in a browser.
* **Android note:** the `stremio://` link does not always open from a browser; pasting the `https://` URL into the Addons search box always works.

Then play something and use the subtitles menu as described [above](#how-it-looks-to-the-user).

### Updating later

Pull the latest code and run `./deploy.sh` again with the same environment variables (use the **same** `ACCESS_TOKEN` so your install URL does not change). No reinstall in Stremio is needed.

### Uninstalling

Stremio → Addons → remove the addon. In Cloudflare, delete the Worker `stremio-he-subs` and the KV namespace `stremio-ai-subs-cache`. Revoke the Cloudflare API token and the Gemini key if you no longer need them.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Subtitle menu has no AI entry | Open the **עברית** language row (not the English one) and look for "AI Subtitles (Hebrew)". Stremio only asks addons for subtitles once a real stream is **playing** (not trailers). Make sure the addon is installed and shows in Addons. |
| "AI translation in progress" | Normal for the first view. Wait about a minute, turn subtitles off, select it again. |
| "AI translation failed … Gemini HTTP 429" | Your Gemini key hit its rate limit. Use the free-tier settings in step 2, or attach billing. The Worker already waits and retries on 429. |
| "Gemini HTTP 400/403 … API key" | Wrong or disabled key. Re-run `./deploy.sh` with the right `GEMINI_API_KEY`. |
| "Daily limit reached" | The 25 new translations per day cap (cached titles are free). Raise `DAILY_LIMIT` in `wrangler.toml` and redeploy. |
| Addon URL returns 404 | Wrong `ACCESS_TOKEN` in the URL. |
| Deploy says no `workers.dev` subdomain | Open Workers & Pages in the dashboard once and choose a subdomain, then re-run. |
| Stray Arabic letters in a few lines | Rare model slip; the Worker retries and rejects wrong-script output, but a few lines can still slip through after 4 tries. |
| Subtitle looks late or early | Timing is copied from the source subtitle, so the English one from the same source is equally off. Use Stremio's subtitle delay control. |

---

## Configuration (`[vars]` in `wrangler.toml`)

| Var | Default | Meaning |
|---|---|---|
| `GEMINI_MODELS` | `gemini-3.5-flash-lite,gemini-3-flash-preview` | Preferred model first. The next is used only while the first is rate-limit paused or returns 404. |
| `RPM_PER_MODEL` | `60` | Requests per minute per model. Use `12` on the Gemini free tier. |
| `BATCH_SIZE` / `BATCHES_PER_STEP` | `200` / `5` | Subtitle cues per Gemini request / parallel requests (max 6). Use `2` parallel on the free tier. |
| `DEADLINE_SECONDS` | `900` | The job fails with a clear message after this long. |
| `TARGET_LANGS` | `he` | Comma list of target languages (for example `he,ru,es,ar,fr,de`; see `LANGS` in `src/config.ts`). One picker entry each. |
| `SOURCE_LANG` | `eng` | Language of the subtitle to translate from. |
| `DAILY_LIMIT` | `25` | Max **new** translations per day (day rolls over at midnight in `QUOTA_TZ`). |
| `QUOTA_TZ` | `Asia/Jerusalem` | Time zone for the daily reset. |
| `WAIT_SECONDS` | `25` | How long the subtitle request waits before showing the "in progress" line. |
| `FAIL_COOLDOWN_SECONDS` | `120` | After a failure, retrying sooner shows the error again without calling Gemini. |
| `CACHE_TTL_DAYS` | `180` | How long finished translations stay cached. |
| `RTL_MARKS` | `on` | Wrap right-to-left lines in a direction mark so punctuation lands on the correct side. Set `off` if it looks odd in your player. |
| `ALLOWED_SOURCE_HOSTS` | `strem.io` | Only https subtitle URLs on these hosts can be translated. |
| `MAX_SOURCES` | `1` | How many source subtitles per title get an entry. |

Secrets (set by `deploy.sh`, never in git): `ACCESS_TOKEN`, `GEMINI_API_KEY`.

---

## How it works

```
Stremio ── GET /subtitles/…json ──► Worker ──► opensubtitles-v3.strem.io (lists English subs)
                                      └─ returns one "AI Subtitles (Hebrew)" entry (lang "heb")
Stremio ── GET /translated/….srt ─► Worker ─► cached in KV? ── yes ──► SRT (instant)
                                      │ no
                                      ├─ daily budget used up? → one-line "limit reached" SRT
                                      └─ Durable Object (one per language + source URL), driven by alarm steps:
                                           fetch → plan (parse, ~200-cue batches) → translate (parallel Gemini calls)
                                           → finalize (re-attach ORIGINAL timing, store in KV)
```

* **Timing is never sent to the model.** Only text goes to Gemini and the original timing lines are re-attached by position, so timing is identical by construction. Missing or empty cues are re-requested (up to 4 tries), otherwise the job fails visibly.
* **Formatting kept:** `<i>`, `<b>`, `<font>`, `{\an8}`, music notes and speaker dashes.
* **429 is a pause, not a failure:** the job honours Gemini's `retryDelay`, reschedules itself, and can switch to the next model in `GEMINI_MODELS`.
* **Why Durable Objects:** the Workers Free plan allows 10 ms of CPU and 50 subrequests per invocation. Each alarm step is a fresh invocation, progress is saved after every step, and waiting for Gemini is I/O (not CPU).
* **Errors are visible:** a one-line subtitle explains what went wrong. There is no silent fallback to another translation engine. Failures are never cached.
* **Security:** the token is compared in constant time; a wrong or missing token returns 404 for everything; only https hosts listed in `ALLOWED_SOURCE_HOSTS` are fetched.
* **Picker entry:** `lang` is the ISO 639-2 code `heb` because Stremio's Android app hides entries with non-ISO language text and ignores labels. Consequence: if your Stremio *preferred subtitle language* is Hebrew, Stremio may auto-select it and start a translation. The daily cap bounds that cost.

### Endpoints

| Path | Purpose |
|---|---|
| `/{TOKEN}/manifest.json` | Stremio manifest (subtitles, movie and series, ids starting `tt`) |
| `/{TOKEN}/subtitles/{type}/{id}[/{extra}].json` | Lists the AI subtitle entry for a title |
| `/{TOKEN}/translated/{lang}.{base64url(source .srt URL)}.srt` | Translates on first request, then serves from cache |

### Cloudflare Free-plan limits this relies on

| Limit | Free plan | Fit |
|---|---|---|
| Worker CPU per invocation | 10 ms (I/O wait not counted) | Measured 0 to 10 ms; the tightest spot is the 10 ms Durable Object wait call. If you ever see error 1102, lower `BATCHES_PER_STEP` to 3, or use the $5/month Paid plan. |
| Subrequests per invocation | 50 | Under about 10 |
| Durable Objects | SQLite backend only (used here) | About 30 row writes per new translation |
| KV writes | 1,000 per day | About 2 per new translation |

### Measured results (Oct 2026, billed Gemini key)

2,127 cues in 71 s (23 requests); 898 cues in 43 s; 592 cues in 46 s. Timing identical to the source in all cases; a handful of stray Arabic letters in the largest titles.

---

## Known limitations

* Needs an **English subtitle** to exist for the title (it translates, it does not transcribe audio).
* Stremio's own timeout for the first request is unknown. The Worker answers within 25 s with the "in progress" line, and the job keeps running and is cached for the next try.
* Stremio only requests subtitles when a real stream is playing.
* Right-to-left rendering depends on the player; try `RTL_MARKS = "off"` if lines look odd.
* `gemini-3-flash-preview` is a preview model and could be retired; update `GEMINI_MODELS` if so.
* This is a personal tool, provided as is. You are responsible for your own API keys and costs, and for respecting the terms of the services and content you use it with.

---

## Development and tests

```bash
npm install
npm test                      # unit tests (SRT parse/serialize)
npm run typecheck
# end-to-end against `wrangler dev` with a MOCK Gemini and the real OpenSubtitles addon:
cp .dev.vars.example .dev.vars
node test/mock-gemini.mjs &
npx wrangler dev --port 8787 --persist-to /tmp/wr --var GEMINI_BASE_URL:http://127.0.0.1:8799 --var DAILY_LIMIT:4 &
npx tsx test/e2e.mjs                           # needs internet
# 429 handling scenarios: npx tsx test/e2e-rl.mjs <paced|pause|fallback|gone|deadline>
```

For a real local run, put your key in `.dev.vars` and run `npx wrangler dev` without `GEMINI_BASE_URL`.

### Files

`wrangler.toml` · `src/index.ts` (router, token, manifest, listing, .srt endpoint) · `src/job.ts` (Durable Object job) · `src/gemini.ts` (batching, retries, 429 handling) · `src/srt.ts` · `src/quota.ts` · `src/config.ts` (vars, language table) · `deploy.sh` · `test/*` · `.dev.vars.example`

## License

MIT
