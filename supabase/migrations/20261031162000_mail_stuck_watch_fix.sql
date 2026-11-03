-- Исправление: тег красное через array_append (|| с литералом падал: malformed array literal). Поймано тестом до первого запуска.
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
