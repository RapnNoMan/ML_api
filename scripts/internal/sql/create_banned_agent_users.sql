create table if not exists public.banned_agent_users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone not null default now(),
  agent_id uuid not null references public.agents (id) on update cascade on delete cascade,
  anon_id text not null,
  reason text null,
  evidence text null,
  unique (agent_id, anon_id)
);

create index if not exists banned_agent_users_agent_anon_idx
  on public.banned_agent_users (agent_id, anon_id);

create index if not exists banned_agent_users_created_idx
  on public.banned_agent_users (created_at desc);

alter table public.banned_agent_users disable row level security;

revoke all on table public.banned_agent_users from public;
revoke all on table public.banned_agent_users from anon;
revoke all on table public.banned_agent_users from authenticated;

grant all on table public.banned_agent_users to service_role;
