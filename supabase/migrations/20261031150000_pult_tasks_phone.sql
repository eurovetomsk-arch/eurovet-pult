-- Пульт 0.7.1: копия напоминаний в приложении «Напоминания» iPhone через Команду (Shortcuts).
-- phone_sig: что сейчас лежит на iPhone (название|срок). null - на iPhone копии нет.
-- Сервер сравнивает его с текущим: изменилось - старую копию убрать, новую добавить.
alter table public.pult_tasks add column if not exists phone_sig text check (length(phone_sig) <= 400);
