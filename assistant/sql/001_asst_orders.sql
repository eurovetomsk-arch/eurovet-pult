-- ЛИЧНЫЙ АССИСТЕНТ: журнал поручений и Сторож без ИИ (31.10.2026, архив 431)
create table if not exists public.asst_orders (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  body        text not null check (char_length(body) between 1 and 2000),
  route       text not null check (route in ('штаб','маркетинг','лаборатория','видео','консилиум','советники','архитектор',
                                             'секретарь','искатель','закупщик','завхоз','сам')),
  status      text not null default 'новое' check (status in ('новое','отправлено','принято','ответ получен',
                                                               'ждёт Михаила','сделано','отказ','ошибка')),
  letter_id   bigint,          -- письмо в work_archive (kind вопрос)
  answer_id   bigint,          -- ответ места (kind ответ, re:letter_id)
  due_at      timestamptz,     -- срок, если назвал Михаил
  result      text check (result is null or char_length(result) <= 1000),
  needs_yes   boolean not null default false,  -- деньги, наружу, удаление: только с «да» Михаила
  alarm_at    timestamptz,     -- когда Сторож поднял тревогу
  closed_at   timestamptz
);
create index if not exists asst_orders_open on public.asst_orders(status) where closed_at is null;
create index if not exists asst_orders_letter on public.asst_orders(letter_id);

alter table public.asst_orders enable row level security;
drop policy if exists asst_orders_owner_read on public.asst_orders;
create policy asst_orders_owner_read on public.asst_orders for select to authenticated using (public.pult_is_owner());
revoke all on public.asst_orders from anon;
grant select on public.asst_orders to authenticated;

create or replace function public.asst_touch() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if new.status in ('сделано','отказ') and new.closed_at is null then new.closed_at := now(); end if;
  return new;
end $$;
drop trigger if exists asst_orders_touch on public.asst_orders;
create trigger asst_orders_touch before update on public.asst_orders for each row execute function public.asst_touch();

-- Ответ места: письмо kind 'ответ' с тегами кому:ассистент и re:N сам отмечает поручение. Сбой здесь не мешает записи в архив.
create or replace function public.asst_on_answer() returns trigger language plpgsql security definer set search_path = public as $$
declare t text; n bigint;
begin
  if new.kind = 'ответ' and new.tags @> array['кому:ассистент'] then
    foreach t in array new.tags loop
      if t ~ '^re:[0-9]+$' then
        n := substring(t from 4)::bigint;
        update public.asst_orders set answer_id = new.id, status = 'ответ получен'
         where letter_id = n and closed_at is null and status in ('отправлено','принято','новое');
      end if;
    end loop;
  end if;
  return new;
exception when others then
  return new;
end $$;
drop trigger if exists asst_answer_trg on public.work_archive;
create trigger asst_answer_trg after insert on public.work_archive for each row execute function public.asst_on_answer();

-- Сторож: поручение месту без ответа 2 часа или просроченный срок -> напоминание в пульте (пуш шлёт pult-push).
-- Ночью (22-08 Омск) тревогу откладывает до 08:00.
create or replace function public.asst_watch() returns integer language plpgsql security definer set search_path = public as $$
declare r record; k integer := 0; owner uuid; fire_at timestamptz; omsk timestamp;
begin
  select owner_id into owner from public.pult_settings where id = 1;
  if owner is null then return 0; end if;
  omsk := now() at time zone 'Asia/Omsk';
  if extract(hour from omsk) between 8 and 21 then fire_at := now();
  else fire_at := ((date_trunc('day', omsk) + case when extract(hour from omsk) >= 22 then interval '1 day' else interval '0' end
                    + interval '8 hours') at time zone 'Asia/Omsk');
  end if;
  for r in
    select * from public.asst_orders
     where closed_at is null and alarm_at is null
       and ((status in ('отправлено','принято') and updated_at < now() - interval '2 hours')
            or (due_at is not null and due_at < now() and status not in ('ждёт Михаила')))
     order by id limit 20
  loop
    insert into public.pult_tasks(owner_id, title, note, due_at, priority)
    values (owner, left('Поручение ' || r.id || ' (' || r.route || '): ' ||
                        case when r.due_at is not null and r.due_at < now() then 'срок прошёл' else 'нет ответа 2 ч' end, 300),
            left(r.body, 500) || E'\nНапиши ассистенту: «что с поручением ' || r.id || '»', fire_at, 2);
    update public.asst_orders set alarm_at = now() where id = r.id;
    k := k + 1;
  end loop;
  return k;
end $$;
revoke all on function public.asst_watch() from public, anon, authenticated;
revoke all on function public.asst_on_answer() from public, anon, authenticated;

select cron.unschedule('asst-watch') where exists (select 1 from cron.job where jobname = 'asst-watch');
select cron.schedule('asst-watch', '*/15 * * * *', 'select public.asst_watch()');
