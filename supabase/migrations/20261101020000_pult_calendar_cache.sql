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
