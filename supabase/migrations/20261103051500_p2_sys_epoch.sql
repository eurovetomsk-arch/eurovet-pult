-- П2 (ТЗ 991, критерий 1002, решение Архитектора 1049): эпоха и ограждение записи.
-- Флаг readonly ВЫКЛЮЧЕН. Триггеры на ev_* вешает Штаб через ev_guard (они владельцы ev_*):
--   create trigger <имя> before insert or update or delete on ev_<таблица>
--     for each statement execute function public.sys_write_guard();
-- Маяк боевым ключом не подписывается (хранение ключа - вопрос Михаила).
-- Включить ограждение: update public.sys_epoch set readonly = true where id = 1;  (только по решению)
-- Откат: supabase/rollback/20261103051500_p2_sys_epoch_rollback.sql

create table if not exists public.sys_epoch (
  id         int primary key default 1 check (id = 1),     -- ровно одна строка
  epoch      bigint not null default 1 check (epoch >= 1),
  readonly   boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.sys_epoch (id) values (1) on conflict (id) do nothing;

alter table public.sys_epoch enable row level security;
revoke all on public.sys_epoch from anon, authenticated;

-- эпоха только растёт
create or replace function public.sys_epoch_only_up()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if new.epoch < old.epoch then
    raise exception 'sys_epoch: эпоха только растёт (было %, пришло %)', old.epoch, new.epoch;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger sys_epoch_only_up before update on public.sys_epoch
  for each row execute function public.sys_epoch_only_up();

-- ограждение записи: при readonly = true бросает ошибку, иначе пропускает.
-- security definer: флаг виден при любой роли, вызвавшей запись.
create or replace function public.sys_write_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce((select readonly from sys_epoch where id = 1), false) then
    raise exception 'Запись закрыта: база в режиме только чтение (эпоха %)', (select epoch from sys_epoch where id = 1)
      using errcode = 'read_only_sql_transaction';
  end if;
  if tg_level = 'ROW' then
    return coalesce(new, old);
  end if;
  return null;
end $$;

revoke execute on function public.sys_epoch_only_up() from public, anon, authenticated;
revoke execute on function public.sys_write_guard()   from public, anon, authenticated;
