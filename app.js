// Пульт Михаила V0. Экран собирается из реестра панелей (таблица pult_layout),
// поэтому новую панель известного вида добавляют данными, без правки этого файла.
'use strict';

const CFG = {
  url: 'https://ikxmzapfmgqnnrsttuxc.supabase.co',
  key: 'sb_publishable_T8ccLgWCaguS1EABck2d0A_-KnjFd9K', // публичный ключ, доступ режет RLS
  version: '0.7.2',
  tz: 'Asia/Omsk',
  nightFrom: 22.5, // снимок почты ночью не обновляется: 22:30-07:30 по Омску плашку не краснеем
  nightTo: 7.5,
};

const sb = supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } });
const $ = (id) => document.getElementById(id);
// текст ассистента: экранируем, потом делаем ссылки кликабельными
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 60 ? u.slice(0, 57) + '…' : u}</a>`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- время по Омску ----------
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: CFG.tz }).format(d);
const hhmm = (d) => new Intl.DateTimeFormat('ru-RU', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit' }).format(d);
// Календарь (0.7.2, ТЗ 805): снимок кладёт агент раз в 30 мин; старше 3 ч - предупреждение
const calStamp = () => {
  const d = new Date(state.cal.fetched_at), dd = dayKey(d) === today0() ? '' : ' ' + new Intl.DateTimeFormat('ru-RU', { timeZone: CFG.tz, day: '2-digit', month: '2-digit' }).format(d);
  return `обновлено${dd} ${hhmm(d)}`;
};
const calStale = () => state.cal && state.cal.configured !== false && (state.cal.stale || Date.now() - new Date(state.cal.fetched_at) > 3 * 36e5)
  ? `<div class="banner org">Календарь не обновлялся с ${esc(calStamp().replace('обновлено ', ''))}: показан последний снимок.</div>` : '';
const dayTitle = (key) => {
  const d = new Date(key + 'T12:00:00+06:00');
  const t = new Intl.DateTimeFormat('ru-RU', { timeZone: CFG.tz, weekday: 'short', day: '2-digit', month: '2-digit' }).format(d);
  const today = dayKey(new Date());
  const tomorrow = dayKey(new Date(Date.now() + 864e5));
  return (key === today ? 'Сегодня, ' : key === tomorrow ? 'Завтра, ' : '') + t;
};
const omskHour = () => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':');
  return Number(p[0]) + Number(p[1]) / 60;
};
const evDay = (e) => (e.all_day ? e.start.slice(0, 10) : dayKey(new Date(e.start)));
const evTime = (e) => (e.all_day ? 'весь день' : hhmm(new Date(e.start)) + '-' + hhmm(new Date(e.end)));
// Отметка встречи: «прошла» или «не было». Ключ = начало + название (у повторяющихся встреч начало разное)
const evKey = (e) => (e.start + '|' + e.title).slice(0, 400);
const evIndex = new Map();
// Отмеченные встречи («прошла» / «не было») убираем из списков и календаря пульта.
// Только в пульте: Google Календарь не меняется (связь в одну сторону).
let showMarked = false;
const isMarked = (e) => !!state.marks?.[evKey(e)];
const visible = (evs) => (showMarked ? evs : evs.filter((e) => !isMarked(e)));
function hiddenNote(evs) {
  const n = evs.filter(isMarked).length;
  if (!n) return '';
  return `<p class="mute">${showMarked ? 'Отмеченные показаны' : 'Скрыто отмеченных: ' + n} · <button class="ghost small" data-act="toggle-marked">${showMarked ? 'Скрыть' : 'Показать'}</button></p>`;
}
function evLine(e) {
  const k = evKey(e), mk = state.marks?.[k];
  evIndex.set(k, e);
  const btn = mk ? `<button class="ghost small" data-unmark="${esc(k)}" aria-label="Снять отметку">${mk === 'прошла' ? '✓ прошла' : '✕ не было'}</button>`
    : new Date(e.start) <= new Date() ? `<button class="ghost small" data-mark="прошла" data-k="${esc(k)}">✓ прошла</button><button class="ghost small" data-mark="не было" data-k="${esc(k)}" aria-label="Не было">✕</button>` : '';
  return `<li class="row"><div class="grow${mk ? ' done' : ''}"><b>${esc(evTime(e))}</b> ${esc(e.title)}</div>${btn}</li>`;
}

// ---------- кэш для офлайна ----------
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };
const cache = {
  get() { try { return JSON.parse(localStorage.getItem('pult.cache') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('pult.cache', JSON.stringify(v)); } catch { /* нет места или приватный режим */ } },
};

let state = { layout: null, versions: [], tasks: [], archived: [], mail: null, settings: null, cal: null, calError: null, orders: null, inbox: null, marks: {}, offline: false };

// ---------- загрузка ----------
async function load() {
  const old = cache.get();
  const since = new Date(Date.now() - 2 * 864e5).toISOString();
  const [lay, tasks, mail, set, cal, orders, inbox, marks, arch] = await Promise.all([
    sb.from('pult_layout').select('version,created_at,note,modules').order('version', { ascending: false }).limit(20),
    sb.from('pult_tasks').select('*').is('archived_at', null).or(`done_at.is.null,done_at.gt.${since}`).order('due_at', { ascending: true, nullsFirst: false }),
    sb.from('pult_mail_snapshot').select('*').order('taken_at', { ascending: false }).limit(1),
    sb.from('pult_settings').select('stale_after_minutes').limit(1),
    sb.functions.invoke('pult-calendar?days=35', { method: 'GET' }).catch((e) => ({ error: e })),
    sb.from('asst_orders').select('id,created_at,body,route,status,due_at,result,needs_yes,closed_at')
      .or(`closed_at.is.null,closed_at.gt.${new Date(Date.now() - 7 * 864e5).toISOString()}`)
      .order('created_at', { ascending: false }).limit(100),
    sb.from('pult_inbox').select('id,created_at,body,via,taken_at,order_id,note')
      .or(`taken_at.is.null,created_at.gt.${since}`).order('created_at', { ascending: false }).limit(50),
    sb.from('pult_event_marks').select('event_key,mark').gte('start_at', new Date(Date.now() - 10 * 864e5).toISOString()),
    sb.from('pult_tasks').select('id,title,due_at,archived_at').not('archived_at', 'is', null).order('archived_at', { ascending: false }).limit(30),
  ]);
  const netFail = [lay, tasks, mail].some((r) => r.error && /fetch|network/i.test(r.error.message || ''));
  state.offline = netFail;
  if (netFail) {
    Object.assign(state, old.state || {});
    state.offline = true;
    return;
  }
  for (const r of [lay, tasks, mail, set]) if (r.error) throw r.error;
  state.versions = lay.data;
  state.layout = lay.data[0] || { version: 0, modules: [] };
  state.tasks = tasks.data;
  state.mail = mail.data[0] || null;
  state.settings = set.data[0] || { stale_after_minutes: 120 };
  state.orders = orders.error ? null : orders.data; // таблицу ведёт ассистент; нет таблицы - панель покажет заглушку
  state.inbox = inbox.error ? null : inbox.data;
  state.archived = arch.error ? [] : arch.data;
  state.marks = marks.error ? (old.state?.marks || {}) : Object.fromEntries(marks.data.map((x) => [x.event_key, x.mark]));
  if (cal.error || cal.data?.error) {
    state.calError = (cal.data && cal.data.error) || 'календарь не ответил';
    state.cal = old.state?.cal || null;
  } else {
    state.calError = null;
    state.cal = cal.data;
  }
  // 0.7.2 (ТЗ 805): секрета iCal нет - читаем снимок агента прямо из базы (RLS: только владелец).
  // Если pult-calendar v6 уже отдаёт снимок сам (source 'cache'), этот шаг не нужен.
  if (state.cal && state.cal.configured === false && state.cal.source !== 'cache') {
    const c = await calFromCache().catch((e) => ({ error: e }));
    if (c && !c.error) { state.cal = c; state.calError = null; }
  }
  cache.set({ state: { ...state, offline: false }, at: new Date().toISOString() });
}

async function calFromCache() {
  const [snap, rows] = await Promise.all([
    sb.from('pult_calendar_snap').select('snapshot_at').eq('id', 1).maybeSingle(),
    sb.from('pult_calendar_cache').select('title,start_at,end_at,all_day,link,recurring').gt('snapshot_at', '2000-01-01').order('start_at').limit(2000),
  ]);
  if (snap.error || rows.error) return { error: snap.error || rows.error };
  if (!snap.data) return { error: 'снимка нет' };
  const events = rows.data.map((r) => ({ title: r.title, start: r.start_at, end: r.end_at, all_day: r.all_day, link: r.link, recurring: r.recurring }));
  return { configured: true, source: 'cache', events, fetched_at: snap.data.snapshot_at, stale: Date.now() - new Date(snap.data.snapshot_at) > 3 * 36e5 };
}

// ---------- панели ----------
const R = {};

// Встречи и напоминания раздельно (0.7). В Google Календаре пока лежат и напоминания из почты:
// сроки оплат 🔴/🟠/💰, «[Почта] ...», «Оплата ...», дни рождения 🎂. Пульт показывает их во вкладке «Напоминания».
const REM_RE = /^\s*(🔴|🟠|💰|\[Почта\]|Оплата|🎂)/u;
const isRemEv = (e) => REM_RE.test(e.title);
const calEvents = () => state.cal?.events || [];
const meetings = () => calEvents().filter((e) => !isRemEv(e));
const today0 = () => dayKey(new Date());
const tomorrow0 = () => dayKey(new Date(Date.now() + 864e5));
const isGoogleLink = (u) => typeof u === 'string' && u.startsWith('https://www.google.com/calendar/event?eid=');

// Единый список напоминаний: свои (pult_tasks) + из Google Календаря (только чтение, до переноса)
function reminders() {
  const own = state.tasks.map((t) => ({ src: 'own', id: t.id, title: t.title, due: t.due_at, day: t.due_at ? dayKey(new Date(t.due_at)) : null, done: !!t.done_at, t }));
  const g = calEvents().filter(isRemEv).map((e) => ({ src: 'google', key: evKey(e), title: e.title, due: e.start, day: evDay(e), done: isMarked(e), allDay: e.all_day, e }));
  for (const x of g) evIndex.set(x.key, x.e);
  return own.concat(g).sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9')));
}
const openRem = () => reminders().filter((r) => !r.done);

function urgency(t) {
  if (t.done_at || !t.due_at) return '';
  const k = dayKey(new Date(t.due_at)), today = today0();
  if (k < today) return '<span class="tag red">просрочено</span>';
  if (k === today) return '<span class="tag org">сегодня</span>';
  if (k === tomorrow0()) return '<span class="tag org">завтра</span>';
  return '';
}

// Время напоминания вводится и показывается по Омску (UTC+6, без перехода на летнее время)
const toLocal = (iso) => new Date(new Date(iso).getTime() + 6 * 36e5).toISOString().slice(0, 16);
const fromLocal = (v) => (v ? new Date(v + ':00+06:00').toISOString() : null);
const at = (key, h, m = 0) => new Date(`${key}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+06:00`).toISOString();

function pushHint() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return '<div class="banner org">Уведомления: открой пульт с иконки на экране «Домой» (Safari: Поделиться - На экран Домой).</div>';
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem('pult.push') === '1') return '';
  return '<p><button class="ghost" data-act="push-on">Включить уведомления о напоминаниях</button></p>';
}

// ---------- строки ----------
function meetLine(e, withDay = false) {
  const k = evKey(e), mk = state.marks?.[k];
  evIndex.set(k, e);
  return `<li class="row tap" data-ev="${esc(k)}"><div class="grow${mk ? ' done' : ''}"><b>${withDay ? esc(dayTitle(evDay(e))) + ', ' : ''}${esc(evTime(e))}</b> ${esc(e.title)}${mk ? ` <span class="mute">${mk === 'прошла' ? '✓ прошла' : '✕ не было'}</span>` : ''}</div><span class="chev">›</span></li>`;
}
function remWhen(r) {
  if (!r.due) return 'без срока';
  const d = new Date(r.due);
  return (r.day !== today0() ? esc(dayTitle(r.day)) + ', ' : '') + (r.allDay ? 'весь день' : hhmm(d));
}
function remLine(r, withDay = false) {
  if (r.src === 'google') {
    return `<li class="row tap" data-gev="${esc(r.key)}"><span class="gdot" aria-hidden="true">G</span><div class="grow${r.done ? ' done' : ''}"><div class="rt">${esc(r.title)}</div><div class="mute">${withDay ? remWhen(r) : r.allDay ? 'весь день' : hhmm(new Date(r.due))} · из Google Календаря</div></div><span class="chev">›</span></li>`;
  }
  const t = r.t;
  return `<li class="swipe" data-task="${t.id}"><div class="acts"><button data-act="tomorrow" style="background:#6b6266">Завтра</button><button data-act="edit" style="background:#1d4ed8">Изменить</button><button data-act="archive" style="background:var(--red)">В архив</button></div>
    <div class="front"><button class="chk${t.done_at ? ' on' : ''}" data-act="done" aria-label="${t.done_at ? 'Вернуть' : 'Сделано'}">${t.done_at ? '✓' : ''}</button>
    <div class="grow tap" data-act="edit"><div class="${t.done_at ? 'done' : ''}">${t.priority === 1 ? '❗ ' : ''}${esc(t.title)}${urgency(t)}</div>
    <div class="mute">${withDay ? remWhen(r) : t.due_at ? hhmm(new Date(t.due_at)) : 'без срока'}${t.reminded_at ? ' · уведомлено' : ''}${t.note ? ' · 📝' : ''}</div></div></div></li>`;
}

// ---------- вкладка «Сегодня» ----------
R.today = (m) => {
  const today = today0(), tom = tomorrow0();
  const mt = meetings().filter((e) => evDay(e) === today);
  const left = mt.filter((e) => !isMarked(e));
  const rem = reminders();
  const remNow = rem.filter((r) => !r.done && r.day && (r.day === today || (r.src === 'own' && r.day < today))); // прошедшие события Google не тащим в «сегодня»
  const remDoneToday = rem.filter((r) => r.done && r.src === 'own' && r.t.done_at && dayKey(new Date(r.t.done_at)) === today);
  const noDue = rem.filter((r) => !r.done && !r.day);
  const from = dayKey(new Date(Date.now() - 3 * 864e5));
  const past = meetings().filter((e) => !e.all_day && evDay(e) < today && evDay(e) >= from && !state.marks?.[evKey(e)]);
  const tomM = meetings().filter((e) => evDay(e) === tom && !isMarked(e));
  const tomR = rem.filter((r) => !r.done && r.day === tom);
  const calWarn = !state.cal ? `<div class="banner org">Календарь ещё не загружен${state.calError ? ': ' + esc(state.calError) : ''}.</div>`
    : state.calError ? `<div class="banner org">Встречи: ${esc(calStamp())}, ${esc(state.calError)}</div>` : calStale();
  return `<div class="row"><div class="grow"><div class="big">${left.length}</div><div class="mute">${left.length < mt.length ? 'встреч осталось' : 'встреч сегодня'}</div></div>
      <div class="grow"><div class="big" style="color:${remNow.length ? 'var(--red)' : 'inherit'}">${remNow.length}</div><div class="mute">напоминаний на сегодня</div></div>
      <div class="grow tap" data-tab-go="mail"><div class="big">${state.mail ? state.mail.reply_count : '-'}</div><div class="mute">писем ответить</div></div></div>
    ${calWarn}
    <h3>Встречи</h3><ul>${left.map((e) => meetLine(e)).join('') || `<li class="mute">${mt.length ? 'Все встречи дня отмечены' : 'Встреч нет'}</li>`}</ul>
    ${past.length ? `<details class="banner org"><summary>Отметь прошедшие встречи: ${past.length}</summary><ul>${past.map((e) => meetLine(e, true)).join('')}</ul></details>` : ''}
    <h3>Напоминания</h3>${pushHint()}<ul>${remNow.map((r) => remLine(r, r.day !== today)).join('') || '<li class="mute">На сегодня напоминаний нет</li>'}${remDoneToday.map((r) => remLine(r)).join('')}</ul>
    ${noDue.length ? `<h3>Без срока</h3><ul>${noDue.map((r) => remLine(r)).join('')}</ul>` : ''}
    <form data-form="quick" class="row" style="margin-top:8px"><input name="title" placeholder="Новое напоминание" maxlength="300" class="grow" autocomplete="off"><button aria-label="Добавить">＋</button></form>
    <h3>Завтра, ${esc(dayTitle(tom).replace(/^Завтра, /, ''))}</h3><ul>${tomM.map((e) => meetLine(e)).join('')}${tomR.map((r) => remLine(r)).join('') || (tomM.length ? '' : '<li class="mute">Пусто</li>')}</ul>`;
};

R.mail = (m) => {
  const s = state.mail;
  if (!s) return '<div class="banner org">Снимков почты ещё нет: агент снимка не запускался.</div>';
  const age = (Date.now() - new Date(s.taken_at)) / 6e4;
  const h = omskHour();
  const night = h >= CFG.nightFrom || h < CFG.nightTo;
  const stale = age > (state.settings?.stale_after_minutes || 120) && !night;
  return `${stale ? `<div class="banner red">Данные почты устарели: снимок от ${hhmm(new Date(s.taken_at))}, ${Math.round(age / 60)} ч назад. Проверь агента снимка.</div>` : ''}
    <div class="grid2"><div><div class="big" style="color:var(--red)">${s.reply_count}</div><div class="mute">Ответить</div></div>
      <div><div class="big">${s.plan_count}</div><div class="mute">В плане</div></div>
      <div><div class="big">${s.wait_count ?? '-'}</div><div class="mute">Ждём ответа</div></div>
      <div><div class="big">${s.inbox_count ?? '-'}</div><div class="mute">Во входящих</div></div></div>
    <p class="mute">данные от ${hhmm(new Date(s.taken_at))}${night ? ', ночью не обновляется' : ''}</p>`;
};

// Старые виды панелей (до 0.7): остаются рабочими, если их включить в «Панелях»
function grouped(evs, empty) {
  if (!state.cal) return `<div class="banner org">Календарь ещё не загружен${state.calError ? ': ' + esc(state.calError) : ''}.</div>`;
  if (state.cal.configured === false) return '<div class="banner org">Календарь ещё не подключён: снимка календаря пока нет.</div>';
  const by = {};
  for (const e of visible(evs)) (by[evDay(e)] ||= []).push(e);
  const keys = Object.keys(by).sort();
  if (!keys.length) return `<p class="mute">${evs.length ? 'Все встречи отмечены' : empty}</p>`;
  return keys.map((k) => `<div class="day">${esc(dayTitle(k))}</div><ul>${by[k].map((e) => meetLine(e)).join('')}</ul>`).join('')
    + calStale() + `<p class="mute">${esc(calStamp())}</p>`;
}
function window7(days) {
  const today = today0(), end = dayKey(new Date(Date.now() + (days - 1) * 864e5));
  return meetings().filter((e) => { const k = evDay(e); return k >= today && k <= end; });
}
R.events = (m) => {
  const c = m.config || {};
  const word = (c.match || '').toLowerCase();
  return grouped(window7(c.days || 7).filter((e) => !word || e.title.toLowerCase().includes(word)), word ? `Нет событий со словом «${esc(c.match)}»` : 'Событий нет');
};
R.shifts = (m) => {
  const word = ((m.config || {}).match || 'Смена').toLowerCase();
  const evs = window7(7).filter((e) => e.title.toLowerCase().includes(word));
  return `<div class="big">${evs.length}</div><div class="mute">смен за 7 дней</div>` + grouped(evs, 'Смен нет');
};
R.tasks = (m) => {
  const open = openRem().filter((r) => r.src === 'own');
  return `${pushHint()}<ul>${open.map((r) => remLine(r, true)).join('') || '<li class="mute">Напоминаний нет</li>'}</ul>`;
};

// ---------- вкладка «Календарь»: Встречи | Напоминания ----------
let calDay = null;
let calMode = lsGet('pult.calMode') === 'r' ? 'r' : 'm';
R.calendar = (m) => {
  if (!state.cal || state.cal.configured === false) return grouped([], '');
  const today = today0();
  const t = new Date(today + 'T12:00:00+06:00');
  const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 864e5);
  const rem = reminders();
  const byM = {}, byR = {};
  for (const e of meetings()) if (!isMarked(e)) (byM[evDay(e)] ||= []).push(e);
  for (const r of rem) if (r.day && !r.done) (byR[r.day] ||= []).push(r);
  const nM = meetings().filter((e) => evDay(e) >= today && !isMarked(e)).length;
  const nR = rem.filter((r) => !r.done && (r.src === 'own' || r.day >= today)).length; // прошедшие события Google не считаем
  const by = calMode === 'm' ? byM : byR;
  const sel = calDay || today;
  let cells = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d) => `<div class="cal-h">${d}</div>`).join('');
  for (let i = 0; i < 35; i++) {
    const k = dayKey(new Date(monday.getTime() + i * 864e5));
    const n = (by[k] || []).length;
    const cls = ['cal-d', 'mode-' + calMode, k === today ? 'cal-today' : '', k === sel ? 'cal-sel' : '', k < today ? 'cal-past' : ''].join(' ');
    cells += `<button class="${cls}" data-day="${k}"><span>${Number(k.slice(8))}</span><i>${n ? (n > 3 ? '•••' : '•'.repeat(n)) : '&nbsp;'}</i></button>`;
  }
  let list;
  if (calMode === 'm') {
    const all = meetings().filter((e) => evDay(e) === sel);
    list = `<ul>${visible(all).map((e) => meetLine(e)).join('') || `<li class="mute">${all.length ? 'Все встречи дня отмечены' : 'Встреч нет'}</li>`}</ul>${hiddenNote(all)}`;
  } else {
    const all = rem.filter((r) => r.day === sel);
    list = `<ul>${all.map((r) => remLine(r)).join('') || '<li class="mute">Напоминаний нет</li>'}</ul>
      <p style="margin:10px 0 0"><button style="width:100%" data-act="new-on" data-day="${sel}">＋ Напоминание на ${esc(dayTitle(sel).replace(/^(Сегодня|Завтра), /, ''))}</button></p>
      ${state.archived?.length ? `<details style="margin-top:10px"><summary class="mute">Архив напоминаний: ${state.archived.length}</summary><ul>${state.archived.map((a) => `<li class="row"><div class="grow mute">${esc(a.title)}${a.due_at ? ' · ' + esc(dayTitle(dayKey(new Date(a.due_at)))) : ''}</div><button class="ghost small" data-unarchive="${a.id}">Вернуть</button></li>`).join('')}</ul></details>` : ''}`;
  }
  return `<div class="seg" role="tablist"><button data-cal-mode="m" class="${calMode === 'm' ? 'on' : ''}">Встречи<span class="n m">${nM}</span></button><button data-cal-mode="r" class="${calMode === 'r' ? 'on' : ''}">Напоминания<span class="n r">${nR}</span></button></div>
    <div class="cal" data-swipe-cal>${cells}</div><div class="day">${esc(dayTitle(sel))}</div>${list}
    <p class="hint">${calMode === 'm' ? 'смахни календарь влево: напоминания · нажми на встречу, чтобы изменить' : 'кружок: сделано · строку влево: Завтра / Изменить / В архив'}</p>
    ${calStale()}<p class="mute">встречи из Google Календаря, ${esc(calStamp())}${state.calError ? ' (' + esc(state.calError) + ')' : ''}</p>`;
};
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act="toggle-marked"]');
  if (t) { showMarked = !showMarked; renderBoard(); return; }
  const mo = ev.target.closest('[data-cal-mode]');
  if (mo) { setCalMode(mo.dataset.calMode); return; }
  const d = ev.target.closest('.cal [data-day]');
  if (d) { calDay = d.dataset.day; renderBoard(); }
});
function setCalMode(mode) { calMode = mode; lsSet('pult.calMode', mode); renderBoard(); }

// Поручения ассистента (таблица asst_orders, пишет только ассистент)
let orderDraft = '', orderVia = 'текст';
const orderForm = () => `<form data-form="order"><p><textarea name="body" rows="3" maxlength="2000" placeholder="Поручение: что сделать, кому, к какому сроку">${esc(orderDraft)}</textarea></p>
    <p class="row"><button type="button" class="ghost" data-act="mic">🎤 Голосом</button><button>Поручить</button></p><p class="mute" id="micMsg"></p></form>`;
function inboxList() {
  const wait = (state.inbox || []).filter((x) => !x.taken_at || (!x.order_id && x.note));
  return wait.length ? `<ul>${wait.map((x) => `<li><div>${esc(x.body)}</div><div class="mute">${x.via === 'голос' ? '🎤 ' : ''}${hhmm(new Date(x.created_at))} · ${x.taken_at ? linkify(x.note || 'не взято') : 'ждёт разбора ассистентом (заходит раз в час, 7-22)'}</div></li>`).join('')}</ul>` : '';
}
R.orders = (m) => {
  if (!state.orders) return orderForm() + inboxList() + '<p class="mute">Журнал поручений пока недоступен.</p>';
  const open = state.orders.filter((o) => !o.closed_at).sort((a, b) => (b.needs_yes - a.needs_yes) || String(a.due_at || '9').localeCompare(String(b.due_at || '9')));
  const closed = state.orders.filter((o) => o.closed_at);
  const line = (o) => `<li><div class="row"><div class="grow" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(o.body)}</div>${o.needs_yes ? '<span class="tag red">нужно твоё да</span>' : ''}<button class="ghost small" data-order-done="${o.id}">✓ Сделано</button></div>
      <div class="mute">${esc(o.route)} · ${esc(o.status)}${o.due_at ? ' · до ' + esc(dayTitle(dayKey(new Date(o.due_at)))) + ' ' + hhmm(new Date(o.due_at)) : ''}</div>${o.result ? `<div class="answer">${linkify(o.result)}</div>` : ''}</li>`;
  return orderForm() + inboxList() + `<div class="row"><div class="grow"><div class="big">${open.length}</div><div class="mute">открыто</div></div>
      <div class="grow"><div class="big" style="color:${open.some((o) => o.needs_yes) ? 'var(--red)' : 'inherit'}">${open.filter((o) => o.needs_yes).length}</div><div class="mute">ждут твоего да</div></div></div>
    <ul style="margin-top:8px">${open.map(line).join('') || '<li class="mute">Открытых поручений нет</li>'}</ul>
    ${closed.length ? `<details><summary class="mute">Закрыто за 7 дней: ${closed.length}</summary><ul>${closed.map((o) => `<li><div>${esc(o.body)}</div><div class="mute">${esc(o.status)}</div>${o.result ? `<div class="answer">${linkify(o.result)}</div>` : ''}</li>`).join('')}</ul></details>` : ''}`;
};

R.stub = R.note = (m) => `<p class="mute">${esc((m.config || {}).text || '')}</p>`;

// ---------- вкладки ----------
const TABS = [['today', 'Сегодня', '🏠'], ['cal', 'Календарь', '📅'], ['orders', 'Поручения', '✉️'], ['mail', 'Почта', '📬']];
const tabOf = (kind) => (kind === 'calendar' ? 'cal' : kind === 'orders' ? 'orders' : kind === 'mail' ? 'mail' : 'today');
let tab = TABS.some((t) => t[0] === lsGet('pult.tab')) ? lsGet('pult.tab') : 'today';
function setTab(t) { tab = t; lsSet('pult.tab', t); closeSheet(); renderBoard(); window.scrollTo(0, 0); }

function renderBoard() {
  const all = (state.layout?.modules || []).filter((m) => m.enabled !== false);
  const mods = all.filter((m) => tabOf(m.kind) === tab);
  $('board').innerHTML = mods.map((m) => {
    let body;
    try { body = (R[m.kind] || (() => `<p class="mute">Вид панели «${esc(m.kind)}» эта версия пульта не знает.</p>`))(m); }
    catch (e) { body = `<div class="banner red">Панель не отрисовалась: ${esc(e.message)}</div>`; }
    return `<div class="card" data-mod="${esc(m.key)}"><h2>${esc(m.title)}</h2>${body}</div>`;
  }).join('') || `<div class="card mute">${all.length ? 'На этой вкладке панелей нет. Включить: «Панели».' : 'Все панели скрыты. Нажми «Панели».'}</div>`;
  if (tab === 'today' && pkOK && !lsGet('pult.pk')) $('board').insertAdjacentHTML('afterbegin', `<div class="card"><h2>Вход по Face ID</h2>
    <p class="mute">Если пульт когда-нибудь попросит войти, хватит взгляда вместо пароля.</p>
    <p class="row"><button data-act="pk-on">Включить Face ID</button><button class="ghost" data-act="pk-later">Не сейчас</button></p></div>`);
  const yes = (state.orders || []).filter((o) => !o.closed_at && o.needs_yes).length;
  $('tabs').innerHTML = TABS.map(([k, l, i]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}"><b>${i}</b>${l}${k === 'orders' && yes ? `<span class="badge">${yes}</span>` : ''}</button>`).join('');
  $('offline').classList.toggle('hidden', !state.offline);
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-tab], [data-tab-go]');
  if (b) setTab(b.dataset.tab || b.dataset.tabGo);
});

