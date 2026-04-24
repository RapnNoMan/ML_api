-- Existing DB migration: add shift_id to human_handoff_chats

alter table if exists public.human_handoff_chats
  add column if not exists shift_id bigint null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'human_handoff_chats_shift_id_fkey'
  ) then
    alter table public.human_handoff_chats
      add constraint human_handoff_chats_shift_id_fkey
      foreign key (shift_id)
      references public.human_agents_on_shift (id)
      on update cascade
      on delete set null;
  end if;
end $$;

create index if not exists human_handoff_chats_shift_idx
  on public.human_handoff_chats using btree (shift_id);

