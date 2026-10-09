import { describe, it, expect, vi } from "vitest";
import zlib from "zlib";
import {
  htmlToPlainText,
  extractArticleFromHtml,
  extractPdfText,
  normalizePushedJson,
  assertSafeUrl,
  condenseForPrompt,
} from "./ingest";
import { createQuotaGuard } from "./gemini-pipeline";

describe("htmlToPlainText", () => {
  it("strips scripts, styles and tags; decodes entities", () => {
    const html = `<html><head><style>.a{color:red}</style></head>
      <body><nav>menu menu</nav><p>Hello &amp; welcome&nbsp;friend</p><script>alert(1)</script></body></html>`;
    const text = htmlToPlainText(html);
    expect(text).toContain("Hello & welcome friend");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });
  it("prefers <article> content over boilerplate", () => {
    const html = `<html><body><div>ads ads ads</div><article><h1>Big News</h1><p>The real story is here.</p></article></body></html>`;
    const text = extractArticleFromHtml(html);
    expect(text).toContain("Big News");
    expect(text).toContain("The real story is here.");
    expect(text).not.toContain("ads ads");
  });
});

describe("extractPdfText", () => {
  /** Build a minimal one-stream FlateDecode PDF for the test. */
  function makePdf(content: string): Buffer {
    const compressed = zlib.deflateSync(Buffer.from(content, "latin1"));
    return Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj<<>>\nstream\n", "latin1"),
      compressed,
      Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
    ]);
  }

  it("recovers text from Tj/TJ operators in deflated streams", () => {
    const content = `BT /F1 12 Tf 5 700 Td (Radio show about quantum computing) Tj ET
      BT (Second line of prose) Tj ET`;
    const pdf = makePdf(content);
    const text = extractPdfText(pdf, zlib as any);
    expect(text).toContain("Radio show about quantum computing");
    expect(text).toContain("Second line of prose");
  });
  it("handles escaped parens and octal sequences", () => {
    const content = `BT (Parens \\(like this\\) and \\101 work) Tj ET`;
    const text = extractPdfText(makePdf(content), zlib as any);
    expect(text).toContain("Parens (like this) and A work");
  });
  it("returns empty string for non-deflated/garbage input", () => {
    const junk = Buffer.from("%PDF-1.4 not really a pdf", "latin1");
    expect(extractPdfText(junk, zlib as any)).toBe("");
  });
});

describe("normalizePushedJson", () => {
  it("accepts a ready-made script when segments have text", () => {
    const r = normalizePushedJson({
      title: "Pushed Ep",
      segments: [
        { speaker: "Alex", text: "Line one" },
        { speaker: "Sam", text: "Line two" },
      ],
    });
    expect(r.kind).toBe("script");
    expect(r.data.title).toBe("Pushed Ep");
  });
  it("rejects script segments missing text", () => {
    const r = normalizePushedJson({ segments: [{ speaker: "Alex", text: "" }, { speaker: "Sam", text: "x" }] });
    expect(r.error).toMatch(/text/);
  });
  it("treats sourceText payloads as source material", () => {
    const r = normalizePushedJson({ sourceText: "A long article body...", subject: "AI" });
    expect(r.kind).toBe("source");
    expect(r.data).toBe("A long article body...");
    expect(r.subject).toBe("AI");
  });
  it("subject-only payload is valid", () => {
    const r = normalizePushedJson({ subject: "just a topic" });
    expect(r.kind).toBe("source");
    expect(r.subject).toBe("just a topic");
    expect(r.error).toBeUndefined();
  });
  it("empty object yields helpful error", () => {
    const r = normalizePushedJson({});
    expect(r.error).toMatch(/segments|sourceText|subject/);
  });
});

describe("assertSafeUrl (SSRF guard)", () => {
  it("allows public http(s) URLs", () => {
    expect(assertSafeUrl("https://example.com/post").hostname).toBe("example.com");
  });
  it("blocks private/loopback hosts and odd protocols", () => {
    expect(() => assertSafeUrl("http://localhost/x")).toThrow();
    expect(() => assertSafeUrl("http://127.0.0.1/")).toThrow();
    expect(() => assertSafeUrl("http://192.168.1.10/admin")).toThrow();
    expect(() => assertSafeUrl("http://10.0.0.1/")).toThrow();
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow();
    expect(() => assertSafeUrl("not a url")).toThrow();
  });
});

describe("condenseForPrompt", () => {
  it("leaves short text alone, truncates middle of long text", () => {
    expect(condenseForPrompt("short", 100)).toBe("short");
    const long = "A".repeat(1000);
    const out = condenseForPrompt(long, 300);
    expect(out.length).toBeLessThanOrEqual(400); // body capped at maxChars; marker adds a few chars
    expect(out).toContain("truncated");
    expect(out.startsWith("AAAA")).toBe(true);
    expect(out.endsWith("AAAA")).toBe(true);
  });
});

describe("createQuotaGuard", () => {
  it("consumes up to the daily limit then refuses", () => {
    const q = createQuotaGuard({ dailyLimit: 3, persist: false });
    expect(q.status()).toMatchObject({ limit: 3, used: 0, remaining: 3 });
    expect(q.tryConsume()).toBe(true);
    expect(q.tryConsume()).toBe(true);
    expect(q.tryConsume()).toBe(true);
    expect(q.tryConsume()).toBe(false);
    expect(q.status().remaining).toBe(0);
  });
  it("refund returns budget", () => {
    const q = createQuotaGuard({ dailyLimit: 1, persist: false });
    expect(q.tryConsume()).toBe(true);
    expect(q.tryConsume()).toBe(false);
    q.refund();
    expect(q.tryConsume()).toBe(true);
  });
  it("limit 0 disables premium entirely", () => {
    const q = createQuotaGuard({ dailyLimit: 0, persist: false });
    expect(q.tryConsume()).toBe(false);
  });
  it("rolls over on a new UTC day", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 8, 23, 59, 0));
      const q = createQuotaGuard({ dailyLimit: 1, persist: false });
      expect(q.tryConsume()).toBe(true);
      expect(q.tryConsume()).toBe(false);
      // advance past midnight UTC -> budget resets
      vi.setSystemTime(Date.UTC(2026, 9, 9, 0, 0, 1));
      expect(q.status().remaining).toBe(1);
      expect(q.tryConsume()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("persists through storage map and reloads", () => {
    const store = new Map<string, string>();
    const q1 = createQuotaGuard({ dailyLimit: 2, persist: true }, store);
    q1.tryConsume();
    const q2 = createQuotaGuard({ dailyLimit: 2, persist: true }, store); // simulates restart
    expect(q2.status().used).toBe(1);
    expect(q2.tryConsume()).toBe(true);
    expect(q2.tryConsume()).toBe(false);
  });
});

