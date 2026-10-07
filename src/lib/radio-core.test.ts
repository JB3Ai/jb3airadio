import { describe, it, expect } from "vitest";
import {
  resolveModels,
  isValidGeminiVoice,
  safeGeminiVoice,
  partnerVoice,
  estimateDurationSeconds,
  pcmDurationSeconds,
  pcmToWavBytes,
  pcmToWavBase64,
  base64ToBytes,
  buildTimeline,
  totalDurationOf,
  segmentIndexAtTime,
  formatTime,
  sanitizeText,
  validateScript,
  getFallbackScript,
  pickTopicBrief,
  hashString,
  pickVoicesForSpeakers,
  pitchForSpeaker,
  chunkForSpeech,
  LIMITS,
} from "./radio-core";

describe("resolveModels", () => {
  it("returns valid default model ids (no more gemini-3.5-flash typos)", () => {
    const m = resolveModels({});
    expect(m.scriptModel).toBe("gemini-3-flash-preview");
    expect(m.ttsModel).toBe("gemini-2.5-flash-preview-tts");
  });
  it("honors env overrides", () => {
    const m = resolveModels({ GEMINI_SCRIPT_MODEL: "gemini-2.5-flash", GEMINI_TTS_MODEL: "custom-tts" });
    expect(m.scriptModel).toBe("gemini-2.5-flash");
    expect(m.ttsModel).toBe("custom-tts");
  });
});

describe("voice validation", () => {
  it("accepts known voices case-insensitively", () => {
    expect(isValidGeminiVoice("kore")).toBe(true);
    expect(isValidGeminiVoice(" PUCK ")).toBe(true);
    expect(safeGeminiVoice("fenrir")).toBe("Fenrir");
  });
  it("rejects unknown/invalid names and falls back", () => {
    expect(isValidGeminiVoice("Microsoft David Desktop")).toBe(false);
    expect(isValidGeminiVoice(undefined)).toBe(false);
    expect(safeGeminiVoice("Bogus", "Aoede")).toBe("Aoede");
  });
  it("partner voice contrasts", () => {
    expect(partnerVoice("Puck")).toBe("Fenrir");
    expect(partnerVoice("Kore")).toBe("Puck");
  });
});

describe("duration estimation", () => {
  it("estimates ~160wpm speech", () => {
    const words = Array(80).fill("word").join(" "); // 80 words -> 30s
    expect(estimateDurationSeconds(words)).toBe(30);
  });
  it("never returns zero / handles empty", () => {
    expect(estimateDurationSeconds("")).toBe(1);
    expect(estimateDurationSeconds("   ")).toBe(1);
  });
  it("converts PCM byte length to seconds", () => {
    // 24000 samples/s * 2 bytes = 48000 bytes per second at 24kHz mono 16-bit
    expect(pcmDurationSeconds(48000)).toBeCloseTo(1);
    expect(pcmDurationSeconds(48000 * 2.5)).toBeCloseTo(2.5);
    expect(pcmDurationSeconds(0)).toBe(0);
    expect(pcmDurationSeconds(-5)).toBe(0);
  });
});

