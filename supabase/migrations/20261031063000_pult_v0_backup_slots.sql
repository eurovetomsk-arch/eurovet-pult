-- Ночная копия данных пульта внутри базы, без Claude. 31 ячейка по числу месяца: каждая ночь перезаписывает свою.
create table public.pult_backup (
  slot smallint primary key check (slot between 1 and 31),
  taken_at timestamptz not null default now(),
  data jsonb not null
);
alter table public.pult_backup enable row level security;
create policy pult_backup_owner_read on public.pult_backup for select to authenticated using (public.pult_is_owner());
revoke all on public.pult_backup from anon, authenticated;
grant select on public.pult_backup to authenticated;

create or replace function public.pult_backup_run() returns smallint
language plpgsql security definer set search_path = public as $$
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
end $$;
revoke execute on function public.pult_backup_run() from public, anon, authenticated;

select cron.schedule('pult-backup-nightly', '0 21 * * *', $job$ select public.pult_backup_run() $job$);
select public.pult_backup_run();
