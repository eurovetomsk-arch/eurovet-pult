// Пульт Михаила V0. Экран собирается из реестра панелей (таблица pult_layout),
// поэтому новую панель известного вида добавляют данными, без правки этого файла.
'use strict';

const CFG = {
  url: 'https://ikxmzapfmgqnnrsttuxc.supabase.co',
  key: 'sb_publishable_T8ccLgWCaguS1EABck2d0A_-KnjFd9K', // публичный ключ, доступ режет RLS
  version: '0.1.0',
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

let state = { layout: null, versions: [], tasks: [], mail: null, settings: null, cal: null, calError: null, offline: false };

// ---------- загрузка ----------
async function load() {
  const old = cache.get();
  const since = new Date(Date.now() - 2 * 864e5).toISOString();
  const [lay, tasks, mail, set, cal] = await Promise.all([
    sb.from('pult_layout').select('version,created_at,note,modules').order('version', { ascending: false }).limit(20),
    sb.from('pult_tasks').select('*').or(`done_at.is.null,done_at.gt.${since}`).order('due_at', { ascending: true, nullsFirst: false }),
    sb.from('pult_mail_snapshot').select('*').order('taken_at', { ascending: false }).limit(1),
    sb.from('pult_settings').select('stale_after_minutes').limit(1),
    sb.functions.invoke('pult-calendar', { method: 'GET' }).catch((e) => ({ error: e })),
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

R.tasks = (m) => {
  const items = state.tasks.map((t) => `<li class="row" data-task="${t.id}">
      <button class="chk" data-act="done" aria-label="Сделано">${t.done_at ? '✓' : ''}</button>
      <div class="grow"><div class="${t.done_at ? 'done' : ''}">${esc(t.title)}${urgency(t)}</div>
        <div class="mute">${t.due_at ? 'срок ' + esc(dayTitle(dayKey(new Date(t.due_at)))) : 'без срока'}</div></div>
      ${t.done_at ? '' : `<input type="date" class="small" data-act="move" value="${t.due_at ? dayKey(new Date(t.due_at)) : ''}" style="width:150px" aria-label="Перенести">`}
    </li>`).join('');
  return `<form class="row" data-form="task"><input class="grow" name="title" placeholder="Новое дело" maxlength="300" required>
      <input type="date" name="due" style="width:150px"><button>+</button></form>
    <ul style="margin-top:8px">${items || '<li class="mute">Дел нет</li>'}</ul>`;
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
  return `<div class="big">${evs.length}</div><div class="mute">смен за 7 дней</div>` + grouped(evs, 'Смен нет');
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
  $('offline').classList.toggle('hidden', !state.offline);
}

// ---------- дела ----------
$('board').addEventListener('submit', async (ev) => {
  const f = ev.target.closest('[data-form="task"]');
  if (!f) return;
  ev.preventDefault();
  const title = f.title.value.trim();
  if (!title) return;
  const due = f.due.value ? new Date(f.due.value + 'T09:00:00+06:00').toISOString() : null;
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
  const due = i.value ? new Date(i.value + 'T09:00:00+06:00').toISOString() : null;
  const { error } = await sb.from('pult_tasks').update({ due_at: due }).eq('id', id);
  if (error) return alert('Не сохранилось: ' + error.message);
  await refresh();
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
  if (error) { $('loginMsg').textContent = /confirm/i.test(error.message) ? 'Вход ещё не подтверждён. Напиши Архитектору: «подтверди вход в пульт».' : 'Не вышло: ' + error.message; return; }
  $('password').value = '';
  await start();
};
$('btnSignup').onclick = async () => {
  const email = $('email').value.trim(), password = $('password').value;
  if (!email || password.length < 10) { $('loginMsg').textContent = 'Нужны почта и пароль не короче 10 знаков.'; return; }
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) { $('loginMsg').textContent = 'Не вышло: ' + error.message; return; }
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
    return;
  }
  if (old.state) { state = { ...old.state, offline: false }; renderBoard(); }
  show('board');
  await refresh();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('board').classList.contains('hidden')) refresh(); });
setInterval(() => { if (!document.hidden && !$('board').classList.contains('hidden')) refresh(); }, 5 * 6e4);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
start();
