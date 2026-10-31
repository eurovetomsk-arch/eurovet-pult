-- Вход по Face ID (passkey). Таблицы читает и пишет только функция pult-passkey (service role).
create table public.pult_passkeys (
  id text primary key check (length(id) <= 1024),
  public_key text not null check (length(public_key) <= 2048),
  counter bigint not null default 0,
  transports text[] not null default '{}',
  device text not null default 'устройство' check (length(device) <= 80),
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create table public.pult_passkey_challenges (
  challenge text primary key check (length(challenge) <= 200),
  kind text not null check (kind in ('reg', 'auth')),
  expires_at timestamptz not null default now() + interval '5 minutes'
);
alter table public.pult_passkeys enable row level security;
alter table public.pult_passkey_challenges enable row level security;
revoke all on public.pult_passkeys, public.pult_passkey_challenges from anon, authenticated;
