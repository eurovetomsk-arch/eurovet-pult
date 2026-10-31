-- Поручения из пульта (текстом или голосом) и отметки встреч.
-- pult_inbox: Михаил пишет, ассистент забирает (taken_at, order_id) и раскладывает в asst_orders.
create table public.pult_inbox (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  body text not null check (char_length(body) between 1 and 2000),
  via text not null default 'текст' check (via in ('текст', 'голос')),
  taken_at timestamptz,
  order_id bigint,
  note text check (char_length(note) <= 300)
);
create table public.pult_event_marks (
  event_key text primary key check (char_length(event_key) <= 400),
  owner_id uuid not null default auth.uid(),
  title text not null check (char_length(title) <= 300),
  start_at timestamptz not null,
  mark text not null check (mark in ('прошла', 'не было')),
  marked_at timestamptz not null default now()
);
alter table public.pult_inbox enable row level security;
alter table public.pult_event_marks enable row level security;
create policy pult_inbox_owner_read on public.pult_inbox for select to authenticated using (public.pult_is_owner() and owner_id = auth.uid());
create policy pult_inbox_owner_add on public.pult_inbox for insert to authenticated with check (public.pult_is_owner() and owner_id = auth.uid() and taken_at is null and order_id is null);
create policy pult_marks_owner on public.pult_event_marks for all to authenticated
  using (public.pult_is_owner() and owner_id = auth.uid()) with check (public.pult_is_owner() and owner_id = auth.uid());
revoke all on public.pult_inbox, public.pult_event_marks from anon, authenticated;
grant select, insert on public.pult_inbox to authenticated;
grant select, insert, update, delete on public.pult_event_marks to authenticated;
