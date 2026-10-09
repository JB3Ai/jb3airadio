/**
 * Server-side content ingestion: turn URLs, uploaded documents, and pushed
 * JSON payloads into plain text that Gemini can distill into a broadcast.
 *
 * Design notes:
 *  - No heavy dependencies: HTML is stripped with regex-based extraction good
 *    enough for LLM summarization; PDFs are decompressed with zlib (FlateDecode
 *    streams cover the vast majority of real-world PDFs).
 *  - Everything is size-capped to protect both memory and prompt budgets.
 */

export const MAX_INGEST_BYTES = 2 * 1024 * 1024; // 2 MB per document
export const MAX_EXTRACTED_CHARS = 24_000; // what actually reaches the model

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

/** Strip scripts/styles/tags and collapse whitespace into readable text. */
export function htmlToPlainText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:nav|footer|header|aside|form)[\s\S]*?<\/(?:nav|footer|header|aside|form)>/gi, " ")
    .replace(/<\/(?:p|div|br|li|h[1-6]|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  // Decode the handful of entities that actually appear in prose.
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
  return text
    .split(/\n+/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Crude article extraction: prefer <article>, then main, else whole body. */
export function extractArticleFromHtml(html: string): string {
  const articleMatch = html.match(/<article[\s\S]*?<\/article>/i);
  const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  const candidate = articleMatch?.[0] ?? mainMatch?.[0] ?? bodyMatch?.[0] ?? html;
  return htmlToPlainText(candidate);
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Very small PDF text extractor: finds FlateDecode content streams, inflates
 * them, and pulls strings out of Tj/TJ text-showing operators. This is not a
 * full PDF parser, but it recovers selectable text from most generated PDFs.
 * Scanned/image-only PDFs yield little text — the caller should surface that.
 */
export function extractPdfText(buffer: Buffer, zlib: typeof import("zlib")): string {
  const chunks: string[] = [];
  const raw = buffer.toString("latin1");
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end === -1) continue;
    const bytes = buffer.subarray(start, end);
    let inflated: Buffer;
    try {
      inflated = zlib.inflateSync(bytes);
    } catch {
      continue; // not flate-compressed or corrupt; skip this stream
    }
    const s = inflated.toString("latin1");
    if (!/(Tj|TJ)\s*[)\]]/.test(s) && !/\)\s*Tj/.test(s)) continue;
    // Captures (…) literal strings shown via Tj and inside TJ arrays.
    const stringRe = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ)?/g;
    let t: RegExpExecArray | null;
    let line = "";
    while ((t = stringRe.exec(s)) !== null) {
      const piece = t[1]
        .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
        .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: "\n", r: "", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" }[c] ?? c));
      line += piece;
    }
    if (line.trim()) chunks.push(line);
  }
  return chunks.join("\n").replace(/[ \t]{2,}/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* Pushed JSON ("podcast recipe")                                      */
/* ------------------------------------------------------------------ */

export interface PushedScriptJson {
  title?: string;
  segments?: Array<{ speaker?: string; text?: string; voiceName?: string; mood?: string }>;
  /** Or just hand us source material and let the LLM write the show. */
  sourceText?: string;
  subject?: string;
}

/** Validate a pushed .json payload into either a ready script or source text. */
export interface PushedJsonResult {
  kind: "script" | "source";
  data: any;
  subject?: string;
  error?: string;
}

export function normalizePushedJson(obj: unknown): PushedJsonResult {
  if (obj == null || typeof obj !== "object") {
    return { kind: "source", data: "", error: "JSON payload must be an object." };
  }
  const j = obj as PushedScriptJson;
  if (Array.isArray(j.segments) && j.segments.length >= 2) {
    const ok = j.segments.every((s) => typeof s?.text === "string" && s.text.trim().length > 0);
    if (ok) return { kind: "script", data: j };
    return { kind: "source", data: "", error: "Each segment needs non-empty `text`." };
  }
  if (typeof j.sourceText === "string" && j.sourceText.trim()) {
    return { kind: "source", data: j.sourceText, subject: j.subject };
  }
  if (typeof j.subject === "string" && j.subject.trim()) {
    return { kind: "source", data: "", subject: j.subject };
  }
  return { kind: "source", data: "", error: "Provide `segments[]`, `sourceText`, or `subject`." };
}

/* ------------------------------------------------------------------ */
/* URL fetching                                                        */
/* ------------------------------------------------------------------ */

const BLOCKED_HOST_PATTERN = /^(localhost|127\.|\[::1\]|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/** SSRF guard: only public http(s) URLs. */
export function assertSafeUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Not a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http/https URLs are supported.");
  }
  if (BLOCKED_HOST_PATTERN.test(url.hostname)) {
    throw new Error("Private or loopback addresses are not allowed.");
  }
  return url;
}

export async function fetchReadableText(inputUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = assertSafeUrl(inputUrl);
  const res = await fetchImpl(url.toString(), {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AIRadioBot/1.0)", Accept: "text/html,text/plain,*/*" },
  });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_INGEST_BYTES) throw new Error("Document exceeds 2 MB limit.");
  if (contentType.includes("pdf")) {
    const zlib = await import("zlib");
    return extractPdfText(Buffer.from(buf), zlib as any);
  }
  if (contentType.includes("html") || contentType.includes("xml") || contentType === "") {
    return extractArticleFromHtml(Buffer.from(buf).toString("utf8"));
  }
  return Buffer.from(buf).toString("utf8");
}

/** Cap extracted text near its head + tail so intros AND conclusions survive. */
export function condenseForPrompt(text: string, maxChars = MAX_EXTRACTED_CHARS): string {
  const clean = (text || "").trim();
  if (clean.length <= maxChars) return clean;
  const head = Math.floor(maxChars * 0.75);
  const tail = maxChars - head;
  return `${clean.slice(0, head)}\n\n[… middle truncated …]\n\n${clean.slice(clean.length - tail)}`;
}
