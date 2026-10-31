// Пульт: уведомления о напоминаниях без Claude.
// key       (владелец)  - публичный ключ VAPID; пара ключей создаётся здесь при первом вызове и хранится в pult_private
// subscribe (владелец)  - сохранить подписку телефона
// test      (владелец)  - пробное уведомление
// tick      (таймер pg_cron, заголовок x-pult-cron) - разослать наступившие напоминания
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-pult-cron",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function getPrivate(key: string) {
  const { data } = await admin.from("pult_private").select("value").eq("key", key).maybeSingle();
  return data?.value as string | undefined;
}

async function vapid() {
  let pub = await getPrivate("vapid_public"), priv = await getPrivate("vapid_private");
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    await admin.from("pult_private").upsert([
      { key: "vapid_public", value: k.publicKey },
      { key: "vapid_private", value: k.privateKey },
    ], { onConflict: "key", ignoreDuplicates: true });
    pub = await getPrivate("vapid_public");
    priv = await getPrivate("vapid_private");
  }
  // Apple отвечает 403 BadJwtToken на выдуманный адрес в subject, поэтому здесь адрес пульта
  webpush.setVapidDetails("https://eurovetomsk-arch.github.io", pub!, priv!);
  return pub!;
}

async function sendAll(payload: { title: string; body: string }) {
  await vapid();
  const { data: subs } = await admin.from("pult_push_subs").select("endpoint,p256dh,auth");
  let sent = 0, gone = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { await admin.from("pult_push_subs").delete().eq("endpoint", s.endpoint); gone++; }
      else await admin.from("pult_log").insert({ actor: "push", action: "error", detail: { code, msg: String((e as Error).message).slice(0, 200), body: String((e as { body?: string }).body ?? "").slice(0, 200) } });
    }
  }
  return { sent, gone, subs: subs?.length ?? 0 };
}

async function isOwner(req: Request) {
  const sb = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data } = await sb.rpc("pult_is_owner");
  return data === true ? sb : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const action = new URL(req.url).searchParams.get("action") ?? "";

  if (action === "tick") {
    const token = await getPrivate("cron_token");
    if (!token || req.headers.get("x-pult-cron") !== token) return json({ error: "нет доступа" }, 403);
    // проверка доставки без входа владельца: тот же токен таймера
    if (new URL(req.url).searchParams.get("test") === "1") return json(await sendAll({ title: "Ассистент", body: "Проверка уведомлений: если видишь это, всё работает" }));
    const { data: due } = await admin.from("pult_tasks").select("id,title,due_at")
      .is("done_at", null).is("reminded_at", null)
      .lte("due_at", new Date().toISOString())
      .gte("due_at", new Date(Date.now() - 864e5).toISOString())
      .order("due_at").limit(20);
    if (!due?.length) return json({ due: 0 });
    const body = due.map((t) => "• " + t.title).join("\n").slice(0, 900);
    const r = await sendAll({ title: due.length === 1 ? "Напоминание" : `Напоминаний: ${due.length}`, body });
    if (r.sent > 0) await admin.from("pult_tasks").update({ reminded_at: new Date().toISOString() }).in("id", due.map((t) => t.id));
    await admin.from("pult_log").insert({ actor: "push", action: "tick", detail: { due: due.length, ...r } });
    return json({ due: due.length, ...r });
  }

  const sb = await isOwner(req);
  if (!sb) return json({ error: "нет доступа" }, 403);

  if (action === "key") return json({ key: await vapid() });

  if (action === "subscribe" && req.method === "POST") {
    const s = await req.json();
    if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return json({ error: "нет подписки" }, 400);
    const { error } = await sb.from("pult_push_subs").upsert({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth }, { onConflict: "endpoint" });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "test" && req.method === "POST") {
    return json(await sendAll({ title: "Пульт", body: "Пробное уведомление: всё работает" }));
  }

  return json({ error: "неизвестное действие" }, 400);
});
