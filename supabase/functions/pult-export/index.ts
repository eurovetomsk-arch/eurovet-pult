// Пульт: выгрузка без Claude и без входа.
//   GET  ?t=<токен>&f=ics   - напоминания (открытые дела со сроком) как календарь ICS: подписка iPhone, Google, Outlook
//   GET  ?t=<токен>&f=json  - все данные пульта и ассистента для копии (без ключей, Face ID, подписок пуша, журнала)
//   POST ?action=links  (владелец, JWT) - выдать ссылки с токеном; токен создаётся при первом вызове
//   POST ?action=rotate (владелец, JWT) - сменить токен: старые ссылки перестают работать
// Токен лежит только в pult_private (видит сервер). Функция только читает данные, ничего не меняет, кроме токена.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

async function getToken(create: boolean) {
  const { data } = await admin.from("pult_private").select("value").eq("key", "export_token").maybeSingle();
  if (data?.value || !create) return data?.value as string | undefined;
  await admin.from("pult_private").upsert({ key: "export_token", value: newToken() }, { onConflict: "key", ignoreDuplicates: true });
  return (await admin.from("pult_private").select("value").eq("key", "export_token").single()).data?.value as string;
}

function sameToken(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function isOwner(req: Request) {
  const sb = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data } = await sb.rpc("pult_is_owner");
  return data === true;
}

// ---------- ICS ----------
const icsText = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const enc = new TextEncoder();
// Строки ICS не длиннее 75 байт (RFC 5545), режем по символам, а не посреди буквы
function fold(line: string) {
  const out: string[] = [];
  let cur = "", n = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; n = 0; }
    cur += ch; n += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

async function ics() {
  const from = new Date(Date.now() - 2 * 864e5).toISOString();
  const { data: tasks } = await admin.from("pult_tasks").select("id,title,note,due_at,priority,updated_at")
    .is("done_at", null).not("due_at", "is", null).gte("due_at", from).order("due_at").limit(500);
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//EUROVET//Pult export//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Напоминания пульта", "X-WR-TIMEZONE:Asia/Omsk", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  for (const t of tasks ?? []) {
    L.push("BEGIN:VEVENT", `UID:pult-task-${t.id}@eurovet-pult`, `DTSTAMP:${icsTime(t.updated_at)}`,
      `DTSTART:${icsTime(t.due_at)}`, "DURATION:PT15M", `SUMMARY:${icsText((t.priority === 1 ? "! " : "") + t.title)}`);
    if (t.note) L.push(`DESCRIPTION:${icsText(t.note)}`);
    L.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(t.title)}`, "TRIGGER:PT0M", "END:VALARM", "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return new Response(L.map(fold).join("\r\n") + "\r\n", {
    headers: { ...CORS, "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="pult.ics"', "Cache-Control": "no-store" },
  });
}

// ---------- JSON ----------
async function all(table: string, cols = "*", order = "id") {
  const { data, error } = await admin.from(table).select(cols).order(order).limit(10000);
  return error ? { error: error.message } : data;
}

async function dump() {
  const settings = await admin.from("pult_settings").select("allowed_email,stale_after_minutes").maybeSingle();
  const mail = await admin.from("pult_mail_snapshot").select("*").order("taken_at", { ascending: false }).limit(1);
  return json({
    format: "eurovet-pult-export/1",
    exported_at: new Date().toISOString(),
    note: "Данные пульта и ассистента без ключей, Face ID, подписок уведомлений и журнала. Как вернуть: ВОССТАНОВЛЕНИЕ/00_ЧИТАЙ_МЕНЯ.md",
    tables: {
      pult_settings: settings.data,
      pult_tasks: await all("pult_tasks"),
      pult_layout: await all("pult_layout", "*", "version"),
      pult_event_marks: await all("pult_event_marks", "*", "start_at"),
      pult_inbox: await all("pult_inbox"),
      pult_mail_snapshot_last: mail.data?.[0] ?? null,
      asst_orders: await all("asst_orders"),
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const q = new URL(req.url).searchParams;
  const action = q.get("action") ?? "";

  if (req.method === "POST" && (action === "links" || action === "rotate")) {
    if (!(await isOwner(req))) return json({ error: "нет доступа" }, 403);
    if (action === "rotate") await admin.from("pult_private").upsert({ key: "export_token", value: newToken() }, { onConflict: "key" });
    const t = await getToken(true);
    const base = `${URL_}/functions/v1/pult-export?t=${t}`;
    return json({ ics: `${base}&f=ics`, webcal: `${base}&f=ics`.replace(/^https:/, "webcal:"), json: `${base}&f=json` });
  }

  if (req.method === "GET" && q.get("t")) {
    const t = await getToken(false);
    if (!t || !sameToken(q.get("t")!, t)) return json({ error: "нет доступа" }, 403);
    await admin.from("pult_log").insert({ actor: "export", action: q.get("f") === "json" ? "json" : "ics", detail: { ua: (req.headers.get("user-agent") ?? "").slice(0, 80) } });
    return q.get("f") === "json" ? dump() : ics();
  }

  return json({ error: "нет доступа" }, 403);
});
