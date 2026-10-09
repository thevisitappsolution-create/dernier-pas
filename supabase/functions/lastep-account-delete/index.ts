// Supprime le compte du joueur connecté (exigé par l'App Store et Google Play) : sa ligne de jeu puis son identifiant.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
  const url = Deno.env.get("SUPABASE_URL")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return new Response(JSON.stringify({ error: "not_authenticated" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  const id = data.user.id;
  await admin.from("lastep_accounts").delete().eq("user_id", id);
  const del = await admin.auth.admin.deleteUser(id);
  if (del.error) return new Response(JSON.stringify({ error: "delete_failed" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