// ---------- шторка снизу: правка напоминания, встреча ----------
function openSheet(html) {
  $('sheet').innerHTML = `<div class="dim" data-act="sheet-close"></div><div class="sheet-box" role="dialog"><div class="grab"></div>${html}</div>`;
  $('sheet').classList.remove('hidden');
  document.body.classList.add('noscroll');
}
function closeSheet() { $('sheet').classList.add('hidden'); $('sheet').innerHTML = ''; document.body.classList.remove('noscroll'); }
document.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="sheet-close"]')) closeSheet(); });

// Быстрые варианты срока: считаются по Омску
function dueChips() {
  const now = Date.now(), today = today0(), tom = tomorrow0(), h = omskHour();
  const out = [['Через час', new Date(Math.ceil((now + 36e5) / 3e5) * 3e5).toISOString()]];
  if (h < 18.5) out.push(['Сегодня 19:00', at(today, 19)]);
  out.push(['Завтра 09:00', at(tom, 9)]);
  const sat = new Date(today + 'T12:00:00+06:00'); const add = (6 - sat.getUTCDay() + 7) % 7 || 7;
  out.push([dayTitle(dayKey(new Date(sat.getTime() + add * 864e5))).replace(/,.*/, '') + ' 09:00', at(dayKey(new Date(sat.getTime() + add * 864e5)), 9)]);
  return out;
}
function taskSheet(t, preset = {}) {
  const due = t ? t.due_at : preset.due ?? null;
  const chips = dueChips().map(([l, v]) => `<button type="button" class="chip${due === v ? ' on' : ''}" data-due="${v}">${esc(l)}</button>`).join('')
    + `<button type="button" class="chip${due ? '' : ' on'}" data-due="">Без срока</button>`;
  openSheet(`<form data-form="task-edit" data-id="${t ? t.id : ''}">
    <div class="row" style="margin-bottom:10px"><b class="grow" style="font-size:18px">${t ? 'Напоминание' : 'Новое напоминание'}</b><button type="button" class="ghost small" data-act="sheet-close">Отмена</button></div>
    <p><input name="title" maxlength="300" required placeholder="Что напомнить" value="${esc(t ? t.title : preset.title || '')}"></p>
    <div class="mute">Когда</div><div class="chips">${chips}</div>
    <p><input type="datetime-local" name="due" value="${due ? toLocal(due) : ''}" aria-label="Дата и время"></p>
    <div class="mute">Важность</div><div class="chips"><button type="button" class="chip${(t ? t.priority : 2) !== 1 ? ' on' : ''}" data-prio="2">Обычное</button><button type="button" class="chip${t && t.priority === 1 ? ' on' : ''}" data-prio="1">❗ Важное</button></div>
    <input type="hidden" name="priority" value="${t ? t.priority : 2}">
    <p><textarea name="note" rows="2" maxlength="2000" placeholder="Заметка">${esc(t?.note || '')}</textarea></p>
    <div class="btns">${t ? `<button type="button" class="ghost danger" data-act="archive" data-id="${t.id}">В архив</button>` : ''}<button>Сохранить</button></div>
    ${t ? '<p class="mute">В архив, а не удалить: вернуть можно в «Календарь → Напоминания → Архив».</p>' : ''}</form>`);
}
document.addEventListener('click', (ev) => {
  const f = ev.target.closest('[data-form="task-edit"]');
  if (!f) return;
  const d = ev.target.closest('[data-due]'), p = ev.target.closest('[data-prio]');
  if (d) { f.due.value = d.dataset.due ? toLocal(d.dataset.due) : ''; f.querySelectorAll('[data-due]').forEach((x) => x.classList.toggle('on', x === d)); }
  if (p) { f.priority.value = p.dataset.prio; f.querySelectorAll('[data-prio]').forEach((x) => x.classList.toggle('on', x === p)); }
});
document.addEventListener('input', (ev) => {
  const f = ev.target.closest('[data-form="task-edit"]');
  if (f && ev.target.name === 'due') f.querySelectorAll('[data-due]').forEach((x) => x.classList.remove('on'));
});
document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('[data-form="task-edit"]');
  if (!f) return;
  ev.preventDefault();
  const row = { title: f.title.value.trim(), due_at: fromLocal(f.due.value), priority: Number(f.priority.value) === 1 ? 1 : 2, note: f.note.value.trim() || null };
  if (!row.title) return;
  const b = f.querySelector('button:not([type])'); b.disabled = true;
  const { error } = f.dataset.id ? await sb.from('pult_tasks').update(row).eq('id', f.dataset.id) : await sb.from('pult_tasks').insert(row);
  b.disabled = false;
  if (error) return alert('Не сохранилось: ' + error.message);
  closeSheet(); await refresh();
});

