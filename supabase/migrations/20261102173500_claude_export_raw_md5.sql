-- ТЗ 1007, v2 (02.11.2026, решение Михаила: дёшево и надёжно — раз в сутки только память и инструкции).
-- raw_md5 = md5 исходного текста без хвостовых переводов строки. Задание считает тот же md5 у себя
-- (python: md5(text.rstrip('\n').encode())) и пишет только изменённые файлы — модель не перепечатывает неизменённое.
alter table public.claude_export add column if not exists raw_md5 text;

create or replace function public.claude_export_put(p_project text, p_kind text, p_name text, p_content text, p_run_id text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_text text;
  v_md5  text;
  v_raw  text;
  v_last text;
  v_lraw text;
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
  v_raw  := md5(rtrim(p_content, E'\n'));
  if p_kind in ('memory','instruction','doc') then
    select content_md5, raw_md5 into v_last, v_lraw from public.claude_export
     where project = p_project and kind = p_kind and name = p_name
     order by exported_at desc, id desc limit 1;
    if v_last = v_md5 and v_lraw = v_raw then return 0; end if;
  elsif p_kind in ('chat','thread') then
    if exists (select 1 from public.claude_export
                where project = p_project and kind = p_kind and name = p_name and content_md5 = v_md5) then
      return 0;
    end if;
  end if;
  insert into public.claude_export(project, kind, name, content, content_md5, run_id, raw_md5)
  values (p_project, p_kind, left(p_name, 300), v_text, v_md5, p_run_id, v_raw)
  returning id into v_id;
  return v_id;
end $$;

-- На входе {"имя": "raw md5"}, на выходе имена, которые изменились или новые.
create or replace function public.claude_export_changed(p_project text, p_kind text, p_files jsonb)
returns setof text language sql stable security definer set search_path = '' as $$
  select f.key from jsonb_each_text(p_files) f
   where f.value is distinct from (
     select e.raw_md5 from public.claude_export e
      where e.project = p_project and e.kind = p_kind and e.name = f.key
      order by e.exported_at desc, e.id desc limit 1);
$$;
revoke all on function public.claude_export_changed(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claude_export_put(text, text, text, text, text) from public, anon, authenticated;
