import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { User } from '@supabase/supabase-js'
import type { LearningItem, TranscriptBlock } from './App'
import { supabase } from './supabase'

const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
export type Usage = { is_admin: boolean; plan: string; limit: number; remaining: number; free_remaining: number }
export type LessonSnapshot = {
  episode_id: string; artifact_id: string; transcript_hash: string; title: string; source_name: string; duration_sec: number
  transcript: TranscriptBlock[]; learning_items: LearningItem[]; translations: Array<{ sentence_index: number; translation_kr: string }>
  analysis_status: 'complete' | 'pending' | 'error'; analysis_version: string; translation_version: string; completed_chunks: number; total_chunks: number
  ready: boolean; cached: boolean; can_generate?: boolean; error?: string; usage?: Usage; work: Array<{ kind: string; first_sentence: number; status: string }>
}

export async function platformFetch(path: string, options: RequestInit = {}) {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null
  const headers = new Headers(options.headers)
  if (session) headers.set('Authorization', `Bearer ${session.access_token}`)
  if (options.body) headers.set('Content-Type', 'application/json')
  const timeout = AbortSignal.timeout(options.method === 'POST' ? 180_000 : 20_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  return fetch(`${base}${path}`, { ...options, headers, signal })
}

export async function platformJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await platformFetch(path, options)
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(typeof data?.detail === 'string' ? data.detail : `서버 요청을 완료하지 못했습니다. (${response.status})`)
  return data as T
}

export function UsageNotice({ usage }: { usage: Usage | null }) {
  if (!usage) return <p className="usage-notice">Google 로그인 후 새 영상 10개를 무료로 AI 학습할 수 있어요. 영상 재생은 누구나 가능합니다.</p>
  return <p className="usage-notice" role="status">{usage.plan === 'trial' ? `무료 AI 학습 가능 횟수가 10회 중 ${usage.remaining}회 남았습니다.` : `테스트 구독 · 이번 이용 기간의 새 영상 학습이 30개 중 ${usage.remaining}개 남았습니다.`} <small>이미 학습한 영상은 추가 차감 없이 복습해요.</small></p>
}

export function LearningUsageDialog({ signedIn, onClose, onLearn, onPlay }: {
  signedIn: boolean; onClose: () => void; onLearn: () => void; onPlay: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [loading, setLoading] = useState(signedIn)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const element = dialog.current
    const previousFocus = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => { element?.close(); previousFocus?.focus() }
  }, [])

  useEffect(() => {
    if (!signedIn) return
    const controller = new AbortController()
    setLoading(true); setError('')
    void platformJson<Usage>('/api/account/usage', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setUsage(data) })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '남은 횟수를 확인하지 못했어요.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [signedIn, attempt])

  return createPortal(<dialog ref={dialog} className="learning-usage-dialog" aria-labelledby="learning-usage-title" onCancel={onClose}>
    <button type="button" className="usage-dialog-close" onClick={onClose} aria-label="학습 안내 닫기" autoFocus>×</button>
    <span className="eyebrow">YOUR ENGLISH JOURNEY</span>
    <h2 id="learning-usage-title">학습을 시작할까요?</h2>
    {loading ? <p className="usage-notice" role="status">남은 AI 학습 횟수를 확인하고 있어요…</p>
      : error ? <p className="url-error" role="alert">{error} <button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>다시 확인</button></p>
      : <UsageNotice usage={usage} />}
    <div className="usage-dialog-actions">
      <button type="button" className="usage-dialog-secondary" onClick={onPlay}>영상만 재생 · 무료</button>
      <button type="button" className="usage-dialog-primary" onClick={onLearn} disabled={loading || Boolean(error)}>{signedIn ? '학습 시작 →' : 'Google 로그인'}</button>
    </div>
  </dialog>, document.body)
}

type Video = { video_id: string; title?: string; video_title?: string; channel_name?: string; description?: string; duration_sec?: number; sort_order?: number; visible?: boolean; ready?: boolean; completed?: number; total?: number; api_attempts?: number; input_chars?: number; error?: string; progress_percent?: number; last_studied_at?: string }
type LibraryProps = { user: User | null; isAdmin: boolean; onLogin: () => void; onPlay: (video: Video) => void; onLearn: (url: string) => void; onPrepared: (lesson: LessonSnapshot) => void }