function meetSheet(e) {
  const k = evKey(e), mk = state.marks?.[k], started = new Date(e.start) <= new Date();
  const marks = mk ? `<button class="ghost" data-unmark="${esc(k)}">Снять отметку «${esc(mk)}»</button>`
    : started ? `<button class="ghost" data-mark="прошла" data-k="${esc(k)}">✓ Прошла</button><button class="ghost" data-mark="не было" data-k="${esc(k)}">✕ Не было</button>` : '';
  openSheet(`<div class="row" style="margin-bottom:6px"><b class="grow" style="font-size:18px">${esc(e.title)}</b><button class="ghost small" data-act="sheet-close">Закрыть</button></div>
    <div class="mute" style="margin-bottom:12px">${esc(dayTitle(evDay(e)))} · ${esc(evTime(e))}${e.recurring ? ' · повторяется' : ''}</div>
    ${marks ? `<div class="btns">${marks}</div>` : ''}
    ${isGoogleLink(e.link) ? `<p><a class="btn" href="${esc(e.link)}" target="_blank" rel="noopener">Изменить в Google Календаре ›</a></p>` : ''}
    <p><button class="ghost" style="width:100%" data-act="move-order" data-k="${esc(k)}">Перенести… (поручение ассистенту)</button></p>
    <p class="mute">Встреча правится в Google Календаре: так она одна и везде одинаковая. Пульт подтянет изменение при следующем обновлении.</p>`);
}
function gRemSheet(e) {
  const k = evKey(e), mk = state.marks?.[k];
  openSheet(`<div class="row" style="margin-bottom:6px"><b class="grow" style="font-size:18px">${esc(e.title)}</b><button class="ghost small" data-act="sheet-close">Закрыть</button></div>
    <div class="mute" style="margin-bottom:12px">${esc(dayTitle(evDay(e)))} · ${e.all_day ? 'весь день' : esc(hhmm(new Date(e.start)))} · из Google Календаря</div>
    <div class="btns">${mk ? `<button class="ghost" data-unmark="${esc(k)}">Вернуть в список</button>` : `<button class="ghost" data-mark="прошла" data-k="${esc(k)}">✓ Сделано</button>`}</div>
    ${isGoogleLink(e.link) ? `<p><a class="btn" href="${esc(e.link)}" target="_blank" rel="noopener">Изменить в Google Календаре ›</a></p>` : ''}
    <p class="mute">Это напоминание пока записано в Google Календаре. После переноса в Ассистент его можно будет менять прямо здесь.</p>`);
}
document.addEventListener('click', (ev) => {
  if (ev.target.closest('.swipe.open .acts, [data-act], button, a, input, textarea')) {
    const ed = ev.target.closest('[data-act="edit"]');
    if (ed && ed.closest('[data-task]') && !wasSwipe) { const t = state.tasks.find((x) => String(x.id) === ed.closest('[data-task]').dataset.task); closeSwipes(); if (t) taskSheet(t); }
    const nw = ev.target.closest('[data-act="new-on"]');
    if (nw) taskSheet(null, { due: at(nw.dataset.day, 9) });
    const mv = ev.target.closest('[data-act="move-order"]');
    if (mv) { const e = evIndex.get(mv.dataset.k); orderDraft = `Перенести встречу «${e.title}» (${dayTitle(evDay(e))}, ${evTime(e)}) на `; closeSheet(); setTab('orders'); setTimeout(() => { const ta = orderTA(); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 50); }
    return;
  }
  const m = ev.target.closest('[data-ev]'), g = ev.target.closest('[data-gev]');
  if (m && evIndex.get(m.dataset.ev)) meetSheet(evIndex.get(m.dataset.ev));
  if (g && evIndex.get(g.dataset.gev)) gRemSheet(evIndex.get(g.dataset.gev));
});

// ---------- отметки встреч ----------
document.addEventListener('click', async (ev) => {
  const mk = ev.target.closest('[data-mark]'), un = ev.target.closest('[data-unmark]');
  if (!mk && !un) return;
  const k = (mk || un).dataset[mk ? 'k' : 'unmark'], prev = state.marks[k];
  if (mk) {
    const e = evIndex.get(k);
    state.marks[k] = mk.dataset.mark; closeSheet(); renderBoard();
    const { error } = await sb.from('pult_event_marks').upsert({ event_key: k, title: e.title.slice(0, 300), start_at: e.start, mark: mk.dataset.mark });
    if (error) { state.marks[k] = prev; renderBoard(); alert('Отметка не сохранилась: ' + error.message); }
  } else {
    delete state.marks[k]; closeSheet(); renderBoard();
    const { error } = await sb.from('pult_event_marks').delete().eq('event_key', k);
    if (error) { state.marks[k] = prev; renderBoard(); alert('Не снялось: ' + error.message); }
  }
});

// ---------- поручения ассистенту ----------
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-order-done]');
  if (!b) return;
  const o = state.orders.find((x) => x.id === Number(b.dataset.orderDone));
  if (!o || !confirm('Отметить сделанным: «' + o.body.slice(0, 80) + '»?')) return;
  const { error } = await sb.from('asst_orders').update({ status: 'сделано' }).eq('id', o.id).is('closed_at', null);
  if (error) return alert('Не отметилось: ' + error.message);
  await refresh();
});
document.addEventListener('input', (ev) => { if (ev.target.closest('[data-form="order"]')) orderDraft = ev.target.value; });
document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('[data-form="order"]');
  if (!f) return;
  ev.preventDefault();
  const body = f.body.value.trim();
  if (!body) return;
  const b = f.querySelector('button:not([type])'); b.disabled = true;
  const { error } = await sb.from('pult_inbox').insert({ body, via: orderVia });
  b.disabled = false;
  if (error) return alert('Поручение не ушло: ' + error.message);
  orderDraft = ''; orderVia = 'текст';
  await refresh();
});
let rec = null;
// iPhone: Web Speech в приложении с экрана «Домой» работает ненадёжно (молча гаснет),
// а клавиатуру можно открыть только прямо в нажатии. Поэтому на iPhone - диктовка клавиатуры.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const orderTA = () => $('board').querySelector('[data-form="order"] textarea');
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('[data-act="mic"]')) return;
  const ta = orderTA(), msg = $('micMsg');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const keyboard = () => { orderVia = 'голос'; ta.focus(); msg.textContent = 'Клавиатура открыта: нажми 🎤 справа внизу клавиатуры и говори. Потом «Поручить». Нет 🎤 - включи «Диктовку»: Настройки → Основные → Клавиатура.'; };
  if (rec) { rec.stop(); return; }
  if (isIOS || !SR) return keyboard(); // синхронно, в том же нажатии: иначе iOS не покажет клавиатуру
  const base = ta.value ? ta.value.trim() + ' ' : '';
  let heard = false;
  rec = new SR(); rec.lang = 'ru-RU'; rec.interimResults = true; rec.continuous = true;
  rec.onresult = (e) => { heard = true; const t = orderTA(); if (!t) return; t.value = base + Array.from(e.results).map((r) => r[0].transcript).join(''); orderDraft = t.value; orderVia = 'голос'; };
  rec.onerror = (e) => { if (e.error === 'aborted') return; const m = $('micMsg'); if (m) m.textContent = e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Микрофон не разрешён браузером. Разреши микрофон для сайта или нажми в поле и диктуй с клавиатуры.' : e.error === 'no-speech' ? 'Не расслышал. Нажми «🎤 Голосом» и говори сразу.' : 'Голос не сработал (' + e.error + '). Нажми в поле и диктуй с клавиатуры.'; };
  rec.onend = () => { rec = null; const t = orderTA(), m = $('micMsg'); if (m && heard) m.textContent = t && t.value ? 'Проверь текст и нажми «Поручить».' : ''; };
  try { rec.start(); msg.textContent = 'Слушаю. Нажми «🎤 Голосом» ещё раз, чтобы закончить.'; } catch { rec = null; keyboard(); }
});

