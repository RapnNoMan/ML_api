alter table if exists public.human_handoff_chats
  add column if not exists customer_name text null;

alter table if exists public.human_handoff_chats
  add column if not exists message_start_id bigint null;

alter table if exists public.human_handoff_chats
  add column if not exists message_end_id bigint null;

create or replace function public.assign_human_handoff_chat(
  p_agent_id uuid,
  p_chat_source text,
  p_source text default null,
  p_chat_id text default null,
  p_annon text default null,
  p_external_user_id text default null,
  p_country text default null,
  p_customer_name text default null,
  p_message_start_id bigint default null,
  p_subject text default null,
  p_summery text default null
)
returns table(
  created boolean,
  handoff_chat_id bigint,
  assigned_human_agent_user_id uuid,
  shift_id bigint,
  status text
)
language plpgsql
as $$
declare
  v_existing public.human_handoff_chats%rowtype;
  v_last_assigned_user_id uuid;
  v_assigned_user_id uuid;
  v_assigned_shift_id bigint;
  v_subject text;
  v_summery text;
begin
  if p_agent_id is null then
    raise exception 'MISSING_AGENT_ID';
  end if;
  if p_chat_source is null or btrim(p_chat_source) = '' then
    raise exception 'MISSING_CHAT_SOURCE';
  end if;
  if p_chat_id is null or btrim(p_chat_id) = '' then
    raise exception 'MISSING_CHAT_ID';
  end if;

  v_subject := nullif(btrim(coalesce(p_subject, '')), '');
  v_summery := nullif(btrim(coalesce(p_summery, '')), '');
  if v_subject is null then
    v_subject := 'Human support request';
  end if;
  if v_summery is null then
    v_summery := 'User requested human support.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('human_handoff_agent:' || p_agent_id::text, 0));

  select *
  into v_existing
  from public.human_handoff_chats h
  where h.agent_id = p_agent_id
    and h.chat_source = p_chat_source
    and h.chat_id = p_chat_id
    and h.status <> 'closed'
  order by h.created_at desc
  limit 1;

  if found then
    return query
    select
      false as created,
      v_existing.id as handoff_chat_id,
      v_existing.assigned_human_agent_user_id as assigned_human_agent_user_id,
      v_existing.shift_id as shift_id,
      v_existing.status as status;
    return;
  end if;

  select s.last_assigned_human_agent_user_id
  into v_last_assigned_user_id
  from public.human_handoff_assignment_state s
  where s.agent_id = p_agent_id
  for update;

  with eligible_shifts as (
    select
      hs.id as shift_id,
      hs.human_agent_user_id,
      hs.max_concurrent_chats,
      coalesce(ac.active_count, 0)::integer as active_count
    from public.human_agents_on_shift hs
    left join lateral (
      select count(*) as active_count
      from public.human_handoff_chats hc
      where hc.agent_id = hs.agent_id
        and hc.assigned_human_agent_user_id = hs.human_agent_user_id
        and hc.status = 'active'
    ) ac on true
    where hs.agent_id = p_agent_id
      and hs.is_on_shift = true
      and hs.on_break = false
      and hs.wrap_up = false
  ),
  capacity_ok as (
    select *
    from eligible_shifts
    where max_concurrent_chats is null or active_count < max_concurrent_chats
  ),
  ordered as (
    select
      e.shift_id,
      e.human_agent_user_id,
      row_number() over (order by e.shift_id asc) as rn,
      count(*) over () as total_count
    from capacity_ok e
  ),
  pivot as (
    select rn as last_rn
    from ordered
    where human_agent_user_id = v_last_assigned_user_id
    order by rn
    limit 1
  ),
  choice as (
    select o.shift_id, o.human_agent_user_id
    from ordered o
    order by
      case
        when (select last_rn from pivot) is null then rn
        when rn > (select last_rn from pivot) then rn - (select last_rn from pivot)
        else rn + total_count - (select last_rn from pivot)
      end
    limit 1
  )
  select c.human_agent_user_id, c.shift_id
  into v_assigned_user_id, v_assigned_shift_id
  from choice c;

  if v_assigned_user_id is null or v_assigned_shift_id is null then
    raise exception 'NO_AVAILABLE_HUMAN_AGENT';
  end if;

  insert into public.human_handoff_chats (
    agent_id,
    chat_source,
    source,
    chat_id,
    annon,
    external_user_id,
    country,
    customer_name,
    message_start_id,
    subject,
    summery,
    assigned_human_agent_user_id,
    shift_id,
    status
  )
  values (
    p_agent_id,
    p_chat_source,
    p_source,
    p_chat_id,
    p_annon,
    p_external_user_id,
    p_country,
    nullif(btrim(coalesce(p_customer_name, '')), ''),
    p_message_start_id,
    v_subject,
    v_summery,
    v_assigned_user_id,
    v_assigned_shift_id,
    'active'
  )
  returning *
  into v_existing;

  insert into public.human_handoff_assignment_state (
    agent_id,
    last_assigned_human_agent_user_id,
    last_assigned_at,
    updated_at
  )
  values (
    p_agent_id,
    v_assigned_user_id,
    now(),
    now()
  )
  on conflict (agent_id)
  do update set
    last_assigned_human_agent_user_id = excluded.last_assigned_human_agent_user_id,
    last_assigned_at = excluded.last_assigned_at,
    updated_at = excluded.updated_at;

  return query
  select
    true as created,
    v_existing.id as handoff_chat_id,
    v_existing.assigned_human_agent_user_id as assigned_human_agent_user_id,
    v_existing.shift_id as shift_id,
    v_existing.status as status;
end;
$$;
