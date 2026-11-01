-- ВОССТАНОВЛЕНИЕ: полная схема пульта (pult_*) и ассистента (asst_*) одним файлом.
-- Снята с живой базы Supabase eurovet-archive 31.10.2026 07:00 Омск (каталог Postgres, а не по памяти).
-- Как применить: новый проект Supabase -> SQL Editor -> вставить весь файл -> Run.
-- Секретов здесь нет: токены и ключи создаются заново в разделе 9.
-- При переезде замените ikxmzapfmgqnnrsttuxc на адрес нового проекта (одно место, раздел 10).

-- 0. Расширения (в Supabase уже есть pgcrypto; pg_cron и pg_net включаются здесь или в Database -> Extensions)
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto with schema extensions;

-- 1. Таблицы
create table if not exists public.pult_settings (
  id integer default 1 not null,
  allowed_email text not null,
  owner_id uuid,
  stale_after_minutes integer default 120 not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.pult_tasks (
  id bigint generated always as identity,
  owner_id uuid default auth.uid() not null,
  title text not null,
  note text,
  due_at timestamp with time zone,
  priority smallint default 2 not null,
  done_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  reminded_at timestamp with time zone,
  archived_at timestamp with time zone,
  phone_sig text
);

create table if not exists public.pult_mail_snapshot (
  id bigint generated always as identity,
  taken_at timestamp with time zone default now() not null,
  reply_count integer not null,
  plan_count integer not null,
  wait_count integer,
  inbox_count integer,
  source text default 'agent'::text not null
);

create table if not exists public.pult_layout (
  version bigint generated always as identity,
  created_at timestamp with time zone default now() not null,
  note text not null,
  modules jsonb not null,
  created_by text default 'owner'::text not null
);

create table if not exists public.pult_log (
  id bigint generated always as identity,
  at timestamp with time zone default now() not null,
  actor text not null,
  action text not null,
  detail jsonb
);

create table if not exists public.pult_push_subs (
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  owner_id uuid default auth.uid() not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.pult_private (
  key text not null,
  value text not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.pult_backup (
  slot smallint not null,
  taken_at timestamp with time zone default now() not null,
  data jsonb not null
);

create table if not exists public.pult_passkeys (
  id text not null,
  public_key text not null,
  counter bigint default 0 not null,
  transports text[] default '{}'::text[] not null,
  device text default 'устройство'::text not null,
  created_at timestamp with time zone default now() not null,
  used_at timestamp with time zone
);

create table if not exists public.pult_passkey_challenges (
  challenge text not null,
  kind text not null,
  expires_at timestamp with time zone default (now() + '00:05:00'::interval) not null
);

create table if not exists public.pult_inbox (
  id bigint generated always as identity,
  owner_id uuid default auth.uid() not null,
  created_at timestamp with time zone default now() not null,
  body text not null,
  via text default 'текст'::text not null,
  taken_at timestamp with time zone,
  order_id bigint,
  note text
);

create table if not exists public.pult_event_marks (
  event_key text not null,
  owner_id uuid default auth.uid() not null,
  title text not null,
  start_at timestamp with time zone not null,
  mark text not null,
  marked_at timestamp with time zone default now() not null
);

create table if not exists public.asst_orders (
  id bigint generated always as identity,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  body text not null,
  route text default 'сам'::text not null,
  status text default 'новое'::text not null,
  letter_id bigint,
  answer_id bigint,
  due_at timestamp with time zone,
  result text,
  needs_yes boolean default false not null,
  alarm_at timestamp with time zone,
  closed_at timestamp with time zone,
  source text default 'чат'::text not null
);

create table if not exists public.asst_settings (
  key text not null,
  value text not null,
  updated_at timestamp with time zone default now() not null
);

-- 2. Ключи и проверки
alter table public.pult_settings add constraint pult_settings_pkey PRIMARY KEY (id);
alter table public.pult_settings add constraint pult_settings_id_check CHECK ((id = 1));

alter table public.pult_tasks add constraint pult_tasks_pkey PRIMARY KEY (id);
alter table public.pult_tasks add constraint pult_tasks_note_check CHECK ((length(note) <= 2000));
alter table public.pult_tasks add constraint pult_tasks_priority_check CHECK (((priority >= 1) AND (priority <= 3)));
alter table public.pult_tasks add constraint pult_tasks_title_check CHECK (((length(title) >= 1) AND (length(title) <= 300)));

alter table public.pult_mail_snapshot add constraint pult_mail_snapshot_pkey PRIMARY KEY (id);
alter table public.pult_mail_snapshot add constraint pult_mail_snapshot_inbox_count_check CHECK ((inbox_count >= 0));
alter table public.pult_mail_snapshot add constraint pult_mail_snapshot_plan_count_check CHECK ((plan_count >= 0));
alter table public.pult_mail_snapshot add constraint pult_mail_snapshot_reply_count_check CHECK ((reply_count >= 0));
alter table public.pult_mail_snapshot add constraint pult_mail_snapshot_source_check CHECK ((length(source) <= 40));
alter table public.pult_mail_snapshot add constraint pult_mail_snapshot_wait_count_check CHECK ((wait_count >= 0));

alter table public.pult_layout add constraint pult_layout_pkey PRIMARY KEY (version);
alter table public.pult_layout add constraint pult_layout_created_by_check CHECK ((length(created_by) <= 40));
alter table public.pult_layout add constraint pult_layout_modules_check CHECK ((jsonb_typeof(modules) = 'array'::text));
alter table public.pult_layout add constraint pult_layout_note_check CHECK ((length(note) <= 300));

alter table public.pult_log add constraint pult_log_pkey PRIMARY KEY (id);

alter table public.pult_push_subs add constraint pult_push_subs_pkey PRIMARY KEY (endpoint);
alter table public.pult_push_subs add constraint pult_push_subs_auth_check CHECK ((length(auth) <= 100));
alter table public.pult_push_subs add constraint pult_push_subs_endpoint_check CHECK ((length(endpoint) <= 1000));
alter table public.pult_push_subs add constraint pult_push_subs_p256dh_check CHECK ((length(p256dh) <= 200));

alter table public.pult_private add constraint pult_private_pkey PRIMARY KEY (key);

alter table public.pult_backup add constraint pult_backup_pkey PRIMARY KEY (slot);
alter table public.pult_backup add constraint pult_backup_slot_check CHECK (((slot >= 1) AND (slot <= 31)));

alter table public.pult_passkeys add constraint pult_passkeys_pkey PRIMARY KEY (id);
alter table public.pult_passkeys add constraint pult_passkeys_device_check CHECK ((length(device) <= 80));
alter table public.pult_passkeys add constraint pult_passkeys_id_check CHECK ((length(id) <= 1024));
alter table public.pult_passkeys add constraint pult_passkeys_public_key_check CHECK ((length(public_key) <= 2048));

alter table public.pult_passkey_challenges add constraint pult_passkey_challenges_pkey PRIMARY KEY (challenge);
alter table public.pult_passkey_challenges add constraint pult_passkey_challenges_challenge_check CHECK ((length(challenge) <= 200));
alter table public.pult_passkey_challenges add constraint pult_passkey_challenges_kind_check CHECK ((kind = ANY (ARRAY['reg'::text, 'auth'::text])));

alter table public.pult_inbox add constraint pult_inbox_pkey PRIMARY KEY (id);
alter table public.pult_inbox add constraint pult_inbox_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 2000)));
alter table public.pult_inbox add constraint pult_inbox_note_check CHECK ((char_length(note) <= 300));
alter table public.pult_inbox add constraint pult_inbox_via_check CHECK ((via = ANY (ARRAY['текст'::text, 'голос'::text])));