// ---------- напоминания: сделано, завтра, архив ----------
async function taskUpdate(id, row, okMsg) {
  const { error } = await sb.from('pult_tasks').update(row).eq('id', id);
  if (error) return alert('Не сохранилось: ' + error.message);
  closeSheet(); await refresh();
}
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act="done"], [data-act="tomorrow"], [data-act="archive"], [data-unarchive]');
  if (!b) return;
  if (b.dataset.unarchive) return taskUpdate(b.dataset.unarchive, { archived_at: null });
  const id = b.dataset.id || b.closest('[data-task]')?.dataset.task;
  const t = state.tasks.find((x) => String(x.id) === String(id));
  if (!t) return;
  if (b.dataset.act === 'done') return taskUpdate(id, { done_at: t.done_at ? null : new Date().toISOString() });
  if (b.dataset.act === 'tomorrow') {
    const base = t.due_at ? new Date(t.due_at) : null;
    const hm = base ? hhmm(base).split(':').map(Number) : [9, 0];
    return taskUpdate(id, { due_at: at(dayKey(new Date(Math.max(Date.now(), base ? base.getTime() : 0) + 864e5)), hm[0], hm[1]) });
  }
  if (b.dataset.act === 'archive') return taskUpdate(id, { archived_at: new Date().toISOString() });
});
// Быстрое добавление на «Сегодня»: текст сразу, время выбирается в шторке
document.addEventListener('submit', (ev) => {
  const f = ev.target.closest('[data-form="quick"]');
  if (!f) return;
  ev.preventDefault();
  const title = f.title.value.trim();
  if (!title) return;
  f.title.value = '';
  f.title.blur();
  taskSheet(null, { title, due: null });
});

