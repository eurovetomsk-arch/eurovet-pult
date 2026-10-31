// Пульт Михаила V0. Экран собирается из реестра панелей (таблица pult_layout),
// поэтому новую панель известного вида добавляют данными, без правки этого файла.
'use strict';

const CFG = {
  url: 'https://ikxmzapfmgqnnrsttuxc.supabase.co',
  key: 'sb_publishable_T8ccLgWCaguS1EABck2d0A_-KnjFd9K', // публичный ключ, доступ режет RLS
  version: '0.5.0',
  tz: 'Asia/Omsk',
  nightFrom: 22.5, // снимок почты ночью не обновляется: 22:30-07:30 по Омску плашку не краснеем
  nightTo: 7.5,
};

const sb = supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } });
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- время по Омску ----------
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: CFG.tz }).format(d);
const hhmm = (d) => new Intl.DateTimeFormat('ru-RU', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit' }).format(d);
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

// ---------- кэш для офлайна ----------
const cache = {
  get() { try { return JSON.parse(localStorage.getItem('pult.cache') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('pult.cache', JSON.stringify(v)); } catch { /* нет места или приватный режим */ } },
};

let state = { layout: null, versions: [], tasks: [], mail: null, settings: null, cal: null, calError: null, orders: null, offline: false };

// ---------- загрузка ----------
async function load() {
  const old = cache.get();
  const since = new Date(Date.now() - 2 * 864e5).toISOString();
  const [lay, tasks, mail, set, cal, orders] = await Promise.all([
    sb.from('pult_layout').select('version,created_at,note,modules').order('version', { ascending: false }).limit(20),
    sb.from('pult_tasks').select('*').or(`done_at.is.null,done_at.gt.${since}`).order('due_at', { ascending: true, nullsFirst: false }),
    sb.from('pult_mail_snapshot').select('*').order('taken_at', { ascending: false }).limit(1),
    sb.from('pult_settings').select('stale_after_minutes').limit(1),
    sb.functions.invoke('pult-calendar?days=35', { method: 'GET' }).catch((e) => ({ error: e })),
    sb.from('asst_orders').select('id,created_at,body,route,status,due_at,result,needs_yes,closed_at')
      .or(`closed_at.is.null,closed_at.gt.${new Date(Date.now() - 7 * 864e5).toISOString()}`)
      .order('created_at', { ascending: false }).limit(100),
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
  if (cal.error || cal.data?.error) {
    state.calError = (cal.data && cal.data.error) || 'календарь не ответил';
    state.cal = old.state?.cal || null;
  } else {
    state.calError = null;
    state.cal = cal.data;
  }
  cache.set({ state: { ...state, offline: false }, at: new Date().toISOString() });
}

// ---------- панели ----------
const R = {};

R.today = (m) => {
  const today = dayKey(new Date());
  const evs = (state.cal?.events || []).filter((e) => evDay(e) === today);
  const due = state.tasks.filter((t) => !t.done_at && t.due_at && dayKey(new Date(t.due_at)) <= today);
  return `<div class="row"><div class="grow"><div class="big">${evs.length}</div><div class="mute">событий сегодня</div></div>
    <div class="grow"><div class="big" style="color:${due.length ? 'var(--red)' : 'inherit'}">${due.length}</div><div class="mute">дел на сегодня и просрочено</div></div>
    <div class="grow"><div class="big">${state.mail ? state.mail.reply_count : '-'}</div><div class="mute">писем ответить</div></div></div>
    ${evs.length ? '<ul style="margin-top:10px">' + evs.map((e) => `<li><b>${esc(evTime(e))}</b> ${esc(e.title)}</li>`).join('') + '</ul>' : ''}`;
};

function urgency(t) {
  if (t.done_at || !t.due_at) return '';
  const k = dayKey(new Date(t.due_at)), today = dayKey(new Date());
  if (k < today) return '<span class="tag red">просрочено</span>';
  if (k === today) return '<span class="tag org">сегодня</span>';
  if (k === dayKey(new Date(Date.now() + 864e5))) return '<span class="tag org">завтра</span>';
  return '';
}

// Время напоминания вводится и показывается по Омску (UTC+6, без перехода на летнее время)
const toLocal = (iso) => new Date(new Date(iso).getTime() + 6 * 36e5).toISOString().slice(0, 16);
const fromLocal = (v) => (v ? new Date(v + ':00+06:00').toISOString() : null);

function pushHint() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return '<div class="banner org">Уведомления: открой пульт с иконки на экране «Домой» (Safari: Поделиться - На экран Домой).</div>';
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem('pult.push') === '1') {
    return '<p class="mute">Уведомления включены. <button class="ghost small" data-act="push-test">Проверить</button></p>';
  }
  return '<p><button class="ghost" data-act="push-on">Включить уведомления</button></p>';
}

R.tasks = (m) => {
  const items = state.tasks.map((t) => `<li class="row" data-task="${t.id}">
      <button class="chk" data-act="done" aria-label="Сделано">${t.done_at ? '✓' : ''}</button>
      <div class="grow"><div class="${t.done_at ? 'done' : ''}">${esc(t.title)}${urgency(t)}</div>
        <div class="mute">${t.due_at ? esc(dayTitle(dayKey(new Date(t.due_at)))) + ', ' + hhmm(new Date(t.due_at)) + (t.reminded_at ? ' · уведомлено' : '') : 'без срока'}</div></div>
      ${t.done_at ? '' : `<input type="datetime-local" class="small" data-act="move" value="${t.due_at ? toLocal(t.due_at) : ''}" style="width:190px" aria-label="Перенести">`}
    </li>`).join('');
  return `${pushHint()}<form data-form="task"><p><input name="title" placeholder="Новое напоминание" maxlength="300" required></p>
      <p class="row"><input type="datetime-local" name="due" class="grow" aria-label="Когда напомнить"><button>Добавить</button></p></form>
    <ul style="margin-top:8px">${items || '<li class="mute">Напоминаний нет</li>'}</ul>`;
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

function grouped(evs, empty) {
  if (!state.cal) return `<div class="banner org">Календарь ещё не загружен${state.calError ? ': ' + esc(state.calError) : ''}.</div>`;
  if (state.cal.configured === false) return '<div class="banner org">Календарь не подключён: нет секретной ссылки iCal.</div>';
  const by = {};
  for (const e of evs) (by[evDay(e)] ||= []).push(e);
  const keys = Object.keys(by).sort();
  const warn = state.calError ? `<div class="banner org">Показаны сохранённые данные от ${hhmm(new Date(state.cal.fetched_at))}: ${esc(state.calError)}</div>` : '';
  if (!keys.length) return warn + `<p class="mute">${empty}</p>`;
  return warn + keys.map((k) => `<div class="day">${esc(dayTitle(k))}</div><ul>${by[k].map((e) => `<li><b>${esc(evTime(e))}</b> ${esc(e.title)}</li>`).join('')}</ul>`).join('')
    + `<p class="mute">данные от ${hhmm(new Date(state.cal.fetched_at))}</p>`;
}

function window7(days) {
  const today = dayKey(new Date());
  const end = dayKey(new Date(Date.now() + (days - 1) * 864e5));
  return (state.cal?.events || []).filter((e) => { const k = evDay(e); return k >= today && k <= end; });
}

R.events = (m) => {
  const c = m.config || {};
  const word = (c.match || '').toLowerCase();
  const evs = window7(c.days || 7).filter((e) => !word || e.title.toLowerCase().includes(word));
  return grouped(evs, word ? `Нет событий со словом «${esc(c.match)}»` : 'Событий нет');
};

R.shifts = (m) => {
  const word = ((m.config || {}).match || 'Смена').toLowerCase();
  const evs = window7(7).filter((e) => e.title.toLowerCase().includes(word));
  const ready = state.cal && state.cal.configured !== false;
  return (ready ? `<div class="big">${evs.length}</div><div class="mute">смен за 7 дней</div>` : '') + grouped(evs, 'Смен нет');
};

// Календарь сеткой: 5 недель с понедельника текущей, нажатие на день показывает его события
let calDay = null;
R.calendar = (m) => {
  if (!state.cal || state.cal.configured === false) return grouped([], '');
  const today = dayKey(new Date());
  const t = new Date(today + 'T12:00:00+06:00');
  const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 864e5);
  const by = {};
  for (const e of state.cal.events) (by[evDay(e)] ||= []).push(e);
  const sel = calDay || today;
  let cells = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d) => `<div class="cal-h">${d}</div>`).join('');
  for (let i = 0; i < 35; i++) {
    const k = dayKey(new Date(monday.getTime() + i * 864e5));
    const n = (by[k] || []).length;
    const cls = ['cal-d', k === today ? 'cal-today' : '', k === sel ? 'cal-sel' : '', k < today ? 'cal-past' : ''].join(' ');
    cells += `<button class="${cls}" data-day="${k}"><span>${Number(k.slice(8))}</span>${n ? `<i>${n > 3 ? '•••' : '•'.repeat(n)}</i>` : ''}</button>`;
  }
  const list = by[sel] || [];
  return `<div class="cal">${cells}</div><div class="day">${esc(dayTitle(sel))}</div>
    <ul>${list.map((e) => `<li><b>${esc(evTime(e))}</b> ${esc(e.title)}</li>`).join('') || '<li class="mute">Событий нет</li>'}</ul>
    <p class="mute">данные от ${hhmm(new Date(state.cal.fetched_at))}</p>`;
};
$('board').addEventListener('click', (ev) => {
  const d = ev.target.closest('[data-day]');
  if (!d) return;
  calDay = d.dataset.day;
  renderBoard();
});

