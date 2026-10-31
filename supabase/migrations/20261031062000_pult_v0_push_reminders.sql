-- Напоминания с уведомлениями без Claude: таймер pg_cron -> функция pult-push -> Web Push.
alter table public.pult_tasks add column reminded_at timestamptz;

-- Сбрасывать отметку «уведомлено», если срок перенесли
create or replace function public.pult_tasks_reset_remind() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.due_at is distinct from old.due_at then new.reminded_at = null; end if;
  return new;
end $$;
create trigger pult_tasks_reset_remind before update on public.pult_tasks for each row execute function public.pult_tasks_reset_remind();
revoke execute on function public.pult_tasks_reset_remind() from public, anon, authenticated;

create table public.pult_push_subs (
  endpoint text primary key check (length(endpoint) <= 1000),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  owner_id uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.pult_push_subs enable row level security;
create policy pult_push_subs_owner on public.pult_push_subs for all to authenticated
  using (public.pult_is_owner() and owner_id = auth.uid()) with check (public.pult_is_owner() and owner_id = auth.uid());
revoke all on public.pult_push_subs from anon, authenticated;
grant select, insert, delete on public.pult_push_subs to authenticated;

-- Служебные значения (ключи уведомлений, токен таймера). Видит только сервер: ни anon, ни вошедший.
create table public.pult_private (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
alter table public.pult_private enable row level security;
revoke all on public.pult_private from anon, authenticated;

-- Токен таймера создаётся здесь же и никуда не выводится
insert into public.pult_private(key, value) values ('cron_token', encode(gen_random_bytes(32), 'hex'));
