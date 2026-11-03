-- Тест П3: запускать ОДНИМ запросом вместе с текстом миграции перед ним
-- (simple query = одна неявная транзакция; исключение в конце откатывает всё,
-- включая cron.schedule и тестовые строки).
do $t$
declare r text := ''; n int; a int; t0 timestamptz := now();
begin
  perform public.sys_beat('test-p3', 60);                                   -- регистрация
  n := public.sys_deadhand(t0);                       r := r || 'свежая: '||n||' (ждём 0)'||E'\n';
  update public.sys_heartbeat set last_ok = t0 - interval '80 min' where agent='test-p3';
  n := public.sys_deadhand(t0);                       r := r || '80 мин < 90: '||n||' (0)'||E'\n';
  update public.sys_heartbeat set last_ok = t0 - interval '100 min' where agent='test-p3';
  n := public.sys_deadhand(t0);                       r := r || '100 мин > 90: '||n||' (1)'||E'\n';
  select count(*) into a from public.work_archive w join public.sys_alarm s on s.archive_id=w.id where s.agent='test-p3';
                                                      r := r || 'заметка в архиве: '||a||' (1)'||E'\n';
  n := public.sys_deadhand(t0);                       r := r || 'повтор: '||n||' (0)'||E'\n';
  perform public.sys_beat('test-p3');
  select count(*) into a from public.sys_alarm where agent='test-p3' and cleared_at is null;
                                                      r := r || 'после отметки открытых: '||a||' (0)'||E'\n';
  n := public.sys_deadhand(t0 + interval '30 min');   r := r || 'через 30 мин: '||n||' (0)'||E'\n';
  begin perform public.sys_beat('test-p3-new'); r := r || 'новый без периода: прошёл (ждём ошибку)'||E'\n';
  exception when others then r := r || 'новый без периода: ошибка (ок)'||E'\n'; end;
  r := r || 'EXECUTE anon/auth beat: '||has_function_privilege('anon','public.sys_beat(text,int)','execute')
        ||'/'||has_function_privilege('authenticated','public.sys_beat(text,int)','execute')
        ||', deadhand: '||has_function_privilege('anon','public.sys_deadhand(timestamptz)','execute')
        ||'/'||has_function_privilege('authenticated','public.sys_deadhand(timestamptz)','execute')||' (все false)'||E'\n';
  r := r || 'таблицы anon/auth select: '||has_table_privilege('anon','public.sys_alarm','select')
        ||'/'||has_table_privilege('authenticated','public.sys_heartbeat','select')||' (false)'||E'\n';
  r := r || 'cron: '||(select count(*) from cron.job where jobname='sys-deadhand' and schedule='17 * * * *')||' (1)';
  raise exception 'ИТОГ П3 (всё откатано):%', E'\n'||r;
end $t$;
