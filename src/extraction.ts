import type { Bindings } from "./types";

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
};

const EXTRACTION_PROMPT = `Extract shipment details from the supplier email below. Return raw JSON only, no markdown, matching this exact shape:
{"material": string|null, "freightClass": number|null, "weightLbs": number|null, "pieces": number|null, "lengthIn": number|null, "widthIn": number|null, "heightIn": number|null, "hazmat": boolean|null, "originAddress": string|null, "readyDate": string|null}

Freight class defaults if not stated: wool yarn = 60, polyester/synthetic yarn = 60, cotton yarn = 55.

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

async function extractWithClaude(rawInput: string, apiKey: string): Promise<ExtractedShipment> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages: [{ role: "user", content: EXTRACTION_PROMPT + rawInput }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status}`);
  }

  const body = (await response.json()) as { content: { text: string }[] };
  const text = body.content?.[0]?.text ?? "";
  return JSON.parse(text) as ExtractedShipment;
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
  };
}
