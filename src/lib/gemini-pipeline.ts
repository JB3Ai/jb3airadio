/**
 * Server-side Gemini pipeline: script generation (validated) + per-segment TTS
 * with real measured durations, plus a once-per-day free-quota budget guard.
 */

import { GoogleGenAI, Type } from "@google/genai";
import {
  resolveModels,
  safeGeminiVoice,
  partnerVoice,
  isValidGeminiVoice,
  validateScript,
  estimateDurationSeconds,
  pcmDurationSeconds,
  pcmToWavBase64,
  sanitizeText,
  LIMITS,
} from "./radio-core.ts";
import type { ScriptSegment } from "../types";

export interface GenerateParams {
  subject?: string;
  userName?: string;
  companyName?: string;
  voiceSelection?: string;
  hostsCount?: number;
  /** Optional source material (from URL upload / document / pushed JSON). */
  sourceText?: string;
  /** A ready-made script pushed by another app (skips the LLM writer step). */
  presetScript?: unknown;
}

export interface SegmentAudio {
  /** base64 WAV (PCM wrapped) or null when that segment fell back to browser TTS. */
  data: string | null;
  mime: string;
}

export interface GenerationResult {
  title: string;
  segments: ScriptSegment[];
  segmentAudio: SegmentAudio[] | null;
  usingFallback: boolean;
  message: string;
  quota?: QuotaStatus;
}

/* ------------------------------------------------------------------ */
/* Once-per-day quota guard                                            */
/* ------------------------------------------------------------------ */

export interface QuotaConfig {
  /** Max premium (Gemini API) generations per UTC day. Default 10; set 0 to disable premium entirely. */
  dailyLimit: number;
  /** Set false to skip persistence (tests). */
  persist: boolean;
}

interface QuotaState {
  day: string; // YYYY-MM-DD (UTC)
  count: number;
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Small in-memory + optional file-backed counter so free-tier API usage is
 * capped per day. When the cap is hit, callers fall back to the procedural
 * script + browser Web Speech — the app keeps working for "free forever".
 */
export function createQuotaGuard(cfg: QuotaConfig, storage?: Map<string, string>) {
  const limit = Number.isFinite(cfg.dailyLimit) ? Math.max(0, cfg.dailyLimit) : 10;
  let state: QuotaState = { day: utcDay(), count: 0 };

  const load = () => {
    if (!cfg.persist || !storage) return;
    try {
      const raw = storage.get("quota");
      if (raw) {
        const parsed = JSON.parse(raw) as QuotaState;
        if (parsed.day === utcDay() && Number.isFinite(parsed.count)) state = parsed;
      }
    } catch {
      /* corrupted state resets silently */
    }
  };
  const save = () => {
    if (!cfg.persist || !storage) return;
    try {
      storage.set("quota", JSON.stringify(state));
    } catch {
      /* best-effort */
    }
  };
  load();

  return {
    status(): QuotaStatus {
      if (state.day !== utcDay()) state = { day: utcDay(), count: 0 };
      return { limit, used: state.count, remaining: Math.max(0, limit - state.count), day: state.day };
    },
    tryConsume(): boolean {
      if (state.day !== utcDay()) state = { day: utcDay(), count: 0 };
      if (state.count >= limit) return false;
      state.count += 1;
      save();
      return true;
    },
    refund() {
      if (state.day === utcDay() && state.count > 0) {
        state.count -= 1;
        save();
      }
    },
  };
}

export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  day: string;
}

/* ------------------------------------------------------------------ */
/* Script writing                                                      */
/* ------------------------------------------------------------------ */

function buildScriptPrompt(p: Required<Pick<GenerateParams, "subject" | "userName" | "companyName">> & {
  numHosts: number;
  voiceA: string;
  voiceB: string;
  sourceBlock: string;
}) {
  const hostA = "Alex";
  const hostB = "Sam";
  return `
You are the elite broadcast scriptwriter for "AI Talk Radio", a premium, dark-first interactive radio deck.
Write a polished, high-fidelity, highly engaging radio show script.${p.sourceBlock}

Episode setup:
- Listener name / Guest of Honor: "${p.userName}"
- Guest's Affiliation / Company: "${p.companyName}"
- Topic: "${p.subject}"
- Number of participating hosts: ${p.numHosts}

Host definitions:
- Speaker 1: "${hostA}" (analytical, articulate, upbeat) — voiceName "${p.voiceA}"
${p.numHosts === 2 ? `- Speaker 2: "${hostB}" (witty, collaborative, energetic) — voiceName "${p.voiceB}"` : ""}

Strict Rules:
1. Hosts explicitly introduce themselves and give a personal welcome to "${p.userName}" from "${p.companyName}" near the beginning.
2. Discuss the topic with genuine insight, clean terminology, and crisp conversation. Ground claims in the provided material when present.
3. Keep dialogue turns between exactly ${p.numHosts === 2 ? "4 and 6" : "3 and 5"}. Each turn concise and conversational (25-70 words).
4. Only these voiceNames may appear: "${p.voiceA}"${p.numHosts === 2 ? ` and "${p.voiceB}"` : ""}.
5. durationSeconds = wordCount / ~2.7 (rounded).
6. Text must be plain prose — no markdown, no emojis, no stage directions in asterisks.

Return strictly a single JSON object:
{
  "title": "catchy episode title (max 60 chars)",
  "segments": [
    { "speaker": "${hostA}${p.numHosts === 2 ? `" or "${hostB}` : ""}", "text": "...", "voiceName": "...", "mood": "upbeat|thoughtful|excited|serious|cheerful", "durationSeconds": 10 }
  ]
}`.trim();
}

