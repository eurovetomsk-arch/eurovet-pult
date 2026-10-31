// Пульт: календарь на 7 дней из секретной ссылки iCal Google.
// Ссылка хранится только в секрете PULT_ICAL_URL. Отвечает только владельцу пульта.
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
  if (!url) return json({ configured: false, events: [], fetched_at: new Date().toISOString() });

  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days") ?? 7), 1), 14);
  const from = new Date(Date.now() - 24 * 3600e3);
  const to = new Date(Date.now() + (days + 1) * 24 * 3600e3);

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

  const out: { title: string; start: string; end: string; all_day: boolean }[] = [];
  const push = (ev: ICAL.Event, s: ICAL.Time, e: ICAL.Time) => {
    if (ev.component.getFirstPropertyValue("status") === "CANCELLED") return;
    const sj = s.toJSDate(), ej = e.toJSDate();
    if (ej < from || sj > to) return;
    out.push({
      title: String(ev.summary ?? "(без названия)").slice(0, 200),
      start: s.isDate ? s.toString() : sj.toISOString(),
      end: e.isDate ? e.toString() : ej.toISOString(),
      all_day: s.isDate,
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
      push(d.item, d.startDate, d.endDate);
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return json({ configured: true, events: out, fetched_at: new Date().toISOString() });
});
