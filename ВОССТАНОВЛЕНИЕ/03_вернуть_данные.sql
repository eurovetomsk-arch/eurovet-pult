-- ВОССТАНОВЛЕНИЕ: вернуть данные пульта из JSON-копии (файл pult_ГГГГ-ММ-ДД.json из папки ВОССТАНОВЛЕНИЕ/данные).
-- Когда: после 02_схема_базы.sql и после того, как владелец один раз вошёл в новый пульт («Создать вход»).
-- Как: SQL Editor -> вставить этот файл -> в строке «j jsonb := ...» выделить слово ВСТАВЬТЕ_ДАННЫЕ_ЗДЕСЬ и вставить вместо него всё содержимое JSON-файла -> Run.
-- Повторный запуск безопасен: уже существующие строки не трогаются и не удаляются.

do $restore$
declare
  j jsonb := $json$ВСТАВЬТЕ_ДАННЫЕ_ЗДЕСЬ$json$::jsonb;
  t jsonb := j -> 'tables';
  owner uuid := (select owner_id from public.pult_settings where id = 1);
  n_tasks int; n_orders int; n_marks int; n_inbox int;
begin
  if owner is null then raise exception 'Сначала откройте пульт и создайте вход владельца, потом запустите этот файл'; end if;
  if j ->> 'format' is distinct from 'eurovet-pult-export/1' then raise exception 'Это не копия пульта (нет format eurovet-pult-export/1)'; end if;

  insert into public.pult_tasks (id, owner_id, title, note, due_at, priority, done_at, created_at, updated_at, reminded_at)
  overriding system value
  select r.id, owner, r.title, r.note, r.due_at, r.priority, r.done_at, r.created_at, r.updated_at,
         coalesce(r.reminded_at, case when r.due_at < now() then now() end) -- старые напоминания не присылать повторно
    from jsonb_populate_recordset(null::public.pult_tasks, coalesce(t -> 'pult_tasks', '[]')) r
  on conflict (id) do nothing;
  get diagnostics n_tasks = row_count;

  insert into public.pult_layout (note, modules, created_by)
  select left('восстановлено из копии ' || (j ->> 'exported_at') || ', версия ' || (x ->> 'version'), 300), x -> 'modules', 'restore'
    from jsonb_array_elements(coalesce(t -> 'pult_layout', '[]')) x
   where not exists (select 1 from public.pult_layout l where l.note like 'восстановлено из копии ' || (j ->> 'exported_at') || '%')
   order by (x ->> 'version')::bigint desc limit 1;

  insert into public.pult_event_marks (event_key, owner_id, title, start_at, mark, marked_at)
  select r.event_key, owner, r.title, r.start_at, r.mark, r.marked_at
    from jsonb_populate_recordset(null::public.pult_event_marks, coalesce(t -> 'pult_event_marks', '[]')) r
  on conflict (event_key) do nothing;
  get diagnostics n_marks = row_count;

  insert into public.pult_inbox (id, owner_id, created_at, body, via, taken_at, order_id, note)
  overriding system value
  select r.id, owner, r.created_at, r.body, r.via, r.taken_at, r.order_id, r.note
    from jsonb_populate_recordset(null::public.pult_inbox, coalesce(t -> 'pult_inbox', '[]')) r
  on conflict (id) do nothing;
  get diagnostics n_inbox = row_count;

  insert into public.asst_orders (id, created_at, updated_at, body, route, status, letter_id, answer_id, due_at, result, needs_yes, alarm_at, closed_at, source)
  overriding system value
  select r.id, r.created_at, r.updated_at, r.body, r.route, r.status, r.letter_id, r.answer_id, r.due_at, r.result, r.needs_yes,
         coalesce(r.alarm_at, now()), r.closed_at, r.source  -- сторож не будит по старым поручениям сразу после переезда
    from jsonb_populate_recordset(null::public.asst_orders, coalesce(t -> 'asst_orders', '[]')) r
  on conflict (id) do nothing;
  get diagnostics n_orders = row_count;

  -- счётчики номеров продолжаются после восстановленных
  perform setval(pg_get_serial_sequence('public.pult_tasks', 'id'), greatest((select max(id) from public.pult_tasks), 1));
  perform setval(pg_get_serial_sequence('public.pult_inbox', 'id'), greatest((select max(id) from public.pult_inbox), 1));
  perform setval(pg_get_serial_sequence('public.asst_orders', 'id'), greatest((select max(id) from public.asst_orders), 1));

  insert into public.pult_log(actor, action, detail) values ('restore', 'from_json',
    jsonb_build_object('exported_at', j ->> 'exported_at', 'tasks', n_tasks, 'orders', n_orders, 'marks', n_marks, 'inbox', n_inbox));
  raise notice 'Готово, копия от %. Добавлено: дел % из %, поручений % из %, отметок встреч % из %, входящих % из %. Если «добавлено» меньше «из», такие номера уже были в базе (повторный запуск или новые записи до восстановления).',
    j ->> 'exported_at', n_tasks, jsonb_array_length(coalesce(t -> 'pult_tasks', '[]')), n_orders, jsonb_array_length(coalesce(t -> 'asst_orders', '[]')),
    n_marks, jsonb_array_length(coalesce(t -> 'pult_event_marks', '[]')), n_inbox, jsonb_array_length(coalesce(t -> 'pult_inbox', '[]'));
end
$restore$;