// ---------- смахивания ----------
// Строка напоминания влево: Завтра / Изменить / В архив. Календарь влево-вправо: Встречи <-> Напоминания.
let sw = null, wasSwipe = false;
const closeSwipes = (except) => document.querySelectorAll('.swipe.open').forEach((x) => { if (x !== except) x.classList.remove('open'); });
document.addEventListener('touchstart', (ev) => {
  const row = ev.target.closest('.swipe'), cal = ev.target.closest('[data-swipe-cal]');
  if (!row && !cal) { closeSwipes(); return; }
  const p = ev.touches[0];
  sw = { row, cal, x: p.clientX, y: p.clientY, dx: 0, lock: null };
  wasSwipe = false;
}, { passive: true });
document.addEventListener('touchmove', (ev) => {
  if (!sw) return;
  const p = ev.touches[0];
  sw.dx = p.clientX - sw.x;
  const dy = p.clientY - sw.y;
  if (!sw.lock && (Math.abs(sw.dx) > 10 || Math.abs(dy) > 10)) sw.lock = Math.abs(sw.dx) > Math.abs(dy) ? 'x' : 'y';
  if (sw.lock === 'x' && sw.row) {
    const base = sw.row.classList.contains('open') ? -210 : 0;
    sw.row.querySelector('.front').style.transform = `translateX(${Math.min(0, Math.max(-230, base + sw.dx))}px)`;
  }
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!sw) return;
  const s = sw; sw = null;
  if (s.lock !== 'x') return;
  wasSwipe = true; setTimeout(() => { wasSwipe = false; }, 350);
  if (s.row) {
    s.row.querySelector('.front').style.transform = '';
    const open = s.row.classList.contains('open') ? s.dx < 60 : s.dx < -60;
    closeSwipes(s.row);
    s.row.classList.toggle('open', open);
  } else if (s.cal && Math.abs(s.dx) > 60) {
    setCalMode(s.dx < 0 ? 'r' : 'm');
  }
});

