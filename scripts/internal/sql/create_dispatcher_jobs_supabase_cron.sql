-- Dashboard DB: run the dispatcher scheduled-job processor from Supabase Cron.
--
-- One cron definition processes all due rows in public.dispatcher_scheduled_jobs.
-- Store these secrets in Supabase Vault before enabling the job:
--
--   select vault.create_secret('https://YOUR-API-DOMAIN', 'ml_api_base_url');
--   select vault.create_secret('YOUR_CRON_SECRET', 'ml_api_cron_secret');
--
-- ml_api_cron_secret must match the CRON_SECRET environment variable used by
-- api/v1/dispatcher_jobs.js.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  existing_job_id bigint;
begin
  select jobid
    into existing_job_id
  from cron.job
  where jobname = 'dispatcher-jobs-every-10-seconds'
  limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
end
$$;

select cron.schedule(
  'dispatcher-jobs-every-10-seconds',
  '10 seconds',
  $$
  select net.http_post(
    url := rtrim(
      (select decrypted_secret from vault.decrypted_secrets where name = 'ml_api_base_url' limit 1),
      '/'
    ) || '/api/v1/dispatcher_jobs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'ml_api_cron_secret' limit 1
      )
    ),
    body := jsonb_build_object(
      'source', 'supabase_cron',
      'scheduled_at', now()
    )
  ) as request_id;
  $$
);
