-- Пульт 0.7: напоминания не удаляются, а уходят в архив (решение Михаила: ничего не удалять).
-- Вернуть из архива = archived_at = null. Уведомления и календарь iPhone архив не видят.
alter table public.pult_tasks add column if not exists archived_at timestamptz;
create index if not exists pult_tasks_open_due on public.pult_tasks (due_at) where done_at is null and archived_at is null;