// ---------- уведомления ----------
const b64ToBytes = (b) => Uint8Array.from(atob((b + '='.repeat((4 - (b.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function pushCall(action, body) {
  const { data, error } = await sb.functions.invoke('pult-push?action=' + action, body ? { method: 'POST', body } : { method: 'GET' });
  if (error || data?.error) throw new Error(data?.error || error.message);
  return data;
}
document.addEventListener('click', async (ev) => {
  const on = ev.target.closest('[data-act="push-on"]'), test = ev.target.closest('[data-act="push-test"]');
  if (!on && !test) return;
  try {
    if (test) { const r = await pushCall('test', {}); alert(r.sent ? 'Отправлено, жди уведомление' : 'Подписок нет, включи уведомления заново'); return; }
    if ((await Notification.requestPermission()) !== 'granted') return alert('Уведомления не разрешены. Разреши их в Настройках iPhone для «Пульт».');
    const { key } = await pushCall('key');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
    await pushCall('subscribe', sub.toJSON());
    try { localStorage.setItem('pult.push', '1'); } catch { /* приватный режим */ }
    await pushCall('test', {});
    renderBoard();
  } catch (e) { alert('Не получилось включить уведомления: ' + e.message); }
});

// ---------- вход по Face ID (passkey) ----------
// Ключ Face ID хранится в связке ключей iCloud, поэтому работает и в Safari, и в значке «Домой».
const pkOK = !!window.PublicKeyCredential;
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pk = { auth: null, reg: null }; // заранее полученные вызовы: Safari ждёт Face ID сразу после нажатия
async function pkCall(action, body) {
  const { data, error } = await sb.functions.invoke('pult-passkey?action=' + action, body ? { method: 'POST', body } : { method: 'GET' });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch { /* без тела */ } throw new Error(m); }
  if (data?.error) throw new Error(data.error);
  return data;
}
const pkFresh = (x) => x && Date.now() - x.at < 4 * 6e4;
async function pkPrefetch(kind) {
  if (!pkOK || !navigator.onLine) return;
  try { pk[kind] = { o: await pkCall(kind + '-options'), at: Date.now() }; } catch { pk[kind] = null; }
}
const pkIds = (list) => (list || []).map((c) => ({ ...c, id: b64ToBytes(c.id) }));
function credJSON(c) {
  const r = c.response;
  const out = { id: c.id, rawId: bufToB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults?.() || {},
    authenticatorAttachment: c.authenticatorAttachment || undefined, response: { clientDataJSON: bufToB64u(r.clientDataJSON) } };
  if (r.attestationObject) { out.response.attestationObject = bufToB64u(r.attestationObject); out.response.transports = r.getTransports?.() || []; }
  else {
    out.response.authenticatorData = bufToB64u(r.authenticatorData);
    out.response.signature = bufToB64u(r.signature);
    if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle);
  }
  return out;
}
const pkDevice = () => /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'устройство';
async function pkRegister() {
  const o = pkFresh(pk.reg) ? pk.reg.o : await pkCall('reg-options');
  pk.reg = null;
  const c = await navigator.credentials.create({ publicKey: { ...o, challenge: b64ToBytes(o.challenge),
    user: { ...o.user, id: b64ToBytes(o.user.id) }, excludeCredentials: pkIds(o.excludeCredentials) } });
  await pkCall('reg-verify', { credential: credJSON(c), device: pkDevice() });
  lsSet('pult.pk', '1');
}
async function pkLogin() {
  const o = pkFresh(pk.auth) ? pk.auth.o : await pkCall('auth-options');
  pk.auth = null;
  const c = await navigator.credentials.get({ publicKey: { ...o, challenge: b64ToBytes(o.challenge), allowCredentials: pkIds(o.allowCredentials) } });
  const { token_hash } = await pkCall('auth-verify', credJSON(c));
  const { error } = await sb.auth.verifyOtp({ token_hash, type: 'magiclink' });
  if (error) throw new Error(error.message);
  lsSet('pult.pk', '1');
}
const pkErr = (e) => e?.name === 'NotAllowedError' ? 'Face ID отменён или не сработал.'
  : e?.name === 'InvalidStateError' ? 'На этом устройстве Face ID для пульта уже включён.' : 'Не вышло: ' + (e?.message || e);
document.addEventListener('click', async (ev) => {
  const on = ev.target.closest('[data-act="pk-on"]'), later = ev.target.closest('[data-act="pk-later"]');
  if (later) { lsSet('pult.pk', 'later'); renderBoard(); return; }
  if (!on) return;
  try { await pkRegister(); alert('Готово: Face ID включён. Пароль остаётся запасным.'); }
  catch (e) { if (e?.name === 'InvalidStateError') lsSet('pult.pk', '1'); alert(pkErr(e)); pkPrefetch('reg'); }
  renderBoard();
});
$('btnPkReg').onclick = async () => {
  try { await pkRegister(); $('pkInfo').textContent = 'Face ID включён на этом устройстве.'; }
  catch (e) { $('pkInfo').textContent = pkErr(e); pkPrefetch('reg'); }
};
$('btnPasskey').onclick = async () => {
  $('loginMsg').textContent = 'Жду Face ID...';
  try { await pkLogin(); $('loginMsg').textContent = ''; await start(); }
  catch (e) { $('loginMsg').textContent = pkErr(e) + ' Можно войти паролем.'; pkPrefetch('auth'); }
};

// ---------- подписка календаря iPhone (функция pult-export) ----------
// Ссылки содержат секретный токен: не храним и не показываем, только открываем
async function calLinks(action) {
  const { data, error } = await sb.functions.invoke('pult-export?action=' + action, { method: 'POST', body: {} });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch { /* без тела */ } throw new Error(m); }
  if (!data?.webcal) throw new Error(data?.error || 'нет ссылки');
  return data;
}
$('btnCal').onclick = async () => {
  $('calInfo').textContent = 'Открываю подписку...';
  try { location.href = (await calLinks('links')).webcal; $('calInfo').textContent = 'iPhone предложит «Подписаться». Нажми его.'; }
  catch (e) { $('calInfo').textContent = 'Не вышло: ' + e.message; }
};
$('btnCalRotate').onclick = async () => {
  if (!confirm('Старая ссылка перестанет работать, подписку придётся сделать заново. Сменить?')) return;
  try { await calLinks('rotate'); $('calInfo').textContent = 'Ссылка сменена. Удали старую подписку в настройках iPhone и нажми «Подписать календарь iPhone».'; }
  catch (e) { $('calInfo').textContent = 'Не вышло: ' + e.message; }
};

// ---------- Команда iPhone: ссылки с ключом (показываем, не храним) ----------
$('btnPhone').onclick = async () => {
  if (!$('phoneLinks').classList.contains('hidden') || lsGet('pult.phoneLink')) {
    if (!confirm('Старые ссылки в Команде перестанут работать, их надо будет заменить. Выдать новые?')) return;
  }
  $('phoneInfo').textContent = 'Получаю...';
  try {
    const { data, error } = await sb.functions.invoke('pult-export?action=iphone-link', { method: 'POST', body: {} });
    if (error || !data?.get) throw new Error(data?.error || error?.message || 'нет ссылки');
    $('phoneGet').value = data.get; $('phoneDone').value = data.done;
    $('phoneLinks').classList.remove('hidden'); lsSet('pult.phoneLink', '1');
    $('phoneInfo').textContent = 'Готово. Скопируй по очереди и вставь в Команду.';
  } catch (e) { $('phoneInfo').textContent = 'Не вышло: ' + e.message; }
};
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-copy]');
  if (!b) return;
  const i = $(b.dataset.copy);
  try { await navigator.clipboard.writeText(i.value); b.textContent = 'Скопировано'; }
  catch { i.select(); b.textContent = 'Выдели и скопируй'; }
});

