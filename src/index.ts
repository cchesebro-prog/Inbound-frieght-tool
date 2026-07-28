import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Bindings, Variables } from "./types";
import { verifyPassword, createSessionToken, verifySessionToken } from "./auth";
import { extractShipment } from "./extraction";
import { calculateRates } from "./rating";
import { lookupPurchaseOrder, normalizePoNumber } from "./acumatica";
import { withLock, BATCH_OPERATIONS_LOCK, LockHeldError } from "./locks";

type AppEnv = { Bindings: Bindings; Variables: Variables };

const SESSION_COOKIE = "ift_session";
const ALLOWED_SHIPMENT_FIELDS = [
  "material",
  "freight_class",
  "weight_lbs",
  "pieces",
  "length_in",
  "width_in",
  "height_in",
  "hazmat",
  "origin_address",
  "destination_address",
  "ready_date",
  "po_number_raw",
];

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.post("/api/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const user = await c.env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: number; password_hash: string }>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const token = await createSessionToken(user.id, c.env.SESSION_SECRET);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
  });
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

const requireAuth = async (c: Context<AppEnv>, next: Next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const session = token ? await verifySessionToken(token, c.env.SESSION_SECRET) : null;
  if (!session) return c.json({ error: "Not authenticated" }, 401);
  c.set("userId", session.userId);
  await next();
};

// Hono's "/*" wildcard matches sub-paths but not the bare prefix itself,
// so each protected prefix needs both the exact path and its wildcard.
app.use("/api/shipments", requireAuth);
app.use("/api/shipments/*", requireAuth);
app.use("/api/config", requireAuth);
app.use("/api/config/*", requireAuth);
app.use("/api/metrics", requireAuth);

