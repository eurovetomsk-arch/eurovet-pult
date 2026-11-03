-- Откат П2 без удаления: гарантированно выключить ограждение.
-- Таблица и функции остаются; без readonly = true они ничего не блокируют.
update public.sys_epoch set readonly = false where id = 1;
