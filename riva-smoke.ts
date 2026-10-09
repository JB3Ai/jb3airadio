import "dotenv/config";
import { RivaTtsClient, rivaVoicesFor } from "./server/nvidia-riva";

async function main() {
  const client = RivaTtsClient.fromEnv();
  if (!client) {
    console.log("NVIDIA_API_KEY not set — engine disabled (expected in CI).");
    return;
  }
  const voices = rivaVoicesFor(undefined);
  const t0 = Date.now();
  const res = await client.synthesize(
    "Welcome to JB3 Air, your AI powered radio station.",
    voices.hostA,
    { exaggeration: voices.exaggerationA }
  );
  console.log("OK duration(s):", res.durationSeconds.toFixed(2), "wav b64 bytes:", res.wavBase64.length, "ms:", Date.now() - t0);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
