-- Тест П2: запускать ОДНИМ запросом вместе с текстом миграции перед ним
-- (одна неявная транзакция; исключение в конце откатывает всё).
create temp table p2_probe (x int);
create trigger p2_probe_guard before insert or update or delete on p2_probe
  for each statement execute function public.sys_write_guard();
create temp table p2_probe_row (x int);
create trigger p2_probe_row_guard before insert on p2_probe_row
  for each row execute function public.sys_write_guard();
do $t$
declare r text := ''; e int;
begin
  r := r || 'строк sys_epoch: '||(select count(*) from public.sys_epoch)||' (1), readonly='||(select readonly from public.sys_epoch)||' (false)'||E'\n';
  begin insert into p2_probe values (1); r := r || 'запись при false: прошла (ок)'||E'\n';
  exception when others then r := r || 'запись при false: ОШИБКА '||sqlerrm||E'\n'; end;
  begin insert into p2_probe_row values (1); r := r || 'строчный триггер при false: прошла (ок)'||E'\n';
  exception when others then r := r || 'строчный при false: ОШИБКА '||sqlerrm||E'\n'; end;
  update public.sys_epoch set readonly = true where id = 1;
  begin insert into p2_probe values (2); r := r || 'запись при true: ПРОШЛА (плохо)'||E'\n';
  exception when read_only_sql_transaction then r := r || 'запись при true: ошибка 25006 (ок)'||E'\n'; end;
  begin update p2_probe set x = 3; r := r || 'правка при true: ПРОШЛА (плохо)'||E'\n';
  exception when read_only_sql_transaction then r := r || 'правка при true: ошибка (ок)'||E'\n'; end;
  begin delete from p2_probe; r := r || 'удаление при true: ПРОШЛО (плохо)'||E'\n';
  exception when read_only_sql_transaction then r := r || 'удаление при true: ошибка (ок)'||E'\n'; end;
  update public.sys_epoch set readonly = false where id = 1;
  update public.sys_epoch set epoch = 5 where id = 1;  r := r || 'эпоха вверх до 5: ок'||E'\n';
  begin update public.sys_epoch set epoch = 4 where id = 1; r := r || 'эпоха вниз: ПРОШЛА (плохо)'||E'\n';
  exception when others then r := r || 'эпоха вниз: ошибка (ок)'||E'\n'; end;
  begin insert into public.sys_epoch (id) values (2); r := r || 'вторая строка: ПРОШЛА (плохо)'||E'\n';
  exception when others then r := r || 'вторая строка: ошибка (ок)'||E'\n'; end;
  r := r || 'anon/auth таблица: '||has_table_privilege('anon','public.sys_epoch','select')||'/'||has_table_privilege('authenticated','public.sys_epoch','update')
        ||', guard execute: '||has_function_privilege('anon','public.sys_write_guard()','execute')||'/'||has_function_privilege('authenticated','public.sys_write_guard()','execute')||' (все false)';
  raise exception 'ИТОГ П2 (всё откатано):%', E'\n'||r;
end $t$;
