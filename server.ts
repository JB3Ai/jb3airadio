import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = 3000;

// Initialize Gemini SDK with custom User-Agent
let ai: GoogleGenAI | null = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

// Fallback scripts based on some popular subject keywords
function getFallbackScript(subject: string, userName: string, companyName: string, voiceSelection: string, hostsCount: number) {
  const normSubject = (subject || "").toLowerCase();
  let topicBrief = "modern technology innovations";
  let discussionPoints = [
    "AI is rapidly automating tedious work and freeing up humans to focus on creative tasks.",
    "The transition requires clean, responsive interfaces that focus heavily on modern design systems."
  ];

  if (normSubject.includes("sport") || normSubject.includes("game") || normSubject.includes("football") || normSubject.includes("basketball")) {
    topicBrief = "current sports trends and athletic performance";
    discussionPoints = [
      "Analytics and high-tech wearable biosensors are completely redefining how athletes train.",
      "But under pressure, it's still about raw mental grit and teamwork on the pitch."
    ];
  } else if (normSubject.includes("music") || normSubject.includes("art") || normSubject.includes("movie") || normSubject.includes("design")) {
    topicBrief = "the intersection of creative arts and digital design";
    discussionPoints = [
      "Design trends are shifting towards dark-mode, high-fidelity interfaces with 8pt layouts.",
      "True craftsmanship lies in delivering subtle, micro-interactions that feel premium and tactile."
    ];
  } else if (normSubject.includes("health") || normSubject.includes("food") || normSubject.includes("fitness")) {
    topicBrief = "holistic health, longevity, and active fitness";
    discussionPoints = [
      "Consistency in minor daily routines generates compounding physical and psychological benefits.",
      "The key is adapting technology to serve customized, mindful recovery plans."
    ];
  } else if (normSubject.includes("business") || normSubject.includes("finance") || normSubject.includes("money") || normSubject.includes("marketing")) {
    topicBrief = "the changing landscape of digital entrepreneurship";
    discussionPoints = [
      "Success in hyper-competitive markets relies on personalizing workflows for specific niches.",
      "Integrating bespoke tools creates unmatched operational leverage for modern teams."
    ];
  }

  const hostA = "Alex";
  const hostB = "Sam";
  const voiceA = voiceSelection || "Kore";
  const voiceB = voiceA === "Puck" ? "Fenrir" : "Puck";

  const title = `Insight Frequency: ${subject || "Next-Gen Media Forum"}`;

  const segments = [];

  // Segment 1: Welcome and Shoutout
  segments.push({
    speaker: hostA,
    text: `Welcome to AI Talk Radio! I'm Alex. We are coming to you live, and today we have a very special broadcast for ${userName} tuning in from ${companyName || 'the studio'}. We're diving deep into ${subject || 'the landscape of future technologies'}.`,
    voiceName: voiceA,
    mood: "cheerful",
    durationSeconds: 12
  });

  if (hostsCount === 2) {
    // Segment 2: Host B response
    segments.push({
      speaker: hostB,
      text: `That's right, Alex! Hello everyone, Sam here. It's fantastic to have ${userName} with us. Touching on ${subject || 'our main topic'}, it's clear things are changing. ${discussionPoints[0]}`,
      voiceName: voiceB,
      mood: "excited",
      durationSeconds: 13
    });

    // Segment 3: Host A analyses
    segments.push({
      speaker: hostA,
      text: `Exactly, Sam. That brings up a fascinating point. If we look at the data, ${discussionPoints[1]} It is all about structural precision and execution in high-end design.`,
      voiceName: voiceA,
      mood: "thoughtful",
      durationSeconds: 11
    });

    // Segment 4: Host B wrap up
    segments.push({
      speaker: hostB,
      text: `Spot on! For ${companyName || 'any fast-moving team'}, mastering these standards is the ultimate competitive edge. That is all the time we have for this quick focus segment. Keep innovating!`,
      voiceName: voiceB,
      mood: "upbeat",
      durationSeconds: 11
    });
  } else {
    // Segment 2 (Single host)
    segments.push({
      speaker: hostA,
      text: `Let's break this down. First, ${discussionPoints[0]} This represents an extraordinary shift that affects everyone in our ecosystem.`,
      voiceName: voiceA,
      mood: "thoughtful",
      durationSeconds: 10
    });

    // Segment 3 (Single host)
    segments.push({
      speaker: hostA,
      text: `Second, to make sense of this, ${discussionPoints[1]} Shoutout to the team at ${companyName || 'your organization'} for staying ahead of these trends.`,
      voiceName: voiceA,
      mood: "cheerful",
      durationSeconds: 9
    });

    // Segment 4 (Single host)
    segments.push({
      speaker: hostA,
      text: `Thank you, ${userName}, for joining us today for this special briefing on AI Talk Radio. Keep your frequencies tuned, and we'll see you next time!`,
      voiceName: voiceA,
      mood: "upbeat",
      durationSeconds: 8
    });
  }

  return { title, segments };
}

