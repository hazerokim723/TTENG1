"""Durable shared lessons, server-authorized access, and library endpoints."""
from __future__ import annotations

import hashlib
import hmac
import os
import re
from datetime import datetime, timezone, timedelta
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .platform_store import admin, db, is_admin, rows, rpc, upsert, user


def utcnow():
    return datetime.now(timezone.utc)


def live_until(value):
    return bool(value and datetime.fromisoformat(value.replace('Z', '+00:00')) > utcnow())


class StartRequest(BaseModel):
    youtube_url: str = Field(min_length=1, max_length=2048)


class WorkRequest(BaseModel):
    artifact_id: str = Field(pattern=r'^[a-f0-9]{64}$')
    kind: str = Field(default='analysis', pattern=r'^(analysis|translation)$')
    near: int = Field(default=0, ge=0)


class LookupRequest(WorkRequest):
    word: str = Field(min_length=1, max_length=80)
    sentence_index: int = Field(ge=0)
    clicked_offset: int = Field(ge=0)


class CuratedRequest(StartRequest):
    description: str = Field(default='', max_length=2000)
    sort_order: int = Field(default=0, ge=0, le=100000)
    visible: bool = False


class Platform:
    def __init__(self, engine):
        self.e = engine

    def video(self, value):
        try:
            return self.e.extract_video_id(value)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    def artifact(self, artifact_id):
        result = rows('learning_artifacts', id=f'eq.{artifact_id}', limit='1')
        if not result:
            raise HTTPException(404, '학습 자료를 찾을 수 없습니다.')
        return result[0]

    def access(self, uid, artifact, allow_admin=True):
        if allow_admin and is_admin(uid):
            return {'source': 'admin', 'state': 'granted'}
        records = rows('user_episode_access', user_id=f'eq.{uid}', video_id=f'eq.{artifact["video_id"]}', limit='1')
        if not records or records[0]['state'] not in ('granted', 'reserved'):
            raise HTTPException(403, '먼저 이 영상의 AI 학습을 시작해 주세요.')
        access = records[0]
        if access['state'] == 'reserved' and not live_until(access.get('reservation_until')):
            raise HTTPException(409, '학습 준비 예약이 만료되었습니다. 학습 시작을 다시 눌러 주세요.')
        if access.get('artifact_id') != artifact['id']:
            raise HTTPException(403, '이 계정에 제공된 버전의 학습 자료만 이용할 수 있습니다.')
        return access

    def can_generate(self, uid, artifact, access):
        # A video already granted remains usable, including finishing missing chunks.
        # access() pins the original artifact, so this cannot generate arbitrary new versions.
        return access['state'] in ('reserved', 'granted')

    def ensure_artifact(self, video_id):
        existing = rows('library_episodes', video_id=f'eq.{video_id}', limit='1')
        if existing and existing[0].get('active_artifact_id'):
            candidate = self.artifact(existing[0]['active_artifact_id'])
            if candidate['analysis_version'] == self.e.ANALYSIS_VERSION and candidate['translation_version'] == self.e.TRANSLATION_VERSION:
                return candidate
        token = str(uuid4())
        name = f'prepare:{video_id}'
        if not rpc('platform_claim_lock', p_name=name, p_token=token, p_seconds=240):
            raise HTTPException(409, '다른 요청에서 이 영상의 자막을 준비 중입니다. 잠시 후 다시 시도해 주세요.')
        try:
            if not existing:
                upsert('library_episodes', {'video_id': video_id}, 'video_id', ignore=True)
            entries = self.e.fetch_caption_entries(video_id)
            blocks = [b.model_dump() for b in self.e.build_transcript_blocks(entries)]
            if not blocks:
                raise HTTPException(400, '이 영상에서 사용할 수 있는 영어 자막을 찾지 못했습니다.')
            title, channel = self.e.fetch_video_metadata(video_id)
            canonical = '\n'.join(f'{b["timestamp_sec"]:.3f}|{re.sub(r"\s+", " ", b["text"]).strip()}' for b in blocks)
            digest = hashlib.sha256(canonical.encode()).hexdigest()
            identity = '|'.join([video_id, digest, self.e.ANALYSIS_VERSION, self.e.TRANSLATION_VERSION])
            aid = hashlib.sha256(identity.encode()).hexdigest()
            artifact = {'id': aid, 'video_id': video_id, 'transcript_hash': digest, 'analysis_version': self.e.ANALYSIS_VERSION,
                        'translation_version': self.e.TRANSLATION_VERSION, 'transcript': blocks}
            upsert('learning_artifacts', artifact, 'id', ignore=True)
            chunks = []
            for kind, size in [('analysis', 20), ('translation', 25)]:
                for index, start in enumerate(range(0, len(blocks), size)):
                    end = min(start + size, len(blocks))
                    chunks.append({'artifact_id': aid, 'kind': kind, 'chunk_index': index, 'first_sentence': start,
                                   'last_sentence': end, 'input_chars': sum(len(b['text']) for b in blocks[start:end])})
            # No artificial video-length/chunk-count cap. PostgREST writes are bounded.
            for start in range(0, len(chunks), 200):
                upsert('artifact_chunks', chunks[start:start+200], 'artifact_id,kind,chunk_index', ignore=True)
            db('library_episodes', 'PATCH', params={'video_id': f'eq.{video_id}'}, body={'title': title, 'channel_name': channel,
               'duration_sec': blocks[-1]['end_sec'], 'active_artifact_id': aid})
            return artifact
        except HTTPException:
            raise
        except Exception as exc:
            message = '영어 자막 준비에 실패했습니다. 영상 공개 상태와 Supadata 설정을 확인해 주세요.'
            raise HTTPException(502, message) from exc
        finally:
            db('platform_locks', 'DELETE', params={'name': f'eq.{name}', 'token': f'eq.{token}'})

    def chunks(self, aid):
        # Supabase's default row cap must not truncate long episodes.
        result = []
        for offset in range(0, 1000000, 500):
            batch = rows('artifact_chunks', artifact_id=f'eq.{aid}', order='kind.asc,chunk_index.asc', limit='500', offset=str(offset))
            result.extend(batch)
            if len(batch) < 500:
                return result
        raise HTTPException(413, '학습 자료 목록이 너무 큽니다.')

    def snapshot(self, artifact):
        chunks = self.chunks(artifact['id'])
        analyses = [c for c in chunks if c['kind'] == 'analysis']
        translations = [c for c in chunks if c['kind'] == 'translation']
        completed = [c for c in analyses if c['status'] == 'complete']
        info = rows('library_episodes', video_id=f'eq.{artifact["video_id"]}', limit='1')[0]
        failed = [c for c in chunks if c['status'] == 'failed' and c['attempts'] >= 3]
        return {'episode_id': artifact['video_id'], 'artifact_id': artifact['id'], 'transcript_hash': artifact['transcript_hash'],
                'title': info['title'], 'source_name': info['channel_name'], 'duration_sec': info['duration_sec'],
                'transcript': artifact['transcript'], 'learning_items': [i for c in completed for i in c['result']],
                'translations': [i for c in translations if c['status'] == 'complete' for i in c['result']],
                'analysis_version': artifact['analysis_version'], 'translation_version': artifact['translation_version'],
                'analysis_status': 'complete' if len(completed) == len(analyses) else 'error' if failed else 'pending',
                'completed_chunks': len(completed), 'total_chunks': len(analyses), 'cached': bool(completed),
                'ready': bool(chunks) and all(c['status'] == 'complete' for c in chunks),
                'error': failed[0]['error'] if failed else None,
                'work': [{'kind': c['kind'], 'first_sentence': c['first_sentence'], 'status': c['status']} for c in chunks]}

    def complete_access(self, uid, artifact):
        if rows('artifact_chunks', artifact_id=f'eq.{artifact["id"]}', kind='eq.analysis', status='eq.complete', limit='1'):
            rpc('learning_finish', p_user=uid, p_video=artifact['video_id'], p_artifact=artifact['id'], p_success=True)

    def process(self, artifact, kind, near):
        token = str(uuid4())
        chunk = rpc('artifact_claim', p_artifact=artifact['id'], p_kind=kind, p_near=near, p_token=token)
        if not chunk:
            return
        filters = {'artifact_id': f'eq.{artifact["id"]}', 'kind': f'eq.{kind}', 'chunk_index': f'eq.{chunk["chunk_index"]}', 'lease_token': f'eq.{token}'}
        try:
            key = os.getenv('OPENAI_API_KEY', '').strip()
            if not key:
                raise HTTPException(503, '서버 OpenAI 키를 설정해 주세요.')
            blocks = artifact['transcript']
            indices = range(chunk['first_sentence'], chunk['last_sentence'])
            if kind == 'analysis':
                text = '\n'.join(f'[sentence_index={i}] [{blocks[i]["timestamp_sec"]:.3f}s] {blocks[i]["text"]}' for i in indices)
                items = self.e.analyze_chunk(text, chunk['chunk_index']+1, len([c for c in self.chunks(artifact['id']) if c['kind']=='analysis']), key)
                result = [item.model_dump(by_alias=True) for item in items]
            else:
                info = rows('library_episodes', video_id=f'eq.{artifact["video_id"]}', limit='1')[0]
                payload = self.e.TranslationBatchRequest(video_id=artifact['video_id'], transcript_hash=artifact['transcript_hash'],
                    translation_version=artifact['translation_version'], total_sentences=len(blocks), title=info['title'], channel_name=info['channel_name'],
                    sentences=[{'sentence_index':i,'text':blocks[i]['text'],'previous_text':blocks[i-1]['text'] if i else '',
                                'next_text':blocks[i+1]['text'] if i+1<len(blocks) else ''} for i in indices])
                cached = {x['sentence_index']: self.e.TranslationItem.model_validate(x) for x in rows('episode_translations',
                    video_id=f'eq.{artifact["video_id"]}', transcript_hash=f'eq.{artifact["transcript_hash"]}',
                    translation_version=f'eq.{artifact["translation_version"]}', sentence_index=f'in.({",".join(str(i) for i in indices)})')}
                missing = [s for s in payload.sentences if s.sentence_index not in cached]
                if missing:
                    pending = payload.model_copy(update={'sentences':missing})
                    generated = self.e.translate_sentences(pending, key)
                    self.e.write_supabase_translations(pending, generated)
                    cached.update({x.sentence_index:x for x in generated})
                if any(i not in cached for i in indices):
                    raise HTTPException(502, '일부 번역이 누락되어 해당 구간을 재시도합니다.')
                result = [cached[i].model_dump() for i in indices]
            db('artifact_chunks', 'PATCH', params=filters, body={'status':'complete','result':result,'error':None,'lease_until':None,'updated_at':utcnow().isoformat()})
        except Exception as exc:
            message = str(exc.detail) if isinstance(exc,HTTPException) else self.e.public_analysis_error(exc)
            db('artifact_chunks', 'PATCH', params=filters, body={'status':'failed','error':message,'lease_until':None,'updated_at':utcnow().isoformat()})
            raise HTTPException(502, message) from exc

    def usage(self, uid):
        records = []
        offset = 0
        while True:
            batch = rows('user_episode_access', user_id=f'eq.{uid}', select='state,source,period_id,reservation_until', order='video_id.asc', offset=str(offset), limit='500')
            records.extend(batch)
            if len(batch) < 500: break
            offset += 500
        active = [r for r in records if r['state']=='granted' or r['state']=='reserved' and live_until(r.get('reservation_until'))]
        free = sum(r['source']=='trial' for r in active)
        periods = rows('subscription_periods', user_id=f'eq.{uid}', revoked='eq.false', starts_at=f'lte.{utcnow().isoformat()}', ends_at=f'gt.{utcnow().isoformat()}', order='starts_at.desc',limit='1') if is_admin(uid) else []
        period = periods[0] if periods else None
        used = sum(r['period_id']==period['id'] for r in active) if period else free
        return {'is_admin':is_admin(uid), 'plan':'test_subscription' if period else 'trial', 'limit':30 if period else 10,
                'remaining':max(0,(30 if period else 10)-used), 'free_remaining':max(0,10-free)}


