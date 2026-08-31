-- Run in the Supabase SQL editor/MCP. Every fixture is rolled back.
begin;
do $$
declare u uuid:=gen_random_uuid(); sid uuid; oid uuid; value jsonb; blocked boolean; n integer; aid text:=md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text); vid text;
begin
 insert into auth.users(id) values(u);
 vid:='q'||substr(replace(u::text,'-',''),1,10);
 insert into public.library_episodes(video_id) values(vid);
 insert into public.learning_artifacts(id,video_id,transcript_hash,analysis_version,translation_version,transcript)
 values(aid,vid,'test-hash','test-analysis','test-translation','[]');
 insert into public.artifact_chunks(artifact_id,kind,chunk_index,first_sentence,last_sentence)
 select aid,'analysis',i,i,i+1 from generate_series(0,2) i;
 if public.artifact_claim(aid,'analysis',0,gen_random_uuid()) is null then raise exception 'FAIL: first chunk'; end if;
 if public.artifact_claim(aid,'analysis',0,gen_random_uuid()) is null then raise exception 'FAIL: second chunk'; end if;
 if public.artifact_claim(aid,'analysis',0,gen_random_uuid()) is not null then raise exception 'FAIL: exceeded 2 concurrent chunks'; end if;
 update public.artifact_chunks set status='complete',result='[]' where artifact_id=aid and chunk_index=0;
 if public.artifact_claim(aid,'analysis',0,gen_random_uuid())->>'chunk_index'<>'2' then raise exception 'FAIL: completed chunk regenerated'; end if;
 for n in 1..10 loop perform public.learning_reserve(u,'qa'||lpad(n::text,9,'0')); end loop;
 blocked:=false;
 begin perform public.learning_reserve(u,'qa000000011'); exception when others then blocked:=SQLERRM='TRIAL_LIMIT'; end;
 if not blocked then raise exception 'FAIL: trial cap'; end if;
 perform public.learning_reserve(u,'qa000000001');
 if (select count(*) from public.user_episode_access where user_id=u and state='reserved')<>10 then raise exception 'FAIL: repeat charged'; end if;
 perform public.learning_finish(u,'qa000000001',null,false);
 perform public.learning_reserve(u,'qa000000011');
 if (select count(*) from public.user_episode_access where user_id=u and state='reserved')<>10 then raise exception 'FAIL: failed reservation not returned'; end if;
 perform public.learning_finish(u,'qa000000002',null,true);
 perform public.learning_finish(u,'qa000000002',null,true);
 if (select count(*) from public.learning_usage_events where user_id=u and video_id='qa000000002' and event='granted')<>1 then raise exception 'FAIL: double grant'; end if;
 -- Legacy review rights do not consume the trial.
 insert into public.user_episode_access(user_id,video_id,state,source) values(u,'old00000001','granted','legacy');
 value:=public.learning_reserve(u,'old00000001');
 if value->>'source'<>'legacy' then raise exception 'FAIL: retroactive charge'; end if;
 insert into public.platform_admins values(u);
 insert into public.subscriptions(user_id) values(u) returning id into sid;
 insert into public.billing_orders(subscription_id,period_start,period_end,amount) values(sid,now(),now()+interval '1 month',1000) returning id into oid;
 perform public.billing_fulfill(oid,'test-'||oid::text);
 perform public.billing_fulfill(oid,'test-'||oid::text);
 if (select count(*) from public.subscription_periods where user_id=u)<>1 then raise exception 'FAIL: repeated payment grant'; end if;
 for n in 1..30 loop perform public.learning_reserve(u,'sub'||lpad(n::text,8,'0')); end loop;
 blocked:=false;
 begin perform public.learning_reserve(u,'sub00000031'); exception when others then blocked:=SQLERRM='MONTHLY_LIMIT'; end;
 if not blocked then raise exception 'FAIL: monthly cap'; end if;
 update public.subscriptions set cancel_at_period_end=true where id=sid;
 if not exists(select 1 from public.subscription_periods where user_id=u and ends_at>now() and not revoked) then raise exception 'FAIL: cancel removed current rights'; end if;
 -- RLS/grants on all monetary/shared state; personal tables stay RLS protected.
 for value in select jsonb_build_object('name',tablename) from pg_tables where schemaname='public' and tablename in ('user_episode_access','platform_admins','subscriptions','billing_orders','subscription_periods','learning_artifacts','artifact_chunks','episode_translations') loop
  if has_table_privilege('authenticated','public.'||(value->>'name'),'INSERT') or has_table_privilege('anon','public.'||(value->>'name'),'UPDATE') then raise exception 'FAIL: browser can mutate %',value; end if;
 end loop;
 if has_function_privilege('authenticated','public.learning_reserve(uuid,text)','EXECUTE') then raise exception 'FAIL: browser can call quota RPC'; end if;
 if exists(select 1 from pg_tables where schemaname='public' and tablename in ('saved_words','saved_sentences','learning_progress') and not rowsecurity) then raise exception 'FAIL: personal RLS removed'; end if;
end $$;
select 'PASS: 2 chunk leases, resume/cache, free10, same-video dedupe, failure refund, legacy review, monthly30, idempotent billing, cancellation, RLS' as result;
rollback;
