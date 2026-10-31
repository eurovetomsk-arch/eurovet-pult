-- Сторож зависших писем (ТЗ 717 Архитектора, к 716). Только SQL, без http, без токенов.
-- Раз в час: письма kind 'вопрос' с тегами {почта, кому:X} без ответа получателя
-- (нет записи с re:<id> и от:X) старше 3 ч -> одна запись {система, зависшие, почта}.
-- Старше 6 ч -> тег 'красное' в той же записи. Дубль не пишется, если список не изменился.
-- Ничего не удаляет и никого не будит.
-- Откат: select cron.unschedule('mail-stuck-watch'); (функции можно оставить, они ничего не делают без задания)

-- 1. Список зависших на момент p_now (чтение, без записи)
create or replace function public.mail_stuck_list(p_now timestamptz default now())
returns table(letter_id bigint, rcpt text, age_h numeric, red boolean)
language sql stable security definer set search_path = public
as $$
  select q.id, r.rcpt,
         round(extract(epoch from p_now - q.created_at) / 3600, 1),
         q.created_at < p_now - interval '6 hours'
    from work_archive q
    cross join lateral (
      select substr(t, 6) as rcpt from unnest(q.tags) t where t like 'кому:%'
    ) r
   where q.kind = 'вопрос'
     and 'почта' = any(q.tags)
     and q.created_at < p_now - interval '3 hours'
     and not exists (
       select 1 from work_archive a
        where ('re:' || q.id) = any(a.tags)
          and (('от:' || r.rcpt) = any(a.tags)
               -- письма кому:mac исполняет Строитель (реестр входящих, запись 600)
               or (r.rcpt = 'mac' and 'от:строитель' = any(a.tags)))
     )
   order by q.id, r.rcpt;
$$;

-- 2. Запись в архив, если список изменился с прошлой записи
create or replace function public.mail_stuck_watch(p_now timestamptz default now())
returns bigint
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_key text; v_last text; v_n int; v_red int; v_body text; v_tags text[]; v_id bigint;
begin
  select count(*), count(*) filter (where red),
         md5(coalesce(string_agg(letter_id || ':' || rcpt || ':' || case when red then 'r' else 'y' end, ',' order by letter_id, rcpt), '')),
         string_agg(case when red then 'красное' else 'жёлтое' end || ' ' || letter_id || ' кому:' || rcpt || ' ' || age_h || ' ч',
                    E'\n' order by red desc, letter_id, rcpt)
    into v_n, v_red, v_key, v_body
    from mail_stuck_list(p_now);

  select substring(content from 'ключ: ([0-9a-f]{32})') into v_last
    from work_archive
   where tags @> array['система','зависшие','почта']
   order by id desc limit 1;

  if v_last is not distinct from v_key then
    return null;  -- список не изменился, дубль не пишем
  end if;

  v_tags := array['система','зависшие','почта','от:строитель'];
  if v_red > 0 then v_tags := array_append(v_tags, 'красное'); end if;

  insert into work_archive(kind, title, content, tags)
  values ('заметка',
          'зависшие письма: ' || v_n || ', красных ' || v_red,
          'Письма kind вопрос без ответа получателя (re:N от:получатель) старше 3 ч. Красное - старше 6 ч.'
            || E'\nСнято: ' || to_char(p_now at time zone 'Asia/Omsk', 'DD.MM.YYYY HH24:MI') || ' Омск'
            || E'\nключ: ' || v_key
            || E'\n' || coalesce(v_body, 'Зависших нет.')
            || E'\nСторож: pg_cron mail-stuck-watch, функция mail_stuck_watch (ТЗ 717).',
          v_tags)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.mail_stuck_list(timestamptz) from public, anon, authenticated;
revoke all on function public.mail_stuck_watch(timestamptz) from public, anon, authenticated;

-- 3. Расписание: каждый час в :07
select cron.schedule('mail-stuck-watch', '7 * * * *', 'select public.mail_stuck_watch()');
