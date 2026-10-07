/**
 * useRadioPlayer — owns all playback state for a RadioShow.
 *
 * Fixes the old App.tsx bugs:
 *  - stale-closure interval: every tick reads from refs and derives the active
 *    segment purely from time (no captured state).
 *  - transcript sync drift: when per-segment Gemini audio exists, the playhead
 *    follows the actual <audio> element's currentTime; browser-TTS segments
 *    advance on real utterance `end` events (with a clock as safety net).
 *  - voice selection: deterministic getVoices() picks + voiceschanged handling.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RadioShow, ScriptSegment } from "../types";
import {
  buildTimeline,
  chunkForSpeech,
  pickVoicesForSpeakers,
  pitchForSpeaker,
  segmentIndexAtTime,
} from "../lib/radio-core";

export interface RadioPlayerState {
  isPlaying: boolean;
  currentTime: number;
  totalDuration: number;
  currentSegmentIndex: number;
  currentSegment: ScriptSegment | undefined;
  /** true if any segment lacks premium audio (browser speech used somewhere). */
  usingBrowserSpeech: boolean;
}

export interface RadioPlayerControls {
  toggle: () => void;
  seek: (timeSeconds: number) => void;
  reset: () => void;
}

export function useRadioPlayer(
  show: RadioShow,
  opts: { playbackSpeed: number; volume: number; muted: boolean }
): RadioPlayerState & RadioPlayerControls {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(0);

  const timeline = useMemo(() => buildTimeline(show.segments), [show]);
  const totalDuration = timeline.length ? timeline[timeline.length - 1].end : 0;
  const speakers = useMemo(
    () => Array.from(new Set(show.segments.map((s) => s.speaker))),
    [show]
  );

  /* ---------------- voices (deterministic, voiceschanged-aware) ---------- */
  const [voicesReady, setVoicesReady] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const update = () => setVoicesReady(window.speechSynthesis.getVoices().length > 0);
    update();
    window.speechSynthesis.addEventListener?.("voiceschanged", update);
    const kick = window.setTimeout(update, 300); // Safari populates late
    return () => {
      window.speechSynthesis.removeEventListener?.("voiceschanged", update);
      window.clearTimeout(kick);
    };
  }, []);

  const speakerVoiceMap = useMemo(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || !voicesReady) {
      return new Map<string, SpeechSynthesisVoice>();
    }
    return pickVoicesForSpeakers(window.speechSynthesis.getVoices(), speakers);
  }, [speakers, voicesReady]);

  /* ---------------- live refs (kill stale closures) ----------------------- */
  const speedRef = useRef(opts.playbackSpeed);
  const volumeRef = useRef(opts.volume);
  const mutedRef = useRef(opts.muted);
  useEffect(() => { speedRef.current = opts.playbackSpeed; }, [opts.playbackSpeed]);
  useEffect(() => { volumeRef.current = opts.volume; }, [opts.volume]);
  useEffect(() => { mutedRef.current = opts.muted; }, [opts.muted]);

  const showRef = useRef(show);
  const timelineRef = useRef(timeline);
  const voiceMapRef = useRef(speakerVoiceMap);
  useEffect(() => { showRef.current = show; }, [show]);
  useEffect(() => { timelineRef.current = timeline; }, [timeline]);
  useEffect(() => { voiceMapRef.current = speakerVoiceMap; }, [speakerVoiceMap]);

  const playingRef = useRef(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const playheadRef = useRef(0);   // seconds into the episode
  const segEndRef = useRef(0);     // episode-time at which the current segment should end
  const speakGenRef = useRef(0);   // invalidates queued/late utterances on stop/seek

  const cancelRaf = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  /* ---------------- stop / teardown --------------------------------------- */
  const hardStop = useCallback((keepPosition: boolean) => {
    playingRef.current = false;
    setIsPlaying(false);
    speakGenRef.current++;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    cancelRaf();
    if (audioElRef.current) {
      audioElRef.current.onended = null;
      audioElRef.current.onerror = null;
      audioElRef.current.pause();
    }
    if (!keepPosition) {
      playheadRef.current = 0;
      setCurrentTime(0);
      setCurrentSegmentIndex(0);
    }
  }, []);

  useEffect(() => () => hardStop(false), [hardStop]);

  // New episode loaded -> reset transport.
  useEffect(() => {
    hardStop(false);
  }, [show.title, show.segments, hardStop]);

  /* ---------------- shared rAF visual clock --------------------------------
   * Advances the displayed playhead at wall-clock*speed up to `untilEpisodeTime`,
   * then calls onArrive. Used for browser-speech segments where the true spoken
   * duration is unknown ahead of time.
   */
  const runClock = useCallback((untilEpisodeTime: number, onArrive: () => void) => {
    cancelRaf();
    lastTickRef.current = performance.now();
    const tick = () => {
      if (!playingRef.current) return;
      const now = performance.now();
      const dt = ((now - lastTickRef.current) / 1000) * speedRef.current;
      lastTickRef.current = now;
      playheadRef.current = Math.min(playheadRef.current + dt, untilEpisodeTime);
      setCurrentTime(playheadRef.current);
      if (playheadRef.current >= untilEpisodeTime - 0.02) {
        onArrive();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  /* ---------------- start a segment (real audio or browser speech) --------- */
  // Declared via ref so speakSegment <-> startSegment can reference each other.
  const startSegmentRef = useRef<(index: number, fromTime?: number) => void>(() => {});

  const speakSegment = useCallback(
    (index: number) => {
      const gen = ++speakGenRef.current;
      const seg = showRef.current.segments[index];
      if (!seg) return;
      const tl = timelineRef.current;
      const baseT = tl[index]?.start ?? 0;
      const expectedDur = Math.max(1, seg.durationSeconds);
      segEndRef.current = tl[index]?.end ?? baseT + expectedDur;

      const arriveNext = () => {
        if (gen !== speakGenRef.current || !playingRef.current) return;
        cancelRaf();
        startSegmentRef.current(index + 1);
      };

      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        // No Web Speech at all: fall back to pure timeline clock.
        runClock(segEndRef.current, arriveNext);
        return;
      }
      window.speechSynthesis.cancel();

      const speakerIdx = speakers.indexOf(seg.speaker);
      const chunks = chunkForSpeech(seg.text);
      let arrived = false;
      const onceArrive = () => {
        if (arrived) return;
        arrived = true;
        arriveNext();
      };

      chunks.forEach((chunk, ci) => {
        const u = new SpeechSynthesisUtterance(chunk);
        u.rate = Math.min(2, Math.max(0.5, speedRef.current));
        u.pitch = pitchForSpeaker(speakerIdx);
        u.volume = mutedRef.current ? 0 : volumeRef.current;
        const v = voiceMapRef.current.get(seg.speaker);
        if (v) u.voice = v;
        if (ci === chunks.length - 1) {
          u.onend = onceArrive;
          u.onerror = onceArrive;
        }
        window.speechSynthesis.speak(u);
      });

      // Visual clock in parallel. If it reaches the estimate while the voice is
      // still talking, extend once rather than skipping ahead of the audio.
      runClock(segEndRef.current, () => {
        if (!arrived && gen === speakGenRef.current && playingRef.current) {
          runClock(segEndRef.current + expectedDur, () => {
            if (gen === speakGenRef.current && playingRef.current && !window.speechSynthesis.speaking) {
              onceArrive();
            }
          });
        }
      });
    },
    [runClock, speakers]
  );

  const startSegment = useCallback(
    (index: number, fromTime?: number) => {
      if (!playingRef.current) return;
      const segs = showRef.current.segments;
      const tl = timelineRef.current;
      if (index >= segs.length) {
        hardStop(false);
        return;
      }
      const baseT = tl[index]?.start ?? 0;
      setCurrentSegmentIndex(index);

      const audioData = showRef.current.segmentAudio?.[index]?.data;
      if (audioData) {
        // Premium path: real WAV per segment drives both sound AND the clock.
        cancelRaf();
        const el = audioElRef.current ?? (audioElRef.current = new Audio());
        el.onended = null;
        el.onerror = null;
        el.src = `data:${showRef.current.segmentAudio![index].mime || "audio/wav"};base64,${audioData}`;
        el.playbackRate = speedRef.current;
        el.volume = mutedRef.current ? 0 : volumeRef.current;
        el.onended = () => {
          if (playingRef.current) startSegmentRef.current(index + 1);
        };
        el.onerror = () => speakSegment(index);
        playheadRef.current = baseT;
        setCurrentTime(baseT);
        el.play()
          .then(() => {
            const follow = () => {
              if (!playingRef.current) return;
              if (!el.paused && el.currentTime > 0) {
                playheadRef.current = baseT + el.currentTime;
                setCurrentTime(playheadRef.current);
              }
              rafRef.current = requestAnimationFrame(follow);
            };
            cancelRaf();
            rafRef.current = requestAnimationFrame(follow);
          })
          .catch(() => speakSegment(index));
      } else {
        playheadRef.current = fromTime != null ? Math.max(fromTime, baseT) : baseT;
        setCurrentTime(playheadRef.current);
        speakSegment(index);
      }
    },
    [hardStop, speakSegment]
  );
  useEffect(() => {
    startSegmentRef.current = startSegment;
  }, [startSegment]);

  /* ---------------- public controls ----------------------------------------- */
  const toggle = useCallback(() => {
    if (playingRef.current) {
      hardStop(true);
      return;
    }
    playingRef.current = true;
    setIsPlaying(true);
    const idx = segmentIndexAtTime(timelineRef.current, playheadRef.current);
    startSegmentRef.current(idx, playheadRef.current);
  }, [hardStop]);

  const seek = useCallback(
    (timeSeconds: number) => {
      const wasPlaying = playingRef.current;
      hardStop(true);
      const idx = segmentIndexAtTime(timelineRef.current, timeSeconds);
      const snapped = timelineRef.current[idx]?.start ?? 0;
      playheadRef.current = snapped;
      setCurrentTime(snapped);
      setCurrentSegmentIndex(idx);
      if (wasPlaying) {
        playingRef.current = true;
        setIsPlaying(true);
        startSegmentRef.current(idx);
      }
    },
    [hardStop]
  );

  const reset = useCallback(() => hardStop(false), [hardStop]);

  // Live-apply speed/volume changes to whatever is currently playing.
  useEffect(() => {
    if (audioElRef.current) {
      audioElRef.current.playbackRate = opts.playbackSpeed;
      audioElRef.current.volume = opts.muted ? 0 : opts.volume;
    }
  }, [opts.playbackSpeed, opts.volume, opts.muted]);

  const usingBrowserSpeech = show.segments.some((_, i) => !show.segmentAudio?.[i]?.data);

  return {
    isPlaying,
    currentTime,
    totalDuration,
    currentSegmentIndex,
    currentSegment: show.segments[currentSegmentIndex],
    usingBrowserSpeech,
    toggle,
    seek,
    reset,
  };
}