// Поручения ассистента (таблица asst_orders, пишет только ассистент)
R.orders = (m) => {
  if (!state.orders) return '<p class="mute">Журнал поручений пока недоступен.</p>';
  const open = state.orders.filter((o) => !o.closed_at).sort((a, b) => (b.needs_yes - a.needs_yes) || String(a.due_at || '9').localeCompare(String(b.due_at || '9')));
  const closed = state.orders.filter((o) => o.closed_at);
  const line = (o) => `<li><div class="row"><div class="grow" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(o.body)}</div>${o.needs_yes ? '<span class="tag red">нужно твоё да</span>' : ''}</div>
      <div class="mute">${esc(o.route)} · ${esc(o.status)}${o.due_at ? ' · до ' + esc(dayTitle(dayKey(new Date(o.due_at)))) + ' ' + hhmm(new Date(o.due_at)) : ''}</div></li>`;
  return `<div class="row"><div class="grow"><div class="big">${open.length}</div><div class="mute">открыто</div></div>
      <div class="grow"><div class="big" style="color:${open.some((o) => o.needs_yes) ? 'var(--red)' : 'inherit'}">${open.filter((o) => o.needs_yes).length}</div><div class="mute">ждут твоего да</div></div></div>
    <ul style="margin-top:8px">${open.map(line).join('') || '<li class="mute">Открытых поручений нет</li>'}</ul>
    ${closed.length ? `<details><summary class="mute">Закрыто за 7 дней: ${closed.length}</summary><ul>${closed.map((o) => `<li><div>${esc(o.body)}</div><div class="mute">${esc(o.status)}${o.result ? ' · ' + esc(o.result) : ''}</div></li>`).join('')}</ul></details>` : ''}`;
};

