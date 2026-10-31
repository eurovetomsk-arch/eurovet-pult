// Пульт: вход по Face ID (passkey) без пароля.
// reg-options, reg-verify, count (владелец по JWT) - привязать Face ID этого устройства
// auth-options, auth-verify (без входа) - проверить Face ID и выдать одноразовый токен входа владельца
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import * as lib from "npm:@simplewebauthn/server@13.3.3";
import { authOptions, authVerify, type Cfg, type Cred, regOptions, regVerify, type Store } from "./passkey.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Адрес пульта. При переезде на другой хостинг поменять здесь (RESTORE.md)
const CFG: Cfg = { rpID: "eurovetomsk-arch.github.io", origins: ["https://eurovetomsk-arch.github.io"], rpName: "Пульт" };

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const log = (action: string, detail: unknown) => admin.from("pult_log").insert({ actor: "passkey", action, detail });

const store: Store = {
  async getCreds() {
    const { data, error } = await admin.from("pult_passkeys").select("id,public_key,counter,transports");
    if (error) throw new Error(error.message);
    return (data ?? []) as Cred[];
  },
  async saveCred(c) {
    const { error } = await admin.from("pult_passkeys").insert(c);
    if (error) throw new Error(error.message);
  },
  async setCounter(id, counter) {
    await admin.from("pult_passkeys").update({ counter, used_at: new Date().toISOString() }).eq("id", id);
  },
  async putChallenge(challenge, kind) {
    await admin.from("pult_passkey_challenges").delete().lt("expires_at", new Date().toISOString());
    const { count } = await admin.from("pult_passkey_challenges").select("challenge", { count: "exact", head: true });
    if ((count ?? 0) > 50) throw new Error("слишком много попыток, подожди 5 минут");
    const { error } = await admin.from("pult_passkey_challenges").insert({ challenge, kind });
    if (error) throw new Error(error.message);
  },
  async takeChallenge(challenge, kind) {
    const { data } = await admin.from("pult_passkey_challenges").delete()
      .eq("challenge", challenge).eq("kind", kind).gt("expires_at", new Date().toISOString()).select("challenge");
    return (data?.length ?? 0) === 1;
  },
};

async function ownerUser(req: Request) {
  const sb = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: ok } = await sb.rpc("pult_is_owner");
  if (ok !== true) return null;
  const { data } = await sb.auth.getUser();
  return data.user ? { id: data.user.id, email: data.user.email ?? "" } : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const action = new URL(req.url).searchParams.get("action") ?? "";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  try {
    if (action === "auth-options") return json(await authOptions(lib, store, CFG));

    if (action === "auth-verify") {
      try {
        await authVerify(lib, store, CFG, body);
      } catch (e) {
        await log("auth_fail", { msg: String((e as Error).message).slice(0, 200) });
        return json({ error: (e as Error).message }, 401);
      }
      const { data: s } = await admin.from("pult_settings").select("allowed_email,owner_id").eq("id", 1).single();
      if (!s?.owner_id) return json({ error: "владелец не задан" }, 400);
      const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: s.allowed_email });
      if (error || !data?.properties?.hashed_token) return json({ error: error?.message ?? "нет токена" }, 500);
      await log("auth_ok", {});
      return json({ token_hash: data.properties.hashed_token });
    }

    const user = await ownerUser(req);
    if (!user) return json({ error: "нет доступа" }, 403);
    if (action === "count") return json({ count: (await store.getCreds()).length });
    if (action === "reg-options") return json(await regOptions(lib, store, CFG, user));
    if (action === "reg-verify") {
      await regVerify(lib, store, CFG, body?.credential, String(body?.device ?? "устройство"));
      await log("registered", { device: String(body?.device ?? "").slice(0, 80) });
      return json({ ok: true });
    }
    return json({ error: "неизвестное действие" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});
