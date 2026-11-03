-- ТЗ J3 (письмо 859): КРИТИК-событие пишет ответ только через эту функцию.
-- Ответ: kind 'ответ', tags {почта, кому:<отправитель>, от:критик, re:N, критик}.
-- Откат: revoke execute on function public.critic_reply(bigint,text,text) from service_role;
create or replace function public.critic_reply(p_letter bigint, p_verdict text, p_text text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tags text[];
  v_kind text;
  v_from text;
  v_id bigint;
begin
  select kind, tags into v_kind, v_tags from work_archive where id = p_letter;
  if v_tags is null then
    raise exception 'critic_reply: письма % нет', p_letter;
  end if;
  if v_kind <> 'вопрос' or not ('кому:критик' = any(v_tags)) then
    raise exception 'critic_reply: письмо % не kind вопрос кому:критик', p_letter;
  end if;
  if p_verdict not in ('ок', 'исправить') then
    raise exception 'critic_reply: вердикт только ок или исправить';
  end if;
  if p_text is null or length(p_text) > 1200
     or array_length(regexp_split_to_array(btrim(p_text, E'\n'), E'\n'), 1) > 5 then
    raise exception 'critic_reply: текст до 5 строк и до 1200 знаков';
  end if;
  select substr(t, 4) into v_from from unnest(v_tags) t where t like 'от:%' limit 1;
  if v_from is null or v_from = '' then
    v_from := 'архитектор';
  end if;
  insert into work_archive(kind, title, content, tags)
  values ('ответ',
          '← критик: ' || p_verdict || ' (письмо ' || p_letter || ')',
          p_text,
          array['почта', 'кому:' || v_from, 'от:критик', 're:' || p_letter, 'критик'])
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.critic_reply(bigint, text, text) from public, anon, authenticated;
grant execute on function public.critic_reply(bigint, text, text) to service_role;
