import type { Cfg } from "./config";
import { langInfo, SOURCE_NAMES } from "./config";

/** Thrown for errors that retrying cannot fix (bad key, bad model, blocked content ...). */
export class FatalTranslateError extends Error {}

export interface BatchItem {
  i: number;
  t: string;
}

/** HTTP 429: a pause, not a failure. The caller reschedules; it never counts against the attempt limit. */
export class RateLimitError extends Error {
  constructor(msg: string, public retryAfterMs: number, public daily = false) {
    super(msg);
  }
}
/** HTTP 404 for one model (retired/unavailable). Fatal only if no other model is configured. */
export class ModelNotFoundError extends FatalTranslateError {}

export function parseRetryDelayMs(headerVal: string | null, body: string): number {
  let sec: number | undefined;
  const m1 = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body);
  const m2 = /retry in ([\d.]+)\s*s/i.exec(body);
  if (m1) sec = parseFloat(m1[1]);
  else if (m2) sec = parseFloat(m2[1]);
  else if (headerVal && /^\d+(\.\d+)?$/.test(headerVal.trim())) sec = parseFloat(headerVal);
  const ms = sec !== undefined && Number.isFinite(sec) ? sec * 1000 + 2000 : 60_000;
  return Math.min(Math.max(ms, 5_000), 300_000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS_MS = [2000, 6000, 15000]; // => up to 4 attempts per batch

function systemPrompt(sourceLang: string, targetLang: string): string {
  const src = SOURCE_NAMES[sourceLang] ?? sourceLang;
  const tgt = langInfo(targetLang)[0];
  return [
    `You are a professional subtitle translator. Translate movie/TV subtitles from ${src} to ${tgt}.`,
    `Input is a JSON object: {"context":[...previous lines, for context only, do NOT translate them...],"cues":[{"i":<number>,"t":"<text>"}, ...]}.`,
    `Output ONLY a JSON object: {"cues":[{"i":<number>,"t":"<translated text>"}, ...]}.`,
    `Rules:`,
    `- Return exactly one output cue for every input cue, with the same "i" values. Never merge, split, drop or reorder cues.`,
    `- Keep line breaks inside a cue as "\\n". Keep it short and natural, suitable for on-screen subtitles, in the same register as the speaker.`,
    `- Keep all markup untouched and in a sensible position: <i>, </i>, <b>, <font ...>, {\\an8}, and similar tags.`,
    `- Keep music symbols (♪, #) and speaker dashes ("-") as they are. Translate sound descriptions in [brackets] or (parentheses).`,
    `- Write only in the target language's own script${SCRIPT_NAME[targetLang] ? ` (${SCRIPT_NAME[targetLang]} letters only - never mix in letters of other scripts such as Arabic)` : ""}, apart from names/acronyms that stay in Latin letters.`,
    `- Keep proper names recognisable; do not add notes, explanations or transliteration remarks.`,
    `- If a cue contains only symbols, numbers or markup, return it unchanged.`,
  ].join("\n");
}

/** Scripts that must NOT appear in a translation into this language (Gemini Flash-Lite occasionally leaks Arabic letters into Hebrew). */
const FORBIDDEN_SCRIPT: Record<string, RegExp> = { he: /[\u0600-\u06FF]/ };
const SCRIPT_NAME: Record<string, string> = { he: "Hebrew" };
export function leaksWrongScript(lang: string, source: string, t: string): boolean {
  const re = FORBIDDEN_SCRIPT[lang];
  return !!re && re.test(t) && !re.test(source);
}

function extractJson(text: string): any {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error("Gemini returned text that is not valid JSON");
  }
}

/** Last resort for malformed JSON: pull out every well-formed {"i":N,"t":"..."} object individually. */
export function salvageCues(text: string): any[] {
  const out: any[] = [];
  const re = /\{\s*"i"\s*:\s*(\d+)\s*,\s*"t"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      out.push({ i: parseInt(m[1], 10), t: JSON.parse(m[2]) });
    } catch {}
  }
  return out;
}

class RetryableError extends Error {}