R.stub = R.note = (m) => `<p class="mute">${esc((m.config || {}).text || '')}</p>`;

function renderBoard() {
  const mods = (state.layout?.modules || []).filter((m) => m.enabled !== false);
  $('board').innerHTML = mods.map((m) => {
    let body;
    try { body = (R[m.kind] || (() => `<p class="mute">Вид панели «${esc(m.kind)}» эта версия пульта не знает.</p>`))(m); }
    catch (e) { body = `<div class="banner red">Панель не отрисовалась: ${esc(e.message)}</div>`; }
    return `<div class="card" data-mod="${esc(m.key)}"><h2>${esc(m.title)}</h2>${body}</div>`;
  }).join('') || '<div class="card mute">Все панели скрыты. Нажми «Панели».</div>';
  if (pkOK && !lsGet('pult.pk')) $('board').insertAdjacentHTML('afterbegin', `<div class="card"><h2>Вход по Face ID</h2>
    <p class="mute">Если пульт когда-нибудь попросит войти, хватит взгляда вместо пароля.</p>
    <p class="row"><button data-act="pk-on">Включить Face ID</button><button class="ghost" data-act="pk-later">Не сейчас</button></p></div>`);
  $('offline').classList.toggle('hidden', !state.offline);
}

// ---------- дела ----------
$('board').addEventListener('submit', async (ev) => {
  const f = ev.target.closest('[data-form="task"]');
  if (!f) return;
  ev.preventDefault();
  const title = f.title.value.trim();
  if (!title) return;
  const due = fromLocal(f.due.value);
  const { error } = await sb.from('pult_tasks').insert({ title, due_at: due });
  if (error) return alert('Не сохранилось: ' + error.message);
  await refresh();
});
$('board').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act="done"]');
  if (!b) return;
  const id = b.closest('[data-task]').dataset.task;
  const t = state.tasks.find((x) => String(x.id) === id);
  const { error } = await sb.from('pult_tasks').update({ done_at: t.done_at ? null : new Date().toISOString() }).eq('id', id);
  if (error) return alert('Не сохранилось: ' + error.message);
  await refresh();
});
$('board').addEventListener('change', async (ev) => {
  const i = ev.target.closest('[data-act="move"]');
  if (!i) return;
  const id = i.closest('[data-task]').dataset.task;
  const due = fromLocal(i.value);
  const { error } = await sb.from('pult_tasks').update({ due_at: due }).eq('id', id);
  if (error) return alert('Не сохранилось: ' + error.message);
  await refresh();
});

// ---------- уведомления ----------
const b64ToBytes = (b) => Uint8Array.from(atob((b + '='.repeat((4 - (b.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function pushCall(action, body) {
  const { data, error } = await sb.functions.invoke('pult-push?action=' + action, body ? { method: 'POST', body } : { method: 'GET' });
  if (error || data?.error) throw new Error(data?.error || error.message);
  return data;
}
$('board').addEventListener('click', async (ev) => {
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
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };
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
$('board').addEventListener('click', async (ev) => {
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
$('btnSettings').onclick = openSettings;
$('btnCloseSettings').onclick = () => { renderBoard(); show('board'); };
$('btnLogout').onclick = async () => { await sb.auth.signOut(); cache.set({}); show('login'); };

// ---------- вход ----------
function show(id) {
  for (const s of ['login', 'board', 'settings']) $(s).classList.toggle('hidden', s !== id);
  $('btnSettings').classList.toggle('hidden', id !== 'board');
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

async function refresh() {
  try { await load(); } catch (e) { state.offline = true; console.error(e); }
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

document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('board').classList.contains('hidden')) refresh(); });
setInterval(() => { if (!document.hidden && !$('board').classList.contains('hidden')) refresh(); }, 5 * 6e4);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
start();
