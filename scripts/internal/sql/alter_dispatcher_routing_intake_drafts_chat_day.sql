-- Dashboard DB: make dispatcher intake drafts expire by Jordan dispatcher day.
-- Dispatcher day starts at 02:00 Asia/Amman.

alter table public.dispatcher_routing_intake_drafts
  add column if not exists chat_day date;

update public.dispatcher_routing_intake_drafts
set chat_day = (((created_at at time zone 'Asia/Amman') - interval '2 hours')::date)
where chat_day is null;

alter table public.dispatcher_routing_intake_drafts
  alter column chat_day set not null;

do $$
declare
  v_constraint_name text;
begin
  for v_constraint_name in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'dispatcher_routing_intake_drafts'
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by a.attname::text)
        from unnest(c.conkey) as key(attnum)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = key.attnum
      ) = array['agent_id', 'chat_id', 'workspace_id']
  loop
    execute format('alter table public.dispatcher_routing_intake_drafts drop constraint %I', v_constraint_name);
  end loop;
end;
$$;

create unique index if not exists dispatcher_routing_intake_drafts_workspace_agent_chat_day_key
  on public.dispatcher_routing_intake_drafts (workspace_id, agent_id, chat_id, chat_day);
