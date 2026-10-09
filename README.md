

An AI-powered personal radio station. Drop in a web address, upload documents (TXT/MD/PDF), or push a JSON script from another app — JB3 Air Radio turns it into a multi-host podcast-style show with synchronized transcript playback.

## Features

- **Multiple content sources**
  - Paste a URL → server fetches and extracts readable article text
  - Upload documents (`.txt`, `.md`, `.pdf`) → text is extracted locally on the server
  - Push a pre-made script as JSON from another app (see `POST /api/ingest`)
- **Premium path (Gemini)**: validated script generation + per-segment multi-speaker TTS with *real measured durations* for accurate transcript sync
- **Free fallback path**: browser Speech Synthesis with deterministic voice selection (`getVoices()` + `onvoiceschanged` handling) — no API key required
- **Once-per-day free quota guard**: caps premium Gemini generations per UTC day (`DAILY_PREMIUM_LIMIT`, default 10; set `0` to disable premium entirely)
- **Reliable playback**: `useRadioPlayer` hook drives the playhead from actual audio/speech events (no stale-closure timer drift), with pause/resume, scrubbing, and volume control

## Project Structure

```
server.ts               Express server + API routes (dev & prod)
src/
  App.tsx               UI shell
  types.ts              Shared types (ScriptSegment, etc.)
  hooks/useRadioPlayer.ts   Playback engine hook
  lib/radio-core.ts     Pure core logic: model resolution, voice enums,
                        script validation, duration math, PCM→WAV
  lib/gemini-pipeline.ts    Server pipeline: validated script gen,
                        per-segment TTS, daily quota guard
  lib/ingest.ts         URL/document/JSON ingestion (HTML extraction,
                        minimal PDF text extraction, SSRF-safe URL checks)
  lib/*.test.ts         Vitest unit tests (52 passing)
```

## Run Locally

**Prerequisites:** Node.js 18+

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the env example and fill in your key:
   ```bash
   cp .env.example .env.local
   ```
   Set `GEMINI_API_KEY` to your [Gemini API key](https://aistudio.google.com/apikey).
   *(Optional — without a key the app still works using the free browser-TTS fallback.)*
3. Start the dev server:
   ```bash
   npm run dev
   ```
   Open the URL printed in the terminal (Vite serves the client; `server.ts` provides the API).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Required for the premium (Gemini) path |
| `GEMINI_SCRIPT_MODEL` | `gemini-3-flash-preview` | Script-writing model override |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | Multi-speaker TTS model override |
| `DAILY_PREMIUM_LIMIT` | `10` | Premium generations per UTC day (`0` disables premium) |
| `PORT` | `3000` | HTTP port |

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start server + Vite dev middleware |
| `npm run build` | Build client (`dist/`) and bundle server (`dist/server.cjs`) |
| `npm start` | Run the production build |
| `npm test` | Run Vitest unit tests |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | TypeScript type-check (`tsc --noEmit`) |

## API Overview

- `POST /api/generate` — Generate a show. Accepts `{ subject, sourceText?, presetScript?, voiceSelection?, hostsCount? }`. Returns segments with per-segment audio (base64 WAV, real durations) when the premium path runs, or a fallback plan for browser TTS.
- `POST /api/ingest` — Ingest external content. Accepts `{ url }` (fetch + extract readable text) or `{ json }` (pushed script payload, normalized and validated).

## Notes

- PDF text extraction is a lightweight built-in decoder (works for common uncompressed/Flate text streams). For heavily formatted or scanned PDFs, plain-text/markdown sources give better results.
- The daily quota counter persists server-side per UTC day; restarting the server resets it unless persistence storage is available.
