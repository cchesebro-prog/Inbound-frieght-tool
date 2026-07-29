import type { Bindings } from "./types";
import { normalizePoNumber } from "./acumatica";

export type ExtractedShipment = {
  material: string | null;
  freightClass: number | null;
  weightLbs: number | null;
  pieces: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  hazmat: boolean | null;
  originAddress: string | null;
  readyDate: string | null;
  poNumber: string | null;
};

const EXTRACTION_PROMPT = `Extract shipment details from the supplier email below. Return raw JSON only, no markdown, matching this exact shape:
{"material": string|null, "freightClass": number|null, "weightLbs": number|null, "pieces": number|null, "lengthIn": number|null, "widthIn": number|null, "heightIn": number|null, "hazmat": boolean|null, "originAddress": string|null, "readyDate": string|null, "poNumber": string|null}

Freight class defaults if not stated: wool yarn = 60, polyester/synthetic yarn = 60, cotton yarn = 55.

poNumber is any purchase order number the vendor references (e.g. "PO P000513", "PO# 513", "order P000513") — extract it as written, don't reformat it. Null if none is mentioned.

Email:
`;

export async function extractShipment(
  rawInput: string,
  env: Bindings
): Promise<{ data: ExtractedShipment; method: "ai" | "regex_fallback" }> {
  try {
    const data = await extractWithClaude(rawInput, env.ANTHROPIC_API_KEY);
    return { data, method: "ai" };
  } catch {
    return { data: extractWithRegex(rawInput), method: "regex_fallback" };
  }
}

// Generous relative to acumatica.ts's timeout since this is a live LLM call,
// but still bounded — a hung Anthropic request must fall back to regex
// extraction rather than hang the whole "add shipment" request.
const CLAUDE_FETCH_TIMEOUT_MS = 20_000;

async function extractWithClaude(rawInput: string, apiKey: string): Promise<ExtractedShipment> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      // Haiku 4.5: this is a small structured-extraction task (short email in,
      // small JSON object out) that doesn't need Sonnet-tier reasoning, and
      // Haiku is roughly 3x cheaper per token.
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: EXTRACTION_PROMPT + rawInput }],
    }),
    signal: AbortSignal.timeout(CLAUDE_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status}`);
  }

  const body = (await response.json()) as { content: { text: string }[] };
  const text = body.content?.[0]?.text ?? "";
  return JSON.parse(text) as ExtractedShipment;
}

// For the "Connections" test panel — extractShipment() silently falls back
// to regex on any Anthropic failure, so a bad/expired ANTHROPIC_API_KEY
// would otherwise never surface anywhere. This makes a minimal real call
// (1 token) instead of reusing extractWithClaude, so failures are reported
// rather than swallowed.
export async function testConnection(env: Bindings): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(CLAUDE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { ok: false, detail: `Claude API error: ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}` };
    }
    return { ok: true, detail: "Authenticated successfully" };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

function extractWithRegex(rawInput: string): ExtractedShipment {
  const weightMatch = rawInput.match(/([\d,]+)\s*lbs?/i);
  const dimsMatch = rawInput.match(/(\d+)"?\s*[Ll]\s*x\s*(\d+)"?\s*[Ww]\s*x\s*(\d+)"?\s*[Hh]/);
  const piecesMatch = rawInput.match(/(\d+)\s*(pallets?|pieces?)/i);
  const originMatch = rawInput.match(/(\d+\s+[\w\s.]+(?:Rd|Dr|St|Ave|Row)[\w\s.,]*\d{5})/i);
  const hazmatMatch = rawInput.match(/hazmat:\s*(yes|no)/i);

  return {
    material: null,
    freightClass: null,
    weightLbs: weightMatch ? Number(weightMatch[1].replace(/,/g, "")) : null,
    pieces: piecesMatch ? Number(piecesMatch[1]) : null,
    lengthIn: dimsMatch ? Number(dimsMatch[1]) : null,
    widthIn: dimsMatch ? Number(dimsMatch[2]) : null,
    heightIn: dimsMatch ? Number(dimsMatch[3]) : null,
    hazmat: hazmatMatch ? hazmatMatch[1].toLowerCase() === "yes" : null,
    originAddress: originMatch ? originMatch[1] : null,
    readyDate: null,
    poNumber: normalizePoNumber(rawInput),
  };
}