alter table public.pult_event_marks add constraint pult_event_marks_pkey PRIMARY KEY (event_key);
alter table public.pult_event_marks add constraint pult_event_marks_event_key_check CHECK ((char_length(event_key) <= 400));
alter table public.pult_event_marks add constraint pult_event_marks_mark_check CHECK ((mark = ANY (ARRAY['прошла'::text, 'не было'::text])));
alter table public.pult_event_marks add constraint pult_event_marks_title_check CHECK ((char_length(title) <= 300));

alter table public.asst_orders add constraint asst_orders_pkey PRIMARY KEY (id);
alter table public.asst_orders add constraint asst_orders_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 2000)));
alter table public.asst_orders add constraint asst_orders_result_check CHECK (((result IS NULL) OR (char_length(result) <= 1000)));
alter table public.asst_orders add constraint asst_orders_route_check CHECK ((route = ANY (ARRAY['штаб'::text, 'маркетинг'::text, 'лаборатория'::text, 'видео'::text, 'консилиум'::text, 'советники'::text, 'архитектор'::text, 'секретарь'::text, 'искатель'::text, 'закупщик'::text, 'завхоз'::text, 'сам'::text])));
alter table public.asst_orders add constraint asst_orders_source_check CHECK ((source = ANY (ARRAY['чат'::text, 'пульт'::text, 'место'::text, 'тест'::text])));
alter table public.asst_orders add constraint asst_orders_status_check CHECK ((status = ANY (ARRAY['новое'::text, 'отправлено'::text, 'принято'::text, 'ответ получен'::text, 'ждёт Михаила'::text, 'сделано'::text, 'отказ'::text, 'ошибка'::text])));

