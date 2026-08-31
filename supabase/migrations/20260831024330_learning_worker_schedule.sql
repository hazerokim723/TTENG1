-- Safe by default: no outgoing requests until the two Vault values are configured.
-- Filename matches the applied Supabase migration history.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create function public.turtle_dispatch_workers() returns void
language plpgsql security definer set search_path='' as $$
declare target text; secret text;
begin
 select decrypted_secret into target from vault.decrypted_secrets where name='turtle_worker_origin';
 select decrypted_secret into secret from vault.decrypted_secrets where name='turtle_worker_secret';
 if target is null or secret is null or target !~ '^https://[a-z0-9.-]+\.vercel\.app$' then return; end if;
 if exists(select 1 from public.learning_due_work()) then
  perform net.http_post(url:=target||'/api/internal/tick',headers:=jsonb_build_object('Content-Type','application/json','x-worker-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=240000);
 end if;
 if exists(select 1 from public.subscriptions where status='active' and period_end<=now())
 or exists(select 1 from public.billing_orders where status in ('processing','unknown')) then
  perform net.http_post(url:=target||'/api/internal/billing-tick',headers:=jsonb_build_object('Content-Type','application/json','x-worker-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=240000);
 end if;
end $$;
revoke all on function public.turtle_dispatch_workers() from public,anon,authenticated,service_role;
select cron.schedule('turtle-durable-workers','* * * * *','select public.turtle_dispatch_workers()');
