-- Подписка на уведомления делается upsert-ом: нужно право update (без него 400 при «Включить уведомления»)
grant update on public.pult_push_subs to authenticated;
