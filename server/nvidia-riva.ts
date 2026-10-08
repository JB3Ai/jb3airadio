/**
 * NVIDIA Riva (NIM) TTS engine over gRPC — free-tier audio for the premium path.
 *
 * Uses the Chatterbox-Multilingual voices exposed on grpc.nvcf.nvidia.com:443
 * (same function-id / API key validated with the nvidia-riva/python-clients
 * `talk.py`). Implemented with @grpc/grpc-js + protobufjs so no .proto files
 * or codegen step are needed; message shapes mirror
 * riva/proto/riva_tts.proto (client v2.27).
 *
 * Env config:
 *   NVIDIA_API_KEY          - nvapi-... key (required to enable this engine)
 *   NVIDIA_RIVA_FUNCTION_ID - NIM function id (default below)
 *   NVIDIA_RIVA_SERVER      - host:port (default grpc.nvcf.nvidia.com:443)
 *   NVIDIA_RIVA_VOICE       - voice base name (default Chatterbox-Multilingual.en-US)
 */

import * as grpc from "@grpc/grpc-js";
import { credentials, ChannelCredentials } from "@grpc/grpc-js";
import * as protobuf from "protobufjs";

const COMMON_SRC = `
syntax = "proto3";
package nvidia.riva;

enum AudioEncoding {
  ENCODING_UNSPECIFIED = 0;
  LINEAR_PCM = 1;
  FLAC = 2;
  MULAW = 3;
  OGGGOPUS = 4;
  ALAW = 20;
}

message AudioResponse {
  bytes audio_content = 1;
  uint32 sample_rate_hz = 2;
}
`;

const TTS_SRC = `
syntax = "proto3";
package nvidia.riva.tts;

import "riva_audio.proto";

message SynthesizeSpeechRequest {
  string text = 1;
  string language_code = 2;
  nvidia.riva.AudioEncoding encoding = 3;
  uint32 sample_rate_hz = 4;
  string voice_name = 5;
  map<string, string> custom_configuration = 8;
}

message SynthesizeSpeechResponse {
  nvidia.riva.AudioResponse audio = 1;
}

service RivaSpeechSynthesis {
  rpc Synthesize(SynthesizeSpeechRequest) returns (SynthesizeSpeechResponse) {}
}
`;

let cachedRoot: protobuf.Root | null = null;

/** Build a protobuf Root that resolves the "riva_audio.proto" import. */
function loadRoot(): protobuf.Root {
  if (cachedRoot) return cachedRoot;
  // Parse the common proto first; then parse the TTS proto with an inline
  // resolver that returns the already-parsed common root for the import.
  const common = protobuf.parse(COMMON_SRC, { keepCase: true }).root;
  const parsed = protobuf.parse(
    TTS_SRC,
    { keepCase: true },
    (filename, callback) => {
      if (filename === "riva_audio.proto") return callback(null, common as any);
      return callback(new Error(`unresolved proto import: ${filename}`), null);
    }
  );
  cachedRoot = parsed.root;
  return cachedRoot;
}

export interface RivaTtsConfig {
  apiKey: string;
  functionId: string;
  server?: string; // host:port
  voiceBase?: string; // e.g. "Chatterbox-Multilingual.en-US"
  sampleRateHz?: number;
}

export const DEFAULT_FUNCTION_ID = "ddacc747-1269-4fab-bfd9-8f593dead106";

/** Voice pair used per host. Chatterbox currently exposes one voice per
 * language, so hosts are differentiated via exaggeration_factor instead. */
export interface RivaVoicePair {
  hostA: string;
  hostB: string;
  exaggerationA: number;
  exaggerationB: number;
}

export function rivaVoicesFor(_voiceSelection: string | undefined): RivaVoicePair {
  const base = process.env.NVIDIA_RIVA_VOICE || "Chatterbox-Multilingual.en-US";
  const full = `${base}.Male`;
  return { hostA: full, hostB: full, exaggerationA: 1.0, exaggerationB: 1.6 };
}

export class RivaTtsClient {
  private client: any;
  private reqType: protobuf.Type;
  private resType: protobuf.Type;
  private meta: grpc.Metadata;
  private cfg: Required<RivaTtsConfig>;

