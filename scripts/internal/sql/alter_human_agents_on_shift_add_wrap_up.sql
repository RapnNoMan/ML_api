-- Existing DB migration: add wrap_up to human_agents_on_shift

alter table if exists public.human_agents_on_shift
  add column if not exists wrap_up boolean not null default false;

create index if not exists human_agents_on_shift_wrapup_idx
  on public.human_agents_on_shift (agent_id, human_agent_user_id, is_on_shift, wrap_up, on_break, updated_at);
