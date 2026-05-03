-- Dashboard DB: delayed dispatcher reply and unanswered follow-up jobs.

create table if not exists public.dispatcher_scheduled_jobs (
  id bigserial primary key,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  dispatcher_agent_id uuid not null references public.agents(id) on delete cascade,
  chat_id text not null,
  annon text not null,
  dispatcher_chat_day date not null,
  portal_chat_id bigint not null,
  job_type text not null,
  run_at timestamptz not null,
  status text not null default 'pending',
  portal_customer_message_id bigint null,
  raw_event jsonb not null default '{}'::jsonb,
  raw_connection jsonb not null default '{}'::jsonb,
  error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dispatcher_scheduled_jobs_type_chk
    check (job_type in ('initial_dispatcher_reply', 'unanswered_followup')),
  constraint dispatcher_scheduled_jobs_status_chk
    check (status in ('pending', 'running', 'done', 'cancelled', 'failed'))
);

create unique index if not exists dispatcher_scheduled_jobs_unique_pending_key
  on public.dispatcher_scheduled_jobs (
    workspace_id,
    dispatcher_agent_id,
    chat_id,
    annon,
    dispatcher_chat_day,
    portal_chat_id,
    job_type
  );

create index if not exists dispatcher_scheduled_jobs_due_idx
  on public.dispatcher_scheduled_jobs (status, run_at, id);

drop trigger if exists trg_dispatcher_scheduled_jobs_updated_at on public.dispatcher_scheduled_jobs;
create trigger trg_dispatcher_scheduled_jobs_updated_at
before update on public.dispatcher_scheduled_jobs
for each row execute function public.set_dispatcher_routing_updated_at();
