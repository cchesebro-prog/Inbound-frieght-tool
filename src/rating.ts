// Ported from the inbound-routing proof-of-concept. Phase 1 rates are
// estimates, not live carrier quotes (that's Phase 2).

export const ZONE_MAP: Record<string, number> = {
  WI: 0, MN: 2, IA: 2, IL: 3, IN: 3, OH: 3, MI: 4, KY: 3, TN: 3,
  NC: 4, SC: 4, GA: 4, AL: 4, MS: 4, VA: 4, PA: 4, NY: 4,
  MO: 4, TX: 5, CO: 5, CA: 6, WA: 6,
};
export const DEFAULT_ZONE = 4;

export const CLASS_MULTIPLIERS: Record<number, number> = {
  50: 1.0, 55: 1.05, 60: 1.10, 65: 1.18, 70: 1.27,
  77.5: 1.38, 85: 1.50, 92.5: 1.62, 100: 1.75,
};
export const DEFAULT_CLASS_MULTIPLIER = 1.0;

export const CARRIERS = [
  "XPO Logistics",
  "Old Dominion",
  "SAIA Freight",
  "Estes Express",
  "R+L Carriers",
  "UPS Freight",
];

const DIM_FACTOR = 139;
const BASE_RATE_PER_LB = 0.42;
const ZONE_SURCHARGE_PER_STEP = 0.12;

export type ShipmentInput = {
  weightLbs: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  freightClass: number;
  originState: string;
};

export type CarrierQuote = {
  carrier: string;
  price: number;
};

function billedWeight(s: ShipmentInput): number {
  const dimWeight = (s.lengthIn * s.widthIn * s.heightIn) / DIM_FACTOR;
  return Math.max(s.weightLbs, dimWeight || 0);
}

// Deterministic per-carrier variance so results are stable/testable rather
// than relying on Math.random().
function carrierVariance(index: number): number {
  return 1 + (((index * 37) % 23) / 100) - 0.1;
}

export function calculateRates(s: ShipmentInput): CarrierQuote[] {
  const weight = billedWeight(s);
  const classMultiplier = CLASS_MULTIPLIERS[s.freightClass] ?? DEFAULT_CLASS_MULTIPLIER;
  const zone = ZONE_MAP[s.originState.toUpperCase()] ?? DEFAULT_ZONE;
  const base = weight * BASE_RATE_PER_LB * classMultiplier * (1 + zone * ZONE_SURCHARGE_PER_STEP);

  return CARRIERS.map((carrier, i) => ({
    carrier,
    price: Math.round(base * carrierVariance(i) * 100) / 100,
  })).sort((a, b) => a.price - b.price);
}
