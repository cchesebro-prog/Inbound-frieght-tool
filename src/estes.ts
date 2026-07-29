import type { Bindings } from "./types";

// Base URL is a Worker secret (ESTES_BASE_URL), not hardcoded — Estes'
// onboarding email (2026-07-28) confirmed a separate UAT/test host
// (uat-cloudapi.estes-express.com) distinct from production
// (cloudapi.estes-express.com), contradicting the earlier swagger.yaml spec
// review's assumption of a single host. See README.md "Estes Express setup".

// Same rationale as src/acumatica.ts — no outbound fetch() here is allowed
// to hang indefinitely.
const FETCH_TIMEOUT_MS = 10_000;

// The Estes rate-quotes request requires a 2-letter handling-unit type code
// (e.g. PT = pallet) per commodity.handlingUnits[]. This tool doesn't track
// handling-unit type per shipment yet (open item, PHASE1_BUILD_PLAN.md
// section 8) — pallet is the correct default for the yarn shipments this
// tool currently handles, but will need to become a real shipment field if a
// shipment ever ships loose/boxed instead of palletized.
const DEFAULT_HANDLING_UNIT_TYPE = "PT";

export type EstesShipmentInput = {
  weightLbs: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  freightClass: number;
  hazmat: boolean;
  pieces: number;
  originAddress: string;
  destinationAddress: string;
};

export type EstesRateQuote = {
  quoteId: string;
  totalCharges: number;
  transitDays: number | null;
};

type EstesAddress = {
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
};

// Shipment addresses are stored as a single free-text string (e.g. "5300
// WI-42, Sheboygan, WI 53083"), not structured fields, so this pulls the
// "street, city, ST ZIP" shape out for Estes' origin/destination address
// blocks. Falls back to putting the whole string in addressLine1 if it
// doesn't match — the request still goes out, just with a blank
// city/state/zip that Estes will presumably reject with a clear error.
function parseAddress(raw: string): EstesAddress {
  const match = raw.match(/^(.*),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})(?:-\d{4})?\s*$/i);
  if (!match) {
    return { addressLine1: raw.trim(), city: "", state: "", zip: "" };
  }
  const [, line1, city, state, zip] = match;
  return { addressLine1: line1.trim(), city: city.trim(), state: state.toUpperCase(), zip };
}

let cachedToken: string | null = null;

// POST /authenticate (Basic auth with the Estes account username/password)
// returns a bearer JWT. Confirmed live 2026-07-29: this endpoint also
// requires the apikey header (rejects with "No API key found in request"
// otherwise) — it's not just the operational endpoints after it, as the
// earlier spec-review notes assumed. The spec states no expiry, so this
// only re-authenticates on a 401 from a downstream call rather than
// tracking a TTL (see getEstesRateQuote).
async function authenticate(env: Bindings): Promise<string> {
  const credentials = btoa(`${env.ESTES_USERNAME}:${env.ESTES_PASSWORD}`);
  const response = await fetch(`${env.ESTES_BASE_URL}/authenticate`, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      apikey: env.ESTES_API_KEY,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Estes authenticate failed: ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  }

  const body = (await response.json()) as { token: string };
  return body.token;
}

async function getToken(env: Bindings, forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken) return cachedToken;
  cachedToken = await authenticate(env);
  return cachedToken;
}

type EstesRateQuotesResponse = {
  rateFound?: boolean;
  quoteId?: string;
  quoteRate?: { totalCharges?: string };
  transitDetails?: { transitDays?: number };
}[];

async function callRateQuotes(
  env: Bindings,
  token: string,
  shipment: EstesShipmentInput
): Promise<Response> {
  const origin = parseAddress(shipment.originAddress);
  const destination = parseAddress(shipment.destinationAddress);

  return fetch(`${env.ESTES_BASE_URL}/v1/rate-quotes`, {
    method: "POST",
    headers: {
      apikey: env.ESTES_API_KEY,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      serviceLevels: ["LTL"],
      payment: {
        account: env.ESTES_ACCOUNT_NUMBER,
        // Wigwam's confirmed terms for inbound raw-material freight: Prepaid,
        // shipper pays (not Collect/Third Party) — see PHASE1_BUILD_PLAN.md
        // section 8.
        payor: "Shipper",
        terms: "Prepaid",
      },
      origin: {
        address: {
          addressLine1: origin.addressLine1,
          city: origin.city,
          stateProvince: origin.state,
          postalCode: origin.zip,
          country: "USA",
        },
      },
      destination: {
        address: {
          addressLine1: destination.addressLine1,
          city: destination.city,
          stateProvince: destination.state,
          postalCode: destination.zip,
          country: "USA",
        },
      },
      commodity: {
        handlingUnits: [
          {
            count: Math.max(shipment.pieces, 1),
            type: DEFAULT_HANDLING_UNIT_TYPE,
            weight: shipment.weightLbs,
            length: shipment.lengthIn,
            width: shipment.widthIn,
            height: shipment.heightIn,
            lineItems: [
              {
                classification: shipment.freightClass,
                isHazardous: shipment.hazmat,
              },
            ],
          },
        ],
      },
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// Requires ESTES_API_KEY / ESTES_USERNAME / ESTES_PASSWORD /
// ESTES_ACCOUNT_NUMBER as Worker secrets (see README.md "Estes Express
// setup"). Always throws rather than silently returning a fake or empty
// result — a 200 with no usable rate (rateFound: false, or a missing
// totalCharges) is just as much a "why didn't this work" case as an HTTP
// error, so it's surfaced the same way. The caller (see the rate-batch
// route in src/index.ts) decides whether to fall back to the simulated
// estimate and persists the message for later inspection rather than
// requiring `wrangler tail` to have been running at the time.
export async function getEstesRateQuote(
  env: Bindings,
  shipment: EstesShipmentInput
): Promise<EstesRateQuote> {
  let token = await getToken(env);
  let response = await callRateQuotes(env, token, shipment);

  if (response.status === 401) {
    token = await getToken(env, true);
    response = await callRateQuotes(env, token, shipment);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Estes rate-quotes failed: ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  }

  const body = (await response.json()) as EstesRateQuotesResponse;
  const quote = body[0];
  if (!quote || quote.rateFound === false || !quote.quoteRate?.totalCharges) {
    throw new Error(`Estes rate-quotes returned no usable rate: ${JSON.stringify(body).slice(0, 400)}`);
  }

  return {
    quoteId: quote.quoteId ?? "",
    totalCharges: parseFloat(quote.quoteRate.totalCharges),
    transitDays: quote.transitDetails?.transitDays ?? null,
  };
}

// For the "Connections" test panel — verifies the /authenticate handshake
// only (not a real rate quote, which would need a full shipment payload),
// forcing a fresh token rather than reusing a cached one.
export async function testConnection(env: Bindings): Promise<{ ok: boolean; detail: string }> {
  try {
    await getToken(env, true);
    return { ok: true, detail: "Authenticated successfully" };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
