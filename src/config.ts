import type { TranslationJob } from "./job";

export interface Env {
  // bindings
  CACHE: KVNamespace;
  TRANSLATION_JOB: DurableObjectNamespace<TranslationJob>;
  // secrets
  ACCESS_TOKEN: string;
  GEMINI_API_KEY: string;
  // vars (all optional; defaults in cfg())
  GEMINI_MODEL?: string;
  GEMINI_MODELS?: string;
  RPM_PER_MODEL?: string;
  DEADLINE_SECONDS?: string;
  GEMINI_BASE_URL?: string;
  OPENSUBTITLES_BASE?: string;
  TARGET_LANGS?: string;
  SOURCE_LANG?: string;
  DAILY_LIMIT?: string;
  QUOTA_TZ?: string;
  BATCH_SIZE?: string;
  BATCHES_PER_STEP?: string;
  MAX_CUES?: string;
  WAIT_SECONDS?: string;
  FAIL_COOLDOWN_SECONDS?: string;
  CACHE_TTL_DAYS?: string;
  ALLOWED_SOURCE_HOSTS?: string;
  RTL_MARKS?: string;
  MAX_SOURCES?: string;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};

export function cfg(env: Env) {
  return {
    // Ordered list: the first model is preferred; later ones are used while earlier ones are rate-limited
    // (free-tier limits are per model). GEMINI_MODEL (single) is still honoured when GEMINI_MODELS is unset.
    models: ((env.GEMINI_MODELS || env.GEMINI_MODEL || "gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean)),
    model: (env.GEMINI_MODELS || env.GEMINI_MODEL || "gemini-3.5-flash-lite").split(",")[0].trim(),
    rpmPerModel: Math.max(1, num(env.RPM_PER_MODEL, 12)),
    deadlineSeconds: num(env.DEADLINE_SECONDS, 900),
    geminiBase: (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, ""),
    osBase: (env.OPENSUBTITLES_BASE || "https://opensubtitles-v3.strem.io").replace(/\/+$/, ""),
    targetLangs: (env.TARGET_LANGS || "he").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    sourceLang: (env.SOURCE_LANG || "eng").trim().toLowerCase(), // OpenSubtitles uses ISO 639-2 ("eng")
    dailyLimit: num(env.DAILY_LIMIT, 25),
    quotaTz: env.QUOTA_TZ || "Asia/Jerusalem",
    batchSize: Math.max(10, num(env.BATCH_SIZE, 200)),
    batchesPerStep: Math.max(1, Math.min(6, num(env.BATCHES_PER_STEP, 3))), // 6 = simultaneous-connection limit
    maxCues: num(env.MAX_CUES, 4000),
    waitSeconds: num(env.WAIT_SECONDS, 25),
    failCooldownSeconds: num(env.FAIL_COOLDOWN_SECONDS, 120),
    cacheTtlSeconds: Math.round(num(env.CACHE_TTL_DAYS, 180) * 86400),
    allowedHosts: (env.ALLOWED_SOURCE_HOSTS || "strem.io").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    rtlMarks: (env.RTL_MARKS || "on").toLowerCase() !== "off",
    maxSources: Math.max(1, Math.min(3, num(env.MAX_SOURCES, 1))),
  };
}
export type Cfg = ReturnType<typeof cfg>;

// Target languages: code -> [English name for the prompt, label shown in Stremio, is RTL]
export const LANGS: Record<string, [string, string, boolean]> = {
  he: ["Hebrew", "עברית - AI", true],
  ar: ["Arabic", "العربية - AI", true],
  fa: ["Persian", "فارسی - AI", true],
  ur: ["Urdu", "اردو - AI", true],
  ru: ["Russian", "Русский - AI", false],
  uk: ["Ukrainian", "Українська - AI", false],
  es: ["Spanish", "Español - AI", false],
  fr: ["French", "Français - AI", false],
  de: ["German", "Deutsch - AI", false],
  it: ["Italian", "Italiano - AI", false],
  pt: ["Portuguese", "Português - AI", false],
  tr: ["Turkish", "Türkçe - AI", false],
  pl: ["Polish", "Polski - AI", false],
  nl: ["Dutch", "Nederlands - AI", false],
  ja: ["Japanese", "日本語 - AI", false],
  ko: ["Korean", "한국어 - AI", false],
  zh: ["Chinese (Simplified)", "中文 - AI", false],
  hi: ["Hindi", "हिन्दी - AI", false],
};
export const SOURCE_NAMES: Record<string, string> = { eng: "English", spa: "Spanish", fre: "French", ger: "German", heb: "Hebrew" };

// ISO 639-2 codes Stremio understands (the "lang" field of a subtitle entry). Android ignores `label`
// and shows "und"/blank for non-ISO `lang` text, so we must send a real code.
export const ISO3: Record<string, string> = {
  he: "heb", ar: "ara", fa: "per", ur: "urd", ru: "rus", uk: "ukr", es: "spa", fr: "fre", de: "ger", it: "ita",
  pt: "por", tr: "tur", pl: "pol", nl: "dut", ja: "jpn", ko: "kor", zh: "chi", hi: "hin",
};

export function langInfo(code: string) {
  return LANGS[code] ?? [code, `${code} - AI`, false];
}
