-- ТЗ 1007 (02.11.2026): «чёрный ящик» — автовыгрузка из Claude (переписка проектов, память, инструкции, документы).
-- Каждый проект своим заданием раз в 6 ч дописывает сюда новое. Копию базы делают Mac (ночью) и облачная копия GitHub,
-- как и для всей базы: проекты своих копий не делают (решение 668), они только пишут источник в базу.
-- Только дозапись: UPDATE, DELETE и TRUNCATE запрещены триггером. Доступа у anon и authenticated нет.
-- Перед записью функция скрывает телефоны, e-mail, номера карт, счетов, паспортов, ИНН, СНИЛС и похожее на ключи (259, 260).

create table if not exists public.claude_export (
  id          bigserial primary key,
  project     text not null,
  kind        text not null,
  name        text not null,
  content     text not null,
  content_md5 text not null,
  run_id      text,
  exported_at timestamptz not null default now()
);
create index if not exists claude_export_pkn on public.claude_export (project, kind, name, exported_at desc);
create index if not exists claude_export_at  on public.claude_export (exported_at desc);

alter table public.claude_export enable row level security;
revoke all on public.claude_export from anon, authenticated, public;
revoke all on sequence public.claude_export_id_seq from anon, authenticated, public;

create or replace function public.claude_export_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'claude_export: только дозапись, % запрещено', tg_op;
end $$;

drop trigger if exists claude_export_no_change on public.claude_export;
create trigger claude_export_no_change before update or delete on public.claude_export
  for each row execute function public.claude_export_guard();
drop trigger if exists claude_export_no_truncate on public.claude_export;
create trigger claude_export_no_truncate before truncate on public.claude_export
  for each statement execute function public.claude_export_guard();

-- Маска персональных данных и ключей. Не идеальна: имена людей в тексте агент заменяет сам по инструкции задания.
create or replace function public.claude_export_mask(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare t text := p;
begin
  -- ключи и токены
  t := regexp_replace(t, '(sk-[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9\-]{10,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})', '[ключ скрыт]', 'g');
  -- паспорт, ИНН, СНИЛС, ОГРНИП, БИК, счёт — по слову рядом
  t := regexp_replace(t, '([Пп]аспорт[^0-9\n]{0,20})[0-9]{2}\s?[0-9]{2}\s?[0-9]{6}', '\1[паспорт скрыт]', 'g');
  t := regexp_replace(t, '((ИНН|ОГРНИП|ОГРН|БИК|КПП)[^0-9\n]{0,6})[0-9]{9,15}', '\1[скрыт]', 'gi');
  t := regexp_replace(t, '[0-9]{3}-[0-9]{3}-[0-9]{3}[ -][0-9]{2}', '[СНИЛС скрыт]', 'g');
  -- номера счетов (20 цифр) и карт (16 цифр, можно с пробелами)
  t := regexp_replace(t, '(?<![0-9])[0-9]{20}(?![0-9])', '[счёт скрыт]', 'g');
  t := regexp_replace(t, '(?<![0-9])[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}(?![0-9])', '[карта скрыта]', 'g');
  -- мобильные телефоны РФ: +7 / 8 / без префикса, 9XX XXX XX XX
  t := regexp_replace(t, '(?<![0-9+])(\+7|8)?[ (\-]{0,2}9[0-9]{2}[ )\-]{0,2}[0-9]{3}[ \-]?[0-9]{2}[ \-]?[0-9]{2}(?![0-9])', '[телефон скрыт]', 'g');
  -- e-mail, кроме служебных (eurovet*, noreply, notifications, support, info)
  t := regexp_replace(t, '(?<![A-Za-z0-9._%+\-])(?!(eurovet|no-?reply|notifications|support|info)[A-Za-z0-9._%+\-]*@)[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', '[e-mail скрыт]', 'gi');
  return t;
end $$;

-- Запись одной строки. Возвращает id новой строки или 0, если такой же текст уже записан (повтор не пишем).
-- kind: run (отметка прогона, пишется всегда), chat, thread, memory, instruction, doc.
create or replace function public.claude_export_put(p_project text, p_kind text, p_name text, p_content text, p_run_id text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_text text;
  v_md5  text;
  v_last text;
  v_id   bigint;
begin
  if p_project not in ('штаб','строитель','архитектор','ассистент','маркетинг','видеостудия','лаборатория','консилиум','советники') then
    raise exception 'claude_export: неизвестный проект %', p_project;
  end if;
  if p_kind not in ('run','chat','thread','memory','instruction','doc') then
    raise exception 'claude_export: неизвестный вид %', p_kind;
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'claude_export: пустое имя'; end if;
  if p_content is null then raise exception 'claude_export: пустой текст'; end if;
  if length(p_content) > 2000000 then raise exception 'claude_export: текст больше 2 млн знаков, разбей на части'; end if;

  v_text := public.claude_export_mask(p_content);
  v_md5  := md5(v_text);

  if p_kind in ('memory','instruction','doc') then
    select content_md5 into v_last from public.claude_export
     where project = p_project and kind = p_kind and name = p_name
     order by exported_at desc, id desc limit 1;
    if v_last = v_md5 then return 0; end if;
  elsif p_kind in ('chat','thread') then
    if exists (select 1 from public.claude_export
                where project = p_project and kind = p_kind and name = p_name and content_md5 = v_md5) then
      return 0;
    end if;
  end if;

  insert into public.claude_export(project, kind, name, content, content_md5, run_id)
  values (p_project, p_kind, left(p_name, 300), v_text, v_md5, p_run_id)
  returning id into v_id;
  return v_id;
end $$;

-- С какого времени брать сообщения: время НАЧАЛА прошлого удачного прогона (имя строки run = начало прогона, ISO UTC).
-- Сообщения, пришедшие во время прогона, попадут в следующий; повтор отсекает проверка md5 в claude_export_put.
create or replace function public.claude_export_since(p_project text)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select coalesce(max(name::timestamptz), '2000-01-01'::timestamptz) from public.claude_export
   where project = p_project and kind = 'run' and name ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9:]+)$';
$$;

-- Сторож: проекты без отметки run моложе 7 ч (6 ч + запас).
create or replace function public.claude_export_stale()
returns table(project text, last_run timestamptz)
language sql stable security definer set search_path = '' as $$
  select p, (select max(e.exported_at) from public.claude_export e where e.project = p and e.kind = 'run')
    from unnest(array['штаб','строитель','архитектор','ассистент','маркетинг','видеостудия','лаборатория','консилиум','советники']) p
   where coalesce((select max(e.exported_at) from public.claude_export e where e.project = p and e.kind = 'run'), '2000-01-01') < now() - interval '7 hours';
$$;

revoke all on function public.claude_export_mask(text) from public, anon, authenticated;
revoke all on function public.claude_export_put(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.claude_export_since(text) from public, anon, authenticated;
revoke all on function public.claude_export_stale() from public, anon, authenticated;
revoke all on function public.claude_export_guard() from public, anon, authenticated;
