/**
 * Pure, side-effect-free logic shared by the server and the browser:
 * voice validation, script validation, duration estimation, timeline math,
 * fallback-script generation, and deterministic Web-Speech voice selection.
 *
 * Everything here is unit-testable without a DOM or network (see src/lib/*.test.ts).
 */

import type { ScriptSegment } from "../types";

/* ------------------------------------------------------------------ */
/* Gemini model + voice configuration                                  */
/* ------------------------------------------------------------------ */

export interface ModelConfig {
  /** Validated script-writing model. Override with GEMINI_SCRIPT_MODEL. */
  scriptModel: string;
  /** Validated multi-speaker TTS model. Override with GEMINI_TTS_MODEL. */
  ttsModel: string;
}

/** Resolve model IDs from env with sane, currently-valid defaults. */
export function resolveModels(env: Record<string, string | undefined> = {}): ModelConfig {
  return {
    scriptModel: env.GEMINI_SCRIPT_MODEL || "gemini-3-flash-preview",
    ttsModel: env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts",
  };
}

/** Prebuilt voices supported by Gemini TTS models. */
export const GEMINI_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Automele", "Tyro", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Laomedeia", "Achernar", "Sulafat", "Gacrux", "Vindemiatrix", "Sadachbia",
] as const;

export type GeminiVoice = (typeof GEMINI_VOICES)[number];

/** Case-insensitive membership check against the known voice enum. */
export function isValidGeminiVoice(name: unknown): name is GeminiVoice {
  if (typeof name !== "string") return false;
  const lower = name.trim().toLowerCase();
  return GEMINI_VOICES.some((v) => v.toLowerCase() === lower);
}

/** Normalize to canonical casing; fall back to `fallback` when unknown. */
export function safeGeminiVoice(name: unknown, fallback: GeminiVoice = "Kore"): GeminiVoice {
  if (!isValidGeminiVoice(name)) return fallback;
  const lower = (name as string).trim().toLowerCase();
  return GEMINI_VOICES.find((v) => v.toLowerCase() === lower)!;
}

/** Pick a contrasting second voice for host B. */
export function partnerVoice(primary: GeminiVoice): GeminiVoice {
  return primary === "Puck" ? "Fenrir" : "Puck";
}

/* ------------------------------------------------------------------ */
/* Duration estimation                                                 */
/* ------------------------------------------------------------------ */

/** Rough spoken-word rate (words per minute) used for estimates. */
export const SPEECH_WPM = 160;

export function estimateDurationSeconds(text: string, wpm: number = SPEECH_WPM): number {
  const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 1;
  return Math.max(1, Math.round((words / wpm) * 60));
}

/** PCM16 mono bytes -> seconds. Used to replace LLM guesses with real durations. */
export function pcmDurationSeconds(byteLength: number, sampleRate = 24000, channels = 1, bytesPerSample = 2): number {
  const frames = byteLength / (channels * bytesPerSample);
  if (!Number.isFinite(frames) || frames <= 0) return 0;
  return frames / sampleRate;
}

/**
 * Wrap raw PCM bytes (as a Uint8Array) into a valid 16-bit mono WAV blob part.
 * Pure/Node-free so it is unit-testable and reusable on server and client.
 * NOTE: uses explicit little-endian byte writes rather than DataView.set*LE,
 * which does not exist in Node 20's V8 (ES2024 feature).
 */
export function pcmToWavBytes(pcm: Uint8Array, sampleRate = 24000): Uint8Array {
  const header = new Uint8Array(44);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) header[offset + i] = str.charCodeAt(i);
  };
  const u16le = (offset: number, value: number) => {
    header[offset] = value & 0xff;
    header[offset + 1] = (value >>> 8) & 0xff;
  };
  const u32le = (offset: number, value: number) => {
    header[offset] = value & 0xff;
    header[offset + 1] = (value >>> 8) & 0xff;
    header[offset + 2] = (value >>> 16) & 0xff;
    header[offset + 3] = (value >>> 24) & 0xff;
  };
  const byteRate = sampleRate * 2; // mono, 16-bit
  writeStr(0, "RIFF");
  u32le(4, 36 + pcm.length);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  u32le(16, 16);
  u16le(20, 1); // PCM
  u16le(22, 1); // mono
  u32le(24, sampleRate);
  u32le(28, byteRate);
  u16le(32, 2); // block align
  u16le(34, 16); // bits per sample
  writeStr(36, "data");
  u32le(40, pcm.length);
  const out = new Uint8Array(header.length + pcm.length);
  out.set(header, 0);
  out.set(pcm, header.length);
  return out;
}