describe("WAV wrapping", () => {
  it("produces a valid RIFF/WAVE header around the payload", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const wav = pcmToWavBytes(pcm, 24000);
    // Read little-endian ints manually (Node 20's DataView lacks set*LE/get*LE).
    const u32 = (o: number) => wav[o] | (wav[o + 1] << 8) | (wav[o + 2] << 16) | (wav[o + 3] << 24);
    const u16 = (o: number) => wav[o] | (wav[o + 1] << 8);
    const str = (o: number, len: number) => String.fromCharCode(...wav.subarray(o, o + len));
    expect(str(0, 4)).toBe("RIFF");
    expect(str(8, 4)).toBe("WAVE");
    expect(str(12, 4)).toBe("fmt ");
    expect(u32(4)).toBe(36 + pcm.length);
    expect(u16(20)).toBe(1); // PCM
    expect(u16(22)).toBe(1); // mono
    expect(u32(24)).toBe(24000);
    expect(u32(28)).toBe(48000); // byte rate
    expect(str(36, 4)).toBe("data");
    expect(u32(40)).toBe(pcm.length);
    expect(Array.from(wav.subarray(44))).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("round-trips through base64", () => {
    const b64 = Buffer.from(new Uint8Array([9, 8, 7, 6])).toString("base64");
    const wavB64 = pcmToWavBase64(b64, 16000);
    const bytes = base64ToBytes(wavB64);
    expect(bytes.length).toBe(44 + 4);
    expect(Array.from(bytes.subarray(44))).toEqual([9, 8, 7, 6]);
  });
});

describe("timeline math", () => {
  const segs = [{ durationSeconds: 10 }, { durationSeconds: 5 }, { durationSeconds: 7 }];
  const timeline = buildTimeline(segs);

  it("builds cumulative windows", () => {
    expect(timeline).toEqual([
      { index: 0, start: 0, end: 10 },
      { index: 1, start: 10, end: 15 },
      { index: 2, start: 15, end: 22 },
    ]);
    expect(totalDurationOf(segs)).toBe(22);
  });
  it("maps time -> correct segment index", () => {
    expect(segmentIndexAtTime(timeline, 0)).toBe(0);
    expect(segmentIndexAtTime(timeline, 9.99)).toBe(0);
    expect(segmentIndexAtTime(timeline, 10)).toBe(1);
    expect(segmentIndexAtTime(timeline, 21)).toBe(2);
    expect(segmentIndexAtTime(timeline, 999)).toBe(2); // clamps past end
  });
  it("tolerates missing/negative durations", () => {
    const bad = [{ durationSeconds: -3 }, { durationSeconds: NaN as any }, { durationSeconds: 4 }];
    const t = buildTimeline(bad);
    expect(totalDurationOf(bad)).toBe(4);
    expect(t[0].end).toBe(0);
    expect(t[1].end).toBe(0);
    expect(t[2].end).toBe(4);
  });
  it("formats time", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(599.9)).toBe("9:59");
    expect(formatTime(-4)).toBe("0:00");
  });
});

describe("sanitizeText", () => {
  it("strips control chars and caps length", () => {
    expect(sanitizeText("hi\u0000there", 100)).toBe("hi there");
    expect(sanitizeText("a".repeat(200), 50)).toHaveLength(50);
    expect(sanitizeText(123 as any, 10)).toBe("");
    expect(sanitizeText("  collapse   spaces\t\there ", 100)).toBe("collapse spaces here");
  });
});

