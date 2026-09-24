/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from "react";
import { useState, useEffect, useRef } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  Users,
  User,
  Radio,
  Settings,
  Sparkles,
  FileText,
  Activity,
  Terminal,
  AlertCircle,
  VolumeX,
  FastForward,
  CheckCircle,
  HelpCircle,
  ListRestart
} from "lucide-react";

interface ScriptSegment {
  speaker: string;
  text: string;
  voiceName: string;
  mood: string;
  durationSeconds: number;
}

interface RadioShow {
  title: string;
  segments: ScriptSegment[];
  audioData?: string | null;
  usingFallback?: boolean;
}

// Full premium fallback episode data about AI Talk Radio & design systems
const INITIAL_RADIO_SHOW: RadioShow = {
  title: "Aether Grid: Spacing and Visual Rhythm",
  segments: [
    {
      speaker: "Alex",
      text: "What is up broadcast system! You are tuned into AI Talk Radio. I am your co-host Alex, broadcasting live in dark, cyber-slate high contrast config.",
      voiceName: "Kore",
      mood: "cheerful",
      durationSeconds: 9
    },
    {
      speaker: "Sam",
      text: "And this is Sam. Joining us is our honorary guest operator today, working deep inside the design grid system. We are talking about strict spatial harmony.",
      voiceName: "Puck",
      mood: "excited",
      durationSeconds: 10
    },
    {
      speaker: "Alex",
      text: "That's right. The user prompt mandates an 8-pixel spacing system. No exceptions! We are ditching arbitrary margin sizes for perfect, clean multipliers.",
      voiceName: "Kore",
      mood: "thoughtful",
      durationSeconds: 9
    },
    {
      speaker: "Sam",
      text: "Exactly, Alex. Spacing creates rhythm, and rhythm creates comfort for the eyes. When you build with strict 8pt layouts, everything locks together perfectly.",
      voiceName: "Puck",
      mood: "thoughtful",
      durationSeconds: 8
    },
    {
      speaker: "Alex",
      text: "Beautifully stated, Sam. To our operator tuning in, we salute your commitment to high-end craftsmanship. Keep your design grids pristine, and stay tuned!",
      voiceName: "Kore",
      mood: "upbeat",
      durationSeconds: 8
    }
  ]
};

