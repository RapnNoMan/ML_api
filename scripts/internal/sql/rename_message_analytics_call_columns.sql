do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'message_analytics' and column_name = 'model_mini'
  ) then
    alter table public.message_analytics rename column model_mini to model_first_call;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'message_analytics' and column_name = 'model_nano'
  ) then
    alter table public.message_analytics rename column model_nano to model_second_call;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'message_analytics' and column_name = 'mini_input_tokens'
  ) then
    alter table public.message_analytics rename column mini_input_tokens to first_input_tokens;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'message_analytics' and column_name = 'mini_output_tokens'
  ) then
    alter table public.message_analytics rename column mini_output_tokens to first_output_tokens;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'message_analytics' and column_name = 'nano_input_tokens'
  ) then
    alter table public.message_analytics rename column nano_input_tokens to second_input_tokens;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'message_analytics' and column_name = 'nano_output_tokens'
  ) then
    alter table public.message_analytics rename column nano_output_tokens to second_output_tokens;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'message_analytics' and column_name = 'latency_mini_ms'
  ) then
    alter table public.message_analytics rename column latency_mini_ms to latency_first_call_ms;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'message_analytics' and column_name = 'latency_nano_ms'
  ) then
    alter table public.message_analytics rename column latency_nano_ms to latency_second_call_ms;
  end if;
end $$;
