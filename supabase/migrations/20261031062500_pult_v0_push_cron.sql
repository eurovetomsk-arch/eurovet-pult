-- Каждые 5 минут база сама будит функцию pult-push: напоминания приходят без Claude.
-- При переезде на новый проект заменить адрес ikxmzapfmgqnnrsttuxc на новый.
select cron.schedule('pult-push-tick', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://ikxmzapfmgqnnrsttuxc.supabase.co/functions/v1/pult-push?action=tick',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-pult-cron', (select value from public.pult_private where key = 'cron_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000)
$job$);