app.post("/api/shipments", async (c) => {
  const { rawInput } = await c.req.json<{ rawInput: string }>();
  if (!rawInput?.trim()) return c.json({ error: "rawInput is required" }, 400);

  const { data, method } = await extractShipment(rawInput, c.env);

  const result = await c.env.DB.prepare(
    `INSERT INTO shipments
      (status, raw_input, material, freight_class, weight_lbs, pieces, length_in, width_in, height_in, hazmat, origin_address, ready_date, extraction_method, po_number_raw, created_by)
     VALUES ('queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      rawInput,
      data.material,
      data.freightClass,
      data.weightLbs,
      data.pieces,
      data.lengthIn,
      data.widthIn,
      data.heightIn,
      data.hazmat ? 1 : 0,
      data.originAddress,
      data.readyDate,
      method,
      data.poNumber,
      c.get("userId")
    )
    .run();

  return c.json({ id: result.meta.last_row_id, extracted: data, method });
});

app.get("/api/shipments", async (c) => {
  const { results: shipments } = await c.env.DB.prepare(
    "SELECT * FROM shipments ORDER BY created_at DESC LIMIT 200"
  ).all<Record<string, unknown>>();

  if (shipments.length === 0) return c.json([]);

  const ids = shipments.map((s) => s.id as number);
  const placeholders = ids.map(() => "?").join(", ");
  const { results: quotes } = await c.env.DB.prepare(
    `SELECT * FROM carrier_quotes WHERE shipment_id IN (${placeholders}) ORDER BY price ASC`
  )
    .bind(...ids)
    .all<Record<string, unknown>>();

  const quotesByShipment = new Map<number, Record<string, unknown>[]>();
  for (const quote of quotes) {
    const shipmentId = quote.shipment_id as number;
    const list = quotesByShipment.get(shipmentId) ?? [];
    list.push(quote);
    quotesByShipment.set(shipmentId, list);
  }

  // FR-5.2 history view: the actually-booked carrier/rate, not just the best
  // quote — a shipment can be booked at a non-best rate via the per-quote
  // Book button, so these can differ.
  const { results: bookings } = await c.env.DB.prepare(
    `SELECT bd.shipment_id as shipment_id, cq.carrier as carrier, cq.price as price
     FROM booking_decisions bd
     JOIN carrier_quotes cq ON cq.id = bd.chosen_quote_id
     WHERE bd.shipment_id IN (${placeholders})
     ORDER BY bd.booked_at ASC`
  )
    .bind(...ids)
    .all<{ shipment_id: number; carrier: string; price: number }>();

  const bookedQuoteByShipment = new Map<number, { carrier: string; price: number }>();
  for (const booking of bookings) {
    // Ascending order + Map overwrite: the most recently booked decision wins
    // if a shipment was ever rebooked.
    bookedQuoteByShipment.set(booking.shipment_id, { carrier: booking.carrier, price: booking.price });
  }

  const enriched = shipments.map((s) => ({
    ...s,
    quotes: quotesByShipment.get(s.id as number) ?? [],
    bookedQuote: bookedQuoteByShipment.get(s.id as number) ?? null,
  }));
  return c.json(enriched);
});

app.patch("/api/shipments/:id", async (c) => {
  const id = c.req.param("id");
  const fields = await c.req.json<Record<string, unknown>>();
  const updates = Object.entries(fields).filter(([key]) => ALLOWED_SHIPMENT_FIELDS.includes(key));
  if (updates.length === 0) return c.json({ error: "No valid fields to update" }, 400);

  const setClause = updates.map(([key]) => `${key} = ?`).join(", ");
  const values = updates.map(([, value]) => value);
  await c.env.DB.prepare(`UPDATE shipments SET ${setClause} WHERE id = ?`)
    .bind(...values, id)
    .run();

  return c.json({ ok: true });
});

// FR-6.1: look up a vendor-referenced PO number against Acumatica. This never
// blocks or auto-confirms anything (FR-6.1b) — it just surfaces candidate
// lines for the shipping manager to verify via /po-confirm.
app.post("/api/shipments/:id/po-lookup", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ poNumber?: string }>().catch(() => ({}) as { poNumber?: string });

  const shipment = await c.env.DB.prepare("SELECT po_number_raw FROM shipments WHERE id = ?")
    .bind(id)
    .first<{ po_number_raw: string | null }>();
  if (!shipment) return c.json({ error: "Shipment not found" }, 404);

  const normalized = normalizePoNumber(body.poNumber ?? shipment.po_number_raw);
  if (!normalized) {
    return c.json({ error: "No PO number to look up — enter one first" }, 400);
  }

  let match;
  try {
    match = await lookupPurchaseOrder(c.env, normalized);
  } catch (err) {
    return c.json({ error: `Acumatica lookup failed: ${(err as Error).message}` }, 502);
  }

  if (!match) {
    await c.env.DB.prepare(
      "UPDATE shipments SET po_number_raw = ?, po_reconciliation_status = 'unmatched', po_match_data = NULL WHERE id = ?"
    )
      .bind(normalized, id)
      .run();
    return c.json({ matched: false });
  }

  await c.env.DB.prepare(
    "UPDATE shipments SET po_number_raw = ?, po_reconciliation_status = 'pending_review', po_match_data = ? WHERE id = ?"
  )
    .bind(normalized, JSON.stringify(match), id)
    .run();

  return c.json({ matched: true, po: match });
});

// FR-6.1b: the shipping manager's manual verification step. Confirming pulls
// the material off the matched PO line (real Acumatica line data, e.g.
// "Y5750-057 / 20/1 50Cot/50Poly 057 Charcoal", is far more specific than the
// AI's guess from email text) rather than overwriting it silently elsewhere.
app.post("/api/shipments/:id/po-confirm", async (c) => {
  const id = c.req.param("id");
  const { lineNbr } = await c.req.json<{ lineNbr: number }>();

  const shipment = await c.env.DB.prepare("SELECT po_match_data FROM shipments WHERE id = ?")
    .bind(id)
    .first<{ po_match_data: string | null }>();
  if (!shipment?.po_match_data) {
    return c.json({ error: "No pending PO match to confirm — run a lookup first" }, 400);
  }

  const po = JSON.parse(shipment.po_match_data) as {
    orderNbr: string;
    lines: { lineNbr: number; inventoryId: string; lineDescription: string }[];
  };
  const line = po.lines.find((l) => l.lineNbr === lineNbr);
  if (!line) return c.json({ error: "Line not found on the matched PO" }, 400);

  const material = `${line.inventoryId} — ${line.lineDescription}`;
  await c.env.DB.prepare(
    `UPDATE shipments
     SET po_number_matched = ?, po_line_id = ?, po_reconciliation_status = 'confirmed', material = ?
     WHERE id = ?`
  )
    .bind(po.orderNbr, String(lineNbr), material, id)
    .run();

  return c.json({ ok: true, material });
});

// FR-6.1d: no PO found, or the manager already knows there isn't one —
// proceed unlinked rather than blocking, flagged for Shipping/Purchasing to
// reconcile later.
app.post("/api/shipments/:id/po-flag-unmatched", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE shipments SET po_reconciliation_status = 'unmatched', po_match_data = NULL WHERE id = ?"
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

app.post("/api/shipments/rate-batch", async (c) => {
  const { shipmentIds } = await c.req.json<{ shipmentIds: number[] }>();

  try {
    const results = await withLock(c.env.DB, BATCH_OPERATIONS_LOCK, c.get("userId"), async () =>
      Promise.all(
        shipmentIds.map(async (id) => {
          const shipment = await c.env.DB.prepare("SELECT * FROM shipments WHERE id = ?")
            .bind(id)
            .first<Record<string, unknown>>();
          if (!shipment) return { id, quotes: [] };

          const originState =
            String(shipment.origin_address ?? "").match(/,\s*([A-Z]{2})\s*\d{5}/)?.[1] ?? "WI";

          const quotes = calculateRates({
            weightLbs: Number(shipment.weight_lbs) || 0,
            lengthIn: Number(shipment.length_in) || 0,
            widthIn: Number(shipment.width_in) || 0,
            heightIn: Number(shipment.height_in) || 0,
            freightClass: Number(shipment.freight_class) || 60,
            originState,
          });

          for (const [index, quote] of quotes.entries()) {
            await c.env.DB.prepare(
              "INSERT INTO carrier_quotes (shipment_id, carrier, price, is_best) VALUES (?, ?, ?, ?)"
            )
              .bind(id, quote.carrier, quote.price, index === 0 ? 1 : 0)
              .run();
          }

          await c.env.DB.prepare("UPDATE shipments SET status = 'rated' WHERE id = ?").bind(id).run();
          return { id, quotes };
        })
      )
    );

    return c.json(results);
  } catch (err) {
    if (err instanceof LockHeldError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

app.post("/api/shipments/:id/book", async (c) => {
  const id = c.req.param("id");
  const { chosenQuoteId } = await c.req.json<{ chosenQuoteId: number }>();

  await c.env.DB.prepare(
    "INSERT INTO booking_decisions (shipment_id, chosen_quote_id, booked_by) VALUES (?, ?, ?)"
  )
    .bind(id, chosenQuoteId, c.get("userId"))
    .run();
  await c.env.DB.prepare("UPDATE shipments SET status = 'booked' WHERE id = ?").bind(id).run();

  return c.json({ ok: true });
});

app.post("/api/shipments/book-all", async (c) => {
  try {
    const bookedIds = await withLock(c.env.DB, BATCH_OPERATIONS_LOCK, c.get("userId"), async () => {
      const { results: rated } = await c.env.DB.prepare(
        "SELECT id FROM shipments WHERE status = 'rated'"
      ).all<{ id: number }>();

      const ids: number[] = [];
      for (const shipment of rated) {
        const best = await c.env.DB.prepare(
          "SELECT id FROM carrier_quotes WHERE shipment_id = ? AND is_best = 1"
        )
          .bind(shipment.id)
          .first<{ id: number }>();
        if (!best) continue;

        await c.env.DB.prepare(
          "INSERT INTO booking_decisions (shipment_id, chosen_quote_id, booked_by) VALUES (?, ?, ?)"
        )
          .bind(shipment.id, best.id, c.get("userId"))
          .run();
        await c.env.DB.prepare("UPDATE shipments SET status = 'booked' WHERE id = ?")
          .bind(shipment.id)
          .run();
        ids.push(shipment.id);
      }
      return ids;
    });

    return c.json({ booked: bookedIds });
  } catch (err) {
    if (err instanceof LockHeldError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

async function buildExportText(
  db: Bindings["DB"],
  shipmentId: number
): Promise<{ text: string; bookingId: number | null } | null> {
  const shipment = await db.prepare("SELECT * FROM shipments WHERE id = ?")
    .bind(shipmentId)
    .first<Record<string, unknown>>();
  if (!shipment) return null;

  const booking = await db
    .prepare(
      `SELECT bd.id as booking_id, cq.carrier, cq.price
       FROM booking_decisions bd
       JOIN carrier_quotes cq ON cq.id = bd.chosen_quote_id
       WHERE bd.shipment_id = ?
       ORDER BY bd.booked_at DESC LIMIT 1`
    )
    .bind(shipmentId)
    .first<{ booking_id: number; carrier: string; price: number }>();

  const bestQuote = booking
    ? null
    : await db
        .prepare("SELECT carrier, price FROM carrier_quotes WHERE shipment_id = ? AND is_best = 1")
        .bind(shipmentId)
        .first<{ carrier: string; price: number }>();

  const quote = booking ?? bestQuote;
  if (!quote) return null;

  const text = [
    `Shipment #${shipment.id} quote confirmation`,
    `Material: ${shipment.material ?? "—"}`,
    `Weight: ${shipment.weight_lbs ?? "—"} lbs`,
    `Origin: ${shipment.origin_address ?? "—"}`,
    `Destination: ${shipment.destination_address}`,
    `Carrier: ${quote.carrier}`,
    `Rate: $${Number(quote.price).toFixed(2)}`,
    booking ? "Status: Booked" : "Status: Not yet booked (best available rate shown)",
  ].join("\n");

  return { text, bookingId: booking?.booking_id ?? null };
}

app.get("/api/shipments/:id/export", async (c) => {
  const id = Number(c.req.param("id"));
  const result = await buildExportText(c.env.DB, id);
  if (!result) return c.json({ error: "No rate available to export yet" }, 400);

  if (result.bookingId !== null) {
    await c.env.DB.prepare("UPDATE booking_decisions SET exported = 1 WHERE id = ?")
      .bind(result.bookingId)
      .run();
  }

  c.header("Content-Disposition", `attachment; filename="shipment-${id}-quote.txt"`);
  return c.text(result.text);
});

app.post("/api/shipments/export-all", async (c) => {
  try {
    const exports = await withLock(c.env.DB, BATCH_OPERATIONS_LOCK, c.get("userId"), async () => {
      const { results: shipments } = await c.env.DB.prepare(
        "SELECT id FROM shipments WHERE status IN ('rated', 'booked')"
      ).all<{ id: number }>();

      const out: { shipmentId: number; text: string }[] = [];
      for (const shipment of shipments) {
        const result = await buildExportText(c.env.DB, shipment.id);
        if (!result) continue;
        if (result.bookingId !== null) {
          await c.env.DB.prepare("UPDATE booking_decisions SET exported = 1 WHERE id = ?")
            .bind(result.bookingId)
            .run();
        }
        out.push({ shipmentId: shipment.id, text: result.text });
      }
      return out;
    });

    return c.json({ exports });
  } catch (err) {
    if (err instanceof LockHeldError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

app.get("/api/config/freight-classes", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM freight_class_defaults").all();
  return c.json(results);
});

app.put("/api/config/freight-classes", async (c) => {
  const { material, freightClass } = await c.req.json<{ material: string; freightClass: number }>();
  if (!material || typeof freightClass !== "number") {
    return c.json({ error: "material and freightClass are required" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO freight_class_defaults (material, freight_class, updated_by)
     VALUES (?, ?, ?)
     ON CONFLICT(material) DO UPDATE SET
       freight_class = excluded.freight_class,
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`
  )
    .bind(material, freightClass, c.get("userId"))
    .run();

  return c.json({ ok: true });
});

app.get("/api/metrics", async (c) => {
  const processed = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM shipments WHERE status IN ('rated', 'booked')"
  ).first<{ count: number }>();

  const bookedCost = await c.env.DB.prepare(
    `SELECT SUM(cq.price) as total
     FROM booking_decisions bd
     JOIN carrier_quotes cq ON cq.id = bd.chosen_quote_id`
  ).first<{ total: number | null }>();

  // FR-5.1: savings vs. the highest quote presented for each booked shipment
  // (not vs. some other carrier's rate) — the counterfactual is "what if the
  // most expensive option had been booked instead."
  const savings = await c.env.DB.prepare(
    `SELECT SUM(
       (SELECT MAX(price) FROM carrier_quotes WHERE shipment_id = bd.shipment_id) - cq.price
     ) as total
     FROM booking_decisions bd
     JOIN carrier_quotes cq ON cq.id = bd.chosen_quote_id`
  ).first<{ total: number | null }>();

  return c.json({
    processed: processed?.count ?? 0,
    totalBookedCost: bookedCost?.total ?? 0,
    totalSavingsVsHighestQuote: savings?.total ?? 0,
  });
});

// Escape hatch for a stuck batch-operations lock (src/locks.ts) — e.g. a
// request that acquired the lock died before reaching its release step.
// Deliberately not behind the session-cookie auth (requireAuth): if the app
// itself is wedged, whoever's clearing this shouldn't depend on a working
// login. Auth is the shared ADMIN_RESET_TOKEN instead.
app.post("/api/admin/reset-lock", async (c) => {
  const token = c.req.header("x-admin-token");
  if (!token || token !== c.env.ADMIN_RESET_TOKEN) {
    return c.json({ error: "Not authorized" }, 401);
  }

  const { lockName } = await c.req.json<{ lockName?: string }>().catch(() => ({}) as { lockName?: string });
  if (lockName) {
    await c.env.DB.prepare("DELETE FROM locks WHERE name = ?").bind(lockName).run();
  } else {
    await c.env.DB.prepare("DELETE FROM locks").run();
  }

  return c.json({ ok: true });
});

// Fallback for anything not served as a static asset from /public.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