describe("validateScript", () => {
  it("accepts a well-formed script", () => {
    const r = validateScript({
      title: "Episode One",
      segments: [
        { speaker: "Alex", text: "Hello there, welcome to the show.", voiceName: "Kore", mood: "cheerful", durationSeconds: 4 },
        { speaker: "Sam", text: "Great to be here today!", voiceName: "Puck", mood: "upbeat", durationSeconds: 3 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Episode One");
    expect(r.segments).toHaveLength(2);
  });
  it("drops malformed segments but keeps the rest", () => {
    const r = validateScript({
      title: "X",
      segments: [
        { speaker: "Alex", text: "Good line.", voiceName: "Kore", mood: "cheerful", durationSeconds: 2 },
        { speaker: "Sam", text: "   ", voiceName: "Puck", mood: "upbeat", durationSeconds: 2 }, // empty -> dropped
        null,
        { speaker: "Sam", text: "Also good line here.", voiceName: "Puck", mood: "weird-mood", durationSeconds: 999 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.segments).toHaveLength(2);
    // bad mood coerced, absurd duration re-estimated from word count
    expect(r.segments![1].mood).toBe("upbeat");
    expect(r.segments![1].durationSeconds).toBeLessThanOrEqual(120);
  });
  it("fails when too few usable segments", () => {
    const r = validateScript({ title: "x", segments: [{ speaker: "A", text: "only one", mood: "upbeat", durationSeconds: 2, voiceName: "Kore" }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/minimum/);
  });
  it("rejects non-objects and missing arrays", () => {
    expect(validateScript(null).ok).toBe(false);
    expect(validateScript("nope").ok).toBe(false);
    expect(validateScript({ title: "t" }).ok).toBe(false);
  });
  it("truncates runaway segment counts", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      speaker: i % 2 ? "Sam" : "Alex",
      text: `Segment number ${i} with plenty of spoken words to say something.`,
      voiceName: "Kore",
      mood: "upbeat",
      durationSeconds: 5,
    }));
    const r = validateScript({ title: "long", segments: many });
    expect(r.ok).toBe(true);
    expect(r.segments!.length).toBe(LIMITS.maxSegments);
  });
});

describe("getFallbackScript", () => {
  it("two hosts produce 4 alternating segments with estimated durations", () => {
    const s = getFallbackScript({ subject: "football", userName: "Ana", companyName: "ACME", hostsCount: 2 });
    expect(s.segments).toHaveLength(4);
    expect(s.segments.map((x) => x.speaker)).toEqual(["Alex", "Sam", "Alex", "Sam"]);
    expect(s.segments.every((x) => x.durationSeconds >= 1)).toBe(true);
    expect(s.title).toContain("football");
  });
  it("single host produces 4 same-speaker segments", () => {
    const s = getFallbackScript({ subject: "music", hostsCount: 1 });
    expect(s.segments.every((x) => x.speaker === "Alex")).toBe(true);
    expect(s.segments).toHaveLength(4);
  });
  it("sanitizes hostile input and defaults voices", () => {
    const s = getFallbackScript({ subject: "AI\u0000", voiceSelection: "NotAVoice", hostsCount: 2 });
    expect(s.segments[0].voiceName).toBe("Kore");
    expect(s.segments[1].voiceName).toBe("Puck");
    expect(s.segments[0].text).not.toContain("\u0000");
  });
  it("topic brief routing", () => {
    expect(pickTopicBrief("NBA basketball playoffs").brief).toContain("sports");
    expect(pickTopicBrief("healthy eating").brief).toContain("health");
    expect(pickTopicBrief("marketing funnels").brief).toContain("entrepreneurship");
    expect(pickTopicBrief("quantum widgets").brief).toContain("technology");
  });
});

describe("pickVoicesForSpeakers", () => {
  const mk = (name: string, lang: string) => ({ name, lang });
  const voices = [
    mk("Zarvox", "cy"), // non-English, must be filtered out
    mk("Google US English", "en-US"),
    mk("Google UK English Female", "en-GB"),
    mk("Microsoft Aria", "en-US"),
    mk("Samantha", "en-US"),
  ];

  it("filters to English voices only", () => {
    const picks = pickVoicesForSpeakers(voices, ["Alex", "Sam"]);
    const chosen = [...picks.values()];
    expect(chosen.every((v) => /^en/i.test(v.lang))).toBe(true);
  });
  it("assigns DISTINCT voices to distinct speakers", () => {
    const picks = pickVoicesForSpeakers(voices, ["Alex", "Sam"]);
    expect(picks.get("Alex")!.name).not.toBe(picks.get("Sam")!.name);
  });
  it("is deterministic across calls", () => {
    const a = pickVoicesForSpeakers(voices, ["Alex", "Sam"]);
    const b = pickVoicesForSpeakers(voices, ["Alex", "Sam"]);
    expect(a.get("Alex")!.name).toBe(b.get("Alex")!.name);
    expect(a.get("Sam")!.name).toBe(b.get("Sam")!.name);
  });
  it("handles empty inputs gracefully", () => {
    expect(pickVoicesForSpeakers([], ["Alex"]).size).toBe(0);
    expect(pickVoicesForSpeakers(voices, []).size).toBe(0);
  });
  it("falls back to full pool when no English voices exist", () => {
    const picks = pickVoicesForSpeakers([mk("Hilda", "es-MX")], ["Alex"]);
    expect(picks.get("Alex")!.name).toBe("Hilda");
  });
  it("hashString is stable & unsigned", () => {
    expect(hashString("Alex")).toBe(hashString("Alex"));
    expect(hashString("Alex")).not.toBe(hashString("Sam"));
    expect(hashString("")).toBeGreaterThanOrEqual(0);
  });
  it("pitch alternates by speaker index", () => {
    expect(pitchForSpeaker(0)).toBe(0.95);
    expect(pitchForSpeaker(1)).toBe(1.15);
  });
});

describe("chunkForSpeech", () => {
  it("passes short text through untouched", () => {
    expect(chunkForSpeech("Short sentence.")).toEqual(["Short sentence."]);
    expect(chunkForSpeech("")).toEqual([]);
  });
  it("splits long text into <= maxChars-ish chunks on sentence boundaries", () => {
    const text = "One two three four five six seven eight nine ten.".repeat(20); // ~1000 chars
    const chunks = chunkForSpeech(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(150);
    // No content lost (modulo whitespace joining)
    expect(chunks.join(" ").split(/\s+/).length).toBe(text.split(/\s+/).filter(Boolean).length);
  });
  it("hard-splits a single enormous run-on sentence", () => {
    const huge = "word ".repeat(120).trim(); // 600 chars, no periods
    const chunks = chunkForSpeech(huge, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.join(" ")).toBe(huge);
  });
});
