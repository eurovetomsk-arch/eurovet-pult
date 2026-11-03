# Чёрный ящик: claude_export (ТЗ 1007, 02.11.2026)

Что: переписка проектов Claude (чат проекта и треды), файлы памяти, инструкции проектов, документы claude.ai
дописываются в таблицу `public.claude_export` (Supabase ikxmzapfmgqnnrsttuxc). Копию базы делают Mac (ночью) и облачная копия GitHub.

- Схема: `supabase/migrations/20261102160000_claude_export.sql`.
- Писать можно только `select public.claude_export_put(project, kind, name, content, run_id)`; UPDATE/DELETE/TRUNCATE запрещены триггером.
- Маска ПДн и ключей: `public.claude_export_mask` (телефоны, e-mail, карты, счета, паспорт, ИНН, СНИЛС, ключи).
- С какого времени брать новое: `select public.claude_export_since('<проект>')`.
- Сторож: `select * from public.claude_export_stale()` — проекты без прогона моложе 7 ч.
- Текст задания для проекта: `zadanie_vygruzki.md`.

Прочитать после аварии (пример — последнее сообщение треда):
```sql
select exported_at, name, right(content, 2000) from public.claude_export
 where project = 'советники' and kind = 'thread' and name ilike '%Оргструктура%'
 order by exported_at desc limit 1;
```
