import { DurableObject } from "cloudflare:workers";
import { cfg, langInfo, type Env } from "./config";
import { FatalTranslateError, ModelNotFoundError, RateLimitError, translateBatch } from "./gemini";
import { parseSrt, serializeSrt, type Cue } from "./srt";

/**
 * One TranslationJob Durable Object per (target language, source .srt URL).
 *
 * Why a Durable Object: the Workers Free plan allows only 10 ms CPU per invocation and 50 subrequests,
 * and Stremio fetches the .srt exactly once. The job is therefore split into small alarm steps; every
 * alarm() call is its own invocation with its own limits (wall time is not limited by CPU limits,
 * Gemini round trips are I/O wait and do not count as CPU):
 *   init      -> download the source .srt and store it                   (1 subrequest)
 *   plan      -> parse it and split into batches                          (0 subrequests)
 *   translate -> BATCHES_PER_STEP parallel Gemini calls per step         (<= 6 subrequests)
 *   finalize  -> assemble the SRT, write it to KV                        (1 subrequest)
 * All progress is persisted in DO (SQLite) storage after each step, so an interrupted step is simply retried.
 */

export interface JobParams {
  srtUrl: string;
  lang: string;
  cacheKey: string;
}

type Status = "idle" | "running" | "done" | "failed";
interface State {
  status: Status;
  phase: "init" | "plan" | "translate" | "finalize";
  params?: JobParams;
  nBatches: number;
  done?: boolean[]; // per-batch completion flags (batches finish out of order when 429s hit)
  wakeAt?: number; // when the next alarm should fire (set by steps that need to pause)
  models?: Record<string, { sent: number[]; pausedUntil: number; dead?: boolean }>; // per-model pacing state
  reqs?: number; // Gemini requests sent (all attempts)
  rl?: number; // number of 429 pauses
  lastRl?: string;
  total: number; // cue count
  error?: string;
  startedAt: number;
  lastProgress: number;
  finishedAt?: number;
}
export interface JobView {
  status: Status;
  progress: number; // 0..1
  total: number;
  paused?: boolean; // waiting out a Gemini rate limit
  parts?: [number, number]; // [done, total] batches
  error?: string;
  finishedAt?: number;
}

