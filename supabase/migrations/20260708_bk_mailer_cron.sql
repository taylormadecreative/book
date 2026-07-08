-- Enable pg_cron and drain the booking email queue every 10 minutes via pg_net.
-- The mailer secret is read from bk_config at fire time (never stored in the job).
create extension if not exists pg_cron;

select cron.schedule(
  'bk-mailer-q10',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://pgqdmnmessbbzyszjfvr.supabase.co/functions/v1/bk-mailer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mailer-secret', (select value from public.bk_config where key = 'mailer_secret')
    ),
    body := '{}'::jsonb
  )
  $$
);
