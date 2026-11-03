-- Толкатель писем (решение Архитектора 31.10.2026 по слову Михаила:
-- «толкатели включайте сами, меня больше не просите»).
-- Находит письма kind 'вопрос' {почта, кому:X} без ответа получателя старше 30 мин
-- и отдаёт плановому агенту список входящих (trigger_id), которые надо толкнуть.
-- Одно письмо одному получателю: не чаще раза в 6 ч, не больше 3 толчков,
-- письма старше 7 дней не толкаются (их видит сторож mail_stuck_watch).
-- Сам ничего не будит: fire_trigger делает агент trig_01DHvHt26Ethwzuixd2kFHh7.

create table if not exists public.mail_inbox (
  place       text primary key,
  trigger_id  text not null check (trigger_id like 'trig\_%'),
  answered_by text,          -- кто ещё может закрыть письмо ответом (mac -> строитель)
  note        text
);

create table if not exists public.mail_push_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  letter_id  bigint not null,
  rcpt       text not null,
  trigger_id text not null
);
create index if not exists mail_push_log_letter on public.mail_push_log(letter_id, rcpt);

alter table public.mail_inbox enable row level security;
alter table public.mail_push_log enable row level security;
-- RLS без политик: anon/authenticated не видят таблицы.

-- Реестр входящих (копия строк реестра {система, входящие}, запись 600 и новее).
insert into public.mail_inbox(place, trigger_id, answered_by, note) values
  ('штаб',                 'trig_01GH3syU2YeZTxW4DF5wnVXy', null,         null),
  ('маркетинг',            'trig_01AV7JBLDbAgqpu2VpyjV4k6', null,         null),
  ('видео',                'trig_01LhRRbUND84fVfGCbiPNc82', null,         null),
  ('лаборатория',          'trig_01HkKU9AqrwQwtK3nDrvSfg6', null,         null),
  ('архитектор',           'trig_015n3X4BS3XyrNESXPy8HTtk', null,         null),
  ('архитектор-компьютер', 'trig_015n3X4BS3XyrNESXPy8HTtk', 'архитектор', 'задачи для ПК исполняет Архитектор, когда ПК в сети'),
  ('строитель',            'trig_01Gun8juBXyabxvZ32tr78wc', null,         null),
  ('mac',                  'trig_01Gun8juBXyabxvZ32tr78wc', 'строитель',  'письма кому:mac исполняет Строитель (реестр 600)'),
  ('ассистент',            'trig_018133cMbrjHs5TYbtjqDfBE', null,         null)
on conflict (place) do nothing;

create or replace function public.mail_push_due(p_now timestamptz default now(), p_dry boolean default false)
returns table(trigger_id text, places text, letters text, n int)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- вызовы из браузера (anon/authenticated через PostgREST) запрещены
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('anon', 'authenticated') then
    raise exception 'mail_push_due: нет доступа';
  end if;
  return query
  with due as (
    select q.id as letter_id, r.rcpt, i.trigger_id as trig
      from work_archive q
      cross join lateral (
        select substr(t, 6) as rcpt from unnest(q.tags) t where t like 'кому:%'
      ) r
      join mail_inbox i on i.place = r.rcpt
     where q.kind = 'вопрос'
       and 'почта' = any(q.tags)
       and q.created_at < p_now - interval '30 minutes'
       and q.created_at > p_now - interval '7 days'
       and not exists (
         select 1 from work_archive a
          where ('re:' || q.id) = any(a.tags)
            and (('от:' || r.rcpt) = any(a.tags)
                 or (i.answered_by is not null and ('от:' || i.answered_by) = any(a.tags)))
       )
       and (select count(*) from mail_push_log l where l.letter_id = q.id and l.rcpt = r.rcpt) < 3
       and not exists (
         select 1 from mail_push_log l
          where l.letter_id = q.id and l.rcpt = r.rcpt and l.at > p_now - interval '6 hours'
       )
  ), logged as (
    insert into mail_push_log(at, letter_id, rcpt, trigger_id)
    select p_now, d.letter_id, d.rcpt, d.trig from due d where not p_dry
    returning 1
  )
  select d.trig,
         string_agg(distinct d.rcpt, ','),
         string_agg(distinct d.letter_id::text, ', '),
         count(distinct d.letter_id)::int
    from due d
   group by d.trig
   order by 1;
end $function$;

-- Проверка без записи: select * from public.mail_push_due(now(), true);