/** Base64 helpers that work in both Node (Buffer) and the browser (btoa/atob). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Wrap base64 raw PCM into a valid WAV base64 payload (for data URIs). */
export function pcmToWavBase64(base64Pcm: string, sampleRate = 24000): string {
  return bytesToBase64(pcmToWavBytes(base64ToBytes(base64Pcm), sampleRate));
}

/** Full data URI form, handy for direct <audio src> assignment. */
export function pcmToWavDataUri(base64Pcm: string, sampleRate = 24000): string {
  return `data:audio/wav;base64,${pcmToWavBase64(base64Pcm, sampleRate)}`;
}

/* ------------------------------------------------------------------ */
/* Timeline math                                                       */
/* ------------------------------------------------------------------ */

export interface SegmentWindow {
  index: number;
  start: number;
  end: number;
}

/** Cumulative [start,end) windows derived from segment durations. */
export function buildTimeline(segments: Array<{ durationSeconds: number }>): SegmentWindow[] {
  let acc = 0;
  return segments.map((seg, index) => {
    const start = acc;
    acc += Math.max(0, seg.durationSeconds || 0);
    return { index, start, end: acc };
  });
}

export function totalDurationOf(segments: Array<{ durationSeconds: number }>): number {
  const timeline = buildTimeline(segments);
  return timeline.length ? timeline[timeline.length - 1].end : 0;
}

/** Index of the segment containing `time`; clamps to last segment at/after end. */
export function segmentIndexAtTime(timeline: SegmentWindow[], time: number): number {
  if (timeline.length === 0) return 0;
  for (const w of timeline) {
    if (time < w.end) return w.index;
  }
  return timeline[timeline.length - 1].index;
}

/** Format seconds as m:ss (used by the transport UI). */
export function formatTime(secs: number): string {
  const safe = Math.max(0, Math.floor(secs || 0));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

/* ------------------------------------------------------------------ */
/* Input sanitization + script validation                                */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  subject: 400,
  userName: 60,
  companyName: 80,
  maxSegments: 12,
  minSegments: 2,
  maxSegmentChars: 700,
};

export function sanitizeText(input: unknown, maxLen: number): string {
  if (typeof input !== "string") return "";
  // Strip control chars (except newline), collapse whitespace runs, cap length.
  return input
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, maxLen);
}

export interface ValidatedScript {
  ok: boolean;
  errors: string[];
  title?: string;
  segments?: ScriptSegment[];
}

/**
 * Validate + normalize an untrusted LLM JSON payload into a well-formed script.
 * Never trusts model output: bounds arrays, clamps numbers, coerces enums.
 */
export function validateScript(raw: unknown): ValidatedScript {
  const errors: string[] = [];
  if (raw == null || typeof raw !== "object") {
    return { ok: false, errors: ["Script payload is not an object."] };
  }
  const obj = raw as Record<string, unknown>;

  const rawTitle = typeof obj.title === "string" ? obj.title.trim() : "";
  const title = rawTitle.slice(0, 80) || "Untitled Broadcast";
  if (!Array.isArray(obj.segments)) {
    return { ok: false, errors: ["Missing `segments` array."] };
  }

  const MOODS = ["upbeat", "thoughtful", "excited", "serious", "cheerful"];
  const segments: ScriptSegment[] = [];
  (obj.segments as unknown[]).forEach((item, i) => {
    if (item == null || typeof item !== "object") {
      errors.push(`Segment ${i}: not an object, dropped.`);
      return;
    }
    const s = item as Record<string, unknown>;
    const text = sanitizeText(s.text, LIMITS.maxSegmentChars);
    if (!text) {
      errors.push(`Segment ${i}: empty text, dropped.`);
      return;
    }
    const speaker = sanitizeText(s.speaker, 30) || "Alex";
    const moodRaw = sanitizeText(s.mood, 20).toLowerCase();
    const mood = MOODS.includes(moodRaw) ? moodRaw : "upbeat";
    const durNum = Number(s.durationSeconds);
    const durationSeconds =
      Number.isFinite(durNum) && durNum > 0 && durNum <= 120 ? Math.round(durNum) : estimateDurationSeconds(text);
    segments.push({ speaker, text, voiceName: String(s.voiceName || "Kore"), mood, durationSeconds });
  });

  if (segments.length < LIMITS.minSegments) {
    errors.push(`Only ${segments.length} usable segments (minimum ${LIMITS.minSegments}).`);
    return { ok: false, errors };
  }
  const trimmed = segments.slice(0, LIMITS.maxSegments);
  if (trimmed.length < segments.length) {
    errors.push(`Truncated ${segments.length - trimmed.length} extra segments.`);
  }
  return { ok: true, errors, title, segments: trimmed };
}