// REST API for Generation
app.post("/api/generate", async (req, res) => {
  const { subject, userName, companyName, playbackSpeed, voiceSelection, hostsCount } = req.body;

  const resolvedUserName = userName || "Special Guest";
  const resolvedCompanyName = companyName || "Acme Corp";
  const numHosts = parseInt(hostsCount || "2") === 1 ? 1 : 2;

  console.log(`[AI Radio Server] Received request for topic: "${subject}" | User: ${resolvedUserName} | Company: ${resolvedCompanyName}`);

  if (!ai) {
    console.log("[AI Radio Server] GEMINI_API_KEY not configured. Generating high-quality procedural script.");
    const fallbackScript = getFallbackScript(subject, resolvedUserName, resolvedCompanyName, voiceSelection, numHosts);
    return res.json({
      title: fallbackScript.title,
      segments: fallbackScript.segments,
      audioData: null, // Signals client to use native multi-voice Web SpeechSynthesis
      usingFallback: true,
      message: "Server is in simulated broadcast mode (No API key present)."
    });
  }

  try {
    const hostA = "Alex";
    const hostB = "Sam";
    const voiceA = voiceSelection || "Kore";
    const voiceB = voiceA === "Puck" ? "Fenrir" : "Puck";

    const scriptPrompt = `
You are the elite broadcast scriptwriter for "AI Talk Radio", a premium, dark-first interactive radio deck.
Your absolute directive is to write a polished, high-fidelity, highly engaging radio show script centered on: "${subject || 'Modern design systems and technical excellence'}".

Details of the episode setup:
- Listener name / Guest of Honor: "${resolvedUserName}"
- Guest's Affiliation / Company: "${resolvedCompanyName}"
- Number of participating hosts: ${numHosts}

Host definitions:
- Speaker 1: "${hostA}" (analytical, articulate, upbeat)
- Speaker 2 (only include if hostsCount is 2): "${hostB}" (witty, collaborative, energetic)

Strict Rules:
1. Make sure the hosts explicitly introduce themselves and give an aesthetic personal welcome to "${resolvedUserName}" from "${resolvedCompanyName}" near the beginning.
2. Discuss the topic "${subject}" with genuine technical insights, clean terminology, and crisp conversation.
3. Keep the total number of dialogue turns between exactly 4 and 6. Each turn should be concise and conversational.
4. Host A (${hostA}) speaks with voiceName: "${voiceA}".
5. Host B (${hostB}) speaks with voiceName: "${voiceB}".
6. Map each segment's estimated duration in seconds (usually wordCount divided by 3).

Return your response strictly as a single JSON object conforming to this schema (no markdown blocks, no extra text):
{
  "title": "A short, catchy, professional title of this episode (max 40 chars)",
  "segments": [
    {
      "speaker": "${hostA}" or "${hostB}",
      "text": "The spoken speech turn matching the persona of the host",
      "voiceName": "${voiceA}" or "${voiceB}",
      "mood": "upbeat, thoughtful, excited, serious, or cheerful",
      "durationSeconds": 10
    }
  ]
}
`;

    console.log("[AI Radio Server] Triggering Gemini model for script generation...");
    const modelResponse = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: scriptPrompt,
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
                  durationSeconds: { type: Type.NUMBER }
                },
                required: ["speaker", "text", "voiceName", "mood", "durationSeconds"]
              }
            }
          },
          required: ["title", "segments"]
        }
      }
    });

    const responseText = modelResponse.text;
    if (!responseText) {
      throw new Error("Received empty script from Gemini API.");
    }

    const scriptData = JSON.parse(responseText.trim());
    console.log(`[AI Radio Server] Script generated successfully: "${scriptData.title}". Commencing TTS synthesis...`);

    // Prepare TTS content
    // Map speakers to their voiceName
    const uniqueSpeakers = Array.from(new Set(scriptData.segments.map((s: any) => s.speaker)));
    const speakerVoiceConfigs = uniqueSpeakers.map((speaker: any) => {
      const seg = scriptData.segments.find((s: any) => s.speaker === speaker);
      return {
        speaker: speaker,
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: seg?.voiceName || "Kore" }
        }
      };
    });

    const ttsTextPrompt = scriptData.segments.map((seg: any) => `${seg.speaker}: ${seg.text}`).join("\n\n");

    console.log("[AI Radio Server] Call to gemini-3.1-flash-tts-preview for audio output...");
    const ttsResponse = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: ttsTextPrompt }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: speakerVoiceConfigs
          }
        }
      }
    });

    const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      console.log("[AI Radio Server] TTS API yielded empty audio bytes. Falling back to client-side synthesis.");
      return res.json({
        title: scriptData.title,
        segments: scriptData.segments,
        audioData: null,
        usingFallback: true,
        message: "Script written successfully. Speech is handled via browser voice synth."
      });
    }

    console.log("[AI Radio Server] Successfully synthesized combined multi-speaker audio stream!");
    return res.json({
      title: scriptData.title,
      segments: scriptData.segments,
      audioData: base64Audio,
      usingFallback: false,
      message: "Interactive high-fidelity broadcast synthesized."
    });

  } catch (err: any) {
    console.error("[AI Radio Server] Error generating Gemini broadcast content:", err);
    // Return graceful procedural fallback so that application is bulletproof
    const fallbackScript = getFallbackScript(subject, resolvedUserName, resolvedCompanyName, voiceSelection, numHosts);
    return res.json({
      title: fallbackScript.title,
      segments: fallbackScript.segments,
      audioData: null,
      usingFallback: true,
      error: err.message,
      message: "Gracefully fell back to local operational synthesis."
    });
  }
});

// Setup Vite Dev Server / Static Asset Serving
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[AI Radio Server] Running at http://localhost:${PORT}`);
  });
}

startServer();