const STALL_MS = 10 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TranslationJob extends DurableObject<Env> {
  private async getState(): Promise<State> {
    return (
      (await this.ctx.storage.get<State>("state")) ?? {
        status: "idle", phase: "init", nBatches: 0, total: 0, startedAt: 0, lastProgress: 0,
      }
    );
  }

  private view(s: State): JobView {
    const nDone = (s.done ?? []).filter(Boolean).length;
    const progress = s.status === "done" ? 1 : s.nBatches ? nDone / s.nBatches : 0;
    const now = Date.now();
    const paused = s.status === "running" && Object.values(s.models ?? {}).length > 0 && Object.values(s.models!).every((m) => m.dead || m.pausedUntil > now);
    return { status: s.status, progress, total: s.total, error: s.error, finishedAt: s.finishedAt, paused, parts: [nDone, s.nBatches] };
  }

  private async fail(s: State, msg: string) {
    s.status = "failed";
    s.error = msg;
    s.finishedAt = Date.now();
    await this.ctx.storage.deleteAll(); // drop intermediate rows
    await this.ctx.storage.put("state", s);
  }

  async status(): Promise<JobView> {
    const s = await this.getState();
    if (s.status === "running" && Date.now() - s.lastProgress > STALL_MS) {
      await this.fail(s, "The translation job stalled (no progress for 10 minutes). Select the subtitle again to retry.");
      return this.view(await this.getState());
    }
    return this.view(s);
  }

  /** Start a job unless one is already running / on cooldown. Returns whether a NEW job was started. */
  async start(params: JobParams): Promise<{ started: boolean; job: JobView }> {
    const c = cfg(this.env);
    const s = await this.getState();
    if (s.status === "running") return { started: false, job: this.view(s) };
    if (s.status === "failed" && Date.now() - (s.finishedAt ?? 0) < c.failCooldownSeconds * 1000) {
      return { started: false, job: this.view(s) };
    }
    // idle, done (but cache entry missing) or failed with expired cooldown -> (re)start
    await this.ctx.storage.deleteAll();
    const now = Date.now();
    const ns: State = {
      status: "running", phase: "init", params, nBatches: 0, total: 0, startedAt: now, lastProgress: now,
    };
    await this.ctx.storage.put("state", ns);
    await this.ctx.storage.setAlarm(now + 1);
    return { started: true, job: this.view(ns) };
  }

  private waiters: Array<() => void> = [];
  private notify() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /**
   * Wait (wall-clock, not CPU) until the job leaves "running" or maxMs elapsed.
   * No polling: the alarm handler runs in this same instance and wakes the waiters, so a long wait costs ~0 CPU
   * (a polling version measured 9 ms CPU for a 20 s wait on the live Free plan - too close to the 10 ms limit).
   */
  async wait(maxMs: number): Promise<JobView> {
    const v = await this.status();
    if (v.status !== "running") return v;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, maxMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
    return this.status();
  }

  async alarm(): Promise<void> {
    const s = await this.getState();
    if (s.status !== "running" || !s.params) return;
    try {
      if (s.phase === "init") await this.stepFetch(s);
      else if (s.phase === "plan") await this.stepPlan(s);
      else if (s.phase === "translate") await this.stepTranslate(s);
      else await this.stepFinalize(s);
    } catch (e: any) {
      console.error("job step failed", s.phase, e?.message);
      const msg = e?.message ?? String(e);
      await this.fail(s, msg);
      this.notify();
      return;
    }
    if (s.status === "running") {
      const at = Math.max(Date.now() + 5, s.wakeAt ?? 0);
      if (s.wakeAt) {
        s.wakeAt = undefined;
        await this.ctx.storage.put("state", s);
      }
      await this.ctx.storage.setAlarm(at);
    } else this.notify();
  }

  /** Step 1: only download + store the raw text (keeps this invocation's CPU tiny). */
  private async stepFetch(s: State) {
    const p = s.params!;
    const res = await fetch(p.srtUrl, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new FatalTranslateError(`Could not download the source subtitle (HTTP ${res.status}).`);
    const raw = await res.text();
    if (raw.length > 1_000_000) throw new FatalTranslateError("The source subtitle file is unexpectedly large (> 1 MB).");
    await this.ctx.storage.put("raw", raw);
    s.phase = "plan";
    s.lastProgress = Date.now();
    await this.ctx.storage.put("state", s);
  }

  /** Step 2: parse + split into batches (the only CPU-heavy part, ~3-5 ms for a 1,700-cue file). */
  private async stepPlan(s: State) {
    const c = cfg(this.env);
    const raw = (await this.ctx.storage.get<string>("raw"))!;
    const cues = parseSrt(raw).filter((q) => q.text.trim() !== "");
    if (!cues.length) throw new FatalTranslateError("The source subtitle could not be parsed as SRT (0 cues found).");
    if (cues.length > c.maxCues) throw new FatalTranslateError(`The source subtitle has ${cues.length} cues; the limit is ${c.maxCues}.`);

    // split into batches by count and by characters
    const batches: { ctx: string[]; items: { i: number; t: string }[] }[] = [];
    let cur: { i: number; t: string }[] = [];
    let chars = 0;
    const flush = () => {
      if (!cur.length) return;
      const first = cur[0].i;
      batches.push({ ctx: cues.slice(Math.max(0, first - 3), first).map((q) => q.text), items: cur });
      cur = [];
      chars = 0;
    };
    cues.forEach((q, i) => {
      if (cur.length >= c.batchSize || (cur.length && chars + q.text.length > 14000)) flush();
      cur.push({ i, t: q.text });
      chars += q.text.length;
    });
    flush();
    if (batches.length > 120) throw new FatalTranslateError("The source subtitle needs too many batches.");

    const entries: Record<string, unknown> = { meta: cues.map((q) => q.timing) };
    batches.forEach((b, n) => (entries[`in:${n}`] = b));
    await this.ctx.storage.put(entries);
    await this.ctx.storage.delete("raw");
    s.nBatches = batches.length;
    s.done = new Array(batches.length).fill(false);
    s.total = cues.length;
    s.phase = "translate";
    s.lastProgress = Date.now();
    await this.ctx.storage.put("state", s);
  }

  /**
   * One translate step. Pacing: at most c.rpmPerModel Gemini requests per rolling minute per model (tracked in
   * state), at most c.batchesPerStep in parallel. HTTP 429 is a pause (honours retryDelay), never a failure;
   * models are tried in order, so a rate-limited primary hands over to the next one. Overall deadline c.deadlineSeconds.
   */
  private async stepTranslate(s: State) {
    const c = cfg(this.env);
    if (!this.env.GEMINI_API_KEY) throw new FatalTranslateError("GEMINI_API_KEY secret is not set on the Worker.");
    const now = Date.now();
    const deadlineAt = s.startedAt + c.deadlineSeconds * 1000;
    const done = (s.done ??= new Array(s.nBatches).fill(false));
    const st = (s.models ??= {});
    for (const m of c.models) {
      st[m] ??= { sent: [], pausedUntil: 0 };
      st[m].sent = st[m].sent.filter((t) => now - t < 60_000);
    }
    const live = c.models.filter((m) => !st[m].dead);
    if (!live.length) throw new FatalTranslateError(`No usable Gemini model is configured (${c.models.join(", ")}).`);
    const readyAt = (m: string) => (st[m].sent.length >= c.rpmPerModel ? st[m].sent[0] + 60_000 : 0);
    const model = live.find((m) => st[m].pausedUntil <= now && readyAt(m) <= now);
    if (!model) {
      const wake = Math.min(...live.map((m) => Math.max(st[m].pausedUntil, readyAt(m), now + 1000))) + 250;
      if (wake > deadlineAt) {
        throw new Error(
          `Gemini's free-tier rate limit kept blocking the translation for ${Math.round(c.deadlineSeconds / 60)} minutes (HTTP 429${s.lastRl ? `: ${s.lastRl}` : ""}). Try again later.`,
        );
      }
      s.wakeAt = wake;
      s.lastProgress = now;
      await this.ctx.storage.put("state", s);
      return;
    }
    if (now > deadlineAt) {
      throw new Error(`The translation did not finish within ${Math.round(c.deadlineSeconds / 60)} minutes (rate limits / errors). Try again later.`);
    }
    const free = c.rpmPerModel - st[model].sent.length;
    const todo: number[] = [];
    for (let n = 0; n < s.nBatches && todo.length < Math.min(c.batchesPerStep, free); n++) if (!done[n]) todo.push(n);
    const inputs = await this.ctx.storage.get<{ ctx: string[]; items: { i: number; t: string }[] }>(todo.map((n) => `in:${n}`));
    const onRequest = (m: string) => {
      st[m].sent.push(Date.now());
      s.reqs = (s.reqs ?? 0) + 1;
    };
    const settled = await Promise.allSettled(
      todo.map(async (n) => {
        const b = inputs.get(`in:${n}`)!;
        const out = await translateBatch(this.env.GEMINI_API_KEY, c, model, onRequest, s.params!.lang, b.ctx, b.items);
        return [n, b.items.map((it) => out.get(it.i) as string)] as const;
      }),
    );
    const outRows: Record<string, string[]> = {};
    let hardError: unknown;
    for (const r of settled) {
      if (r.status === "fulfilled") {
        outRows[`out:${r.value[0]}`] = r.value[1];
        done[r.value[0]] = true;
      } else if (r.reason instanceof RateLimitError) {
        const ms = r.reason.retryAfterMs;
        st[model].pausedUntil = Math.max(st[model].pausedUntil, Date.now() + ms);
        s.rl = (s.rl ?? 0) + 1;
        s.lastRl = r.reason.message.slice(0, 160);
        console.log(`429 on ${model}: pausing ${Math.round(ms / 1000)}s${r.reason.daily ? " (daily quota)" : ""}`);
      } else if (r.reason instanceof ModelNotFoundError && live.length > 1) {
        st[model].dead = true;
        console.log(`model ${model} unavailable (404); skipping it`);
      } else hardError ??= r.reason;
    }
    if (Object.keys(outRows).length) await this.ctx.storage.put(outRows);
    s.lastProgress = Date.now();
    if (done.every(Boolean)) s.phase = "finalize";
    await this.ctx.storage.put("state", s); // persist successes + pacing even if a hard error follows
    if (hardError) throw hardError;
  }

  private async stepFinalize(s: State) {
    const c = cfg(this.env);
    const [, , rtl] = langInfo(s.params!.lang);
    const meta = (await this.ctx.storage.get<string[]>("meta"))!;
    const keys: string[] = [];
    for (let n = 0; n < s.nBatches; n++) keys.push(`out:${n}`);
    const texts: string[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const part = await this.ctx.storage.get<string[]>(keys.slice(i, i + 100));
      for (const k of keys.slice(i, i + 100)) texts.push(...part.get(k)!);
    }
    if (texts.length !== meta.length) throw new Error(`internal error: ${texts.length} translated cues vs ${meta.length} timings`);
    const cues: Cue[] = meta.map((timing, i) => ({
      index: i + 1,
      timing,
      text: c.rtlMarks && rtl ? texts[i].split("\n").map((l) => (l.trim() ? `\u200F${l}\u200F` : l)).join("\n") : texts[i],
    }));
    const out = serializeSrt(cues);
    await this.env.CACHE.put(s.params!.cacheKey, out, { expirationTtl: c.cacheTtlSeconds });
    console.log(`job done: cues=${meta.length} batches=${s.nBatches} gemini_requests=${s.reqs ?? 0} pauses_429=${s.rl ?? 0} elapsed_s=${Math.round((Date.now() - s.startedAt) / 1000)}`);
    s.status = "done";
    s.finishedAt = Date.now();
    const body = out;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("state", { ...s, phase: "init" });
    // keep a copy in the DO too: KV is eventually consistent and a recent cache miss can be
    // served from the edge's negative cache for up to ~60 s, so the front worker must not rely
    // on an immediate KV read-back.
    await this.ctx.storage.put("result", body);
  }

  async result(): Promise<string | null> {
    const s = await this.getState();
    if (s.status !== "done") return null;
    return (await this.ctx.storage.get<string>("result")) ?? null;
  }
}