/* ------------------------------------------------------------------ */
/* Fallback procedural script                                          */
/* ------------------------------------------------------------------ */

interface FallbackInput {
  subject?: string;
  userName?: string;
  companyName?: string;
  voiceSelection?: string;
  hostsCount?: number;
}

interface TopicBrief {
  brief: string;
  points: [string, string];
}

export function pickTopicBrief(normSubject: string): TopicBrief {
  if (/sport|game|football|basketball/.test(normSubject)) {
    return {
      brief: "current sports trends and athletic performance",
      points: [
        "Analytics and high-tech wearable biosensors are completely redefining how athletes train.",
        "But under pressure, it's still about raw mental grit and teamwork on the pitch.",
      ],
    };
  }
  if (/music|art|movie|design/.test(normSubject)) {
    return {
      brief: "the intersection of creative arts and digital design",
      points: [
        "Design trends are shifting towards dark-mode, high-fidelity interfaces with 8pt layouts.",
        "True craftsmanship lies in delivering subtle, micro-interactions that feel premium and tactile.",
      ],
    };
  }
  if (/health|food|fitness/.test(normSubject)) {
    return {
      brief: "holistic health, longevity, and active fitness",
      points: [
        "Consistency in minor daily routines generates compounding physical and psychological benefits.",
        "The key is adapting technology to serve customized, mindful recovery plans.",
      ],
    };
  }
  if (/business|finance|money|marketing/.test(normSubject)) {
    return {
      brief: "the changing landscape of digital entrepreneurship",
      points: [
        "Success in hyper-competitive markets relies on personalizing workflows for specific niches.",
        "Integrating bespoke tools creates unmatched operational leverage for modern teams.",
      ],
    };
  }
  return {
    brief: "modern technology innovations",
    points: [
      "AI is rapidly automating tedious work and freeing up humans to focus on creative tasks.",
      "The transition requires clean, responsive interfaces that focus heavily on modern design systems.",
    ],
  };
}

/** Deterministic, pure fallback episode generator (no API required). */
export function getFallbackScript(input: FallbackInput = {}) {
  const subject = sanitizeText(input.subject, LIMITS.subject);
  const userName = sanitizeText(input.userName, LIMITS.userName) || "Special Guest";
  const companyName = sanitizeText(input.companyName, LIMITS.companyName) || "the studio";
  const numHosts = Number(input.hostsCount) === 1 ? 1 : 2;

  const topic = pickTopicBrief(subject.toLowerCase());
  const hostA = "Alex";
  const hostB = "Sam";
  const voiceA = safeGeminiVoice(input.voiceSelection);
  const voiceB = partnerVoice(voiceA);

  const mk = (speaker: string, text: string, voiceName: string, mood: string): ScriptSegment => ({
    speaker,
    text,
    voiceName,
    mood,
    durationSeconds: estimateDurationSeconds(text),
  });

  const segments: ScriptSegment[] = [
    mk(
      hostA,
      `Welcome to AI Talk Radio! I'm Alex. We are coming to you live, and today we have a very special broadcast for ${userName} tuning in from ${companyName}. We're diving deep into ${subject || topic.brief}.`,
      voiceA,
      "cheerful"
    ),
  ];

  if (numHosts === 2) {
    segments.push(
      mk(hostB, `That's right, Alex! Hello everyone, Sam here. It's fantastic to have ${userName} with us. Touching on ${subject || topic.brief}, it's clear things are changing. ${topic.points[0]}`, voiceB, "excited"),
      mk(hostA, `Exactly, Sam. That brings up a fascinating point. If we look at the data, ${topic.points[1]} It is all about structural precision and execution in high-end design.`, voiceA, "thoughtful"),
      mk(hostB, `Spot on! For ${companyName}, mastering these standards is the ultimate competitive edge. That is all the time we have for this quick focus segment. Keep innovating!`, voiceB, "upbeat")
    );
  } else {
    segments.push(
      mk(hostA, `Let's break this down. First, ${topic.points[0]} This represents an extraordinary shift that affects everyone in our ecosystem.`, voiceA, "thoughtful"),
      mk(hostA, `Second, to make sense of this, ${topic.points[1]} Shoutout to the team at ${companyName} for staying ahead of these trends.`, voiceA, "cheerful"),
      mk(hostA, `Thank you, ${userName}, for joining us today for this special briefing on AI Talk Radio. Keep your frequencies tuned, and we'll see you next time!`, voiceA, "upbeat")
    );
  }

  return { title: `Insight Frequency: ${subject || "Next-Gen Media Forum"}`, segments };
}