  constructor(config: RivaTtsConfig) {
    this.cfg = {
      server: "grpc.nvcf.nvidia.com:443",
      voiceBase: "Chatterbox-Multilingual.en-US",
      sampleRateHz: 22050,
      ...config,
    } as Required<RivaTtsConfig>;

    const root = loadRoot();
    this.reqType = root.lookupType("nvidia.riva.tts.SynthesizeSpeechRequest");
    this.resType = root.lookupType("nvidia.riva.tts.SynthesizeSpeechResponse");

    const creds: ChannelCredentials = credentials.createSsl();
    const methodDef = {
      requestStream: false,
      responseStream: false,
      requestSerialize: (obj: any) => Buffer.from(this.reqType.create(obj).finish()),
      requestDeserialize: (b: Buffer) => b,
      responseSerialize: (obj: any) => Buffer.from(obj),
      responseDeserialize: (b: Buffer) => b,
    };
    const ClientCtor = (grpc as any).makeGenericClientConstructor(
      { Synthesize: { path: "/nvidia.riva.tts.RivaSpeechSynthesis/Synthesize", ...methodDef } },
      "RivaSpeechSynthesis",
      {}
    );
    this.client = new ClientCtor(this.cfg.server, creds);

    this.meta = new grpc.Metadata();
    this.meta.add("authorization", `Bearer ${this.cfg.apiKey}`);
    this.meta.add("function-id", this.cfg.functionId);
  }

  /** True when env has what we need. */
  static isConfigured(env: Record<string, string | undefined> = process.env): boolean {
    return Boolean(env.NVIDIA_API_KEY && env.NVIDIA_API_KEY.startsWith("nvapi-"));
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): RivaTtsClient | null {
    if (!RivaTtsClient.isConfigured(env)) return null;
    return new RivaTtsClient({
      apiKey: env.NVIDIA_API_KEY!,
      functionId: env.NVIDIA_RIVA_FUNCTION_ID || DEFAULT_FUNCTION_ID,
      server: env.NVIDIA_RIVA_SERVER || "grpc.nvcf.nvidia.com:443",
      voiceBase: env.NVIDIA_RIVA_VOICE || "Chatterbox-Multilingual.en-US",
    });
  }

  /** Synthesize one line -> WAV base64 + real measured duration (seconds). */
  async synthesize(
    text: string,
    voiceName: string,
    opts: { exaggeration?: number } = {}
  ): Promise<{ wavBase64: string; durationSeconds: number }> {
    const payload = {
      text,
      languageCode: "en-US",
      encoding: 1, // LINEAR_PCM
      sampleRateHz: this.cfg.sampleRateHz,
      voiceName,
      customConfiguration: {
        exaggeration_factor: String(opts.exaggeration ?? 1.0),
      },
    };

    const buf = await new Promise<Buffer>((resolve, reject) => {
      this.client.Synthesize(
        payload,
        this.meta,
        { deadline: Date.now() + 30_000 },
        (err: grpc.ServiceError | null, resp: Buffer) => {
          if (err) return reject(new Error(`Riva TTS gRPC error ${err.code}: ${err.details || err.message}`));
          resolve(resp);
        }
      );
    });

    const decoded: any = this.resType.decode(buf);
    const pcmBytes: Uint8Array = decoded?.audio?.audioContent ?? decoded?.audio?.audio_content;
    const rate: number =
      decoded?.audio?.sampleRateHz ?? decoded?.audio?.sample_rate_hz ?? this.cfg.sampleRateHz;
    if (!pcmBytes || pcmBytes.length === 0) throw new Error("Riva TTS returned empty audio");

    const durationSeconds = Math.max(0.5, pcmBytes.length / 2 / rate);
    return { wavBase64: pcmToWavBase64Local(pcmBytes, rate), durationSeconds };
  }
}

/* Local PCM->WAV wrapper (server-side twin of radio-core.pcmToWavBytes). */
function pcmToWavBytesLocal(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new Uint8Array(44);
  const dv = new DataView(header.buffer);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) header[off + i] = s.charCodeAt(i);
  };
  wstr(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, "data");
  dv.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(header, 0);
  out.set(pcm, 44);
  return out;
}

function pcmToWavBase64Local(pcmBytes: Uint8Array, sampleRate: number): string {
  return Buffer.from(pcmToWavBytesLocal(pcmBytes, sampleRate)).toString("base64");
}