def install(app, engine):
    service = Platform(engine)
    app.state.platform = service
    router = APIRouter(prefix='/api')

    @app.middleware('http')
    async def retire_unguarded_api(request, call_next):
        path = request.url.path
        if path.startswith(('/api/episodes/', '/api/translations', '/api/vocabulary/')) or path == '/api/openai/validate':
            if request.method != 'OPTIONS':
                return JSONResponse({'detail':'새 학습 보안 API로 변경되었습니다. 페이지를 새로고침해 주세요.'}, status_code=410)
        return await call_next(request)

    @router.get('/account/usage')
    def usage(request: Request):
        return service.usage(user(request)['id'])

    @router.post('/account/connection')
    def connection(request: Request):
        uid=user(request)['id']
        if not rpc('platform_claim_lock',p_name=f'connection:{uid}',p_token=str(uuid4()),p_seconds=60):
            raise HTTPException(429,'연결 확인은 1분 후 다시 시도할 수 있습니다.')
        key=os.getenv('OPENAI_API_KEY','').strip()
        if not key: raise HTTPException(503,'서버의 OpenAI API 키를 설정해 주세요.')
        try: engine.validate_openai_connection(key)
        except Exception as exc: raise HTTPException(502,engine.public_analysis_error(exc)) from exc
        return {'status':'connected','model':engine.OPENAI_MODEL}

    @router.get('/library')
    def library():
        curated = rows('curated_videos', visible='eq.true', order='sort_order.asc,video_id.asc')
        result=[]
        for c in curated:
            episode=rows('library_episodes',video_id=f'eq.{c["video_id"]}',limit='1')[0]
            result.append({k:v for k,v in {**episode,**c}.items() if k not in ('active_artifact_id','published_artifact_id','prepare_requested')})
        return result

    @router.get('/library/mine')
    def mine(request: Request):
        return rows('learning_progress',user_id=f'eq.{user(request)["id"]}',hidden='eq.false',order='last_studied_at.desc')

    @router.get('/library/video/{video_id}')
    def video_metadata(video_id: str):
        vid=service.video(video_id)
        found=rows('library_episodes',video_id=f'eq.{vid}',limit='1')
        if found and found[0]['title']!='YouTube 영상':
            return {k:found[0][k] for k in ('video_id','title','channel_name','duration_sec')}
        if not rpc('platform_claim_lock',p_name=f'metadata:{vid}',p_token=str(uuid4()),p_seconds=30):
            raise HTTPException(429,'영상 정보를 확인 중입니다.')
        title,channel=engine.fetch_video_metadata(vid)
        upsert('library_episodes',{'video_id':vid,'title':title,'channel_name':channel},'video_id')
        return {'video_id':vid,'title':title,'channel_name':channel,'duration_sec':0}

    @router.post('/learning/start')
    def start(payload: StartRequest, request: Request):
        uid=user(request)['id']; vid=service.video(payload.youtube_url)
        reservation=rpc('learning_reserve',p_user=uid,p_video=vid)
        try:
            published=rows('curated_videos',video_id=f'eq.{vid}',visible='eq.true',limit='1')
            aid=reservation.get('artifact_id') or (published[0].get('published_artifact_id') if published else None)
            artifact=service.artifact(aid) if aid else service.ensure_artifact(vid)
            # Legacy rights are pinned once too; no retroactive charge for existing videos.
            rpc('learning_bind', p_user=uid, p_video=vid, p_artifact=artifact['id'])
            db('artifact_chunks','PATCH',params={'artifact_id':f'eq.{artifact["id"]}','status':'eq.failed','updated_at':f'lt.{(utcnow() - timedelta(minutes=5)).isoformat()}'},body={'attempts':0,'status':'pending'})
            service.complete_access(uid,artifact)
            response=service.snapshot(artifact)
            previous=rows('learning_progress',user_id=f'eq.{uid}',video_id=f'eq.{vid}',limit='1')
            record={'user_id':uid,'video_id':vid,'video_title':response['title'],'channel_name':response['source_name'],
                    'duration_sec':response['duration_sec'],'hidden':False,'last_studied_at':utcnow().isoformat()}
            if previous: record={**previous[0],**record}
            upsert('learning_progress',record,'user_id,video_id')
            response['usage']=service.usage(uid)
            return response
        except HTTPException as exc:
            if exc.status_code != 409:
                rpc('learning_finish',p_user=uid,p_video=vid,p_artifact=None,p_success=False)
            raise

    @router.get('/learning/{artifact_id}')
    def lesson(artifact_id: str, request: Request):
        uid=user(request)['id']; artifact=service.artifact(artifact_id)
        service.access(uid,artifact); service.complete_access(uid,artifact)
        return service.snapshot(artifact)

    @router.post('/learning/work')
    def work(payload: WorkRequest, request: Request):
        uid=user(request)['id']; artifact=service.artifact(payload.artifact_id)
        access=service.access(uid,artifact)
        if not service.can_generate(uid,artifact,access):
            return service.snapshot(artifact)
        try:
            service.process(artifact,payload.kind,payload.near)
            service.complete_access(uid,artifact)
        except HTTPException:
            if not rows('artifact_chunks',artifact_id=f'eq.{artifact["id"]}',status='in.(complete,running)',limit='1'):
                rpc('learning_finish',p_user=uid,p_video=artifact['video_id'],p_artifact=None,p_success=False)
            raise
        return service.snapshot(artifact)

    @router.post('/learning/lookup')
    def lookup(payload: LookupRequest, request: Request):
        uid=user(request)['id']; artifact=service.artifact(payload.artifact_id); access=service.access(uid,artifact)
        blocks=artifact['transcript']
        if payload.sentence_index>=len(blocks): raise HTTPException(400,'문장 번호가 올바르지 않습니다.')
        context=blocks[payload.sentence_index]['text']; offset=payload.clicked_offset
        if context[offset:offset+len(payload.word)].casefold()!=payload.word.casefold(): raise HTTPException(400,'원문의 단어 위치와 일치하지 않습니다.')
        cached=rows('context_definitions',artifact_id=f'eq.{artifact["id"]}',sentence_index=f'eq.{payload.sentence_index}',word_key=f'eq.{payload.word.casefold()}',limit='1')
        if cached: return cached[0]['definition']
        if not service.can_generate(uid,artifact,access): raise HTTPException(403,'저장된 뜻은 계속 복습할 수 있어요. 새로운 AI 해설은 구독이 필요합니다.')
        token=str(uuid4()); lock=f'lookup:{uid}'
        if not rpc('platform_claim_lock',p_name=lock,p_token=token,p_seconds=2): raise HTTPException(429,'잠시 후 다른 단어를 선택해 주세요.')
        value=engine.define_word(payload.word,context,offset,os.environ.get('OPENAI_API_KEY','')).model_dump(by_alias=True)
        upsert('context_definitions',{'artifact_id':artifact['id'],'sentence_index':payload.sentence_index,'word_key':payload.word.casefold(),'definition':value},'artifact_id,sentence_index,word_key')
        return value

    @router.get('/admin/library')
    def admin_library(request: Request):
        admin(request); result=[]
        for c in rows('curated_videos',order='sort_order.asc,video_id.asc'):
            episode=rows('library_episodes',video_id=f'eq.{c["video_id"]}',limit='1')[0]
            aid=episode.get('active_artifact_id'); chunks=service.chunks(aid) if aid else []
            result.append({**episode,**c,'ready':bool(chunks) and all(x['status']=='complete' for x in chunks),
                           'completed':sum(x['status']=='complete' for x in chunks),'total':len(chunks),
                           'api_attempts':sum(x['attempts'] for x in chunks),'input_chars':sum(x['input_chars'] for x in chunks),
                           'error':next((x['error'] for x in chunks if x.get('error')),None)})
        return result

    @router.post('/admin/library')
    def edit(payload: CuratedRequest, request: Request):
        admin(request); vid=service.video(payload.youtube_url)
        upsert('library_episodes',{'video_id':vid},'video_id',ignore=True)
        existing=rows('library_episodes',video_id=f'eq.{vid}',limit='1')[0]
        aid=existing.get('active_artifact_id')
        if payload.visible and (not aid or not service.snapshot(service.artifact(aid))['ready']):
            raise HTTPException(409,'전체 자막·받아쓰기·번역 준비가 완료된 뒤 공개할 수 있습니다.')
        return upsert('curated_videos',{'video_id':vid,'description':payload.description,'sort_order':payload.sort_order,
                       'visible':payload.visible,'published_artifact_id':aid if payload.visible else None,'updated_at':utcnow().isoformat()},'video_id')

    @router.post('/admin/library/prepare')
    def prepare(payload: StartRequest, request: Request):
        admin(request); vid=service.video(payload.youtube_url)
        if not rows('curated_videos',video_id=f'eq.{vid}',limit='1'): raise HTTPException(404,'먼저 추천 영상에 등록해 주세요.')
        artifact=service.ensure_artifact(vid)
        db('curated_videos','PATCH',params={'video_id':f'eq.{vid}'},body={'prepare_requested':True})
        db('artifact_chunks','PATCH',params={'artifact_id':f'eq.{artifact["id"]}','status':'eq.failed'},body={'attempts':0,'status':'pending'})
        return service.snapshot(artifact)

    @router.post('/internal/tick')
    def tick(request: Request):
        expected=os.getenv('INTERNAL_WORKER_SECRET','')
        if not expected or not hmac.compare_digest(request.headers.get('x-worker-secret',''),expected): raise HTTPException(403,'Forbidden')
        # Bounded, durable work. No detached post-response tasks on Vercel.
        jobs=rpc('learning_due_work') or []
        worked=0
        for job in jobs[:1]:
            aid=job['artifact_id']
            artifact=service.artifact(aid); snapshot=service.snapshot(artifact)
            try: service.process(artifact,job['kind'],job['first_sentence'])
            except HTTPException: pass
            worked+=1
            rpc('learning_settle_artifact',p_artifact=aid)
        return {'processed':worked}

    @router.post('/internal/billing-tick')
    def billing_tick(request: Request):
        expected=os.getenv('INTERNAL_WORKER_SECRET','')
        if not expected or not hmac.compare_digest(request.headers.get('x-worker-secret',''),expected): raise HTTPException(403,'Forbidden')
        from .subscriptions import run_due
        return run_due()

    app.include_router(router)
    from .subscriptions import install_billing
    install_billing(app)
