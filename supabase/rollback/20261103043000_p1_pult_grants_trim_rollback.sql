-- Откат П1: вернуть 4 права authenticated ровно как было до 03.11.2026 (снимок 1084).
grant delete on public.pult_tasks     to authenticated;
grant delete on public.pult_push_subs to authenticated;
grant select on public.pult_backup    to authenticated;
grant select on public.pult_log       to authenticated;
