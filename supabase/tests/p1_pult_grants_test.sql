-- П1 (ТЗ 991/1049): проверка пульта под урезанными правами authenticated.
-- Всё внутри одного DO-блока, который в конце бросает исключение с итогом:
-- база откатывает всё (отзыв прав, тестовые строки). Ничего не сохраняется.
do $test$
declare
  owner uuid := (select owner_id from public.pult_settings where id = 1);
  r text := '';
  tid bigint;
  -- [ожидание, запрос]: true = должно пройти, false = должно быть запрещено
  checks text[][] := array[
    ['ok',   'select count(*) from public.pult_tasks'],
    ['ok',   'select count(*) from public.pult_layout'],
    ['ok',   'select count(*) from public.pult_mail_snapshot'],
    ['ok',   'select count(*) from public.pult_settings'],
    ['ok',   'select count(*) from public.pult_inbox'],
    ['ok',   'select count(*) from public.pult_event_marks'],
    ['ok',   'select count(*) from public.pult_calendar_cache'],
    ['ok',   'select count(*) from public.pult_calendar_snap'],
    ['ok',   'select count(*) from public.pult_decisions'],
    ['ok',   'select count(*) from public.asst_orders'],
    ['ok',   'insert into public.pult_tasks(title, due_at) values (''TEST П1 откат'', now() + interval ''1 day'')'],
    ['ok',   'update public.pult_tasks set note = ''TEST П1'' where title = ''TEST П1 откат'''],
    ['ok',   'insert into public.pult_event_marks(event_key, title, start_at, mark) values (''test-p1'', ''TEST'', now(), ''прошла'') on conflict (event_key) do update set mark = excluded.mark'],
    ['ok',   'delete from public.pult_event_marks where event_key = ''test-p1'''],
    ['ok',   'insert into public.pult_inbox(body, via) values (''TEST П1 откат'', ''текст'')'],
    ['ok',   'insert into public.pult_push_subs(endpoint, p256dh, auth) values (''https://test.invalid/p1'', ''x'', ''y'') on conflict (endpoint) do update set p256dh = excluded.p256dh'],
    ['ok',   'select public.pult_is_owner()'],
    ['deny', 'delete from public.pult_tasks where title = ''TEST П1 откат'''],
    ['deny', 'delete from public.pult_push_subs where endpoint = ''https://test.invalid/p1'''],
    ['deny', 'select count(*) from public.pult_backup'],
    ['deny', 'select count(*) from public.pult_log']
  ];
  i int;
  got text;
begin
  -- то же, что в миграции П1
  revoke delete on public.pult_tasks from authenticated;
  revoke delete on public.pult_push_subs from authenticated;
  revoke select on public.pult_backup from authenticated;
  revoke select on public.pult_log from authenticated;

  perform set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', owner::text, true);
  execute 'set local role authenticated';

  for i in 1 .. array_length(checks, 1) loop
    begin
      execute checks[i][2];
      got := 'ok';
    exception when insufficient_privilege then
      got := 'deny';
    when others then
      got := 'err:' || sqlstate;
    end;
    r := r || case when got = checks[i][1] then 'ПРОШЛО ' else 'ПРОВАЛ ' end
           || checks[i][1] || '/' || got || ' : ' || left(checks[i][2], 70) || E'\n';
  end loop;

  execute 'reset role';
  raise exception 'ИТОГ (всё откатано):%', E'\n' || r;
end
$test$;
