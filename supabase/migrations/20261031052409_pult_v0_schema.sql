-- Личный пульт Михаила V0 (задача 427). Только pult_*, таблицы Штаба не трогаем.
-- Применено в Supabase eurovet-archive 31.10.2026. Файл - копия для истории и отката.

create table public.pult_settings (
  id int primary key default 1 check (id = 1),
  allowed_email text not null,
  owner_id uuid,
  stale_after_minutes int not null default 600,
  updated_at timestamptz not null default now()
);

create table public.pult_tasks (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid(),
  title text not null check (length(title) between 1 and 300),
  note text check (length(note) <= 2000),
  due_at timestamptz,
  priority smallint not null default 2 check (priority between 1 and 3),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pult_mail_snapshot (
  id bigint generated always as identity primary key,
  taken_at timestamptz not null default now(),
  reply_count int not null check (reply_count >= 0),
  plan_count int not null check (plan_count >= 0),
  wait_count int check (wait_count >= 0),
  inbox_count int check (inbox_count >= 0),
  source text not null default 'agent' check (length(source) <= 40)
);

create table public.pult_layout (
  version bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  note text not null check (length(note) <= 300),
  modules jsonb not null check (jsonb_typeof(modules) = 'array'),
  created_by text not null default 'owner' check (length(created_by) <= 40)
);

create table public.pult_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  detail jsonb
);

-- Кто владелец
create or replace function public.pult_is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and auth.uid() = (select owner_id from public.pult_settings where id = 1)
$$;

-- Регистрация закрыта: в проекте может появиться только один пользователь с разрешённой почтой
create or replace function public.pult_guard_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select * into s from public.pult_settings where id = 1;
  if s is null or s.owner_id is not null or lower(new.email) <> lower(s.allowed_email) then
    raise exception 'Регистрация закрыта';
  end if;
  return new;
end $$;

create or replace function public.pult_bind_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.pult_settings set owner_id = new.id, updated_at = now()
   where id = 1 and owner_id is null and lower(allowed_email) = lower(new.email);
  insert into public.pult_log(actor, action, detail) values ('auth', 'owner_bound', jsonb_build_object('user', new.id));
  return new;
end $$;

create trigger pult_guard_signup before insert on auth.users for each row execute function public.pult_guard_signup();
create trigger pult_bind_owner after insert on auth.users for each row execute function public.pult_bind_owner();

-- updated_at
create or replace function public.pult_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger pult_tasks_touch before update on public.pult_tasks for each row execute function public.pult_touch();

-- Добавить версию раскладки (новый модуль, скрытие, порядок) и откат = копия старой версии новой записью
create or replace function public.pult_layout_save(p_modules jsonb, p_note text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if not public.pult_is_owner() then raise exception 'нет доступа'; end if;
  if jsonb_typeof(p_modules) <> 'array' then raise exception 'modules должен быть массивом'; end if;
  insert into public.pult_layout(note, modules) values (left(p_note, 300), p_modules) returning version into v;
  insert into public.pult_log(actor, action, detail) values ('owner', 'layout_save', jsonb_build_object('version', v));
  return v;
end $$;

create or replace function public.pult_layout_rollback(p_version bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare m jsonb; v bigint;
begin
  if not public.pult_is_owner() then raise exception 'нет доступа'; end if;
  select modules into m from public.pult_layout where version = p_version;
  if m is null then raise exception 'версии % нет', p_version; end if;
  insert into public.pult_layout(note, modules) values ('откат к версии ' || p_version, m) returning version into v;
  insert into public.pult_log(actor, action, detail) values ('owner', 'layout_rollback', jsonb_build_object('from', p_version, 'version', v));
  return v;
end $$;

-- RLS: всё только владельцу
alter table public.pult_settings enable row level security;
alter table public.pult_tasks enable row level security;
alter table public.pult_mail_snapshot enable row level security;
alter table public.pult_layout enable row level security;
alter table public.pult_log enable row level security;

create policy pult_settings_owner_read on public.pult_settings for select to authenticated using (public.pult_is_owner());
create policy pult_tasks_owner on public.pult_tasks for all to authenticated
  using (public.pult_is_owner() and owner_id = auth.uid()) with check (public.pult_is_owner() and owner_id = auth.uid());
create policy pult_mail_owner_read on public.pult_mail_snapshot for select to authenticated using (public.pult_is_owner());
create policy pult_layout_owner_read on public.pult_layout for select to authenticated using (public.pult_is_owner());
create policy pult_log_owner_read on public.pult_log for select to authenticated using (public.pult_is_owner());

revoke all on public.pult_settings, public.pult_tasks, public.pult_mail_snapshot, public.pult_layout, public.pult_log from anon;
revoke all on public.pult_settings, public.pult_mail_snapshot, public.pult_layout, public.pult_log from authenticated;
grant select on public.pult_settings, public.pult_mail_snapshot, public.pult_layout, public.pult_log to authenticated;
revoke all on public.pult_tasks from authenticated;
grant select, insert, update, delete on public.pult_tasks to authenticated;
revoke execute on function public.pult_layout_save(jsonb, text), public.pult_layout_rollback(bigint), public.pult_is_owner() from public, anon;
grant execute on function public.pult_layout_save(jsonb, text), public.pult_layout_rollback(bigint), public.pult_is_owner() to authenticated;
revoke execute on function public.pult_guard_signup(), public.pult_bind_owner() from public, anon, authenticated;

-- Начальные данные
insert into public.pult_settings(allowed_email) values ('vitatiba101010@gmail.com');
insert into public.pult_layout(note, modules, created_by) values ('V0: стартовая раскладка', '[
 {"key":"today","title":"Сегодня","kind":"today","source":"calendar+tasks","enabled":true},
 {"key":"need","title":"Нужно тебе","kind":"tasks","source":"pult_tasks","enabled":true},
 {"key":"mail","title":"Почта","kind":"mail","source":"pult_mail_snapshot","enabled":true},
 {"key":"shifts","title":"Смены на 7 дней","kind":"shifts","source":"calendar","enabled":true,"config":{"match":"Смена"}},
 {"key":"events","title":"События","kind":"events","source":"calendar","enabled":true,"config":{"days":7}},
 {"key":"clinics","title":"Клиники","kind":"stub","source":"later","enabled":true,"config":{"text":"Цифры клиник появятся в V1 из агрегатов Штаба"}}
]'::jsonb, 'architect');