export default function App() {
  // Persistent Settings fields from Local Storage
  const [userName, setUserName] = useState<string>(() => {
    return localStorage.getItem("ai_radio_userName") || "Lead Operator";
  });
  const [companyName, setCompanyName] = useState<string>(() => {
    return localStorage.getItem("ai_radio_companyName") || "Aether Labs";
  });
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(() => {
    return parseFloat(localStorage.getItem("ai_radio_speed") || "1.0");
  });
  const [voiceSelection, setVoiceSelection] = useState<string>(() => {
    return localStorage.getItem("ai_radio_voice") || "Kore";
  });
  const [hostsCount, setHostsCount] = useState<number>(() => {
    return parseInt(localStorage.getItem("ai_radio_hostsCount") || "2", 10);
  });

  // Ephemeral Application States
  const [subjectText, setSubjectText] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generationStep, setGenerationStep] = useState<number>(0);
  const [generationLogs, setGenerationLogs] = useState<string[]>([]);
  
  const [currentShow, setCurrentShow] = useState<RadioShow>(INITIAL_RADIO_SHOW);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState<number>(0);
  const [currentTimeOffset, setCurrentTimeOffset] = useState<number>(0);
  const [totalDuration, setTotalDuration] = useState<number>(43); // sum of initial segments
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [volume, setVolume] = useState<number>(0.8);
  const [isMuted, setIsMuted] = useState<boolean>(false);

  // Audio simulation or real state
  const [audioSource, setAudioSource] = useState<HTMLAudioElement | null>(null);
  const [speechSynthesisActive, setSpeechSynthesisActive] = useState<boolean>(false);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const synthesisUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const playheadIntervalRef = useRef<number | null>(null);
  const visualizerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const terminalBottomRef = useRef<HTMLDivElement | null>(null);

  // Sync state defaults back into localStorage on changes
  useEffect(() => {
    localStorage.setItem("ai_radio_userName", userName);
  }, [userName]);

  useEffect(() => {
    localStorage.setItem("ai_radio_companyName", companyName);
  }, [companyName]);

  useEffect(() => {
    localStorage.setItem("ai_radio_speed", playbackSpeed.toString());
    if (audioSource) {
      audioSource.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed, audioSource]);

  useEffect(() => {
    localStorage.setItem("ai_radio_voice", voiceSelection);
  }, [voiceSelection]);

  useEffect(() => {
    localStorage.setItem("ai_radio_hostsCount", hostsCount.toString());
  }, [hostsCount]);

  // Calculate sum duration on show change
  useEffect(() => {
    const total = currentShow.segments.reduce((acc, seg) => acc + seg.durationSeconds, 0);
    setTotalDuration(total);
    setCurrentSegmentIndex(0);
    setCurrentTime(0);
  }, [currentShow]);

  // Stop running streams on unmount
  useEffect(() => {
    return () => {
      stopPlayback();
    };
  }, []);

  // Update volume on state change
  useEffect(() => {
    if (audioSource) {
      audioSource.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted, audioSource]);

  // Handle generation logs scroll
  useEffect(() => {
    if (terminalBottomRef.current) {
      terminalBottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [generationLogs, generationStep]);

  // Animate dynamic media visualizer when playing
  useEffect(() => {
    const canvas = visualizerCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = canvas.width = canvas.offsetWidth || 300;
    let height = canvas.height = canvas.offsetHeight || 60;
    const barCount = 36;
    const barWidth = width / barCount - 2;
    const heights = Array(barCount).fill(4);

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // Gradient for cyberpunk feeling
      const gradient = ctx.createLinearGradient(0, height, 0, 0);
      gradient.addColorStop(0, "rgba(0, 130, 138, 0.2)");
      gradient.addColorStop(0.5, "rgba(0, 255, 209, 0.6)");
      gradient.addColorStop(1, "rgba(0, 255, 209, 0.95)");

      for (let i = 0; i < barCount; i++) {
        let targetHeight = 4;
        if (isPlaying) {
          // Create simulated dynamic frequencies
          const multiplier = Math.sin(Date.now() * 0.003 + i * 0.2) + Math.cos(Date.now() * 0.007 - i * 0.5);
          targetHeight = Math.max(4, Math.abs(multiplier) * (height - 8) * (0.4 + Math.random() * 0.6));
        } else {
          // Low resting state noise
          targetHeight = 4 + Math.sin(Date.now() * 0.001 + i * 0.1) * 2;
        }

        // Smooth height transition
        heights[i] = heights[i] * 0.7 + targetHeight * 0.3;

        const x = i * (barWidth + 2);
        const y = height - heights[i];

        // Drawing sleek capsule rounded bars
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, heights[i], 2);
        ctx.fill();
      }

      animationFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isPlaying]);

  // Helper: Stop playback safely
  const stopPlayback = () => {
    setIsPlaying(false);
    if (audioSource) {
      audioSource.pause();
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setSpeechSynthesisActive(false);
    if (playheadIntervalRef.current) {
      clearInterval(playheadIntervalRef.current);
      playheadIntervalRef.current = null;
    }
  };

  // Main Playback Controller (Handles file-audio vs. text-to-speech fallback smoothly)
  const handlePlayPause = () => {
    if (isPlaying) {
      stopPlayback();
      return;
    }

    setIsPlaying(true);

    // If we have returned real audioData from server
    if (currentShow.audioData) {
      if (!audioSource) {
        const audioUri = `data:audio/mp3;base64,${currentShow.audioData}`;
        const audio = new Audio(audioUri);
        audio.playbackRate = playbackSpeed;
        audio.volume = isMuted ? 0 : volume;

        audio.addEventListener("timeupdate", () => {
          const rawTime = audio.currentTime;
          setCurrentTime(rawTime);
          syncTranscriptToTime(rawTime);
        });

        audio.addEventListener("ended", () => {
          stopPlayback();
          setCurrentTime(0);
          setCurrentSegmentIndex(0);
        });

        setAudioSource(audio);
        audio.play().catch(e => {
          console.error("Audio playback error:", e);
          // If native play fails, fallback to simulated speaker speech synthesis
          runSimulationPlayback();
        });
      } else {
        audioSource.playbackRate = playbackSpeed;
        audioSource.play().catch(() => runSimulationPlayback());
      }
    } else {
      // Trigger dynamic browser-native TTS synthesis of script segments, mapped by speaker
      runSimulationPlayback();
    }
  };

  // Run dynamic simulated speech playback
  const runSimulationPlayback = () => {
    setSpeechSynthesisActive(true);
    let cumulativeTimes = [0];
    currentShow.segments.forEach((seg, i) => {
      cumulativeTimes.push(cumulativeTimes[i] + seg.durationSeconds);
    });

    // Handle timer for mock playhead progress bar
    const startTimeStamp = Date.now() - (currentTime * 1000 / playbackSpeed);

    if (playheadIntervalRef.current) clearInterval(playheadIntervalRef.current);

    // Start native TTS or playhead timer
    playheadIntervalRef.current = window.setInterval(() => {
      const elapsed = ((Date.now() - startTimeStamp) / 1000) * playbackSpeed;
      if (elapsed >= totalDuration) {
        stopPlayback();
        setCurrentTime(totalDuration);
        setCurrentSegmentIndex(currentShow.segments.length - 1);
        return;
      }

      setCurrentTime(elapsed);
      syncTranscriptToTime(elapsed);
    }, 100) as unknown as number;

    // Speak active segment with SpeechSynthesis if active
    speakActiveSegment(currentSegmentIndex);
  };

  const syncTranscriptToTime = (time: number) => {
    let accumulated = 0;
    for (let i = 0; i < currentShow.segments.length; i++) {
      const seg = currentShow.segments[i];
      if (time >= accumulated && time < accumulated + seg.durationSeconds) {
        if (currentSegmentIndex !== i) {
          setCurrentSegmentIndex(i);
          // Only trigger speak if we are in fallback speech synthesis and not playing real file audio
          if (!currentShow.audioData) {
            speakActiveSegment(i);
          }
        }
        break;
      }
      accumulated += seg.durationSeconds;
    }
  };

  // Custom text-to-speech engine using browser SpeechSynthesis
  const speakActiveSegment = (index: number) => {
    if (!("speechSynthesis" in window) || currentShow.audioData) return;

    window.speechSynthesis.cancel(); // Stop pre-existing utterances

    const segment = currentShow.segments[index];
    if (!segment) return;

    const utterance = new SpeechSynthesisUtterance(segment.text);
    utterance.rate = playbackSpeed;

    // Get available voices and try to assign distinct voices based on selection
    const voices = window.speechSynthesis.getVoices();
    
    if (segment.speaker === "Alex") {
      // Look for a standard masculine/neutral analyst voice
      const preferred = voices.find(v => v.name.includes("Google US English") || v.name.includes("Microsoft David") || v.name.includes("Male"));
      if (preferred) utterance.voice = preferred;
      utterance.pitch = 0.95; // slightly lower pitch for host A
    } else {
      // Look for a standard bright feminine/neutral voice
      const preferred = voices.find(v => v.name.includes("Zira") || v.name.includes("Hazel") || v.name.includes("Female") || v.name.includes("Google UK English Female"));
      if (preferred) utterance.voice = preferred;
      utterance.pitch = 1.15; // slightly higher vocal pitch for host B
    }

    synthesisUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  };

  const handleReset = () => {
    stopPlayback();
    setCurrentTime(0);
    setCurrentSegmentIndex(0);
    if (audioSource) {
      audioSource.currentTime = 0;
    }
  };

  // Simulated live broadcast synthesis pipeline with progress feedback
  const triggerSynthesis = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isGenerating) return;

    stopPlayback();
    setIsGenerating(true);
    setGenerationStep(1);
    setGenerationLogs([]);

    const addLog = (msg: string) => {
      setGenerationLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };

    addLog("⚡ INITIALIZING BROADCAST CONSOLE SIGNAL...");
    await new Promise(r => setTimeout(r, 600));

    addLog(`🎙️ PRE-PROCESSING PROFILE CONFIGS - User: "${userName}", Company: "${companyName || 'Unknown'}"`);
    setGenerationStep(2);
    await new Promise(r => setTimeout(r, 800));

    addLog(`💡 PARSING SUBJECT OUTLINE: "${subjectText || 'General Tech Overview'}"`);
    setGenerationStep(3);
    await new Promise(r => setTimeout(r, 900));

    addLog("🤖 CONNECTING SECURE SATELLITE TO GEMINI BROADCAST ENGINES...");
    setGenerationStep(4);

    try {
      // Call local backend endpoint
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subjectText || "High-End System Design Harmonization",
          userName,
          companyName,
          playbackSpeed,
          voiceSelection,
          hostsCount
        })
      });

      if (!response.ok) {
        throw new Error("Local server reported error or disconnected.");
      }

      const rawData = await response.json();
      
      addLog(`✨ SCRIPTS RECEIVED! TITLE: "${rawData.title}"`);
      await new Promise(r => setTimeout(r, 600));

      if (rawData.audioData) {
        addLog("🔊 AUDIO SYNTHESIS COMPLETED SUCCESSFUL - Base64 pipeline streaming.");
      } else {
        addLog("⚠️ VOICE SYNTH FALLBACK TRIGGERED - Harnessing local SpeechSynthesis.");
      }

      setGenerationStep(5);
      addLog("🎚️ MIXING DOWN HOST AUDIO WITH AMBIENT COGNITIVE BED...");
      await new Promise(r => setTimeout(r, 700));

      addLog("📺 BROADCAST MASTER READY. INJECTING TO MEDIA PLAYER CHANNEL.");
      await new Promise(r => setTimeout(r, 400));

      setCurrentShow({
        title: rawData.title,
        segments: rawData.segments,
        audioData: rawData.audioData,
        usingFallback: rawData.usingFallback
      });

      // Clear audio player object to force renewal of audio Data URI next click
      setAudioSource(null);

    } catch (e: any) {
      addLog(`❌ PIPELINE EXCEPTION: ${e.message || "Connection interrupted."}`);
      addLog("👉 REVERTING TO LOCAL PROCEDURAL RADIO ASSEMBLY MATRIX...");
      await new Promise(r => setTimeout(r, 1200));

      // Generate a client-side beautiful procedural script show so the interface never breaks
      const targetSub = subjectText || "Digital Architecture Mastery";
      const procedSegments = [
        {
          speaker: "Alex",
          text: `Hey ${userName}, welcome back. We're tuning our frequencies to talk about ${targetSub}, and this is Alex from the technical core dashboard.`,
          voiceName: voiceSelection,
          mood: "cheerful",
          durationSeconds: 9
        }
      ];

      if (hostsCount === 2) {
        procedSegments.push({
          speaker: "Sam",
          text: `And I'm Sam, supporting the frequency of ${companyName || 'your local machine'}. This theme represents solid craftsmanship in a dark, beautiful UI.`,
          voiceName: voiceSelection === "Kore" ? "Puck" : "Fenrir",
          mood: "excited",
          durationSeconds: 10
        });
        procedSegments.push({
          speaker: "Alex",
          text: `Strict spatial harmonization, beautiful glowing sliders, and absolute focus on user intent. This is AI Talk Radio signing off for this block!`,
          voiceName: voiceSelection,
          mood: "upbeat",
          durationSeconds: 8
        });
      } else {
        procedSegments.push({
          speaker: "Alex",
          text: `For everyone at ${companyName || 'the workspace'}, standard procedural generation has compiled this sequence. All controllers remain functional!`,
          voiceName: voiceSelection,
          mood: "thoughtful",
          durationSeconds: 9
        });
      }

      setCurrentShow({
        title: `Matrix Forum: ${targetSub.substring(0, 24)}`,
        segments: procedSegments,
        audioData: null,
        usingFallback: true
      });
      setAudioSource(null);
    } finally {
      setIsGenerating(false);
      setGenerationStep(0);
    }
  };

  const currentSegment = currentShow.segments[currentSegmentIndex];

  // Helper values for media timeline
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  return (
    <main className="h-screen max-h-screen overflow-hidden flex flex-col bg-brand-dark text-neutral-300 scanlines text-sm font-sans" id="deck-root">
      
      {/* Dynamic Cyber Header Deck */}
      <header className="border-b border-brand-teal/20 bg-brand-panel/80 px-6 py-4 flex items-center justify-between z-20 shrink-0" id="header-bar">
        <div className="flex items-center space-x-3">
          <div className="relative flex items-center justify-center w-8 h-8 rounded border border-brand-cyan/40 bg-brand-dark/90 animate-pulse">
            <Radio className="w-4 h-4 text-brand-cyan" />
            <span className="absolute top-0 right-0 w-2 h-2 rounded-full bg-brand-cyan animate-ping" />
          </div>
          <div>
            <h1 className="font-display font-black tracking-widest text-[#00FFD1] text-lg glow-text-cyan uppercase">
              AI Talk Radio
            </h1>
            <p className="text-[10px] uppercase font-mono tracking-widest text-brand-teal/60">
              Interactive Broadcast System // Console Ver 4.0
            </p>
          </div>
        </div>

        {/* Global Operational Status */}
        <div className="hidden md:flex items-center space-x-6 text-[11px] font-mono border-l border-brand-teal/20 pl-6">
          <div className="flex items-center space-x-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-zinc-400 uppercase">SYS: ACTIVE</span>
          </div>
          <div className="flex items-center space-x-2">
            <span className="text-zinc-500">BANDWIDTH:</span>
            <span className="text-brand-cyan">1.2 Gbps</span>
          </div>
          <div className="flex items-center space-x-2">
            <span className="text-zinc-500">SYNTH MODE:</span>
            <span className="text-brand-cyan uppercase">
              {currentShow.audioData ? "GEMINI FLUID STS" : "LOCAL VOICE GENERATOR"}
            </span>
          </div>
        </div>
      </header>

      {/* Main Multi-Columns Operatives Desktop (Height bounded to allow zero scroll experience) */}
      <section className="flex-1 min-h-0 w-full grid grid-cols-1 lg:grid-cols-12 gap-4 p-4" id="main-grid">
        
        {/* Left Column (Content Core & Transmitter Parameters Panel) - occupying 4 cols */}
        <div className="lg:col-span-4 flex flex-col space-y-4 min-h-0" id="left-column">
          
          {/* PROFILE DECK (localStorage saved) */}
          <section className="glow-border-cyan rounded-lg bg-brand-panel/50 p-4 border border-brand-teal/15 space-y-3 shadow-md" id="profile-deck">
            <div className="flex items-center space-x-2 text-brand-cyan border-b border-brand-teal/10 pb-2">
              <User className="w-4 h-4 text-brand-cyan" />
              <h2 className="font-header font-bold tracking-wider text-xs uppercase text-zinc-200">
                Transmitter Profile Setup
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-mono tracking-wider text-zinc-500">Operator Initials</label>
                <input
                  type="text"
                  placeholder="e.g. Jono"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  className="w-full bg-black/60 border border-brand-teal/25 rounded px-2.5 py-1.5 text-brand-cyan focus:outline-none focus:border-brand-cyan font-mono"
                  id="profile-user-name"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-mono tracking-wider text-zinc-500">Organization Bed</label>
                <input
                  type="text"
                  placeholder="e.g. Aether Design"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="w-full bg-black/60 border border-brand-teal/25 rounded px-2.5 py-1.5 text-neutral-300 focus:outline-none focus:border-brand-cyan font-mono"
                  id="profile-company-name"
                />
              </div>
            </div>
          </section>

          {/* BROADCAST WRITER MATRIX */}
          <form
            onSubmit={triggerSynthesis}
            className="flex-1 min-h-0 flex flex-col glow-border-cyan rounded-lg bg-brand-panel p-4 border border-brand-teal/15 space-y-4 shadow-lg text-xs"
            id="write-form"
          >
            <div className="flex items-center justify-between text-brand-cyan border-b border-brand-teal/10 pb-2">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-4 h-4 text-brand-cyan animate-signal" />
                <h2 className="font-header font-bold tracking-wider uppercase text-zinc-200">
                  Broadcast Synthesis Deck
                </h2>
              </div>
              <span className="text-[9px] font-mono tracking-wide px-1.5 py-0.5 rounded bg-brand-teal/15 border border-brand-teal/30 text-brand-cyan uppercase">
                COGNITIVE FEED
              </span>
            </div>

            {/* Input Subject Content */}
            <div className="flex-1 min-h-0 flex flex-col space-y-1.5" id="subject-input-block">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-mono uppercase tracking-wider text-zinc-400">Subject Blueprint</label>
                <span className="text-[9px] text-zinc-500 font-mono">{(subjectText || "").length} / 400</span>
              </div>
              <textarea
                placeholder="Declare target broadcasting themes or deep technological papers to be converted into a radio script..."
                maxLength={400}
                value={subjectText}
                onChange={(e) => setSubjectText(e.target.value)}
                className="flex-1 min-h-0 w-full resize-none bg-black/60 border border-brand-teal/25 rounded p-3 text-neutral-200 focus:outline-none focus:border-brand-cyan font-sans placeholder-zinc-600 leading-relaxed"
                id="subject-textarea"
                disabled={isGenerating}
              />
              {/* Intelligent Prompt Helpers */}
              <div className="space-y-1 py-1" id="prompt-shortcuts">
                <span className="text-[9px] uppercase font-mono tracking-wider text-zinc-500">Operational Presets:</span>
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {[
                    "Next-Gen React architecture in standard sandboxes",
                    "The Rust-Powered Oxide Engine of Tailwind v4.0",
                    "Visual design rhythms on an 8pt layout grid",
                    "Holistic mindfulness and high performance biosensors"
                  ].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setSubjectText(preset)}
                      className="text-[9.5px] font-mono border border-brand-teal/15 hover:border-brand-cyan/40 hover:bg-brand-cyan/5 px-2 py-0.5 rounded text-zinc-400 hover:text-brand-cyan transition-all"
                      disabled={isGenerating}
                    >
                      {preset.substring(0, 24)}...
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* SYNTHESIS TUNING PARAMETERS */}
            <div className="bg-black/40 border border-brand-teal/10 rounded-lg p-3 space-y-3" id="synthesis-parameters">
              <div className="flex items-center justify-between text-[10px] border-b border-brand-teal/10 pb-1.5">
                <span className="font-mono text-zinc-400 uppercase tracking-wider">Aesthetic Adjustments</span>
                <Settings className="w-3.5 h-3.5 text-brand-teal/60" />
              </div>

              {/* Pitch-Voice Selector */}
              <div className="grid grid-cols-2 gap-3" id="tuning-grid">
                <div className="space-y-1">
                  <label className="text-[9px] uppercase font-mono tracking-wider text-zinc-500">VOICE MATRIX</label>
                  <select
                    value={voiceSelection}
                    onChange={(e) => setVoiceSelection(e.target.value)}
                    className="w-full bg-[#181a20] border border-brand-teal/25 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-brand-cyan font-mono"
                    id="param-voice-selection"
                    disabled={isGenerating}
                  >
                    <option value="Kore">Kore - Analytical</option>
                    <option value="Puck">Puck - Energetic</option>
                    <option value="Fenrir">Fenrir - Narrative</option>
                    <option value="Aoede">Aoede - Playful</option>
                  </select>
                </div>

                {/* Hosts Count Toggle */}
                <div className="space-y-1">
                  <label className="text-[9px] uppercase font-mono tracking-wider text-zinc-500">HOST COUNT</label>
                  <div className="grid grid-cols-2 gap-1 bg-[#181a20] p-0.5 rounded border border-brand-teal/20">
                    <button
                      type="button"
                      onClick={() => setHostsCount(1)}
                      className={`py-0.5 text-[10px] font-mono rounded text-center transition-all ${
                        hostsCount === 1
                          ? "bg-brand-teal/20 text-brand-cyan border border-brand-cyan/20"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                      disabled={isGenerating}
                    >
                      <User className="w-2.5 h-2.5 inline mr-1" />
                      1
                    </button>
                    <button
                      type="button"
                      onClick={() => setHostsCount(2)}
                      className={`py-0.5 text-[10px] font-mono rounded text-center transition-all ${
                        hostsCount === 2
                          ? "bg-brand-teal/20 text-brand-cyan border border-brand-cyan/20"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                      disabled={isGenerating}
                    >
                      <Users className="w-2.5 h-2.5 inline mr-1" />
                      2
                    </button>
                  </div>
                </div>
              </div>

              {/* Playback speed slider bar */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[9px] font-mono">
                  <span className="text-zinc-500 uppercase tracking-wider">SPEED INDEX</span>
                  <span className="text-brand-cyan font-bold">{playbackSpeed.toFixed(2)}x</span>
                </div>
                <div className="flex items-center space-x-3">
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    value={playbackSpeed}
                    onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                    className="flex-1 accent-brand-cyan bg-[#181a20] h-1 rounded"
                    id="param-playback-speed"
                  />
                </div>
              </div>
            </div>

            {/* SYNTHESIZE TRIGGER BUTTON */}
            <button
              type="submit"
              disabled={isGenerating}
              className={`relative overflow-hidden w-full font-display font-black tracking-widest text-xs uppercase rounded py-3.5 px-4 transition-all duration-300 border ${
                isGenerating
                  ? "bg-brand-panel/40 border-brand-teal/30 text-zinc-400 cursor-not-allowed"
                  : "bg-gradient-to-r from-brand-teal/40 to-brand-cyan/40 text-brand-cyan border-brand-cyan/40 hover:from-brand-teal/60 hover:to-brand-cyan/60 glow-text-cyan hover:shadow-[0_0_15px_rgba(0,255,209,0.2)]"
              }`}
              id="synthesize-button"
            >
              {isGenerating ? (
                <div className="flex items-center justify-center space-x-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-cyan animate-ping" />
                  <span className="font-mono tracking-widest text-[10px]">
                    COMPILE MATRIX (STEP {generationStep}/5)...
                  </span>
                </div>
              ) : (
                <div className="flex items-center justify-center space-x-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-cyan" />
                  <span>Synthesize Broadcast</span>
                </div>
              )}
              {isGenerating && (
                <span className="absolute inset-0 bg-brand-cyan/10 animate-sweep" />
              )}
            </button>
          </form>
        </div>

        {/* Center / Right Column Combined Operational Matrix: occupy 8 cols */}
        <div className="lg:col-span-8 flex flex-col space-y-4 min-h-0" id="right-column">
          
          {/* Active Generation Logs (Only displays when compiling to represent dynamic broadcast backend pipeline) */}
          {isGenerating ? (
            <div className="flex-1 min-h-0 flex flex-col glow-border-cyan rounded-lg bg-brand-panel border border-brand-teal/25 p-4 space-y-3" id="compiling-screen">
              <div className="flex items-center space-x-2 text-brand-cyan border-b border-brand-teal/10 pb-2">
                <Terminal className="w-4 h-4 text-brand-cyan" />
                <h2 className="font-header font-bold tracking-wider text-xs uppercase text-zinc-200">
                  Broadcast Compliation Logs
                </h2>
              </div>
              <div className="flex-1 min-h-0 bg-black/80 font-mono text-xs text-zinc-400 p-4 rounded border border-brand-teal/10 overflow-y-auto space-y-1.5">
                {generationLogs.map((log, index) => (
                  <div key={index} className="leading-relaxed border-l-2 border-brand-cyan/30 pl-2">
                    {log}
                  </div>
                ))}
                
                {generationStep > 0 && (
                  <div className="pt-2 animate-pulse flex items-center space-x-1">
                    <span className="text-brand-cyan">❯</span>
                    <span className="text-brand-cyan">PROCESSING SPECTRAL FEED...</span>
                  </div>
                )}
                <div ref={terminalBottomRef} />
              </div>
              {/* Progress Bar Indicator */}
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                  <span>METRIC COMPLETION STATUS</span>
                  <span>{Math.round((generationStep / 5) * 100)}%</span>
                </div>
                <div className="bg-black/60 h-2 rounded overflow-hidden border border-brand-teal/20">
                  <div
                    className="bg-gradient-to-r from-brand-teal to-brand-cyan h-full transition-all duration-500"
                    style={{ width: `${(generationStep / 5) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          ) : (
            
            /* Main Broadcast Desk and Script Transcript Reader Frame (Visible on normal loop) */
            <div className="flex-1 min-h-0 flex flex-col space-y-4" id="broadcast-center-frame">
              
              {/* HIGH END BUILT-IN MEDIA PLAYER CONTROLLER */}
              <section className="glow-border-cyan rounded-lg bg-brand-panel p-4 border border-brand-teal/15 shadow-md flex flex-col space-y-3" id="integrated-media-player">
                
                {/* Track Headers */}
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-[9px] uppercase font-mono tracking-widest text-[#00FFD1] bg-[#00ffd1]/10 px-2 py-0.5 rounded border border-brand-cyan/20">
                      Now Streaming
                    </span>
                    <h3 className="font-display font-semibold text-neutral-100 tracking-wide mt-1 text-base">
                      {currentShow.title}
                    </h3>
                  </div>

                  <div className="flex items-center space-x-2">
                    {currentShow.usingFallback && (
                      <span className="text-[9px] font-mono text-orange-400 border border-orange-400/25 px-1.5 py-0.5 rounded uppercase">
                        Browser Synth Enabled
                      </span>
                    )}
                    <span className="text-[10px] font-mono text-zinc-400 bg-black px-2 py-1 rounded">
                      SEGMENT: {currentSegmentIndex + 1}/{currentShow.segments.length}
                    </span>
                  </div>
                </div>

                {/* Spectral High-Resolution Animated Visualizer wave */}
                <div className="relative bg-black/70 border border-brand-teal/15 rounded-lg p-3 flex flex-col justify-end min-h-[70px] overflow-hidden" id="visualizer-container">
                  <canvas ref={visualizerCanvasRef} className="w-full h-[50px] opacity-90" />
                  <div className="absolute inset-x-3 bottom-0 flex justify-between text-[9px] font-mono text-brand-teal/60 uppercase">
                    <span>Grid Core System</span>
                    <span>10.1 kHz Lowpass Filter</span>
                    <span>Broadcasting Signal</span>
                  </div>
                </div>

                {/* Timeline Player Scrub-bar indicator */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                    <span>{formatTime(currentTime)}</span>
                    <span className="text-zinc-500">// TOTAL INTERACTIVE DURATION //</span>
                    <span>{formatTime(totalDuration)}</span>
                  </div>
                  <div className="relative group">
                    <div 
                      onClick={(e) => {
                        // Support spatial clicking/seeking
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickX = e.clientX - rect.left;
                        const pct = clickX / rect.width;
                        const targetTime = pct * totalDuration;
                        setCurrentTime(targetTime);
                        if (audioSource) {
                          audioSource.currentTime = targetTime;
                        }
                        syncTranscriptToTime(targetTime);
                      }}
                      className="bg-zinc-800 h-1.5 rounded cursor-pointer overflow-hidden relative"
                    >
                      <div
                        className="bg-brand-cyan h-full hover:bg-brand-cyan shadow-[0_0_8px_rgba(0,255,209,1)] transition-all"
                        style={{ width: `${(currentTime / totalDuration) * 100}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* Core Player Knobs & Switches */}
                <div className="flex items-center justify-between pt-1" id="player-controls-deck">
                  <div className="flex items-center space-x-3.5">
                    {/* Play/Pause Button conforming to geometric rule */}
                    <button
                      onClick={handlePlayPause}
                      className={`w-10 h-10 rounded border flex items-center justify-center transition-all ${
                        isPlaying
                          ? "bg-brand-cyan/15 text-brand-cyan border-brand-cyan/40 hover:bg-brand-cyan/25"
                          : "bg-brand-dark hover:bg-zinc-900 border-brand-teal/35 text-zinc-200"
                      }`}
                      id="command-toggle-play"
                      title={isPlaying ? "Pause Stream" : "Initiate Broadcast Stream"}
                    >
                      {isPlaying ? (
                        <Pause className="w-5 h-5 fill-current" />
                      ) : (
                        <Play className="w-5 h-5 fill-current ml-0.5" />
                      )}
                    </button>

                    {/* Reset Button */}
                    <button
                      onClick={handleReset}
                      className="w-8 h-8 rounded border border-brand-teal/20 bg-brand-dark hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 flex items-center justify-center transition-all"
                      id="command-toggle-reset"
                      title="Reset Track"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Operational Settings Quick-Check info row */}
                  <div className="hidden lg:flex items-center text-[11px] text-zinc-500 font-mono space-x-4 border-l border-brand-teal/15 pl-4">
                    <span>RECIPIENT: <b className="text-brand-cyan uppercase font-bold">{userName}</b></span>
                    <span>BED: <b className="text-zinc-300 uppercase font-bold">{companyName || "AETHER LABS"}</b></span>
                  </div>

                  {/* High Quality Volume Control section */}
                  <div className="flex items-center space-x-2.5">
                    <button
                      onClick={() => setIsMuted(!isMuted)}
                      className="text-zinc-400 hover:text-brand-cyan transition-colors"
                      id="volume-toggle-mute"
                    >
                      {isMuted ? (
                        <VolumeX className="w-4 h-4 text-rose-500 animate-pulse" />
                      ) : (
                        <Volume2 className="w-4 h-4 text-brand-teal/80 hover:text-brand-cyan" />
                      )}
                    </button>
                    <input
                      type="range"
                      min="0.0"
                      max="1.0"
                      step="0.05"
                      disabled={isMuted}
                      value={volume}
                      onChange={(e) => setVolume(parseFloat(e.target.value))}
                      className="w-16 accent-brand-cyan bg-zinc-800 h-1 rounded disabled:opacity-30"
                      id="volume-master-slider"
                    />
                  </div>
                </div>
              </section>

              {/* TIMECODED TRANSCRIPT LIVE PANE */}
              <section className="flex-1 min-h-0 flex flex-col glow-border-cyan rounded-lg bg-brand-panel p-4 border border-brand-teal/15 shadow-md" id="transcript-deck">
                <div className="flex items-center justify-between text-brand-cyan border-b border-brand-teal/10 pb-2">
                  <div className="flex items-center space-x-2">
                    <FileText className="w-4 h-4 text-brand-cyan" />
                    <h2 className="font-header font-bold tracking-wider text-xs uppercase text-zinc-200">
                      Live Broadcast Teleprompter Flow
                    </h2>
                  </div>
                  <span className="text-[9px] font-mono text-zinc-500">
                    SPEED FACTOR: {playbackSpeed}X
                  </span>
                </div>

                {/* Chronologically highlights each statement linked to playback times */}
                <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pt-3 pr-1" id="transcript-scroll-area">
                  {currentShow.segments.map((segment, index) => {
                    const isActive = currentSegmentIndex === index && isPlaying;
                    return (
                      <div
                        key={index}
                        className={`transition-all duration-300 p-3 rounded border text-xs leading-relaxed flex flex-col space-y-1 select-none ${
                          isActive
                            ? "bg-[#0b0f19] border-brand-cyan/55 shadow-[0_0_12px_rgba(0,255,209,0.1)] text-[#ffffff]"
                            : "bg-black/25 border-brand-teal/10 text-zinc-400 hover:border-brand-teal/20"
                        }`}
                      >
                        {/* Speaker Meta Information header */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <span 
                              className={`w-1.5 h-1.5 rounded-full ${
                                segment.speaker === "Alex" 
                                  ? "bg-brand-cyan shadow-[0_0_6px_rgba(0,255,209,1)]" 
                                  : "bg-[#FF0055] shadow-[0_0_6px_rgba(255,0,85,1)]"
                              }`} 
                            />
                            <span className="font-display font-black tracking-widest text-[#00FFD1] uppercase text-[10px]">
                              {segment.speaker}
                            </span>
                            <span className="font-mono text-[9px] text-zinc-500 bg-black/60 px-1.5 py-0.5 rounded tracking-wide uppercase">
                              {segment.mood} mood // voice: {segment.voiceName}
                            </span>
                          </div>
                          
                          <span className="text-[10px] font-mono text-zinc-600">
                            ~{segment.durationSeconds} SECS
                          </span>
                        </div>

                        {/* Text Chunk */}
                        <p className={`font-sans ${isActive ? "text-neutral-100 font-medium" : "text-zinc-400"}`}>
                          {segment.text}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>

            </div>
          )}
        </div>
      </section>

      {/* Aesthetic Bottom Metadata Info Bar */}
      <footer className="border-t border-brand-teal/20 bg-brand-panel/90 px-6 py-2 flex items-center justify-between text-[11px] text-zinc-500 font-mono shrink-0" id="deck-footer">
        <div>
          <span>OPERATIVE UTC TIME: <b>2026-06-02 11:33:38</b></span>
        </div>
        <div className="flex items-center space-x-4">
          <span className="hover:text-neutral-300 transition-colors uppercase">
            Designed on 8pt Grid System
          </span>
          <span className="text-[#00FFD1]">● SYSTEM SYNC STEADY</span>
        </div>
      </footer>
    </main>
  );
}