// ---------- настройка панелей ----------
let draft = [];
function renderSettings() {
  $('modList').innerHTML = draft.map((m, i) => `<li class="row" data-i="${i}">
      <input type="checkbox" ${m.enabled !== false ? 'checked' : ''} data-s="toggle" style="width:auto" aria-label="Показывать">
      <div class="grow">${esc(m.title)} <span class="mute">${esc(m.kind)}</span></div>
      <button class="ghost small" data-s="up" aria-label="Выше">↑</button>
      <button class="ghost small" data-s="down" aria-label="Ниже">↓</button>
      <button class="ghost small" data-s="del" aria-label="Убрать">✕</button></li>`).join('');
  $('verList').innerHTML = state.versions.map((v) => `<li class="row"><div class="grow">v${v.version} · ${esc(v.note)}<div class="mute">${new Date(v.created_at).toLocaleString('ru-RU', { timeZone: CFG.tz })}</div></div>
      ${v.version === state.layout.version ? '<span class="mute">сейчас</span>' : `<button class="ghost small" data-v="${v.version}">Вернуть</button>`}</li>`).join('');
  $('appVer').textContent = 'Версия пульта ' + CFG.version;
}
$('modList').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-s]');
  if (!b) return;
  const i = Number(b.closest('[data-i]').dataset.i);
  const s = b.dataset.s;
  if (s === 'toggle') draft[i].enabled = b.checked;
  if (s === 'up' && i > 0) [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]];
  if (s === 'down' && i < draft.length - 1) [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]];
  if (s === 'del' && confirm('Убрать панель «' + draft[i].title + '»? Вернуть можно через версии.')) draft.splice(i, 1);
  renderSettings();
});
$('btnAddModule').onclick = () => {
  const kind = $('newKind').value, title = $('newTitle').value.trim(), p = $('newParam').value.trim();
  if (!title) return alert('Дай панели название');
  const key = kind + '_' + Date.now().toString(36);
  draft.push({ key, title, kind, source: kind === 'events' ? 'calendar' : 'text', enabled: true, config: kind === 'events' ? { match: p, days: 7 } : { text: p } });
  $('newTitle').value = $('newParam').value = '';
  renderSettings();
};
$('btnSaveLayout').onclick = async () => {
  const note = prompt('Что поменял (для списка версий)?', 'правка панелей');
  if (note === null) return;
  const { error } = await sb.rpc('pult_layout_save', { p_modules: draft, p_note: note || 'правка панелей' });
  if (error) return alert('Не сохранилось: ' + error.message);
  await refresh();
  openSettings();
};
$('verList').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-v]');
  if (!b || !confirm('Вернуть раскладку версии ' + b.dataset.v + '?')) return;
  const { error } = await sb.rpc('pult_layout_rollback', { p_version: Number(b.dataset.v) });
  if (error) return alert('Не получилось: ' + error.message);
  await refresh();
  openSettings();
});
function openSettings() {
  pkPrefetch('reg');
  if (pkOK) pkCall('count').then((r) => { $('pkInfo').textContent = r.count ? `Face ID включён на устройствах: ${r.count}.` : 'Face ID пока не включён.'; }).catch(() => {});
  draft = JSON.parse(JSON.stringify(state.layout?.modules || []));
  renderSettings();
  show('settings');
}
const closeSettings = () => { $('phoneGet').value = $('phoneDone').value = ''; $('phoneLinks').classList.add('hidden'); renderBoard(); show('board'); window.scrollTo(0, 0); };
$('btnSettings').onclick = () => ($('settings').classList.contains('hidden') ? openSettings() : closeSettings());
$('btnCloseSettings').onclick = closeSettings;
$('btnBack').onclick = closeSettings;
$('btnLogout').onclick = async () => { await sb.auth.signOut(); cache.set({}); show('login'); };

