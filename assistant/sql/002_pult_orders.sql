-- Закрытие поручений владельцем из пульта и счётчик лотка pult_inbox (31.10.2026).
-- Поручения из пульта (текст и голос) пульт пишет в свой лоток public.pult_inbox; insert в asst_orders владельцу НЕ даём.
alter table public.asst_orders add column if not exists source text not null default 'чат' check (source in ('чат','пульт','место','тест'));
alter table public.asst_orders alter column route set default 'сам';
create table if not exists public.asst_settings (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table public.asst_settings enable row level security;
revoke all on public.asst_settings from anon, authenticated;
grant update (status) on public.asst_orders to authenticated;
create policy asst_orders_owner_close on public.asst_orders for update to authenticated
  using (public.pult_is_owner() and closed_at is null) with check (public.pult_is_owner() and status in ('сделано','отказ'));
-- Сколько новых поручений из пульта и куда толкнуть ассистента (вызывает почасовой агент снимка почты)
create or replace function public.asst_pult_pending() returns table(n integer, inbox text) language sql security definer set search_path = public as $$
  select (select count(*)::int from public.pult_inbox where taken_at is null),
         (select value from public.asst_settings where key = 'inbox_trigger');
$$;
revoke all on function public.asst_pult_pending() from public, anon, authenticated;
