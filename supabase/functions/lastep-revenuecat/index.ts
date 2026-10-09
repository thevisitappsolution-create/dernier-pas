// Webhook RevenueCat : crédite les achats en argent réel (Premium, coffres de pièces) sur le compte du joueur.
// Dans RevenueCat : Integrations > Webhooks > URL de cette fonction, en-tête Authorization = valeur du secret REVENUECAT_WEBHOOK_AUTH.
// L'appli identifie le joueur dans RevenueCat avec son identifiant Supabase (Purchases.logIn(user.id)).
import { createClient } from "jsr:@supabase/supabase-js@2";

const COINS: Record<string, number> = { lastep_coins_500: 500, lastep_coins_1200: 1200, lastep_coins_3500: 3500, lastep_coins_8000: 8000 };
const PREMIUM = new Set(["lastep_premium_month", "lastep_premium_year"]);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("REVENUECAT_WEBHOOK_AUTH");
  if (!secret || req.headers.get("Authorization") !== secret) return json({ error: "unauthorized" }, 401);
  let body: any; try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const ev = body?.event; if (!ev) return json({ error: "no_event" }, 400);
  const user = String(ev.app_user_id || ""); const product = String(ev.product_id || "").split(":")[0];
  if (!/^[0-9a-f-]{36}$/.test(user)) return json({ ok: true, skipped: "anonymous" });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Premium : la date de fin vient de l'abonnement (renouvellement, résiliation, expiration)
  if (PREMIUM.has(product)) {
    const until = ev.expiration_at_ms ? new Date(Number(ev.expiration_at_ms)).toISOString() : null;
    const type = String(ev.type || "");
    const active = ["INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE", "UNCANCELLATION", "NON_RENEWING_PURCHASE"].includes(type);
    if (active || type === "EXPIRATION") await db.from("lastep_accounts").update({ premium_until: active ? until : new Date().toISOString() }).eq("user_id", user);
    return json({ ok: true });
  }
  // Coffres de pièces : crédités une seule fois par transaction
  const coins = COINS[product];
  if (coins && ["INITIAL_PURCHASE", "NON_RENEWING_PURCHASE"].includes(String(ev.type))) {
    const tx = String(ev.transaction_id || ev.id);
    const ins = await db.from("lastep_purchases").insert({ id: tx, user_id: user, product, coins });
    if (ins.error) return json({ ok: true, duplicate: true });
    const { data } = await db.from("lastep_accounts").select("coins").eq("user_id", user).single();
    if (data) await db.from("lastep_accounts").update({ coins: (data.coins || 0) + coins, updated_at: new Date().toISOString() }).eq("user_id", user);
    return json({ ok: true, coins });
  }
  return json({ ok: true, ignored: product });
});