// ---------- вход ----------
function show(id) {
  for (const s of ['login', 'board', 'settings']) $(s).classList.toggle('hidden', s !== id);
  $('tabs').classList.toggle('hidden', id !== 'board');
  if (id !== 'board') closeSheet();
  // в шапке: «Панели» на главном экране, «Назад» в настройке панелей
  $('btnSettings').classList.toggle('hidden', id === 'login');
  $('btnSettings').textContent = id === 'settings' ? '← Назад' : 'Панели';
}
$('loginForm').onsubmit = async (ev) => {
  ev.preventDefault();
  $('loginMsg').textContent = 'Вхожу...';
  const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  if (error) { $('loginMsg').textContent = /confirm/i.test(error.message) ? 'Вход ещё не подтверждён. Напиши Архитектору: «подтверди вход в пульт».'
    : /invalid/i.test(error.message) ? 'Неверная почта или пароль. Если вход ещё не создан, нажми «Создать вход (один раз)».' : 'Не вышло: ' + error.message; return; }
  $('password').value = '';
  try { localStorage.setItem('pult.email', $('email').value.trim()); } catch {}
  await start();
};
try { const e = localStorage.getItem('pult.email'); if (e) $('email').value = e; } catch {}
$('pkRow').classList.toggle('hidden', !pkOK);
// iPhone: у значка на экране «Домой» своя память, вход из Safari туда не переходит
if (/iPhone|iPad/.test(navigator.userAgent)) $('loginMsg').textContent = navigator.standalone
  ? 'Войди здесь один раз: в значке вход запомнится и больше не спросится.'
  : 'Ты в Safari. Вход здесь не перейдёт в значок на экране «Домой». Открой пульт из значка и войди там один раз.';
$('btnSignup').onclick = async () => {
  const email = $('email').value.trim(), password = $('password').value;
  if (!email || password.length < 10) { $('loginMsg').textContent = 'Нужны почта и пароль не короче 10 знаков.'; return; }
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) {
    $('loginMsg').textContent = /database error|unexpected/i.test(error.message)
      ? 'Эта почта не разрешена. Вход создаётся только с почтой, которую Михаил назвал Архитектору.'
      : 'Не вышло: ' + error.message;
    return;
  }
  $('password').value = '';
  if (data.session) return start();
  $('loginMsg').textContent = 'Вход создан. Напиши Архитектору: «подтверди вход в пульт», потом нажми «Войти».';
};

async function refresh(bg = false) {
  try { await load(); } catch (e) { state.offline = true; console.error(e); }
  if (bg && (rec || document.activeElement === orderTA())) return; // фоновое обновление во время диктовки или ввод: не стираем поле перерисовкой
  renderBoard();
}

async function start() {
  const { data } = await sb.auth.getSession();
  const old = cache.get();
  if (!data.session) {
    if (old.state && !navigator.onLine) { state = old.state; state.offline = true; renderBoard(); show('board'); return; }
    show('login');
    pkPrefetch('auth');
    return;
  }
  if (pkOK && !lsGet('pult.pk')) pkPrefetch('reg');
  if (old.state) { state = { ...old.state, offline: false }; renderBoard(); }
  show('board');
  await refresh();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('board').classList.contains('hidden')) refresh(true); });
setInterval(() => { if (!document.hidden && !$('board').classList.contains('hidden')) refresh(true); }, 5 * 6e4);
if ('serviceWorker' in navigator) {
  const hadSW = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadSW && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}
start();