export function Library({ user, isAdmin, onLogin, onPlay, onLearn, onPrepared }: LibraryProps) {
  const [view, setView] = useState<'recommended' | 'mine' | 'admin'>('recommended')
  const [videos, setVideos] = useState<Video[]>([])
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false)
  const [url, setUrl] = useState(''); const [description, setDescription] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true; setError(''); setVideos([])
    if (view === 'mine' && !user) return
    if (view === 'admin' && !isAdmin) { setView('recommended'); return }
    setLoading(true)
    platformJson<Video[]>(view === 'recommended' ? '/api/library' : view === 'mine' ? '/api/library/mine' : '/api/admin/library')
      .then((value) => { if (active) setVideos(value) }).catch((e: Error) => { if (active) setError(e.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [view, user?.id, isAdmin, refresh])
  async function addVideo() {
    setLoading(true); setError('')
    try { await platformJson('/api/admin/library', { method: 'POST', body: JSON.stringify({ youtube_url: url, description, sort_order: videos.length }) }); setUrl(''); setDescription(''); setRefresh((v) => v + 1) }
    catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }
  return <section className="center-panel library-panel">
    <span className="eyebrow">YOUR ENGLISH LIBRARY</span><h2>재생목록</h2>
    <div className="library-tabs"><button aria-pressed={view === 'recommended'} onClick={() => setView('recommended')}>추천 영상</button><button aria-pressed={view === 'mine'} onClick={() => setView('mine')}>내 영상</button>{isAdmin && <button aria-pressed={view === 'admin'} onClick={() => setView('admin')}>관리</button>}</div>
    {view === 'admin' && <div className="library-editor"><label>YouTube 링크<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtu.be/..." /></label><label>직접 작성한 소개글<textarea value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} /></label><button disabled={loading || !url.trim()} onClick={addVideo}>추천 영상 등록</button></div>}
    {view === 'mine' && !user ? <div className="empty-state">내 영상과 학습 진도를 계정에 보관하세요.<button onClick={onLogin}>Google 로그인</button></div> : loading ? <p role="status">재생목록을 불러오는 중…</p> : !videos.length && !error ? <p className="empty-state">{view === 'mine' ? '학습을 시작한 영상이 여기에 자동으로 저장됩니다.' : '아직 공개된 추천 영상이 없습니다.'}</p> : null}
    {error && <p role="alert" className="url-error">{error}</p>}
    <div className="library-grid">{videos.map((video) => <div className="library-video" key={video.video_id}>
      <img src={`https://i.ytimg.com/vi/${video.video_id}/hqdefault.jpg`} alt="" loading="lazy" />
      <small>YouTube · {video.channel_name || 'YouTube'}</small><h3>{video.title || video.video_title || 'YouTube 영상'}</h3>
      {video.description && <p>{video.description}</p>}
      {view === 'mine' && <small>진도 {Math.round(video.progress_percent || 0)}% · {video.last_studied_at ? new Date(video.last_studied_at).toLocaleDateString('ko-KR') : ''}</small>}
      <div className="library-actions"><button onClick={() => onPlay(video)}>영상 보기</button><button onClick={() => onLearn(`https://youtu.be/${video.video_id}`)}>{view === 'mine' ? '학습 이어보기' : 'AI 학습 시작'}</button></div>
      {view === 'mine' && <button className="quiet-button" onClick={async () => { const { error: failure } = await supabase!.from('learning_progress').update({ hidden: true }).eq('user_id', user!.id).eq('video_id', video.video_id); if (failure) setError('목록에서 숨기지 못했습니다.'); else setRefresh((v) => v + 1) }}>목록에서 숨기기</button>}
      {view === 'admin' && <VideoEditor video={video} onPrepared={onPrepared} onUpdated={() => setRefresh((v) => v + 1)} />}
    </div>)}</div>
  </section>
}

function VideoEditor({ video, onPrepared, onUpdated }: { video: Video; onPrepared: LibraryProps['onPrepared']; onUpdated: () => void }) {
  const [description, setDescription] = useState(video.description || '')
  const [order, setOrder] = useState(video.sort_order || 0)
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  async function save(visible: boolean) {
    setBusy(true); setError('')
    try { await platformJson('/api/admin/library', { method: 'POST', body: JSON.stringify({ youtube_url: video.video_id, description, sort_order: order, visible }) }); onUpdated() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function prepare() {
    setBusy(true); setError('')
    try { onPrepared(await platformJson<LessonSnapshot>('/api/admin/library/prepare', { method: 'POST', body: JSON.stringify({ youtube_url: video.video_id }) })) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <div className="library-editor"><label>소개글<textarea value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} /></label><label>노출 순서<input type="number" min="0" max="100000" value={order} onChange={(e) => setOrder(Number(e.target.value))} /></label><small>{video.ready ? '학습 자료 준비 완료' : `준비 ${video.completed || 0}/${video.total || 0}`} · {video.visible ? '공개' : '비공개'}</small><small>분석·번역 시도 {video.api_attempts || 0}회 · 대상 원문 {video.input_chars || 0}자<br />시도 횟수이며 실제 청구 토큰/금액은 아닙니다.</small><div className="library-actions"><button disabled={busy} onClick={prepare}>학습 자료 준비</button><button disabled={busy} onClick={() => save(Boolean(video.visible))}>수정 저장</button><button disabled={busy || !video.visible && !video.ready} onClick={() => save(!video.visible)}>{video.visible ? '비공개로 변경' : '공개'}</button></div>{(error || video.error) && <p role="alert" className="url-error">{error || video.error}</p>}</div>
}

type BillingStatus = { test_only: boolean; is_admin: boolean; configured: boolean; amount: number; monthly_limit: number; subscription: null | { status: string; period_start: string; period_end: string; cancel_at_period_end: boolean }; orders: Array<{ id: string; amount: number; status: string; created_at: string }> }
type Toss = { payment: (options: { customerKey: string }) => { requestBillingAuth: (options: { method: 'CARD'; successUrl: string; failUrl: string }) => Promise<void> } }
declare global { interface Window { TossPayments?: (key: string) => Toss } }
let tossLoader: Promise<void> | undefined
function loadToss() {
  if (window.TossPayments) return Promise.resolve()
  if (!tossLoader) tossLoader = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://js.tosspayments.com/v2/standard'; script.async = true
    script.onload = () => resolve(); script.onerror = () => { tossLoader = undefined; reject(new Error('토스 결제창을 불러오지 못했습니다.')) }; document.head.appendChild(script)
  })
  return tossLoader
}

export function BillingPanel({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<BillingStatus | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const handled = useRef(false)
  async function refresh() { try { setData(await platformJson<BillingStatus>('/api/billing/status')) } catch (e) { setError((e as Error).message) } }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (handled.current) return
    const query = new URLSearchParams(window.location.search)
    if (!query.has('billing')) return
    handled.current = true
    const state = sessionStorage.getItem('turtle-billing-state')
    if (query.get('billing') === 'fail') setError('카드 등록이 취소되었거나 실패했습니다. 다시 시도해 주세요.')
    else if (!state || state !== query.get('state')) setError('이 브라우저에서 시작한 카드 등록 요청이 아닙니다.')
    else {
      setBusy(true)
      void platformJson('/api/billing/confirm', { method: 'POST', body: JSON.stringify({ auth_key: query.get('authKey'), customer_key: query.get('customerKey'), state }) })
        .then(() => { onChanged(); return refresh() }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
    }
    sessionStorage.removeItem('turtle-billing-state')
    window.history.replaceState({}, '', `${window.location.pathname}?view=my`)
  }, [onChanged])
  async function begin() {
    setBusy(true); setError('')
    try {
      const setup = await platformJson<{ client_key: string; customer_key: string; state: string }>('/api/billing/setup', { method: 'POST' })
      await loadToss(); sessionStorage.setItem('turtle-billing-state', setup.state)
      await window.TossPayments!(setup.client_key).payment({ customerKey: setup.customer_key }).requestBillingAuth({ method: 'CARD', successUrl: `${window.location.origin}/?view=my&billing=success&state=${encodeURIComponent(setup.state)}`, failUrl: `${window.location.origin}/?view=my&billing=fail` })
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function action(path: string) { setBusy(true); setError(''); try { await platformJson(`/api/billing/${path}`, { method: 'POST' }); await refresh(); onChanged() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  return <section className="subscription-panel"><h3>나의 이용권</h3><p>월 새 영상 30개 · 영상 길이 제한 없음 · 기존 영상 복습 유지</p>
    {!data?.is_admin ? <p className="usage-notice">월 구독은 준비 중입니다. 무료 AI 학습과 기존 자료 복습을 이용해 주세요.</p> : <>
      <p className="test-badge">관리자 전용 테스트 · 실제 청구 없음 · 테스트 금액 월 1,000원</p>
      <p>{data.subscription ? `구독 상태: ${data.subscription.status}${data.subscription.cancel_at_period_end ? ' · 다음 갱신 해지 예약됨' : ''}` : '활성화된 테스트 구독이 없습니다.'}</p>
      {data.subscription?.period_end && <p>{data.subscription.cancel_at_period_end ? '이용 종료' : '다음 결제'}: {new Date(data.subscription.period_end).toLocaleString('ko-KR')}</p>}
      {!data.configured && <p>토스 테스트 키와 서버 암호화 키 설정 후 사용할 수 있습니다.</p>}
      <div className="library-actions"><button disabled={busy || !data.configured || data.subscription?.status === 'active'} onClick={begin}>테스트 카드 등록·구독</button>{data.subscription && <><button disabled={busy || !data.configured} onClick={() => action('retry')}>결제 결과 재확인</button><button disabled={busy || data.subscription.cancel_at_period_end} onClick={() => action('cancel')}>다음 갱신 해지</button></>}</div>
      {data.orders.length > 0 && <ul className="billing-history">{data.orders.map((o) => <li key={o.id}>{new Date(o.created_at).toLocaleDateString('ko-KR')} · 테스트 {o.amount.toLocaleString()}원 · {o.status}</li>)}</ul>}
    </>}{busy && <p role="status">처리 중입니다. 잠시 기다려 주세요.</p>}{error && <p role="alert" className="url-error">{error}</p>}
  </section>
}
