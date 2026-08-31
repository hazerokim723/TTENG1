-- All new data is server-owned. No browser role may mutate grants or payments.
-- Filename matches the version recorded by Supabase when applied through MCP.
create table public.platform_admins (user_id uuid primary key references auth.users(id) on delete cascade);
create table public.library_episodes (
 video_id text primary key check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
 title text not null default 'YouTube 영상', channel_name text not null default 'YouTube',
 duration_sec double precision not null default 0, active_artifact_id text,
 created_at timestamptz not null default now()
);
create table public.learning_artifacts (
 id text primary key, video_id text not null references public.library_episodes(video_id),
 transcript_hash text not null, analysis_version text not null, translation_version text not null,
 transcript jsonb not null, created_at timestamptz not null default now(),
 unique(video_id, transcript_hash, analysis_version, translation_version)
);
create table public.artifact_chunks (
 artifact_id text references public.learning_artifacts(id) on delete cascade,
 kind text check(kind in ('analysis','translation')), chunk_index integer,
 first_sentence integer not null, last_sentence integer not null,
 status text not null default 'pending' check(status in ('pending','running','complete','failed')),
 result jsonb not null default '[]', attempts integer not null default 0,
 lease_token uuid, lease_until timestamptz, error text, input_chars integer not null default 0,
 updated_at timestamptz not null default now(), primary key(artifact_id,kind,chunk_index)
);
create index artifact_chunks_work_idx on public.artifact_chunks(status,lease_until) where status <> 'complete';
create table public.curated_videos (
 video_id text primary key references public.library_episodes(video_id),
 description text not null default '' check(length(description)<=2000), sort_order integer not null default 0,
 published_artifact_id text references public.learning_artifacts(id), visible boolean not null default false,
 prepare_requested boolean not null default false, updated_at timestamptz not null default now()
);
create table public.platform_locks (name text primary key, token uuid not null, expires_at timestamptz not null);
create table public.subscriptions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 mode text not null default 'test' check(mode='test'), customer_key uuid not null unique default gen_random_uuid(),
 billing_key_encrypted text, auth_state text,
 status text not null default 'incomplete' check(status in ('incomplete','active','past_due','canceled')),
 anchor_at timestamptz, period_start timestamptz, period_end timestamptz,
 cancel_at_period_end boolean not null default false, created_at timestamptz not null default now(),
 unique(user_id,mode)
);
create table public.billing_orders (
 id uuid primary key default gen_random_uuid(), subscription_id uuid not null references public.subscriptions(id),
 period_start timestamptz not null, period_end timestamptz not null, amount integer not null check(amount=1000),
 status text not null default 'pending' check(status in ('pending','processing','unknown','paid','failed','canceled')),
 payment_key text unique, error text, created_at timestamptz not null default now(),
 unique(subscription_id,period_start)
);
create table public.subscription_periods (
 id uuid primary key references public.billing_orders(id), user_id uuid not null references auth.users(id),
 starts_at timestamptz not null, ends_at timestamptz not null, allowance integer not null default 30,
 mode text not null check(mode='test'), revoked boolean not null default false
);
create index subscription_periods_user_idx on public.subscription_periods(user_id,ends_at);
create table public.user_episode_access (
 user_id uuid references auth.users(id) on delete cascade, video_id text not null,
 state text not null check(state in ('reserved','granted','released')),
 source text not null check(source in ('trial','subscription','legacy')),
 period_id uuid references public.subscription_periods(id), artifact_id text references public.learning_artifacts(id),
 reservation_until timestamptz, created_at timestamptz not null default now(), granted_at timestamptz,
 primary key(user_id,video_id)
);
create index user_episode_access_usage_idx on public.user_episode_access(user_id,state,source,period_id);
create table public.learning_usage_events (
 id bigint generated always as identity primary key, user_id uuid references auth.users(id) on delete cascade,
 video_id text not null, event text not null, created_at timestamptz not null default now()
);
create table public.context_definitions (
 artifact_id text references public.learning_artifacts(id), sentence_index integer, word_key text,
 definition jsonb not null, primary key(artifact_id,sentence_index,word_key)
);
alter table public.learning_progress add column hidden boolean not null default false;
-- Preserve pre-launch access, independently of deletable progress records.
insert into public.user_episode_access(user_id,video_id,state,source,granted_at)
 select user_id,video_id,'granted','legacy',now() from public.learning_progress on conflict do nothing;