export async function generateScript(ai: GoogleGenAI, params: GenerateParams): Promise<{ title: string; segments: ScriptSegment[] }> {
  const models = resolveModels(process.env as Record<string, string | undefined>);

  // Pushed-script path: another app handed us a finished script — validate, don't regenerate.
  if (params.presetScript) {
    const validated = validateScript(params.presetScript);
    if (!validated.ok || !validated.segments) {
      throw new Error(`Preset script invalid: ${validated.errors.join(" ")}`);
    }
    return { title: validated.title!, segments: validated.segments };
  }

  const subject = sanitizeText(params.subject, LIMITS.subject) || "Modern design systems and technical excellence";
  const userName = sanitizeText(params.userName, LIMITS.userName) || "Special Guest";
  const companyName = sanitizeText(params.companyName, LIMITS.companyName) || "Acme Corp";
  const numHosts = Number(params.hostsCount) === 1 ? 1 : 2;
  const voiceA = safeGeminiVoice(params.voiceSelection);
  const voiceB = partnerVoice(voiceA);

  const sourceText = (params.sourceText || "").slice(0, 24_000);
  const sourceBlock = sourceText
    ? `\n\nBASE THE EPISODE ON THIS SOURCE MATERIAL (summarize it conversationally; do not read it verbatim):\n"""\n${sourceText}\n"""`
    : "";

  const prompt = buildScriptPrompt({ subject, userName, companyName, numHosts, voiceA, voiceB, sourceBlock });

  const modelResponse = await ai.models.generateContent({
    model: models.scriptModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          segments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                speaker: { type: Type.STRING },
                text: { type: Type.STRING },
                voiceName: { type: Type.STRING },
                mood: { type: Type.STRING },
                durationSeconds: { type: Type.NUMBER },
              },
              required: ["speaker", "text", "voiceName", "mood", "durationSeconds"],
            },
          },
        },
        required: ["title", "segments"],
      },
    },
  });

  const responseText = modelResponse.text;
  if (!responseText) throw new Error("Received empty script from Gemini API.");

  let raw: unknown;
  try {
    raw = JSON.parse(responseText.trim());
  } catch {
    throw new Error("Gemini returned non-JSON script payload.");
  }

  const validated = validateScript(raw);
  if (!validated.ok || !validated.segments) {
    throw new Error(`Script validation failed: ${validated.errors.join("; ")}`);
  }

  // Enforce voice hygiene regardless of what the model wrote.
  const segments = validated.segments.map((s) => ({
    ...s,
    voiceName: isValidGeminiVoice(s.voiceName)
      ? safeGeminiVoice(s.voiceName)
      : s.speaker === "Alex"
        ? voiceA
        : voiceB,
  }));

  return { title: validated.title!, segments };
}

/* ------------------------------------------------------------------ */
/* Per-segment TTS with real durations                                 */
/* ------------------------------------------------------------------ */

async function synthesizeOneSegment(
  ai: GoogleGenAI,
  ttsModel: string,
  segment: ScriptSegment
): Promise<{ wavBase64: string; durationSeconds: number } | null> {
  const voice = safeGeminiVoice(segment.voiceName);
  // Style cue from mood makes single-speaker synthesis noticeably more expressive.
  const styled = `[${segment.mood.toUpperCase()}]\n${segment.speaker}: ${segment.text}`;

  const res = await ai.models.generateContent({
    model: ttsModel,
    contents: [{ role: "user", parts: [{ text: styled }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });

  const part = res.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
  if (!part?.inlineData?.data) return null;

  const mime = part.inlineData.mimeType || "audio/pcm";
  const b64 = part.inlineData.data;
  const byteLen = Math.floor((b64.length * 3) / 4); // approx decoded size, fine for duration

  let sampleRate = 24000;
  const m = /rate=(\d+)/.exec(mime); // e.g. "audio/L16;codec=pcm;rate=24000"
  if (m) sampleRate = Number(m[1]);

  const durationSeconds = Math.max(0.5, pcmDurationSeconds(byteLen, sampleRate));

  if (/wav/i.test(mime)) {
    return { wavBase64: b64, durationSeconds };
  }
  // PCM16 -> wrap into WAV so browsers can decode it.
  return { wavBase64: pcmToWavBase64(b64, sampleRate), durationSeconds };
}

/**
 * Synthesize each segment independently: accurate timeline durations,
 * per-segment retry, and partial success (failed segments fall back to
 * browser speech individually instead of losing the whole episode).
 */
export async function synthesizeSegments(
  ai: GoogleGenAI,
  segments: ScriptSegment[],
  onProgress?: (index: number) => void
): Promise<{ audio: SegmentAudio[]; segments: ScriptSegment[] }> {
  const models = resolveModels(process.env as Record<string, string | undefined>);
  const audio: SegmentAudio[] = [];
  const outSegments: ScriptSegment[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    onProgress?.(i);
    let result: Awaited<ReturnType<typeof synthesizeOneSegment>> = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        result = await synthesizeOneSegment(ai, models.ttsModel, seg);
      } catch (err) {
        lastErr = err;
        // brief backoff before the single retry
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    if (result) {
      audio.push({ data: result.wavBase64, mime: "audio/wav" });
      // Replace the LLM's guess with the REAL measured duration.
      outSegments.push({ ...seg, durationSeconds: Math.round(result.durationSeconds * 10) / 10 });
    } else {
      if (lastErr) console.warn(`[TTS] segment ${i} failed after retries, browser fallback for this line:`, lastErr);
      audio.push({ data: null, mime: "" });
      outSegments.push({ ...seg, durationSeconds: seg.durationSeconds || estimateDurationSeconds(seg.text) });
    }
  }

  return { audio, segments: outSegments };
}
