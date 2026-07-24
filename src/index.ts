import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Bindings, Variables } from "./types";
import { verifyPassword, createSessionToken, verifySessionToken } from "./auth";
import { extractShipment } from "./extraction";
import { calculateRates } from "./rating";

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
      (status, raw_input, material, freight_class, weight_lbs, pieces, length_in, width_in, height_in, hazmat, origin_address, ready_date, extraction_method, created_by)
     VALUES ('queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      c.get("userId")
    )
    .run();

  return c.json({ id: result.meta.last_row_id, extracted: data, method });
});

app.get("/api/shipments", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM shipments ORDER BY created_at DESC LIMIT 200"
  ).all();
  return c.json(results);
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

app.post("/api/shipments/rate-batch", async (c) => {
  const { shipmentIds } = await c.req.json<{ shipmentIds: number[] }>();

  const results = await Promise.all(
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
  );

  return c.json(results);
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

  return c.json({
    processed: processed?.count ?? 0,
    totalBookedCost: bookedCost?.total ?? 0,
  });
});

// Fallback for anything not served as a static asset from /public.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
