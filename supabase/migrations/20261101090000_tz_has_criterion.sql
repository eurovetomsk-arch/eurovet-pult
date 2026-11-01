-- ТЗ J2 (Архитектор, письмо 848, 01.11.2026): проверка ТЗ без ИИ.
-- tz_has_criterion(текст письма) -> 'да', если в письме есть строка «Готово, когда:» с текстом после двоеточия, иначе 'нет'.
-- Строитель вызывает её первым шагом на каждом ТЗ кому:строитель; 'нет' = «отказ: нет критерия», работа не начата.
-- Чистая функция: не читает и не пишет таблицы. Выполнять может только владелец базы.
-- Откат: drop function if exists public.tz_has_criterion(text);

create or replace function public.tz_has_criterion(p_content text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when coalesce(p_content, '') ~* '(^|\n)[[:space:]*_#>•-]*(\d+[.)][[:space:]]*)?готово,?[[:space:]]+когда[[:space:]]*:[[:space:]]*[^[:space:]]'
    then 'да' else 'нет'
  end
$$;

comment on function public.tz_has_criterion(text) is
  'ТЗ J2 (848): да/нет - есть ли в письме строка «Готово, когда:» с текстом. Без ИИ. Откат: drop function public.tz_has_criterion(text).';

revoke all on function public.tz_has_criterion(text) from public, anon, authenticated;
