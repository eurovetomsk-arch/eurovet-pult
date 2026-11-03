-- П3 (ТЗ 991, критерий 1002, решение Архитектора 1049): «мёртвая рука» для сверок.
-- Только сигнал: база сверки не запускает, журналы агентов не трогает.
-- Агент сверки Штаба последним шагом после УСПЕШНОЙ сверки вызывает
--   select public.sys_beat('<имя агента>', <период в минутах>);   -- первый вызов регистрирует агента
--   select public.sys_beat('<имя агента>');                       -- дальше период можно не передавать
-- pg_cron sys-deadhand раз в час (:17 UTC): если last_ok старше 1,5 * period_min,
-- одна строка в sys_alarm + одна заметка в work_archive {система, сторож, тревога}.
-- Повтор при открытой тревоге не пишется. Новая отметка закрывает тревогу (cleared_at).
-- В pult_event_marks и pult_tasks не пишет, push Михаилу не шлёт (1049 п.2).
-- Откат: supabase/rollback/20261103050000_p3_sys_deadhand_rollback.sql

create table if not exists public.sys_heartbeat (
  agent      text primary key check (char_length(agent) between 1 and 100),
  period_min int  not null check (period_min between 1 and 10080),
  last_ok    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sys_alarm (
  id         bigint generated always as identity primary key,
  kind       text not null,
  agent      text,
  detail     jsonb not null default '{}'::jsonb,
  raised_at  timestamptz not null default now(),
  cleared_at timestamptz,
  archive_id bigint
);
create index if not exists sys_alarm_open on public.sys_alarm (kind, agent) where cleared_at is null;

alter table public.sys_heartbeat enable row level security;
alter table public.sys_alarm     enable row level security;
revoke all on public.sys_heartbeat, public.sys_alarm from anon, authenticated;

create or replace function public.sys_beat(p_agent text, p_period_min int default null)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare t timestamptz := now();
begin
  if p_agent is null or btrim(p_agent) = '' then raise exception 'sys_beat: пустое имя агента'; end if;
  update sys_heartbeat
     set last_ok = t, updated_at = t, period_min = coalesce(p_period_min, period_min)
   where agent = p_agent;
  if not found then
    if p_period_min is null then
      raise exception 'sys_beat: агент % не зарегистрирован, передай период в минутах вторым параметром', p_agent;
    end if;
    insert into sys_heartbeat (agent, period_min, last_ok, updated_at)
    values (p_agent, p_period_min, t, t)
    on conflict (agent) do update set last_ok = t, updated_at = t, period_min = excluded.period_min;
  end if;
  update sys_alarm set cleared_at = t
   where kind = 'deadhand' and agent = p_agent and cleared_at is null;
  return t;
end $$;

create or replace function public.sys_deadhand(p_now timestamptz default now())
returns int
language plpgsql security definer set search_path = public
as $$
declare r record; n int := 0; aid bigint; last_txt text;
begin
  for r in
    select h.* from sys_heartbeat h
     where coalesce(h.last_ok, h.created_at) < p_now - make_interval(mins => ceil(h.period_min * 1.5)::int)
       and not exists (select 1 from sys_alarm a where a.kind = 'deadhand' and a.agent = h.agent and a.cleared_at is null)
  loop
    last_txt := coalesce(to_char(r.last_ok at time zone 'Asia/Omsk', 'DD.MM HH24:MI') || ' Омск', 'ни разу');
    insert into work_archive (kind, title, content, tags)
    values ('заметка',
            'Тревога: сверка давно не проходила — ' || r.agent,
            'Агент ' || r.agent || ': последняя успешная отметка ' || last_txt
              || ', период ' || r.period_min || ' мин, порог 1,5 периода. Сигнал мёртвой руки (ТЗ 991 П3). '
              || 'Сверку база не запускает. Закроется сама при следующей отметке sys_beat.',
            array['система','сторож','тревога','мёртвая-рука','от:строитель'])
    returning id into aid;
    insert into sys_alarm (kind, agent, detail, raised_at, archive_id)
    values ('deadhand', r.agent,
            jsonb_build_object('last_ok', r.last_ok, 'period_min', r.period_min), p_now, aid);
    n := n + 1;
  end loop;
  return n;
end $$;

-- по умолчанию база даёт EXECUTE новых функций anon и authenticated: отзываем явно (1049 п.4)
revoke execute on function public.sys_beat(text, int)       from public, anon, authenticated;
revoke execute on function public.sys_deadhand(timestamptz) from public, anon, authenticated;
grant  execute on function public.sys_beat(text, int)       to service_role;
grant  execute on function public.sys_deadhand(timestamptz) to service_role;

select cron.schedule('sys-deadhand', '17 * * * *', 'select public.sys_deadhand()');
