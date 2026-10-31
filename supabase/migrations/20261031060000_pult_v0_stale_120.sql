alter table public.pult_settings alter column stale_after_minutes set default 120;
update public.pult_settings set stale_after_minutes = 120, updated_at = now() where id = 1;