alter table public.asst_settings add constraint asst_settings_pkey PRIMARY KEY (key);

CREATE INDEX asst_orders_letter ON public.asst_orders USING btree (letter_id);
CREATE INDEX asst_orders_open ON public.asst_orders USING btree (status) WHERE (closed_at IS NULL);

-- 3. Функции
CREATE OR REPLACE FUNCTION public.pult_is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select auth.uid() is not null and auth.uid() = (select owner_id from public.pult_settings where id = 1)
$function$;

CREATE OR REPLACE FUNCTION public.pult_guard_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s record;
begin
  select * into s from public.pult_settings where id = 1;
  if s is null or s.owner_id is not null or lower(new.email) <> lower(s.allowed_email) then
    raise exception 'Регистрация закрыта';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.pult_bind_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.pult_settings set owner_id = new.id, updated_at = now()
   where id = 1 and owner_id is null and lower(allowed_email) = lower(new.email);
  insert into public.pult_log(actor, action, detail) values ('auth', 'owner_bound', jsonb_build_object('user', new.id));
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.pult_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin new.updated_at = now(); return new; end $function$;

CREATE OR REPLACE FUNCTION public.pult_tasks_reset_remind()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.due_at is distinct from old.due_at then new.reminded_at = null; end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.pult_layout_save(p_modules jsonb, p_note text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v bigint;
begin
  if not public.pult_is_owner() then raise exception 'нет доступа'; end if;
  if jsonb_typeof(p_modules) <> 'array' then raise exception 'modules должен быть массивом'; end if;
  insert into public.pult_layout(note, modules) values (left(p_note, 300), p_modules) returning version into v;
  insert into public.pult_log(actor, action, detail) values ('owner', 'layout_save', jsonb_build_object('version', v));
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.pult_layout_rollback(p_version bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m jsonb; v bigint;
begin
  if not public.pult_is_owner() then raise exception 'нет доступа'; end if;
  select modules into m from public.pult_layout where version = p_version;
  if m is null then raise exception 'версии % нет', p_version; end if;
  insert into public.pult_layout(note, modules) values ('откат к версии ' || p_version, m) returning version into v;
  insert into public.pult_log(actor, action, detail) values ('owner', 'layout_rollback', jsonb_build_object('from', p_version, 'version', v));
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.pult_backup_run()
 RETURNS smallint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s smallint := extract(day from now() at time zone 'Asia/Omsk')::smallint;
begin
  insert into public.pult_backup(slot, taken_at, data) values (s, now(), jsonb_build_object(
    'tasks',  coalesce((select jsonb_agg(t order by t.id) from public.pult_tasks t), '[]'::jsonb),
    'layout', coalesce((select jsonb_agg(l order by l.version) from public.pult_layout l), '[]'::jsonb),
    'settings', (select jsonb_build_object('allowed_email', allowed_email, 'stale_after_minutes', stale_after_minutes) from public.pult_settings),
    'mail_last', (select to_jsonb(m) from public.pult_mail_snapshot m order by taken_at desc limit 1)
  ))
  on conflict (slot) do update set taken_at = excluded.taken_at, data = excluded.data;
  return s;
end $function$;

CREATE OR REPLACE FUNCTION public.asst_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at := now();
  if new.status in ('сделано','отказ') and new.closed_at is null then new.closed_at := now(); end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.asst_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; k integer := 0; owner uuid; fire_at timestamptz; omsk timestamp;
begin
  select owner_id into owner from public.pult_settings where id = 1;
  if owner is null then return 0; end if;
  omsk := now() at time zone 'Asia/Omsk';
  if extract(hour from omsk) between 8 and 21 then fire_at := now();
  else fire_at := ((date_trunc('day', omsk) + case when extract(hour from omsk) >= 22 then interval '1 day' else interval '0' end
                    + interval '8 hours') at time zone 'Asia/Omsk');
  end if;
  for r in
    select * from public.asst_orders
     where closed_at is null and alarm_at is null
       and ((status in ('отправлено','принято') and updated_at < now() - interval '2 hours')
            or (due_at is not null and due_at < now() and status not in ('ждёт Михаила')))
     order by id limit 20
  loop
    insert into public.pult_tasks(owner_id, title, note, due_at, priority)
    values (owner, left('Поручение ' || r.id || ' (' || r.route || '): ' ||
                        case when r.due_at is not null and r.due_at < now() then 'срок прошёл' else 'нет ответа 2 ч' end, 300),
            left(r.body, 500) || E'\nНапиши ассистенту: «что с поручением ' || r.id || '»', fire_at, 2);
    update public.asst_orders set alarm_at = now() where id = r.id;
    k := k + 1;
  end loop;
  return k;
end $function$;

CREATE OR REPLACE FUNCTION public.asst_pult_pending()
 RETURNS TABLE(n integer, inbox text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (select count(*)::int from public.pult_inbox where taken_at is null),
         (select value from public.asst_settings where key = 'inbox_trigger');
$function$;

-- Нужна таблица work_archive (общий архив системы). Если её в новом проекте нет, функцию и триггер asst_answer_trg пропустите.
CREATE OR REPLACE FUNCTION public.asst_on_answer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t text; n bigint;
begin
  if new.kind = 'ответ' and new.tags @> array['кому:ассистент'] then
    foreach t in array new.tags loop
      if t ~ '^re:[0-9]+$' then
        n := substring(t from 4)::bigint;
        update public.asst_orders set answer_id = new.id, status = 'ответ получен'
         where letter_id = n and closed_at is null and status in ('отправлено','принято','новое');
      end if;
    end loop;
  end if;
  return new;
exception when others then
  return new;
end $function$;

-- 4. Триггеры
CREATE TRIGGER pult_guard_signup BEFORE INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION pult_guard_signup();
CREATE TRIGGER pult_bind_owner AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION pult_bind_owner();
CREATE TRIGGER pult_tasks_touch BEFORE UPDATE ON public.pult_tasks FOR EACH ROW EXECUTE FUNCTION pult_touch();
CREATE TRIGGER pult_tasks_reset_remind BEFORE UPDATE ON public.pult_tasks FOR EACH ROW EXECUTE FUNCTION pult_tasks_reset_remind();
CREATE TRIGGER asst_orders_touch BEFORE UPDATE ON public.asst_orders FOR EACH ROW EXECUTE FUNCTION asst_touch();
-- только если есть work_archive:
-- CREATE TRIGGER asst_answer_trg AFTER INSERT ON public.work_archive FOR EACH ROW EXECUTE FUNCTION asst_on_answer();

-- 5. Защита строк (RLS): всё видит и меняет только владелец
alter table public.pult_settings enable row level security;
alter table public.pult_tasks enable row level security;
alter table public.pult_mail_snapshot enable row level security;
alter table public.pult_layout enable row level security;
alter table public.pult_log enable row level security;
alter table public.pult_push_subs enable row level security;
alter table public.pult_private enable row level security;
alter table public.pult_backup enable row level security;
alter table public.pult_passkeys enable row level security;
alter table public.pult_passkey_challenges enable row level security;
alter table public.pult_inbox enable row level security;
alter table public.pult_event_marks enable row level security;
alter table public.asst_orders enable row level security;
alter table public.asst_settings enable row level security;

create policy pult_settings_owner_read on public.pult_settings as permissive for select to authenticated using (pult_is_owner());
create policy pult_tasks_owner on public.pult_tasks as permissive for all to authenticated using ((pult_is_owner() AND (owner_id = auth.uid()))) with check ((pult_is_owner() AND (owner_id = auth.uid())));
create policy pult_mail_owner_read on public.pult_mail_snapshot as permissive for select to authenticated using (pult_is_owner());
create policy pult_layout_owner_read on public.pult_layout as permissive for select to authenticated using (pult_is_owner());
create policy pult_log_owner_read on public.pult_log as permissive for select to authenticated using (pult_is_owner());
create policy pult_push_subs_owner on public.pult_push_subs as permissive for all to authenticated using ((pult_is_owner() AND (owner_id = auth.uid()))) with check ((pult_is_owner() AND (owner_id = auth.uid())));
create policy pult_backup_owner_read on public.pult_backup as permissive for select to authenticated using (pult_is_owner());
create policy pult_inbox_owner_read on public.pult_inbox as permissive for select to authenticated using ((pult_is_owner() AND (owner_id = auth.uid())));
create policy pult_inbox_owner_add on public.pult_inbox as permissive for insert to authenticated with check ((pult_is_owner() AND (owner_id = auth.uid()) AND (taken_at IS NULL) AND (order_id IS NULL)));
create policy pult_marks_owner on public.pult_event_marks as permissive for all to authenticated using ((pult_is_owner() AND (owner_id = auth.uid()))) with check ((pult_is_owner() AND (owner_id = auth.uid())));
create policy asst_orders_owner_read on public.asst_orders as permissive for select to authenticated using (pult_is_owner());
create policy asst_orders_owner_insert on public.asst_orders as permissive for insert to authenticated with check ((pult_is_owner() AND (source = 'пульт'::text) AND (status = 'новое'::text) AND (route = 'сам'::text)));
create policy asst_orders_owner_close on public.asst_orders as permissive for update to authenticated using ((pult_is_owner() AND (closed_at IS NULL))) with check ((pult_is_owner() AND (status = ANY (ARRAY['сделано'::text, 'отказ'::text]))));

-- 6. Права ролей
revoke all on public.pult_settings, public.pult_tasks, public.pult_mail_snapshot, public.pult_layout, public.pult_log,
  public.pult_push_subs, public.pult_private, public.pult_backup, public.pult_passkeys, public.pult_passkey_challenges,
  public.pult_inbox, public.pult_event_marks, public.asst_orders, public.asst_settings from anon, authenticated;
grant select on public.pult_settings, public.pult_mail_snapshot, public.pult_layout, public.pult_log, public.pult_backup, public.asst_orders to authenticated;
grant select, insert, update, delete on public.pult_tasks, public.pult_event_marks to authenticated;
grant select, insert, delete on public.pult_push_subs to authenticated;
grant select, insert on public.pult_inbox to authenticated;
grant update (status) on public.asst_orders to authenticated; -- «Сделано»/«Отказ» у поручения, остальные поля менять нельзя

revoke execute on function public.pult_is_owner(), public.pult_layout_save(jsonb, text), public.pult_layout_rollback(bigint),
  public.pult_guard_signup(), public.pult_bind_owner(), public.pult_touch(), public.pult_tasks_reset_remind(), public.pult_backup_run(),
  public.asst_watch(), public.asst_pult_pending(), public.asst_on_answer() from public, anon, authenticated;
grant execute on function public.pult_is_owner(), public.pult_layout_save(jsonb, text), public.pult_layout_rollback(bigint) to authenticated;

-- 7. Владелец: только эта почта сможет создать вход (регистрация других закрыта триггером)
insert into public.pult_settings(allowed_email) values ('vitatiba101010@gmail.com') on conflict (id) do nothing;

-- 8. Стартовая раскладка панелей. Если есть копия данных, вместо этого вставьте последнюю раскладку из JSON (см. 00_ЧИТАЙ_МЕНЯ.md, шаг 6).
insert into public.pult_layout(note, modules, created_by)
select 'старт после восстановления', '[
 {"key":"today","title":"Сегодня","kind":"today","source":"calendar+tasks","enabled":true},
 {"key":"need","title":"Нужно тебе","kind":"tasks","source":"pult_tasks","enabled":true},
 {"key":"events","title":"События","kind":"events","source":"calendar","enabled":true,"config":{"days":7}}
]'::jsonb, 'restore'
where not exists (select 1 from public.pult_layout);

-- 9. Служебные токены создаются заново (старые не нужны и нигде не хранятся)
insert into public.pult_private(key, value) values ('cron_token', encode(extensions.gen_random_bytes(32), 'hex')) on conflict (key) do nothing;
insert into public.pult_private(key, value) values ('export_token', encode(extensions.gen_random_bytes(24), 'hex')) on conflict (key) do nothing;
-- ключи уведомлений (vapid_*) функция pult-push создаст сама при первом «Включить уведомления»

-- 10. Расписание без ИИ: напоминания каждые 5 минут, ночная копия, сторож поручений
-- ЗАМЕНИТЕ ikxmzapfmgqnnrsttuxc на адрес нового проекта!
select cron.schedule('pult-push-tick', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://ikxmzapfmgqnnrsttuxc.supabase.co/functions/v1/pult-push?action=tick',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-pult-cron', (select value from public.pult_private where key = 'cron_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000)
$job$);
select cron.schedule('pult-backup-nightly', '0 21 * * *', $job$ select public.pult_backup_run() $job$);
select cron.schedule('asst-watch', '*/15 * * * *', $job$select public.asst_watch()$job$);

-- 11. Календарь-снимок без секрета iCal (ТЗ 805, 01.11.2026). Сторож пишет тревогу в work_archive.
-- ТЗ 805 (Архитектор, 01.11.2026): календарь пульта без секрета iCal.
-- Плановый агент читает Google Календарь коннектором и раз в 30 минут кладёт сюда полный снимок.
-- Хранится только: название, начало, конец, весь день, ссылка, повтор, время снимка.
-- description и location НЕ хранятся (там бывают ссылки Zoom с паролем).

create table if not exists public.pult_calendar_cache (
  id         bigserial primary key,
  title      text not null,
  start_at   text not null,          -- как отдавал iCal: 'ГГГГ-ММ-ДД' для «весь день», иначе ISO UTC
  end_at     text not null,
  all_day    boolean not null default false,
  link       text,                   -- htmlLink Google, только https://www.google.com/calendar/event?eid=...
  recurring  boolean not null default false,
  snapshot_at timestamptz not null
);

-- Одна строка: когда снят последний снимок, сколько событий, кто снял. Нужна и при пустом календаре.
create table if not exists public.pult_calendar_snap (
  id          int primary key default 1 check (id = 1),
  snapshot_at timestamptz not null,
  events      int not null,
  actor       text not null,
  alarm_key   text                    -- сторож: по какому снимку уже была тревога
);

alter table public.pult_calendar_cache enable row level security;
alter table public.pult_calendar_snap  enable row level security;
create policy pult_calendar_cache_owner_read on public.pult_calendar_cache for select to authenticated using (public.pult_is_owner());
create policy pult_calendar_snap_owner_read  on public.pult_calendar_snap  for select to authenticated using (public.pult_is_owner());
revoke all on public.pult_calendar_cache, public.pult_calendar_snap from anon, authenticated;
grant select on public.pult_calendar_cache, public.pult_calendar_snap to authenticated;
revoke all on sequence public.pult_calendar_cache_id_seq from anon, authenticated;

-- Полная замена снимка одним вызовом (строки не удаляются, лишние гасятся). Пишет только service role / агент через SQL (не anon, не владелец).
-- Вход: массив [{t,s,e,a,l,r}] или [{title,start,end,all_day,link,recurring}].
-- s/e: dateTime или date из Google; l: htmlLink или только eid.
create or replace function public.pult_calendar_replace(p_events jsonb, p_actor text default 'agent-calendar')
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := now();
  v_n int;
  v_bad int;
begin
  if jsonb_typeof(p_events) <> 'array' then raise exception 'нужен массив событий'; end if;
  if jsonb_array_length(p_events) > 2000 then raise exception 'слишком много событий: %', jsonb_array_length(p_events); end if;

  -- защита от ошибки агента: пустой снимок не затирает непустой (за 49 суток событий всегда больше 5)
  if jsonb_array_length(p_events) = 0 and coalesce((select events from public.pult_calendar_snap where id = 1), 0) > 5 then
    raise exception 'пустой снимок не принят: в прошлом снимке % событий', (select events from public.pult_calendar_snap where id = 1);
  end if;

  select count(*) into v_bad from jsonb_array_elements(p_events) x
   where coalesce(x->>'s', x->>'start') is null or coalesce(x->>'e', x->>'end') is null;
  if v_bad > 0 then raise exception 'у % событий нет начала или конца', v_bad; end if;

  -- Без удаления строк: снимок пишется в строки 1..n (upsert по id), строки > n гасятся (пустое название,
  -- старое время снимка). Пульт читает только строки с snapshot_at = времени последнего снимка.
  with ev as (
    select row_number() over (order by coalesce(x->>'s', x->>'start')) as n,
           left(coalesce(nullif(trim(x->>'t'), ''), nullif(trim(x->>'title'), ''), '(без названия)'), 200) as title,
           coalesce(x->>'s', x->>'start') as s,
           coalesce(x->>'e', x->>'end')   as e,
           coalesce((x->>'a')::boolean, (x->>'all_day')::boolean, coalesce(x->>'s', x->>'start') ~ '^\d{4}-\d{2}-\d{2}$') as a,
           coalesce(x->>'l', x->>'link') as l,
           coalesce((x->>'r')::boolean, (x->>'recurring')::boolean, false) as r
      from jsonb_array_elements(p_events) x
  )
  insert into public.pult_calendar_cache(id, title, start_at, end_at, all_day, link, recurring, snapshot_at)
  select n, title,
         case when a then left(s, 10) else to_char(s::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"') end,
         case when a then left(e, 10) else to_char(e::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"') end,
         a,
         case
           when l is null or l = '' then null
           when l like 'https://www.google.com/calendar/event?eid=%' then split_part(l, '&', 1)
           when l ~ '^[A-Za-z0-9_-]+$' then 'https://www.google.com/calendar/event?eid=' || l
           else null                              -- чужие ссылки не храним
         end,
         r, v_now
    from ev
  on conflict (id) do update set title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
     all_day = excluded.all_day, link = excluded.link, recurring = excluded.recurring, snapshot_at = excluded.snapshot_at;
  get diagnostics v_n = row_count;
  update public.pult_calendar_cache set title = '', start_at = '', end_at = '', link = null, recurring = false,
         snapshot_at = '-infinity' where id > v_n and snapshot_at <> '-infinity';

  insert into public.pult_calendar_snap(id, snapshot_at, events, actor)
  values (1, v_now, v_n, left(coalesce(p_actor, 'agent-calendar'), 60))
  on conflict (id) do update set snapshot_at = excluded.snapshot_at, events = excluded.events, actor = excluded.actor;

  insert into public.pult_log(actor, action, detail)
  values (left(coalesce(p_actor, 'agent-calendar'), 60), 'calendar_snapshot', jsonb_build_object('events', v_n));
  return v_n;
end $$;
revoke execute on function public.pult_calendar_replace(jsonb, text) from public, anon, authenticated;

-- Сторож (277): снимок старше 3 ч - тревога заметкой в архив (как mail_stuck_watch), не Михаилу.
-- Агент работает 07:13-23:43 Омск, ночью снимков нет: днём (10:00-23:59) порог 3 ч, ночью - снимок не позже 20:43 Омск.
create or replace function public.pult_calendar_watch(p_now timestamptz default now())
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  s record; v_has boolean; v_age interval; v_omsk timestamp; v_late boolean; v_key text; v_id bigint;
begin
  select * into s from public.pult_calendar_snap where id = 1;
  v_has := found;   -- не «s is not null»: для записи это ложь, если хоть одно поле null
  v_omsk := p_now at time zone 'Asia/Omsk';
  if not v_has then
    v_late := true; v_age := null; v_key := 'нет снимка';
  else
    v_age := p_now - s.snapshot_at;
    v_late := case when extract(hour from v_omsk) >= 10 then v_age > interval '3 hours'
                   else v_age > interval '3 hours' + (v_omsk - (date_trunc('day', v_omsk) - interval '1 day' + interval '23 hours 43 minutes')) end;
    v_key := to_char(s.snapshot_at, 'YYYY-MM-DD HH24:MI:SS');
  end if;
  if not v_late then return null; end if;
  if v_has and s.alarm_key is not distinct from v_key then return null; end if;   -- по этому снимку уже звонили
  if not v_has and exists (select 1 from work_archive where tags @> array['сторож','календарь','пульт']
                              and created_at > p_now - interval '6 hours') then return null; end if;

  insert into work_archive(kind, title, content, tags)
  values ('заметка',
          'сторож календаря пульта: снимок устарел',
          'Снимок календаря пульта (pult_calendar_snap) старше 3 ч.'
            || E'\nПоследний снимок: ' || coalesce(to_char(s.snapshot_at at time zone 'Asia/Omsk', 'DD.MM.YYYY HH24:MI') || ' Омск', 'нет')
            || E'\nВозраст: ' || coalesce(round(extract(epoch from v_age) / 3600, 1)::text || ' ч', '-')
            || E'\nПроверено: ' || to_char(v_omsk, 'DD.MM.YYYY HH24:MI') || ' Омск'
            || E'\nЧто смотреть: плановая задача «СТРОИТЕЛЬ: календарь пульта» (последний запуск), коннектор Google Календаря.'
            || E'\nСторож: pg_cron pult-calendar-watch, функция pult_calendar_watch (ТЗ 805).',
          array['система','сторож','календарь','пульт','от:строитель','тревога'])
  returning id into v_id;
  if v_has then update public.pult_calendar_snap set alarm_key = v_key where id = 1; end if;
  insert into public.pult_log(actor, action, detail) values ('watch-calendar', 'alarm', jsonb_build_object('archive_id', v_id, 'snapshot', v_key));
  return v_id;
end $$;
revoke execute on function public.pult_calendar_watch(timestamptz) from public, anon, authenticated;

select cron.schedule('pult-calendar-watch', '*/15 * * * *', $job$ select public.pult_calendar_watch() $job$);
