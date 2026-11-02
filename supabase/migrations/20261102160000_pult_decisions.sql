-- Пульт 0.9 (ТЗ 1006, правило 1005 п.4): экран «Ждут твоего да».
-- Источник: письма work_archive kind 'вопрос' с тегом 'нужно-да', на которые нет ответа Михаила.
-- Ответ Михаила = строка pult_decisions ('да'/'нет') или письмо work_archive kind 'ответ' с тегами от:михаил и re:<id>.
-- Нажатие «Да»/«Нет» кладёт письмо-ответ в work_archive (правило 479): kind 'ответ', tags {почта, кому:<место>, от:михаил, re:<id>}.
-- «Позже» прячет карточку на 12 часов. Архив только дополняется: ничего не правим и не удаляем.
-- Доступ: только владелец пульта (pult_is_owner). anon не видит ничего. Таблицы ev_* не трогаем.
-- Откат: drop function pult_yes_list(), pult_yes_answer(bigint,text,text), pult_yes_overdue(), pult_yes_pushed(bigint[]);
--        alter table pult_decisions rename to pult_decisions_old (данные не удалять).

create table public.pult_decisions (
  id bigint generated always as identity primary key,
  question_id bigint not null,
  decision text not null check (decision in ('да', 'нет', 'позже', 'напомнил')),
  comment text check (length(comment) <= 1000),
  answer_id bigint,              -- id письма-ответа в work_archive (для да/нет)
  snooze_until timestamptz,      -- для «позже»
  by_who text not null default 'михаил' check (by_who in ('михаил', 'сервер')),
  created_at timestamptz not null default now()
);
create index pult_decisions_q on public.pult_decisions (question_id, created_at desc);

alter table public.pult_decisions enable row level security;
create policy pult_decisions_owner_read on public.pult_decisions for select to authenticated using (public.pult_is_owner());
revoke all on public.pult_decisions from anon, authenticated;
grant select on public.pult_decisions to authenticated;

-- Вопросы без ответа Михаила
create or replace function public.pult_yes_open()
returns table (id bigint, created_at timestamptz, title text, content text, from_place text, tags text[], snooze_until timestamptz)
language sql stable security definer set search_path = public as $$
  select w.id, w.created_at, w.title, w.content,
         coalesce((select substring(t from 4) from unnest(w.tags) t where t like 'от:%' limit 1), '?') as from_place,
         w.tags,
         (select d.snooze_until from public.pult_decisions d
           where d.question_id = w.id and d.decision = 'позже' order by d.created_at desc limit 1) as snooze_until
    from public.work_archive w
   where w.kind = 'вопрос' and 'нужно-да' = any(w.tags)
     and not exists (select 1 from public.pult_decisions d where d.question_id = w.id and d.decision in ('да', 'нет'))
     and not exists (select 1 from public.work_archive a
                      where a.kind = 'ответ' and a.tags @> array['от:михаил', 're:' || w.id::text])
$$;
revoke execute on function public.pult_yes_open() from public, anon, authenticated;

-- Экран: список для владельца, сверху самые старые. Не владелец получает пусто.
create or replace function public.pult_yes_list()
returns table (id bigint, created_at timestamptz, title text, content text, from_place text, tags text[], snooze_until timestamptz)
language sql stable security definer set search_path = public as $$
  select o.id, o.created_at, o.title, left(o.content, 6000), o.from_place, o.tags, o.snooze_until
    from public.pult_yes_open() o
   where public.pult_is_owner()
   order by o.created_at, o.id
   limit 200
$$;
revoke execute on function public.pult_yes_list() from public, anon;
grant execute on function public.pult_yes_list() to authenticated;

-- Ответ кнопкой
create or replace function public.pult_yes_answer(p_id bigint, p_decision text, p_comment text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  q record; c text := nullif(btrim(coalesce(p_comment, '')), ''); ans bigint; word text; place text;
begin
  if not public.pult_is_owner() then raise exception 'нет доступа'; end if;
  if p_decision not in ('да', 'нет', 'позже') then raise exception 'ответ: да, нет или позже'; end if;
  if length(c) > 1000 then raise exception 'комментарий длиннее 1000 знаков'; end if;
  select * into q from public.pult_yes_open() o where o.id = p_id;
  if q.id is null then raise exception 'вопрос % не найден или уже с ответом', p_id; end if;

  if p_decision = 'позже' then
    insert into public.pult_decisions(question_id, decision, comment, snooze_until)
    values (p_id, 'позже', c, now() + interval '12 hours') returning id into ans;
    insert into public.pult_log(actor, action, detail) values ('owner', 'yes_later', jsonb_build_object('q', p_id));
    return null;
  end if;

  word := case p_decision when 'да' then 'Да' else 'Нет' end;
  place := q.from_place;
  insert into public.work_archive(kind, title, content, tags)
  values ('ответ',
          '<- ' || place || ': ' || word || ' на ' || p_id || ' (слово Михаила из пульта)',
          'Слово Михаила ' || to_char(now() at time zone 'UTC', 'DD.MM.YYYY HH24:MI') || ' UTC, кнопка в пульте (экран «Ждут твоего да»): «' || word || '».'
            || case when c is not null then E'\nКомментарий Михаила: ' || c else '' end
            || E'\nВопрос ' || p_id || ': ' || left(q.title, 300),
          array['почта', 'кому:' || place, 'от:михаил', 're:' || p_id::text])
  returning id into ans;
  insert into public.pult_decisions(question_id, decision, comment, answer_id) values (p_id, p_decision, c, ans);
  insert into public.pult_log(actor, action, detail) values ('owner', 'yes_answer', jsonb_build_object('q', p_id, 'answer', ans, 'decision', p_decision));
  return ans;
end $$;
revoke execute on function public.pult_yes_answer(bigint, text, text) from public, anon;
grant execute on function public.pult_yes_answer(bigint, text, text) to authenticated;

-- Для таймера pult-push (только сервер): ждут дольше 12 ч, не отложены, не напоминали последние 24 ч
create or replace function public.pult_yes_overdue()
returns table (id bigint, title text, from_place text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select o.id, o.title, o.from_place, o.created_at
    from public.pult_yes_open() o
   where o.created_at < now() - interval '12 hours'
     and (o.snooze_until is null or o.snooze_until < now())
     and not exists (select 1 from public.pult_decisions d
                      where d.question_id = o.id and d.decision = 'напомнил' and d.created_at > now() - interval '24 hours')
   order by o.created_at
   limit 50
$$;
create or replace function public.pult_yes_pushed(p_ids bigint[])
returns void
language sql security definer set search_path = public as $$
  insert into public.pult_decisions(question_id, decision, by_who) select unnest(p_ids), 'напомнил', 'сервер'
$$;
revoke execute on function public.pult_yes_overdue(), public.pult_yes_pushed(bigint[]) from public, anon, authenticated;
grant execute on function public.pult_yes_overdue(), public.pult_yes_pushed(bigint[]) to service_role;
