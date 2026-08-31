-- A delayed older receipt must never roll a newer subscription period backwards.
-- Filename matches the applied Supabase migration history.
create or replace function public.billing_fulfill(p_order uuid,p_payment text) returns void
language plpgsql security invoker set search_path='' as $$
declare o public.billing_orders; s public.subscriptions;
begin
 select * into o from public.billing_orders where id=p_order for update;
 if o.id is null then raise exception 'ORDER_NOT_FOUND'; end if;
 if o.status='paid' then return; end if;
 if o.status='canceled' then raise exception 'ORDER_CANCELED'; end if;
 select * into s from public.subscriptions where id=o.subscription_id for update;
 update public.billing_orders set status='paid',payment_key=p_payment,error=null where id=o.id;
 insert into public.subscription_periods(id,user_id,starts_at,ends_at,mode)
 values(o.id,s.user_id,o.period_start,o.period_end,s.mode) on conflict do nothing;
 update public.subscriptions set status='active',anchor_at=coalesce(anchor_at,o.period_start),period_start=o.period_start,period_end=o.period_end
 where id=s.id and (period_end is null or period_end<=o.period_end);
end $$;
revoke all on function public.billing_fulfill(uuid,text) from public,anon,authenticated;
grant execute on function public.billing_fulfill(uuid,text) to service_role;
