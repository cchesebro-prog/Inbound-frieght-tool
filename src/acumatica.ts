import type { Bindings } from "./types";

// Real Wigwam Acumatica PO numbers observed during design (e.g. P000513) follow
// a "P" + 6-digit zero-padded sequence format. Vendor-quoted references often
// need cleanup before they match this exactly (FR-6.1a), so this only pulls the
// pattern out of surrounding text rather than requiring an exact-string match.
const PO_NUMBER_PATTERN = /P\d{6}/i;

// No outbound fetch() here is allowed to hang indefinitely — a slow/wedged
// Acumatica instance would otherwise tie up the Worker request until the
// platform's own limit kills it.
const FETCH_TIMEOUT_MS = 10_000;

export function normalizePoNumber(rawText: string | null | undefined): string | null {
  if (!rawText) return null;
  const match = rawText.match(PO_NUMBER_PATTERN);
  return match ? match[0].toUpperCase() : null;
}

export type MatchedPoLine = {
  lineNbr: number;
  inventoryId: string;
  lineDescription: string;
  orderQty: number;
  uom: string;
  // Needed for landed-cost calculation (FR-5.3 follow-on) — the material
  // cost side of landed cost = extendedCost, tied to a shipment's freight
  // charge via po_number_matched/po_line_id once confirmed.
  unitCost: number;
  extendedCost: number;
};

export type MatchedPurchaseOrder = {
  orderNbr: string;
  vendorId: string;
  vendorName: string;
  status: string;
  date: string | null;
  promisedOn: string | null;
  lines: MatchedPoLine[];
};

// Acumatica's contract-based REST API wraps every field as { value: ... }.
// This is the standard shape across Acumatica versions (not something specific
// to Wigwam's instance), so it's safe to rely on structurally.
type AcumaticaField<T> = { value: T } | undefined;
type AcumaticaPoResponse = {
  OrderNbr?: AcumaticaField<string>;
  Status?: AcumaticaField<string>;
  Date?: AcumaticaField<string>;
  PromisedOn?: AcumaticaField<string>;
  VendorID?: AcumaticaField<string>;
  Details?: {
    LineNbr?: AcumaticaField<number>;
    InventoryID?: AcumaticaField<string>;
    LineDescription?: AcumaticaField<string>;
    OrderQty?: AcumaticaField<number>;
    UOM?: AcumaticaField<string>;
    UnitCost?: AcumaticaField<number>;
    ExtendedCost?: AcumaticaField<number>;
  }[];
};

// The PurchaseOrder entity's "VendorRef" field is a free-text vendor
// reference number (confirmed blank on the real P000513 PO) — NOT the
// vendor's name. The name only lives on the Vendor entity itself, so a
// second lookup is required.
type AcumaticaVendorResponse = {
  VendorName?: AcumaticaField<string>;
};

let cachedToken: { value: string; expiresAt: number } | null = null;

// Requires ACUMATICA_BASE_URL / ACUMATICA_CLIENT_ID / ACUMATICA_CLIENT_SECRET
// as Worker secrets, and ACUMATICA_ENDPOINT_VERSION (a plain, non-secret var
// in wrangler.toml — confirmed live against Wigwam's instance as
// "25.200.001"). Secrets are NOT set yet — see README.md "Acumatica setup"
// section. IT still needs to register an OAuth 2.0 client-credentials
// client against the Wigwam Acumatica instance (2025R2); nothing here
// should be assumed to already be live until that's done.
async function getAccessToken(env: Bindings): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  const response = await fetch(`${env.ACUMATICA_BASE_URL}/identity/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.ACUMATICA_CLIENT_ID,
      client_secret: env.ACUMATICA_CLIENT_SECRET,
      scope: "api",
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    // OAuth token endpoints return the actual reason (invalid_client,
    // unsupported_grant_type, invalid_scope, etc.) in the response body per
    // RFC 6749 — surfacing it here instead of just the status code is the
    // difference between "400" and knowing what to actually fix.
    const detail = await response.text().catch(() => "");
    throw new Error(`Acumatica auth failed: ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  }

  const body = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(body.expires_in - 60, 30) * 1000,
  };
  return cachedToken.value;
}

async function lookupVendorName(env: Bindings, token: string, vendorId: string): Promise<string> {
  if (!vendorId) return "";
  const url = `${env.ACUMATICA_BASE_URL}/entity/Default/${env.ACUMATICA_ENDPOINT_VERSION}/Vendor/${encodeURIComponent(
    vendorId
  )}`;

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) return "";
  const body = (await response.json()) as AcumaticaVendorResponse;
  return body.VendorName?.value ?? "";
}

// Acumatica's contract API only supports lookup by exact OrderNbr for
// PurchaseOrder (broad filtering is unreliable/unsupported) — matches the
// PO-number-driven design in FR-6.1, so this is not a limitation here.
export async function lookupPurchaseOrder(
  env: Bindings,
  orderNbr: string
): Promise<MatchedPurchaseOrder | null> {
  const token = await getAccessToken(env);
  const url = `${env.ACUMATICA_BASE_URL}/entity/Default/${env.ACUMATICA_ENDPOINT_VERSION}/PurchaseOrder/${encodeURIComponent(
    orderNbr
  )}?$expand=Details`;

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Acumatica PO lookup failed: ${response.status}`);
  }

  const body = (await response.json()) as AcumaticaPoResponse;
  const vendorId = body.VendorID?.value ?? "";
  const vendorName = await lookupVendorName(env, token, vendorId);

  return {
    orderNbr: body.OrderNbr?.value ?? orderNbr,
    vendorId,
    vendorName,
    status: body.Status?.value ?? "",
    date: body.Date?.value ?? null,
    promisedOn: body.PromisedOn?.value ?? null,
    lines: (body.Details ?? []).map((line) => ({
      lineNbr: line.LineNbr?.value ?? 0,
      inventoryId: line.InventoryID?.value ?? "",
      lineDescription: line.LineDescription?.value ?? "",
      orderQty: line.OrderQty?.value ?? 0,
      uom: line.UOM?.value ?? "",
      unitCost: line.UnitCost?.value ?? 0,
      extendedCost: line.ExtendedCost?.value ?? 0,
    })),
  };
}
