-- П1 (ТЗ 991, критерий 1002, решение Архитектора 1049): отозвать у authenticated
-- ровно 4 права на pult_*, которые не нужны странице пульта и её функциям.
-- Проверено по коду main 5977457 (app.js, supabase/functions/*) и боевому pult-push v6:
--   pult_tasks      DELETE  - страница задачи не удаляет (только insert/update/select)
--   pult_push_subs  DELETE  - удаляет только pult-push под service_role
--   pult_backup     SELECT  - страница не читает
--   pult_log        SELECT  - страница не читает, пишут функции под service_role
-- Остальное не трогается. Откат: supabase/rollback/20261103043000_p1_pult_grants_trim_rollback.sql
revoke delete on public.pult_tasks     from authenticated;
revoke delete on public.pult_push_subs from authenticated;
revoke select on public.pult_backup    from authenticated;
revoke select on public.pult_log       from authenticated;