async function callOnce(
  apiKey: string,
  c: Cfg,
  model: string,
  onRequest: (model: string) => void,
  targetLang: string,
  context: string[],
  items: BatchItem[],
): Promise<Map<number, string>> {
  const url = `${c.geminiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(c.sourceLang, targetLang) }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify({ context, cues: items }) }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 32768,
      responseMimeType: "application/json",
      // constrained decoding: guarantees syntactically valid JSON (an unescaped quote in a 200-cue answer otherwise breaks the whole batch)
      responseSchema: {
        type: "OBJECT",
        properties: {
          cues: {
            type: "ARRAY",
            items: { type: "OBJECT", properties: { i: { type: "INTEGER" }, t: { type: "STRING" } }, required: ["i", "t"] },
          },
        },
        required: ["cues"],
      },
    },
    // Subtitles contain violence/profanity; we are translating, not generating.
    safetySettings: [
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "HARM_CATEGORY_DANGEROUS_CONTENT",
    ].map((category) => ({ category, threshold: "BLOCK_NONE" })),
  };
  let res: Response;
  onRequest(model);
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
  } catch (e: any) {
    throw new RetryableError(`network error talking to Gemini (${e?.message ?? e})`);
  }
  if (!res.ok) {
    const detailFull = await res.text().catch(() => "");
    const detail = detailFull.slice(0, 300).replace(/\s+/g, " ");
    if (res.status === 429) {
      const daily = /PerDay/i.test(detailFull);
      throw new RateLimitError(`Gemini HTTP 429 on ${model} (rate limit): ${detail}`, daily ? 6 * 3600_000 : parseRetryDelayMs(res.headers.get("retry-after"), detailFull), daily);
    }
    if (res.status >= 500) {
      throw new RetryableError(`Gemini HTTP ${res.status} (rate limit/overload): ${detail}`);
    }
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      const hint =
        res.status === 404
          ? ` Check the GEMINI_MODELS setting ("${model}").`
          : res.status === 400 && /API key/i.test(detail)
            ? " The GEMINI_API_KEY looks invalid."
            : res.status === 401 || res.status === 403
              ? " Check that GEMINI_API_KEY is valid and has access to the Gemini API."
              : "";
      const msg = `Gemini HTTP ${res.status}.${hint} ${detail}`.trim();
      throw res.status === 404 ? new ModelNotFoundError(msg) : new FatalTranslateError(msg);
    }
    throw new RetryableError(`Gemini HTTP ${res.status}: ${detail}`);
  }
  const data: any = await res.json();
  if (data?.promptFeedback?.blockReason) {
    throw new RetryableError(`Gemini blocked the request (${data.promptFeedback.blockReason})`);
  }
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
  if (!text) throw new RetryableError(`Gemini returned no text (finishReason=${cand?.finishReason ?? "unknown"})`);
  let parsed: any;
  try {
    parsed = extractJson(text);
  } catch (e: any) {
    const salv = salvageCues(text);
    if (!salv.length) throw new RetryableError(e.message + (cand?.finishReason === "MAX_TOKENS" ? " (output truncated)" : ""));
    parsed = salv; // missing/garbled cues are re-requested by the caller's retry loop
  }
  const out = new Map<number, string>();
  const arr: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cues) ? parsed.cues : [];
  for (const o of arr) {
    if (o && Number.isInteger(o.i) && typeof o.t === "string") out.set(o.i, o.t);
  }
  return out;
}

/**
 * Translate one batch. A 429 throws RateLimitError immediately (pause, not failure). Retries (only the still-missing cues) on rate limits, overloads,
 * malformed/partial output. Throws FatalTranslateError or Error when giving up.
 */
export async function translateBatch(
  apiKey: string,
  c: Cfg,
  model: string,
  onRequest: (model: string) => void,
  targetLang: string,
  context: string[],
  items: BatchItem[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const tainted = new Map<number, string>(); // wrong-script output; used only if retries never produce a clean one
  let lastErr = "unknown error";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const missing = items.filter((it) => !result.has(it.i));
    if (!missing.length) return result;
    try {
      const got = await callOnce(apiKey, c, model, onRequest, targetLang, context, missing);
      for (const it of missing) {
        const t = got.get(it.i);
        // an empty translation of a non-empty cue counts as missing
        if (t === undefined || (t.trim() === "" && it.t.trim() !== "")) continue;
        if (leaksWrongScript(targetLang, it.t, t)) tainted.set(it.i, t);
        else result.set(it.i, t);
      }
      if (items.every((it) => result.has(it.i))) return result;
      lastErr = `Gemini returned ${result.size}/${items.length} usable cues for a batch`;
    } catch (e: any) {
      if (e instanceof FatalTranslateError || e instanceof RateLimitError) throw e;
      lastErr = e?.message ?? String(e);
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }
  // Out of attempts: a cue that is translated but still has a stray foreign letter beats failing the whole title.
  for (const it of items) if (!result.has(it.i) && tainted.has(it.i)) result.set(it.i, tainted.get(it.i)!);
  if (items.every((it) => result.has(it.i))) return result;
  throw new Error(`${lastErr} (gave up after ${RETRY_DELAYS_MS.length + 1} attempts)`);
}