/* ------------------------------------------------------------------ */
/* Browser SpeechSynthesis: deterministic voice selection              */
/* ------------------------------------------------------------------ */

export interface VoiceLike {
  name: string;
  lang: string;
  voiceURI?: string;
  localService?: boolean;
}

/** Stable FNV-1a hash for deterministic (but varied) voice picking. */
export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Choose distinct English voices for each speaker WITHOUT hard-coding vendor
 * names (which differ across OS/browser). Strategy:
 *  1. filter to en-* voices,
 *  2. rank preferred locales (Google/Microsoft/native natural voices first),
 *  3. assign deterministically by hashing the speaker label into the pool,
 *     avoiding collisions between speakers.
 */
export function pickVoicesForSpeakers<T extends VoiceLike>(voices: T[], speakers: string[]): Map<string, T> {
  const result = new Map<string, T>();
  if (!voices || voices.length === 0) return result;

  const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang || "en-US"));
  const pool = (english.length > 0 ? english : voices).slice().sort((a, b) => {
    const score = (v: T) => {
      let s = 0;
      if (/google/i.test(v.name)) s += 3; // Chrome network voices sound best
      if (/microsoft|natural/i.test(v.name)) s += 2;
      if ((v.lang || "").toLowerCase().startsWith("en-us")) s += 1;
      return s;
    };
    return score(b) - score(a) || a.name.localeCompare(b.name);
  });

  const used = new Set<number>();
  speakers.forEach((speaker) => {
    const n = pool.length;
    let idx = hashString(speaker) % n;
    // Linear probe to guarantee two speakers never share a voice (if possible).
    let guard = 0;
    while (used.has(idx) && guard < n) {
      idx = (idx + 1) % n;
      guard++;
    }
    used.add(idx);
    result.set(speaker, pool[idx]);
  });
  return result;
}

/** Pitch offset per speaker index so paired voices sound more distinct. */
export function pitchForSpeaker(speakerIndex: number): number {
  return speakerIndex % 2 === 0 ? 0.95 : 1.15;
}

/**
 * Split long utterances into speakable chunks. Chrome/Safari stop emitting
 * speech mid-way through very long strings (~150+ words); chunking at
 * sentence boundaries avoids truncation.
 */
export function chunkForSpeech(text: string, maxChars = 220): string[] {
  const clean = (text || "").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sent of sentences) {
    if ((current + " " + sent).trim().length > maxChars && current) {
      chunks.push(current.trim());
      current = sent;
    } else {
      current = current ? `${current} ${sent}` : sent;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  // Safety net: split any single oversized sentence on spaces.
  const out: string[] = [];
  for (const c of chunks) {
    if (c.length <= maxChars * 1.5) {
      out.push(c);
    } else {
      let rest = c;
      while (rest.length > maxChars) {
        const cutAt = rest.lastIndexOf(" ", maxChars);
        const cut = cutAt > 0 ? cutAt : maxChars;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) out.push(rest);
    }
  }
  return out;
}
