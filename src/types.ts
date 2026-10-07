/**
 * Shared types for AI Talk Radio.
 */

export interface ScriptSegment {
  speaker: string;
  text: string;
  voiceName: string;
  mood: string;
  /** Estimated (LLM) or measured (per-segment TTS) duration in seconds. */
  durationSeconds: number;
}

export interface RadioShow {
  title: string;
  segments: ScriptSegment[];
  /** Per-segment base64 audio payloads (index-aligned with `segments`). */
  segmentAudio?: Array<string | null> | null;
  /** MIME type reported by the TTS model (usually audio/pcm or audio/wav). */
  segmentAudioMime?: string | null;
  usingFallback?: boolean;
  message?: string;
}

/** Sources of content that can become a broadcast. */
export type SourceKind = "text" | "url" | "file" | "json";

export interface BroadcastSource {
  kind: SourceKind;
  /** Raw extracted/plain-text content, or an object when kind === "json". */
  content: string;
  name?: string;
}
