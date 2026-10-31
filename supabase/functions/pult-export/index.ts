// Пульт: выгрузка без Claude и без входа.
//   GET  ?t=<токен>&f=ics   - напоминания (открытые дела со сроком) как календарь ICS: подписка iPhone, Google, Outlook
//   GET  ?t=<токен>&f=json  - все данные пульта и ассистента для копии (без ключей, Face ID, подписок пуша, журнала)
//   POST ?action=links  (владелец, JWT) - выдать ссылки с токеном; токен создаётся при первом вызове
//   POST ?action=rotate (владелец, JWT) - сменить токен: старые ссылки перестают работать
//   POST ?action=iphone-link (владелец, JWT) - выдать ссылку для Команды iPhone (новый токен reminders-iphone, старый перестаёт работать)
//   GET  ?t=<токен iPhone>&f=iphone         - что сделать в «Напоминаниях»: remove (метки старых копий), add (новые и изменённые)
//   POST ?t=<токен iPhone>&f=iphone-done    - метки отмеченных на iPhone (поле tags, через запятую) -> «сделано» в Ассистенте
//   Токен iPhone годится только для этих двух вызовов: полную копию и календарь по нему не получить.
// Токен лежит только в pult_private (видит сервер). Функция только читает данные, ничего не меняет, кроме токена.
// Устройства-копировщики (Mac) держат свой токен у себя, а в базе лежит только его SHA-256: pult_private key 'export_hash:<имя>'.
// Так токен Mac не проходит ни через чат, ни через ИИ. Отозвать: заменить значение этой строки.
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

const enc = new TextEncoder();
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

async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Подходит ли токен из ссылки: общий токен или токен одного из устройств (по хэшу)
async function tokenOk(given: string) {
  const main = await getToken(false);
  if (main && sameToken(given, main)) return "main";
  if (given.length < 32) return null;
  const h = await sha256hex(given);
  const { data } = await admin.from("pult_private").select("key,value").like("key", "export_hash:%");
  const hit = (data ?? []).find((r) => sameToken(h, r.value));
  return hit ? hit.key.slice("export_hash:".length) : null;
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
    .is("done_at", null).is("archived_at", null).not("due_at", "is", null).gte("due_at", from).order("due_at").limit(500);
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

// ---------- Команда iPhone: копия в приложении «Напоминания» ----------
const PHONE = "reminders-iphone";
// Метка с закрывающей скобкой: поиск «[ассистент-9]» не найдёт «[ассистент-90]»
const tagOf = (id: number) => `[ассистент-${id}]`;
// Время для iPhone: «2026-11-10 11:00» по Омску, Команды понимают его как дату
const omsk = (iso: string) => new Date(new Date(iso).getTime() + 6 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
async function iphonePlan() {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data, error } = await admin.from("pult_tasks").select("id,title,note,due_at,priority,done_at,archived_at,phone_sig")
    .or(`and(done_at.is.null,archived_at.is.null),phone_sig.not.is.null,updated_at.gt.${since}`).order("due_at", { nullsFirst: false }).limit(500);
  if (error) return json({ error: error.message }, 500);
  const remove: string[] = [], add: { tag: string; title: string; due: string; note: string }[] = [];
  const marks: { id: number; sig: string | null }[] = [];
  for (const t of data ?? []) {
    const open = !t.done_at && !t.archived_at;
    const sig = open ? `${t.title}|${t.due_at ?? ""}`.slice(0, 400) : null;
    if (sig === t.phone_sig) continue;
    if (t.phone_sig) remove.push(tagOf(t.id));
    if (sig) add.push({ tag: tagOf(t.id), title: (t.priority === 1 ? "❗ " : "") + t.title, due: t.due_at ? omsk(t.due_at) : "", note: [t.note, tagOf(t.id)].filter(Boolean).join("\n") });
    marks.push({ id: t.id, sig });
  }
  // Отмечаем сразу при выдаче: Команда выполняет план целиком за один запуск
  for (const m of marks) await admin.from("pult_tasks").update({ phone_sig: m.sig }).eq("id", m.id);
  await admin.from("pult_log").insert({ actor: "export", action: "iphone", detail: { add: add.length, remove: remove.length } });
  return json({ remove, add, removeCount: remove.length, addCount: add.length });
}
async function iphoneDone(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  let raw = "";
  try {
    if (ct.includes("json")) { const b = await req.json(); raw = Array.isArray(b?.tags) ? b.tags.join(",") : String(b?.tags ?? ""); }
    else raw = String((await req.formData()).get("tags") ?? "");
  } catch { return json({ error: "нет поля tags" }, 400); }
  const ids = new Set([...raw.matchAll(/\[ассистент-(\d{1,12})\]/g)].map((m) => Number(m[1])));
  // Отметки на iPhone копятся годами; сверяем только с открытыми напоминаниями, которые есть на телефоне
  const { data: open, error: e1 } = await admin.from("pult_tasks").select("id").is("done_at", null).is("archived_at", null).not("phone_sig", "is", null).limit(2000);
  if (e1) return json({ error: e1.message }, 500);
  const hit = (open ?? []).map((t) => t.id).filter((id) => ids.has(id));
  let done = 0;
  if (hit.length) {
    const { data, error } = await admin.from("pult_tasks").update({ done_at: new Date().toISOString() }).in("id", hit).is("done_at", null).is("archived_at", null).select("id");
    if (error) return json({ error: error.message }, 500);
    done = data?.length ?? 0;
  }
  await admin.from("pult_log").insert({ actor: "export", action: "iphone-done", detail: { seen: ids.size, done } });
  return json({ seen: ids.size, done });
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

  if (req.method === "POST" && action === "iphone-link") {
    if (!(await isOwner(req))) return json({ error: "нет доступа" }, 403);
    const t = newToken() + newToken(); // 96 знаков; в базе только отпечаток
    await admin.from("pult_private").upsert({ key: "export_hash:" + PHONE, value: await sha256hex(t) }, { onConflict: "key" });
    const base = `${URL_}/functions/v1/pult-export?t=${t}`;
    return json({ get: `${base}&f=iphone`, done: `${base}&f=iphone-done` });
  }

  if (q.get("t") && (q.get("f") === "iphone" || q.get("f") === "iphone-done")) {
    const who = await tokenOk(q.get("t")!);
    if (who !== PHONE) return json({ error: "нет доступа" }, 403);
    if (req.method === "GET" && q.get("f") === "iphone") return iphonePlan();
    if (req.method === "POST" && q.get("f") === "iphone-done") return iphoneDone(req);
    return json({ error: "нет доступа" }, 403);
  }

  if (req.method === "GET" && q.get("t")) {
    const who = await tokenOk(q.get("t")!);
    if (!who || who === PHONE) return json({ error: "нет доступа" }, 403); // токен iPhone не даёт полную копию
    await admin.from("pult_log").insert({ actor: "export", action: q.get("f") === "json" ? "json" : "ics", detail: { by: who, ua: (req.headers.get("user-agent") ?? "").slice(0, 80) } });
    return q.get("f") === "json" ? dump() : ics();
  }

  return json({ error: "нет доступа" }, 403);
});