do $$ declare t text; begin
 foreach t in array array['platform_admins','library_episodes','learning_artifacts','artifact_chunks','curated_videos','platform_locks','subscriptions','billing_orders','subscription_periods','user_episode_access','learning_usage_events','context_definitions'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public, anon, authenticated',t);
 execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;
grant usage,select on sequence public.learning_usage_events_id_seq to service_role;

create function public.platform_claim_lock(p_name text,p_token uuid,p_seconds integer) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer; begin
 insert into public.platform_locks(name,token,expires_at) values(p_name,p_token,now()+make_interval(secs=>p_seconds))
 on conflict(name) do update set token=excluded.token, expires_at=excluded.expires_at
 where public.platform_locks.expires_at<now();
 get diagnostics n = row_count; return n=1;
end $$;

create function public.learning_reserve(p_user uuid,p_video text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a public.user_episode_access; per public.subscription_periods; used integer; src text; begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
 update public.user_episode_access set state='released' where user_id=p_user and state='reserved' and reservation_until<now();
 select * into a from public.user_episode_access where user_id=p_user and video_id=p_video;
 if a.state='granted' then return to_jsonb(a); end if;
 if a.state='reserved' then
  update public.user_episode_access set reservation_until=now()+interval '15 minutes' where user_id=p_user and video_id=p_video returning * into a;
  return to_jsonb(a);
 end if;
 select p.* into per from public.subscription_periods p
 join public.platform_admins adm on adm.user_id=p.user_id -- sandbox rights are admin-only
 where p.user_id=p_user and not p.revoked and p.starts_at<=now() and p.ends_at>now()
 order by p.starts_at desc limit 1;
 if per.id is not null then
  src:='subscription';
  select count(*) into used from public.user_episode_access where user_id=p_user and period_id=per.id and state in ('reserved','granted');
  if used>=per.allowance then raise exception 'MONTHLY_LIMIT'; end if;
 else
  src:='trial';
  select count(*) into used from public.user_episode_access where user_id=p_user and source='trial' and state in ('reserved','granted');
  if used>=10 then raise exception 'TRIAL_LIMIT'; end if;
 end if;
 insert into public.user_episode_access(user_id,video_id,state,source,period_id,reservation_until)
 values(p_user,p_video,'reserved',src,per.id,now()+interval '15 minutes')
 on conflict(user_id,video_id) do update set state='reserved',source=excluded.source,period_id=excluded.period_id,reservation_until=excluded.reservation_until
 returning * into a;
 insert into public.learning_usage_events(user_id,video_id,event) values(p_user,p_video,'reserved');
 return to_jsonb(a);
end $$;

create function public.learning_finish(p_user uuid,p_video text,p_artifact text,p_success boolean) returns void
language plpgsql security invoker set search_path='' as $$
declare n integer; begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
 update public.user_episode_access set state=case when p_success then 'granted' else 'released' end,
 artifact_id=case when p_success then p_artifact else artifact_id end, granted_at=case when p_success then now() else granted_at end,
 reservation_until=null where user_id=p_user and video_id=p_video and state='reserved' and reservation_until>now();
 get diagnostics n = row_count;
 if n>0 then insert into public.learning_usage_events(user_id,video_id,event) values(p_user,p_video,case when p_success then 'granted' else 'released' end); end if;
end $$;

create function public.artifact_claim(p_artifact text,p_kind text,p_near integer,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.artifact_chunks; begin
 perform pg_advisory_xact_lock(hashtextextended(p_artifact,1));
 if (select count(*) from public.artifact_chunks where artifact_id=p_artifact and status='running' and lease_until>now())>=2 then return null; end if;
 select * into c from public.artifact_chunks where artifact_id=p_artifact and kind=p_kind and attempts<3
 and (status in ('pending','failed') or (status='running' and lease_until<now()))
 order by abs(first_sentence-p_near),chunk_index for update skip locked limit 1;
 if c.artifact_id is null then return null; end if;
 update public.artifact_chunks set status='running',lease_token=p_token,lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now()
 where artifact_id=c.artifact_id and kind=c.kind and chunk_index=c.chunk_index returning * into c;
 return to_jsonb(c);
end $$;

create function public.billing_fulfill(p_order uuid,p_payment text) returns void
language plpgsql security invoker set search_path='' as $$
declare o public.billing_orders; s public.subscriptions; begin
 select * into o from public.billing_orders where id=p_order for update;
 if o.id is null then raise exception 'ORDER_NOT_FOUND'; end if;
 if o.status='paid' then return; end if;
 if o.status='canceled' then raise exception 'ORDER_CANCELED'; end if;
 select * into s from public.subscriptions where id=o.subscription_id for update;
 update public.billing_orders set status='paid',payment_key=p_payment,error=null where id=o.id;
 insert into public.subscription_periods(id,user_id,starts_at,ends_at,mode) values(o.id,s.user_id,o.period_start,o.period_end,s.mode) on conflict do nothing;
 update public.subscriptions set status='active',anchor_at=coalesce(anchor_at,o.period_start),period_start=o.period_start,period_end=o.period_end where id=s.id;
end $$;

revoke all on function public.platform_claim_lock(text,uuid,integer), public.learning_reserve(uuid,text), public.learning_finish(uuid,text,text,boolean), public.artifact_claim(text,text,integer,uuid), public.billing_fulfill(uuid,text) from public,anon,authenticated;
grant execute on function public.platform_claim_lock(text,uuid,integer), public.learning_reserve(uuid,text), public.learning_finish(uuid,text,text,boolean), public.artifact_claim(text,text,integer,uuid), public.billing_fulfill(uuid,text) to service_role;

create index curated_artifact_idx on public.curated_videos(published_artifact_id);
create index access_artifact_idx on public.user_episode_access(artifact_id);
create index access_period_idx on public.user_episode_access(period_id);
create index usage_events_user_idx on public.learning_usage_events(user_id,created_at);
create index subscriptions_due_idx on public.subscriptions(period_end) where status='active';
create index orders_recovery_idx on public.billing_orders(created_at) where status in ('processing','unknown');

create function public.learning_bind(p_user uuid,p_video text,p_artifact text) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
 if not exists(select 1 from public.learning_artifacts where id=p_artifact and video_id=p_video) then raise exception 'ARTIFACT_MISMATCH'; end if;
 update public.user_episode_access set artifact_id=p_artifact
 where user_id=p_user and video_id=p_video and state in ('reserved','granted') and artifact_id is null;
end $$;

create function public.learning_due_work() returns table(artifact_id text,kind text,first_sentence integer)
language sql security invoker set search_path='' as $$
 select c.artifact_id,c.kind,c.first_sentence from public.artifact_chunks c
 where c.attempts<3 and (c.status in ('pending','failed') or (c.status='running' and c.lease_until<now()))
 and (exists(select 1 from public.user_episode_access a where a.artifact_id=c.artifact_id and
   (a.state='granted' or (a.state='reserved' and a.reservation_until>now())))
 or exists(select 1 from public.curated_videos v join public.library_episodes e using(video_id)
   where v.prepare_requested and e.active_artifact_id=c.artifact_id))
 order by case when c.kind='analysis' and c.chunk_index=0 then 0 else 1 end,c.updated_at,c.artifact_id,c.chunk_index limit 10
$$;

create function public.learning_settle_artifact(p_artifact text) returns void
language plpgsql security invoker set search_path='' as $$
declare a public.user_episode_access; ready boolean; failed boolean;
begin
 select exists(select 1 from public.artifact_chunks where artifact_id=p_artifact and kind='analysis' and status='complete') into ready;
 select not exists(select 1 from public.artifact_chunks where artifact_id=p_artifact and kind='analysis'
   and (status='complete' or attempts<3)) into failed;
 if ready or failed then
  for a in select * from public.user_episode_access where artifact_id=p_artifact and state='reserved' order by user_id loop
   perform public.learning_finish(a.user_id,a.video_id,p_artifact,ready);
  end loop;
 end if;
end $$;

revoke all on function public.learning_bind(uuid,text,text),public.learning_due_work(),public.learning_settle_artifact(text) from public,anon,authenticated;
grant execute on function public.learning_bind(uuid,text,text),public.learning_due_work(),public.learning_settle_artifact(text) to service_role;
