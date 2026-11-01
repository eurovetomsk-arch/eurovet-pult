// Пульт: календарь (неделя назад и до 40 дней вперёд).
// v6 (ТЗ 805): если секрета PULT_ICAL_URL нет, отдаёт снимок из pult_calendar_cache,
// который плановый агент Строителя кладёт раз в 30 минут из коннектора Google Календаря.
// Ветка iCal оставлена: появится секрет - функция снова читает iCal напрямую.
// Отвечает только владельцу пульта.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import ICAL from "npm:ical.js@2.1.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: owner, error } = await sb.rpc("pult_is_owner");
  if (error || owner !== true) return json({ error: "нет доступа" }, 403);

  const url = Deno.env.get("PULT_ICAL_URL");
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days") ?? 7), 1), 40);
  const from = new Date(Date.now() - 8 * 24 * 3600e3); // неделя назад: сетка календаря начинается с понедельника
  const to = new Date(Date.now() + (days + 1) * 24 * 3600e3);

  if (!url) {
    // Снимок читаем с правами владельца (RLS pult_is_owner), ключ service role не нужен.
    const [snap, rows] = await Promise.all([
      sb.from("pult_calendar_snap").select("snapshot_at, events").eq("id", 1).maybeSingle(),
      sb.from("pult_calendar_cache").select("title, start_at, end_at, all_day, link, recurring").order("start_at").limit(2000),
    ]);
    if (snap.error || rows.error) return json({ error: `кэш календаря: ${(snap.error ?? rows.error)!.message}` }, 502);
    if (!snap.data) return json({ configured: false, source: "cache", events: [], fetched_at: new Date().toISOString() });
    const day = (s: string, allDay: boolean) => allDay ? new Date(s + "T00:00:00+06:00") : new Date(s); // весь день - по Омску
    const events = (rows.data ?? [])
      .filter((r) => day(r.end_at, r.all_day) >= from && day(r.start_at, r.all_day) <= to)
      .map((r) => ({ title: r.title, start: r.start_at, end: r.end_at, all_day: r.all_day, link: r.link, recurring: r.recurring }));
    const age = Date.now() - new Date(snap.data.snapshot_at).getTime();
    return json({ configured: true, source: "cache", events, fetched_at: snap.data.snapshot_at, stale: age > 3 * 3600e3 });
  }

  let text: string;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return json({ error: `календарь ответил ${r.status}` }, 502);
    text = await r.text();
  } catch (e) {
    return json({ error: `календарь недоступен: ${(e as Error).message}` }, 502);
  }

  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);

  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const v of root.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);

  // Ссылка «Изменить в Google Календаре»: eid = base64url("<id события> <календарь>").
  // Календарь берём из пути секретной ссылки (/calendar/ical/<календарь>/private-.../basic.ics); сам секрет наружу не уходит.
  let calId = "";
  try { calId = decodeURIComponent(new URL(url).pathname.split("/")[3] ?? ""); } catch { /* не Google */ }
  const b64u = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const editLink = (ev: ICAL.Event, rid: ICAL.Time | null) => {
    const uid = String(ev.uid ?? "");
    if (!calId || !uid.endsWith("@google.com")) return null;
    let id = uid.slice(0, -"@google.com".length);
    if (rid) id += "_" + (rid.isDate ? rid.toString().replace(/-/g, "") : rid.toJSDate().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""));
    return "https://www.google.com/calendar/event?eid=" + b64u(id + " " + calId.replace(/@gmail\.com$/, "@m")); // так пишет сам Google
  };

  const out: { title: string; start: string; end: string; all_day: boolean; link: string | null; recurring: boolean }[] = [];
  const push = (ev: ICAL.Event, s: ICAL.Time, e: ICAL.Time, rid: ICAL.Time | null = null) => {
    if (ev.component.getFirstPropertyValue("status") === "CANCELLED") return;
    const sj = s.toJSDate(), ej = e.toJSDate();
    if (ej < from || sj > to) return;
    out.push({
      title: String(ev.summary ?? "(без названия)").slice(0, 200),
      start: s.isDate ? s.toString() : sj.toISOString(),
      end: e.isDate ? e.toString() : ej.toISOString(),
      all_day: s.isDate,
      link: editLink(ev, rid),
      recurring: rid !== null,
    });
  };

  for (const ev of masters.values()) {
    if (!ev.isRecurring()) {
      push(ev, ev.startDate, ev.endDate);
      continue;
    }
    const it = ev.iterator();
    let n = 0;
    for (let t = it.next(); t && n < 2000; t = it.next(), n++) {
      if (t.toJSDate() > to) break;
      const d = ev.getOccurrenceDetails(t);
      push(d.item, d.startDate, d.endDate, d.recurrenceId ?? t);
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return json({ configured: true, source: "ical", events: out, fetched_at: new Date().toISOString() });
});
