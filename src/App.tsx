import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './supabase'

type Tab = 'dictation' | 'quiz' | 'bag' | 'vault' | 'journey' | 'my'
type SavedSentence = { id: number; time: string; text: string }
type HighlightColor = 'yellow'
type Highlight = { id: number; line: number; start: number; end: number; color: HighlightColor; text: string }
type LearningItem = {
  timestamp_sec: number
  timestamp_display: string
  full_sentence_original: string
  masked_sentence: string
  target_word: string
  word_type: string
  definition_kr: string
  hint_for_tap: string
  level?: 'B2' | 'C1'
  is_phrasal_verb?: boolean
}
type TranscriptBlock = { timestamp_sec: number; end_sec: number; timestamp_display: string; text: string }
type WordDefinition = { word: string; word_type: string; definition_kr: string }
type TranslationResponse = { translation_kr: string }
type AnalyzeResponse = {
  episode_id: string
  title: string
  source_name: string
  duration_sec: number
  transcript: TranscriptBlock[]
  learning_items: LearningItem[]
  analysis_status: AnalysisStatus
  analysis_version: string
  cached: boolean
  completed_chunks: number
  total_chunks: number
}
type AnalysisStatus = 'waiting_for_key' | 'pending' | 'running' | 'complete' | 'error'
type AnalysisResponse = Pick<AnalyzeResponse, 'episode_id' | 'analysis_status' | 'analysis_version' | 'learning_items' | 'completed_chunks' | 'total_chunks'> & { error?: string }
type YouTubePlayerInstance = {
  playVideo: () => void
  pauseVideo: () => void
  seekTo: (seconds: number, allowSeekAhead: boolean) => void
  getCurrentTime: () => number
  getDuration: () => number
  destroy: () => void
}
type YouTubeNamespace = { Player: new (element: HTMLElement, options: Record<string, unknown>) => YouTubePlayerInstance }

declare global {
  interface Window {
    YT?: YouTubeNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let youtubeApiPromise: Promise<YouTubeNamespace> | null = null
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (youtubeApiPromise) return youtubeApiPromise
  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousCallback = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.()
      if (window.YT) resolve(window.YT)
      else reject(new Error('YouTube Player API를 초기화하지 못했습니다.'))
    }
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      script.async = true
      script.onerror = () => reject(new Error('YouTube Player API를 불러오지 못했습니다.'))
      document.head.appendChild(script)
    }
  })
  return youtubeApiPromise
}

const tabs: { id: Tab; label: string }[] = [
  { id: 'dictation', label: '받아쓰기' },
  { id: 'quiz', label: '단어 퀴즈' },
  { id: 'bag', label: '짐가방' },
  { id: 'vault', label: '문장 금고' },
  { id: 'journey', label: '미국행' },
]

const sampleVocab = [
  { word: 'restitution', pos: 'noun', meaning: '반환, 원상회복', definition: 'the restoration of something lost or stolen to its proper owner', example: 'The museum agreed to the restitution of the artifacts.' },
  { word: 'antiquity', pos: 'noun', meaning: '고대, 유물', definition: 'the ancient past, especially before the Middle Ages', example: 'The object has survived since antiquity.' },
  { word: 'provenance', pos: 'noun', meaning: '기원, 출처', definition: 'the place of origin or earliest known history of something', example: 'Its provenance remains disputed.' },
]

const sampleItems: LearningItem[] = [
  { timestamp_sec: 222, timestamp_display: '03:42', full_sentence_original: 'For decades, museums have wrestled with a deceptively simple question: who owns the past?', masked_sentence: 'For decades, museums have wrestled with a deceptively simple question: who owns the past?', target_word: 'wrestled', word_type: 'verb', definition_kr: '고심했다, 씨름했다', hint_for_tap: 'to struggle with a difficult problem' },
  { timestamp_sec: 229, timestamp_display: '03:49', full_sentence_original: 'The debate over restitution is not merely about moving an object from one building to another.', masked_sentence: 'The debate over resti_____ is not merely about moving an object from one building to another.', target_word: 'restitution', word_type: 'noun', definition_kr: '반환, 원상회복', hint_for_tap: 'the restoration of something lost or stolen to its proper owner' },
  { timestamp_sec: 237, timestamp_display: '03:57', full_sentence_original: 'It asks us to reconsider how artifacts left their countries, who benefited, and whether the moral debts of history can ever truly be settled.', masked_sentence: 'It asks us to recon_____ how artifacts left their countries.', target_word: 'reconsider', word_type: 'verb', definition_kr: '재고하다', hint_for_tap: 'to think about something again' },
  { timestamp_sec: 249, timestamp_display: '04:09', full_sentence_original: 'Many objects from antiquity arrived in Western collections under circumstances that would be unacceptable today.', masked_sentence: 'Many objects from anti_____ arrived in Western collections.', target_word: 'antiquity', word_type: 'noun', definition_kr: '고대, 유물', hint_for_tap: 'the ancient past, especially before the Middle Ages' },
  { timestamp_sec: 258, timestamp_display: '04:18', full_sentence_original: 'Yet tracing their provenance can be difficult, and legal ownership does not always align with ethical responsibility.', masked_sentence: 'Yet tracing their prove_____ can be difficult.', target_word: 'provenance', word_type: 'noun', definition_kr: '기원, 출처', hint_for_tap: 'the place of origin or earliest known history of something' },
]

const sampleTranscript: TranscriptBlock[] = [
  { timestamp_sec: 222, end_sec: 229, timestamp_display: '03:42', text: 'For decades, museums have wrestled with a deceptively simple question: who owns the past?' },
  { timestamp_sec: 229, end_sec: 237, timestamp_display: '03:49', text: 'The debate over restitution is not merely about moving an object from one building to another.' },
  { timestamp_sec: 237, end_sec: 249, timestamp_display: '03:57', text: 'It asks us to reconsider how artifacts left their countries, who benefited, and whether the moral debts of history can ever truly be settled.' },
  { timestamp_sec: 249, end_sec: 258, timestamp_display: '04:09', text: 'Many objects from antiquity arrived in Western collections under circumstances that would be unacceptable today.' },
  { timestamp_sec: 258, end_sec: 270, timestamp_display: '04:18', text: 'Yet tracing their provenance can be difficult, and legal ownership does not always align with ethical responsibility.' },
  { timestamp_sec: 270, end_sec: 282, timestamp_display: '04:30', text: 'Museums now have to examine old records, listen to communities, and decide what responsible stewardship should look like.' },
  { timestamp_sec: 282, end_sec: 294, timestamp_display: '04:42', text: 'Those decisions can reshape relationships between institutions and the people whose histories they hold.' },
]

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const WORD_CACHE_STORAGE_KEY = 'turtle-word-definitions-v1'
const PREFETCH_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'another', 'because', 'before', 'being', 'between', 'could', 'does', 'from', 'have', 'into', 'just', 'more', 'most', 'other', 'over', 'same', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your',
])

function loadStoredWordDefinitions() {
  try {
    const stored = JSON.parse(localStorage.getItem(WORD_CACHE_STORAGE_KEY) || '{}') as Record<string, WordDefinition>
    return new Map(Object.entries(stored))
  } catch {
    return new Map<string, WordDefinition>()
  }
}

function storeWordDefinitions(cache: Map<string, WordDefinition>) {
  try {
    localStorage.setItem(WORD_CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)))
  } catch {
    // The backend cache still provides fast lookup when browser storage is unavailable.
  }
}

function MenuIcon({ id }: { id: Tab }) {
  const paths: Record<Tab, ReactNode> = {
    dictation: <><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h5M8 16h7"/></>,
    quiz: <><circle cx="12" cy="12" r="8"/><path d="M9.8 9a2.3 2.3 0 0 1 4.4 1c0 1.8-2.2 2-2.2 3.5M12 17h.01"/></>,
    bag: <><path d="M6 8h12l1 12H5L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></>,
    vault: <><path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
    journey: <><path d="M5 18c3-8 7-11 14-12"/><path d="m14 5 5 1-1 5"/><circle cx="6" cy="18" r="2"/></>,
    my: <><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[id]}</svg>
}

function Hint({ item }: { item: LearningItem }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="hint-wrap">
      <button className={`word-button ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>{item.target_word}</button>
      {open && <span className="wordwise"><b>{item.definition_kr}</b><span>{item.word_type} · {item.hint_for_tap}</span></span>}
    </span>
  )
}

function App() {
  const [tab, setTab] = useState<Tab>(() => new URLSearchParams(window.location.search).get('view') === 'my' ? 'my' : 'dictation')
  const [url, setUrl] = useState('https://youtu.be/ELI8AwyXF1Q')
  const [loaded, setLoaded] = useState(true)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [episodeId, setEpisodeId] = useState('ELI8AwyXF1Q')
  const [episodeTitle, setEpisodeTitle] = useState('Who Owns the Past?')
  const [sourceName, setSourceName] = useState('Freakonomics Radio')
  const [durationSec, setDurationSec] = useState(294)
  const [transcript, setTranscript] = useState<TranscriptBlock[]>(sampleTranscript)
  const [learningItems, setLearningItems] = useState<LearningItem[]>(sampleItems)
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>('complete')
  const [analysisProgress, setAnalysisProgress] = useState({ completed: 1, total: 1 })
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(() => Number(localStorage.getItem('turtle-progress')) || 42)
  const [highlights, setHighlights] = useState<Highlight[]>(() => JSON.parse(localStorage.getItem('turtle-highlights') || '[]'))
  const [saved, setSaved] = useState<SavedSentence[]>(() => JSON.parse(localStorage.getItem('turtle-vault') || '[]'))
  const [bag, setBag] = useState<string[]>(() => JSON.parse(localStorage.getItem('turtle-bag') || '["provenance"]'))
  const [completedWords, setCompletedWords] = useState<string[]>(() => JSON.parse(localStorage.getItem('turtle-completed-words') || '[]'))
  const [answer, setAnswer] = useState('')
  const [quizState, setQuizState] = useState<'idle' | 'correct' | 'wrong'>('idle')
  const [quizIndex, setQuizIndex] = useState(0)
  const [toast, setToast] = useState('')
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)

  function navigateTo(nextTab: Tab) {
    setTab(nextTab)
    const nextUrl = new URL(window.location.href)
    if (nextTab === 'my') nextUrl.searchParams.set('view', 'my')
    else nextUrl.searchParams.delete('view')
    nextUrl.searchParams.delete('code')
    window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`)
  }

  useEffect(() => { localStorage.setItem('turtle-progress', String(progress)) }, [progress])
  useEffect(() => { localStorage.setItem('turtle-highlights', JSON.stringify(highlights)) }, [highlights])
  useEffect(() => { localStorage.setItem('turtle-vault', JSON.stringify(saved)) }, [saved])
  useEffect(() => { localStorage.setItem('turtle-bag', JSON.stringify(bag)) }, [bag])
  useEffect(() => { localStorage.setItem('turtle-completed-words', JSON.stringify(completedWords)) }, [completedWords])

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false)
      return
    }

    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setAuthUser(data.session?.user ?? null)
      setAuthLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return
      setAuthUser(session?.user ?? null)
      setAuthLoading(false)
    })

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!episodeId || !['pending', 'running'].includes(analysisStatus)) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/episodes/${episodeId}/analysis`)
        const data = await response.json().catch(() => null) as AnalysisResponse | { detail?: string } | null
        if (!response.ok || !data || !('analysis_status' in data)) throw new Error(data && 'detail' in data ? data.detail : '분석 상태를 확인하지 못했습니다.')
        if (cancelled) return
        setLearningItems(data.learning_items)
        setAnalysisStatus(data.analysis_status)
        setAnalysisProgress({ completed: data.completed_chunks, total: data.total_chunks })
        if (data.analysis_status === 'complete') flash(`B2·C1 학습 표현 ${data.learning_items.length}개를 준비했어요`)
        if (data.analysis_status === 'error' && data.error) setLoadError(data.error)
        if (['pending', 'running'].includes(data.analysis_status)) timer = window.setTimeout(poll, 1200)
      } catch (error) {
        if (!cancelled) timer = window.setTimeout(poll, 2200)
      }
    }
    timer = window.setTimeout(poll, 500)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [analysisStatus, episodeId])

  const episodeProgress = useMemo(() => Math.min(100, Math.round((progress / 100) * 100)), [progress])

  async function startLearning() {
    const value = url.trim()
    const isYouTubeUrl = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?(.*&)?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]{6,}/i.test(value)
    if (!isYouTubeUrl) {
      setLoadError('올바른 YouTube 영상 링크를 입력해 주세요.')
      return
    }
    setLoading(true)
    setLoadError('')
    try {
      const response = await fetch(`${API_BASE_URL}/api/episodes/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtube_url: value }),
      })
      const data = await response.json().catch(() => null) as AnalyzeResponse | { detail?: string } | null
      if (!response.ok) throw new Error((data && 'detail' in data && data.detail) || '영상 분석에 실패했습니다.')
      if (!data || !('transcript' in data) || !Array.isArray(data.transcript) || data.transcript.length === 0) {
        throw new Error('이 영상에서 학습할 자막을 찾지 못했습니다.')
      }
      setEpisodeId(data.episode_id)
      setEpisodeTitle(data.title)
      setSourceName(data.source_name)
      setDurationSec(data.duration_sec)
      setTranscript(data.transcript)
      setLearningItems(data.learning_items)
      setAnalysisStatus(data.analysis_status)
      setAnalysisProgress({ completed: data.completed_chunks, total: data.total_chunks })
      setHighlights([])
      setAnswer('')
      setQuizState('idle')
      setQuizIndex(0)
      setLoading(false)
      setLoaded(true)
      navigateTo('dictation')
      flash(data.analysis_status === 'complete'
        ? `B2·C1 학습 표현 ${data.learning_items.length}개를 준비했어요`
        : '전체 스크립트를 먼저 준비했어요')
    } catch (error) {
      setLoadError(error instanceof TypeError
        ? '분석 서버에 연결할 수 없습니다. 백엔드가 실행 중인지 확인해 주세요.'
        : error instanceof Error ? error.message : '영상 분석 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  function flash(message: string) {
    setToast(message)
    setTimeout(() => setToast(''), 2400)
  }

  function toggleHighlight(highlight: Omit<Highlight, 'id'>) {
    const exists = highlights.some((item) => item.line === highlight.line && item.start === highlight.start && item.end === highlight.end)
    setHighlights((now) => exists
      ? now.filter((item) => !(item.line === highlight.line && item.start === highlight.start && item.end === highlight.end))
      : [...now.filter((item) => item.line !== highlight.line || item.end <= highlight.start || item.start >= highlight.end), { ...highlight, id: Date.now() }])
    flash(exists ? '형광펜을 해제했어요' : '선택한 부분에 형광펜을 표시했어요')
  }

  function saveSentence(time: string, text: string) {
    if (!saved.some((s) => s.text === text)) setSaved((now) => [...now, { id: Date.now(), time, text }])
    flash('문장 금고에 안전하게 보관했어요')
  }

  function saveWord(word: string) {
    const normalized = word.toLocaleLowerCase()
    setBag((now) => now.some((item) => item.toLocaleLowerCase() === normalized) ? now : [...now, normalized])
    flash(`${word} 단어를 짐가방에 저장했어요`)
  }

  function completeWord(word: string) {
    const normalized = word.toLocaleLowerCase().trim()
    setCompletedWords((now) => now.includes(normalized) ? now : [...now, normalized])
  }

  function submitQuiz() {
    const item = learningItems[quizIndex]
    if (!item) return
    if (answer.trim().toLowerCase() === item.target_word.toLowerCase()) {
      setQuizState('correct')
      setProgress((p) => Math.min(100, p + 4))
      setBag((now) => now.filter((w) => w !== item.target_word))
    } else {
      setQuizState('wrong')
      setBag((now) => now.includes(item.target_word) ? now : [...now, item.target_word])
    }
  }

  return (
    <div className="app-shell">
      {toast && <div className="toast">✓ {toast}</div>}
      <header>
        <div className="header-inner">
          <a className="brand" href="#top" aria-label="Turtle English 홈">
            <img src="/assets/turtle-b.png" alt="" />
            <span>Turtle English</span>
          </a>
          <nav aria-label="학습 메뉴">
            {tabs.map((item) => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => navigateTo(item.id)}><MenuIcon id={item.id} />{item.label}{item.id === 'bag' && bag.length > 0 && <em>{bag.length}</em>}</button>)}
          </nav>
          <div className="user-block"><button className={`avatar ${tab === 'my' ? 'active' : ''}`} aria-label="MY 페이지" aria-current={tab === 'my' ? 'page' : undefined} onClick={() => navigateTo('my')}>MY</button></div>
        </div>
      </header>

      <main id="top">
        <section className="welcome">
          <div><span className="eyebrow">YOUR DAILY JOURNEY</span><h1>천천히, 하지만 끝까지.<br /><strong>오늘도 미국으로 한 걸음.</strong></h1><p>진짜 콘텐츠를 흐름 그대로 듣고, 모르는 표현만 깊게 익혀요.</p></div>
          <div className="mini-journey"><img src="/assets/turtle-b.png" alt="달리는 거북이" /><div><span><b>뉴욕까지</b><b>{100 - progress} km</b></span><div className="journey-track"><i style={{ width: `${progress}%` }} /></div><small>이번 주 18km 전진 · 상위 12%</small></div></div>
        </section>

        <section className="url-card" aria-label="유튜브 에피소드 불러오기">
          <div className="url-card-head"><div className="url-copy"><span className="play-dot">▶</span><div><b>학습할 에피소드를 가져오세요</b><small>유튜브 링크 하나면 전체 스크립트와 C1 퀴즈가 준비돼요.</small></div></div></div>
          <div className="url-form"><input value={url} onChange={(e) => { setUrl(e.target.value); setLoadError('') }} onKeyDown={(e) => e.key === 'Enter' && !loading && startLearning()} placeholder="YouTube 링크를 붙여넣으세요" aria-label="유튜브 링크" aria-invalid={Boolean(loadError)} /><button onClick={startLearning} disabled={loading}>{loading ? <><span className="spinner" />분석 중</> : '학습 시작 →'}</button></div>
          {loadError && <p className="url-error" role="alert">{loadError}</p>}
        </section>

        {loaded && <section className="workspace">
          {tab === 'dictation' && <Dictation episodeId={episodeId} title={episodeTitle} sourceName={sourceName} durationSec={durationSec} transcript={transcript} items={learningItems} playing={playing} setPlaying={setPlaying} highlights={highlights} toggleHighlight={toggleHighlight} saveSentence={saveSentence} saveWord={saveWord} completedWords={completedWords} completeWord={completeWord} episodeProgress={episodeProgress} analysisStatus={analysisStatus} analysisProgress={analysisProgress} />}
          {tab === 'quiz' && <Quiz item={learningItems[quizIndex]} index={quizIndex} total={learningItems.length} answer={answer} setAnswer={setAnswer} state={quizState} submit={submitQuiz} next={() => { setAnswer(''); setQuizState('idle'); setQuizIndex((quizIndex + 1) % learningItems.length) }} />}
          {tab === 'bag' && <Bag words={bag} items={learningItems} practice={() => navigateTo('quiz')} />}
          {tab === 'vault' && <Vault sentences={saved} remove={(id) => setSaved(saved.filter((s) => s.id !== id))} />}
          {tab === 'journey' && <Journey progress={progress} />}
          {tab === 'my' && <MyPage user={authUser} loading={authLoading} configured={isSupabaseConfigured} onMessage={flash} />}
        </section>}
      </main>
      <footer><small>© 2026 Turtle English</small></footer>
    </div>
  )
}

function MyPage({ user, loading, configured, onMessage }: { user: User | null; loading: boolean; configured: boolean; onMessage: (message: string) => void }) {
  const [action, setAction] = useState<'idle' | 'login' | 'logout'>('idle')
  const [error, setError] = useState('')

  async function continueWithGoogle() {
    if (!supabase || !configured) {
      setError('Supabase 환경변수를 먼저 설정해 주세요.')
      return
    }

    setAction('login')
    setError('')
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/?view=my`,
      },
    })

    if (signInError) {
      setAction('idle')
      setError(signInError.message)
    }
  }

  async function signOut() {
    if (!supabase) return
    setAction('logout')
    setError('')
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' })
    setAction('idle')
    if (signOutError) {
      setError(signOutError.message)
      return
    }
    onMessage('로그아웃했어요')
  }

  const metadata = user?.user_metadata as Record<string, unknown> | undefined
  const profileImage = typeof metadata?.avatar_url === 'string'
    ? metadata.avatar_url
    : typeof metadata?.picture === 'string' ? metadata.picture : ''
  const displayName = typeof metadata?.full_name === 'string'
    ? metadata.full_name
    : typeof metadata?.name === 'string' ? metadata.name : user?.email?.split('@')[0] || 'Turtle English 사용자'

  return <section className="center-panel my-page" aria-labelledby="my-page-title">
    <div className="my-page-heading">
      <span className="eyebrow">MY PAGE</span>
      <h2 id="my-page-title">나의 Turtle English</h2>
      <p>로그인하면 여러 기기에서도 같은 Google 계정으로 나를 확인할 수 있어요.</p>
    </div>

    {loading ? <div className="my-auth-loading" role="status"><span className="spinner" />로그인 상태를 확인하고 있어요</div> : user ? <div className="my-profile">
      {profileImage ? <img src={profileImage} alt={`${displayName} 프로필`} referrerPolicy="no-referrer" /> : <span className="my-profile-fallback" aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>}
      <div className="my-profile-copy"><small>GOOGLE ACCOUNT</small><h3>{displayName}</h3><p>{user.email}</p></div>
      <button className="my-logout" type="button" onClick={signOut} disabled={action === 'logout'}>{action === 'logout' ? '로그아웃 중…' : '로그아웃'}</button>
    </div> : <div className="my-login-state">
      <div className="my-login-mark" aria-hidden="true"><MenuIcon id="my" /></div>
      <h3>필요할 때만 로그인하세요</h3>
      <p>로그인하지 않아도 받아쓰기와 모든 학습 기능을 계속 사용할 수 있어요.</p>
      <button className="google-login" type="button" onClick={continueWithGoogle} disabled={action === 'login' || !configured}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z"/><path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.42l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.6 0-4.81-1.76-5.6-4.13H3.06v2.62A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 13.87A6.02 6.02 0 0 1 6.09 12c0-.65.11-1.28.31-1.87V7.51H3.06A10 10 0 0 0 2 12c0 1.61.39 3.14 1.06 4.49l3.34-2.62Z"/><path fill="#EA4335" d="M12 6c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.63 9.63 0 0 0 12 2a10 10 0 0 0-8.94 5.51l3.34 2.62C7.19 7.76 9.4 6 12 6Z"/></svg>
        {action === 'login' ? 'Google로 이동 중…' : 'Google로 계속하기'}
      </button>
      {!configured && <small className="my-config-note">Vercel에 Supabase 환경변수를 추가하면 로그인 버튼이 활성화됩니다.</small>}
    </div>}
    {error && <p className="my-auth-error" role="alert">{error}</p>}
  </section>
}

function formatPlayerTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  const remainder = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function maskLearningTarget(target: string) {
  return target.replace(/[A-Za-z]+/g, (word) => {
    if (word.length <= 2) return word
    const visibleCount = word.length === 3 ? 1 : 2
    return `${word.slice(0, visibleCount)}${'_'.repeat(word.length - visibleCount)}`
  })
}

function C1Token({ item, onSave, onComplete }: { item: LearningItem; onSave: (word: string) => void; onComplete: (word: string) => void }) {
  const phrase = item.target_word.trim()
  const prefix = phrase.slice(0, 2)
  const [revealed, setRevealed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(prefix)
  const [result, setResult] = useState<'idle' | 'correct' | 'wrong'>('idle')
  const [showGood, setShowGood] = useState(false)
  const clickTimer = useRef(0)
  const goodTimer = useRef(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const masked = maskLearningTarget(phrase)

  useEffect(() => () => { window.clearTimeout(clickTimer.current); window.clearTimeout(goodTimer.current) }, [])
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  function reveal() {
    window.clearTimeout(clickTimer.current)
    setRevealed(true)
    setEditing(false)
    onSave(phrase)
  }

  function updateAnswer(nextValue: string) {
    setValue(nextValue)
    setResult('idle')
    if (nextValue.trim().toLocaleLowerCase() === phrase.toLocaleLowerCase()) {
      setResult('correct')
      setRevealed(true)
      setEditing(false)
      setShowGood(true)
      window.clearTimeout(goodTimer.current)
      goodTimer.current = window.setTimeout(() => { setShowGood(false); onComplete(phrase) }, 1400)
      onSave(phrase)
    }
  }

  function checkAnswer() {
    if (value.trim().toLocaleLowerCase() === phrase.toLocaleLowerCase()) updateAnswer(value)
    else setResult('wrong')
  }

  const slots = phrase.split('').map((character, index) => {
    if (!/[A-Za-z]/.test(character)) return <span key={index} className="letter-space">{character}</span>
    const positionInWord = phrase.slice(0, index).split(/[^A-Za-z]/).at(-1)?.length || 0
    const initiallyVisible = positionInWord < 2
    const entered = value[index]
    return <span key={index} className={`letter-slot ${initiallyVisible || entered ? 'filled' : 'empty'}`}>{initiallyVisible ? character : entered || ''}</span>
  })

  return <span className={`c1-token ${revealed ? 'revealed' : ''} ${editing ? 'editing' : ''}`}>
    {showGood && <span className="dictation-good" role="status">Good!</span>}
    <span role="button" tabIndex={0} className="c1-mask" onClick={(event) => { event.stopPropagation(); window.clearTimeout(clickTimer.current); clickTimer.current = window.setTimeout(() => setEditing(true), 220) }} onDoubleClick={(event) => { event.stopPropagation(); reveal() }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setEditing(true) }} aria-label={`${masked}, 한 번 누르면 받아쓰기, 두 번 누르면 정답과 뜻 보기`}>
      {revealed ? phrase : <span className="letter-slots" aria-hidden="true">{slots}</span>}
    </span>
    {editing && !revealed && <span className="c1-entry">
      <input ref={inputRef} value={value} maxLength={phrase.length} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => { event.stopPropagation(); reveal() }} onChange={(event) => updateAnswer(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && checkAnswer()} aria-label={`${masked} B2 또는 C1 표현 받아쓰기, 두 번 클릭하면 정답 공개`} title="철자를 입력하세요. 두 번 클릭하면 정답을 볼 수 있어요" />
      {result === 'wrong' && <small>철자를 다시 확인해 보세요</small>}
    </span>}
    {revealed && <span className="c1-definition"><small>{item.level || 'C1'} · {item.word_type}</small><span>{item.definition_kr}</span></span>}
  </span>
}

function InteractiveScriptText({ text, c1Items, highlights, completedWords, onWordClick, onSaveWord, onCompleteWord }: { text: string; c1Items: LearningItem[]; highlights: Highlight[]; completedWords: string[]; onWordClick: (word: string, event: MouseEvent<HTMLElement>) => void; onSaveWord: (word: string) => void; onCompleteWord: (word: string) => void }) {
  const renderSegment = (value: string, offset: number, key: string) => {
    const nodes: ReactNode[] = []
    const targets = [...c1Items].sort((a, b) => b.target_word.length - a.target_word.length)
    let cursor = 0
    while (cursor < value.length) {
      const remaining = value.slice(cursor)
      const learningItem = targets.find((item) => {
        const target = item.target_word.trim()
        if (!remaining.toLocaleLowerCase().startsWith(target.toLocaleLowerCase())) return false
        const before = cursor === 0 ? '' : value[cursor - 1]
        const after = value[cursor + target.length] || ''
        return !/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after)
      })
      if (learningItem) {
        const target = learningItem.target_word.trim()
        if (completedWords.includes(target.toLocaleLowerCase())) {
          nodes.push(<span key={`${key}-learned-${offset + cursor}`} className="script-word learned-word" onClick={(event) => onWordClick(target, event)}>{target}</span>)
        } else {
          nodes.push(<C1Token key={`${key}-target-${offset + cursor}`} item={learningItem} onSave={onSaveWord} onComplete={onCompleteWord} />)
        }
        cursor += learningItem.target_word.trim().length
        continue
      }
      const word = remaining.match(/^[A-Za-z][A-Za-z'’-]*/)?.[0]
      if (word) {
        nodes.push(<span key={`${key}-word-${offset + cursor}`} className="script-word" onClick={(event) => onWordClick(word, event)}>{word}</span>)
        cursor += word.length
        continue
      }
      nodes.push(value[cursor])
      cursor += 1
    }
    return nodes
  }

  const nodes: ReactNode[] = []
  let cursor = 0
  const ordered = [...highlights].sort((a, b) => a.start - b.start)
  ordered.forEach((mark) => {
    if (mark.start > cursor) nodes.push(...renderSegment(text.slice(cursor, mark.start), cursor, `plain-${cursor}`))
    nodes.push(<mark key={mark.id} className={`saved-highlight ${mark.color}`}>{renderSegment(text.slice(mark.start, mark.end), mark.start, `mark-${mark.id}`)}</mark>)
    cursor = Math.max(cursor, mark.end)
  })
  if (cursor < text.length) nodes.push(...renderSegment(text.slice(cursor), cursor, `plain-${cursor}`))
  return <>{nodes}</>
}

type DictationProps = {
  episodeId: string
  title: string
  sourceName: string
  durationSec: number
  transcript: TranscriptBlock[]
  items: LearningItem[]
  playing: boolean
  setPlaying: (value: boolean) => void
  highlights: Highlight[]
  toggleHighlight: (item: Omit<Highlight, 'id'>) => void
  saveSentence: (time: string, text: string) => void
  saveWord: (word: string) => void
  completedWords: string[]
  completeWord: (word: string) => void
  episodeProgress: number
  analysisStatus: AnalysisStatus
  analysisProgress: { completed: number; total: number }
}

function Dictation({ episodeId, title, sourceName, durationSec, transcript, items, playing, setPlaying, highlights, toggleHighlight, saveSentence, saveWord, completedWords, completeWord, episodeProgress, analysisStatus, analysisProgress }: DictationProps) {
  const [palette, setPalette] = useState<null | { line: number; start: number; end: number; text: string; x: number; y: number; placement: 'above' | 'below' }>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [playerDuration, setPlayerDuration] = useState(0)
  const [playerReady, setPlayerReady] = useState(false)
  const [videoCollapsed, setVideoCollapsed] = useState(false)
  const [wordPopover, setWordPopover] = useState<null | { x: number; y: number; loading: boolean; data: WordDefinition; error?: string }>(null)
  const [translations, setTranslations] = useState<Record<number, string>>(() => JSON.parse(localStorage.getItem(`turtle-translations-${episodeId}`) || '{}'))
  const [translationLoading, setTranslationLoading] = useState<number | null>(null)
  const lineRefs = useRef<Array<HTMLDivElement | null>>([])
  const playerHostRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YouTubePlayerInstance | null>(null)
  const definitionCache = useRef(loadStoredWordDefinitions())
  const translationCache = useRef<Record<number, string>>({ ...translations })
  const duration = Math.max(playerDuration, durationSec, transcript.at(-1)?.end_sec || 0, 1)
  const currentIndex = useMemo(() => {
    let active = 0
    transcript.forEach((line, index) => {
      if (currentTime >= line.timestamp_sec) active = index
    })
    return active
  }, [currentTime, transcript])

  useEffect(() => {
    let changed = false
    items.forEach((item) => {
      const key = item.target_word.toLocaleLowerCase()
      if (!definitionCache.current.has(key)) {
        definitionCache.current.set(key, {
          word: item.target_word,
          word_type: `${item.level || 'C1'} · ${item.word_type}`,
          definition_kr: item.definition_kr,
        })
        changed = true
      }
    })
    if (changed) storeWordDefinitions(definitionCache.current)
  }, [items])

  useEffect(() => {
    const stored = JSON.parse(localStorage.getItem(`turtle-translations-${episodeId}`) || '{}') as Record<number, string>
    translationCache.current = stored
    setTranslations(stored)
  }, [episodeId])

  useEffect(() => { localStorage.setItem(`turtle-translations-${episodeId}`, JSON.stringify(translationCache.current)) }, [episodeId, translations])

  useEffect(() => {
    const controller = new AbortController()
    const candidates: Array<{ word: string; context: string }> = []
    const scheduled = new Set<string>()
    for (const block of transcript) {
      const words = block.text.match(/[A-Za-z][A-Za-z'’-]*/g) || []
      for (const word of words) {
        const normalized = word.toLocaleLowerCase()
        if (word.length < 4 || PREFETCH_STOP_WORDS.has(normalized) || scheduled.has(normalized) || definitionCache.current.has(normalized)) continue
        scheduled.add(normalized)
        candidates.push({ word, context: block.text.slice(0, 700) })
        if (candidates.length >= 90) break
      }
      if (candidates.length >= 90) break
    }

    const prefetch = async () => {
      for (let index = 0; index < candidates.length; index += 30) {
        if (controller.signal.aborted) return
        try {
          const response = await fetch(`${API_BASE_URL}/api/vocabulary/prefetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: candidates.slice(index, index + 30) }),
            signal: controller.signal,
          })
          if (!response.ok) return
          const data = await response.json() as { definitions?: WordDefinition[] }
          data.definitions?.forEach((definition) => {
            definitionCache.current.set(definition.word.toLocaleLowerCase(), definition)
          })
          storeWordDefinitions(definitionCache.current)
          await new Promise((resolve) => window.setTimeout(resolve, 250))
        } catch {
          return
        }
      }
    }
    void prefetch()
    return () => controller.abort()
  }, [episodeId, transcript])

  useEffect(() => {
    let disposed = false
    setCurrentTime(0)
    setPlayerReady(false)
    setPlaying(false)
    loadYouTubeApi().then((YT) => {
      if (disposed || !playerHostRef.current) return
      const player = new YT.Player(playerHostRef.current, {
        videoId: episodeId,
        playerVars: { playsinline: 1, rel: 0, origin: window.location.origin },
        events: {
          onReady: () => {
            if (disposed) return
            setPlayerReady(true)
            setPlayerDuration(player.getDuration() || 0)
          },
          onStateChange: (event: { data: number }) => {
            if (!disposed) setPlaying(event.data === 1)
          },
        },
      })
      playerRef.current = player
      // The command bridge exists as soon as YT.Player replaces the host.
      // Some privacy modes delay onReady, so controls need not stay disabled.
      setPlayerReady(true)
    }).catch(() => setPlayerReady(false))
    return () => {
      disposed = true
      playerRef.current?.destroy()
      playerRef.current = null
    }
  }, [episodeId, setPlaying])

  useEffect(() => {
    if (!playerReady) return
    const timer = window.setInterval(() => {
      const player = playerRef.current
      if (!player || typeof player.getCurrentTime !== 'function' || typeof player.getDuration !== 'function') return
      setCurrentTime(player.getCurrentTime() || 0)
      const actualDuration = player.getDuration()
      if (actualDuration) setPlayerDuration(actualDuration)
    }, 350)
    return () => window.clearInterval(timer)
  }, [playerReady])

  useEffect(() => {
    if (playing && autoFollow) lineRefs.current[currentIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [autoFollow, currentIndex, playing])

  function c1ItemsForBlock(block: TranscriptBlock) {
    return items.filter((item) => item.timestamp_sec >= block.timestamp_sec && item.timestamp_sec < block.end_sec && block.text.toLocaleLowerCase().includes(item.target_word.toLocaleLowerCase()))
  }

  function togglePlayback() {
    const player = playerRef.current
    if (!player) return
    if (playing && typeof player.pauseVideo === 'function') player.pauseVideo()
    else if (typeof player.playVideo === 'function') player.playVideo()
  }

  function seekTo(seconds: number, autoplay = false) {
    const player = playerRef.current
    if (!player || typeof player.seekTo !== 'function') return
    player.seekTo(seconds, true)
    setCurrentTime(seconds)
    if (autoplay && typeof player.playVideo === 'function') player.playVideo()
  }

  function handleSelection(event: PointerEvent<HTMLParagraphElement>, line: number, rawText: string) {
    const selection = window.getSelection()
    const paragraph = event.currentTarget
    if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!paragraph.contains(range.commonAncestorContainer)) return
    const prefix = range.cloneRange()
    prefix.selectNodeContents(paragraph)
    prefix.setEnd(range.startContainer, range.startOffset)
    const start = prefix.toString().length
    const selectedLength = range.toString().length
    if (!selectedLength || !range.toString().trim()) return
    const end = Math.min(rawText.length, start + selectedLength)
    const edgePadding = window.innerWidth < 520 ? 68 : 76
    const rangeRect = range.getBoundingClientRect()
    const releaseX = event.clientX || rangeRect.left + rangeRect.width / 2
    const releaseY = event.clientY || rangeRect.top
    const x = Math.max(edgePadding, Math.min(releaseX, window.innerWidth - edgePadding))
    const placement = releaseY < 92 ? 'below' : 'above'
    const y = placement === 'below' ? releaseY + 14 : releaseY
    setPalette({ line, start, end, text: rawText.slice(start, end), x, y, placement })
  }

  function colorSelection() {
    if (!palette) return
    toggleHighlight({ line: palette.line, start: palette.start, end: palette.end, text: palette.text, color: 'yellow' })
    const block = transcript[palette.line]
    if (block && palette.text.trim() === block.text.trim()) saveSentence(block.timestamp_display, block.text)
    window.getSelection()?.removeAllRanges()
    setPalette(null)
  }

  async function toggleTranslation() {
    if (!palette) return
    const lineIndex = palette.line
    const block = transcript[lineIndex]
    window.getSelection()?.removeAllRanges()
    setPalette(null)
    if (!block) return
    if (translations[lineIndex]) {
      setTranslations((now) => { const next = { ...now }; delete next[lineIndex]; return next })
      return
    }
    const cached = translationCache.current[lineIndex]
    if (cached) return setTranslations((now) => ({ ...now, [lineIndex]: cached }))
    setTranslationLoading(lineIndex)
    try {
      const response = await fetch(`${API_BASE_URL}/api/translations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: block.text }) })
      const data = await response.json().catch(() => null) as TranslationResponse | { detail?: string } | null
      if (!response.ok || !data || !('translation_kr' in data)) throw new Error(data && 'detail' in data ? data.detail : '번역을 불러오지 못했습니다.')
      translationCache.current[lineIndex] = data.translation_kr
      setTranslations((now) => ({ ...now, [lineIndex]: data.translation_kr }))
    } catch (error) {
      setTranslations((now) => ({ ...now, [lineIndex]: error instanceof Error ? error.message : '번역을 불러오지 못했습니다.' }))
    } finally { setTranslationLoading(null) }
  }

  async function openWord(word: string, event: MouseEvent<HTMLElement>, context: string) {
    event.stopPropagation()
    if (window.getSelection()?.toString().trim()) return
    saveWord(word)
    const normalized = word.toLocaleLowerCase()
    const x = Math.max(130, Math.min(event.clientX, window.innerWidth - 130))
    const y = Math.max(90, event.clientY - 12)
    const cached = definitionCache.current.get(normalized)
    if (cached) return setWordPopover({ x, y, loading: false, data: cached })
    const fallback: WordDefinition = { word, word_type: 'word', definition_kr: '문맥에 맞는 뜻을 불러오는 중이에요.' }
    setWordPopover({ x, y, loading: true, data: fallback })
    try {
      const response = await fetch(`${API_BASE_URL}/api/vocabulary/define`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word, context }),
      })
      const data = await response.json().catch(() => null) as WordDefinition | { detail?: string } | null
      if (!response.ok || !data || !('word' in data)) throw new Error(data && 'detail' in data ? data.detail : '뜻을 불러오지 못했습니다.')
      definitionCache.current.set(normalized, data)
      storeWordDefinitions(definitionCache.current)
      setWordPopover({ x, y, loading: false, data })
    } catch (error) {
      setWordPopover({ x, y, loading: false, data: fallback, error: error instanceof Error ? error.message : '뜻을 불러오지 못했습니다.' })
    }
  }

  return <div className="learning-grid episode-learning">
    <section className="episode-overview" aria-labelledby="episode-title">
      <div className={`youtube-video-shell ${videoCollapsed ? 'collapsed' : ''}`}>
        <div className="youtube-player-ratio"><div ref={playerHostRef} className="youtube-player-host" /></div>
      </div>
      <button type="button" className="video-collapse-button" onClick={() => setVideoCollapsed((value) => !value)} aria-expanded={!videoCollapsed}>{videoCollapsed ? '영상 펼치기 ▼' : '영상 접기 ▲'}</button>
      <div className="episode-copy">
        <h2 id="episode-title">{title}</h2>
        <p>{sourceName}</p>
      </div>
      <div className="completion episode-completion"><span><b>에피소드 진도</b><b>{episodeProgress}%</b></span><div><i style={{ width: `${episodeProgress}%` }} /></div></div>
      <div className="audio-player" aria-label="에피소드 오디오 플레이어">
        <button className="audio-play" onClick={togglePlayback} disabled={!playerReady} aria-label={playing ? '일시정지' : '재생'}>{playing ? 'Ⅱ' : '▶'}</button>
        <span>{formatPlayerTime(currentTime)}</span>
        <input type="range" min={0} max={duration} step={0.1} value={Math.min(currentTime, duration)} onChange={(event) => seekTo(Number(event.target.value))} aria-label="영상 재생 위치" />
        <span>{formatPlayerTime(duration)}</span>
        <button className="audio-settings" onClick={() => setVideoCollapsed((value) => !value)} aria-label={videoCollapsed ? '영상 펼치기' : '영상 접기'}>▱</button>
      </div>
    </section>

    <article className="transcript-card reading-view">
      <div className="transcript-head">
        <div><span>FULL TRANSCRIPT</span><h2>전체 스크립트</h2></div>
        <label className="follow-toggle"><span>자동으로 따라가기</span><input type="checkbox" checked={autoFollow} onChange={(event) => setAutoFollow(event.target.checked)} /><i aria-hidden="true" /><b>{autoFollow ? 'ON' : 'OFF'}</b></label>
      </div>
      <div className="now-listening"><span className={`wave ${playing ? 'active' : ''}`}>▮▰▮▰</span><span>{playing ? '현재 발화를 따라가고 있어요' : '재생하면 현재 문장을 표시해요'}</span>{['pending', 'running'].includes(analysisStatus) && <em>학습 단어 분석 중… {analysisProgress.completed}/{analysisProgress.total}</em>}{analysisStatus === 'waiting_for_key' && <em>AI 분석 서버를 준비하고 있어요</em>}<b>{currentIndex + 1} / {transcript.length}</b></div>
      <div className="transcript-body reading-body">
        {transcript.map((line, index) => <div ref={(element) => { lineRefs.current[index] = element }} key={`${line.timestamp_sec}-${index}`} className={`script-line reading-line ${index === currentIndex ? 'current' : ''}`}>
          <span className="timestamp">{line.timestamp_display}</span>
          <div className="script-copy"><p onPointerUp={(event) => handleSelection(event, index, line.text)}><InteractiveScriptText text={line.text} c1Items={c1ItemsForBlock(line)} highlights={highlights.filter((item) => item.line === index)} completedWords={completedWords} onWordClick={(word, event) => openWord(word, event, line.text)} onSaveWord={saveWord} onCompleteWord={completeWord} /></p>{translationLoading === index && <span className="line-translation loading">자연스러운 번역을 준비하고 있어요…</span>}{translations[index] && <span className="line-translation">{translations[index]}</span>}</div>
        </div>)}
      </div>
      <div className="script-tip"><span>⌁</span><p><b>Tip.</b> 블록의 빈 곳을 누르면 그 시점부터 재생해요. B2·C1 빈칸은 한 번 눌러 입력하고, 두 번 눌러 정답을 확인할 수 있어요.</p></div>
      {palette && <div className={`selection-palette ${palette.placement}`} style={{ left: palette.x, top: palette.y }} role="toolbar" aria-label="선택한 텍스트 도구">
        <button className="selection-tool highlight-tool" onPointerDown={(event) => event.preventDefault()} onClick={colorSelection} aria-label="노란색 형광펜 적용 또는 해제">○</button>
        <span className="selection-divider" aria-hidden="true" />
        <button className="selection-tool translation-tool" onPointerDown={(event) => event.preventDefault()} onClick={toggleTranslation} aria-label="한국어 번역 펼치기 또는 접기">한</button>
      </div>}
      {wordPopover && <aside className="word-popover" style={{ left: wordPopover.x, top: wordPopover.y }} role="status">
        <button onClick={() => setWordPopover(null)} aria-label="단어 뜻 닫기">×</button>
        <b>{wordPopover.data.word}</b><small>{wordPopover.data.word_type}</small><p>{wordPopover.error || wordPopover.data.definition_kr}</p>{wordPopover.loading && <i className="popover-loader" />}
        <span>짐가방에 자동 저장됨</span>
      </aside>}
    </article>
  </div>
}

function Quiz({ item, index, total, answer, setAnswer, state, submit, next }: { item?: LearningItem; index: number; total: number; answer: string; setAnswer: (v: string) => void; state: 'idle' | 'correct' | 'wrong'; submit: () => void; next: () => void }) {
  if (!item) return <div className="center-panel"><div className="empty-state">분석된 퀴즈가 없습니다.</div></div>
  const displayedSentence = state === 'correct' ? item.full_sentence_original : item.masked_sentence
  const percent = Math.round(((index + 1) / total) * 100)
  return <div className="center-panel quiz-panel"><span className="eyebrow">C1 VOCABULARY · {index + 1} / {total}</span><div className="quiz-top"><div className="quiz-progress"><i style={{ width: `${percent}%` }} /></div><b>{percent}%</b></div><h2>빈칸에 들어갈 단어는?</h2><p className="quote">“{displayedSentence}”</p><div className="hint-box"><span>💡</span><p><small>{item.word_type.toUpperCase()}</small>{item.definition_kr}<br /><span>{item.hint_for_tap}</span></p></div><input className={`answer-input ${state}`} value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="영어 단어를 입력하세요" autoFocus />{state === 'correct' && <div className="feedback good"><b>정답이에요! +4 km</b><span>{item.target_word} · {item.definition_kr}</span></div>}{state === 'wrong' && <div className="feedback bad"><b>한 번 더 생각해 볼까요?</b><span>첫 글자는 {item.target_word[0]}, 마지막은 {item.target_word.at(-1)}이에요. 짐가방에 담아둘게요.</span></div>}<button className="primary-action" onClick={state === 'correct' ? next : submit}>{state === 'correct' ? '다음 문제 →' : '정답 확인'}</button></div>
}

function Bag({ words, items, practice }: { words: string[]; items: LearningItem[]; practice: () => void }) {
  return <div className="center-panel"><div className="section-title"><div><span className="eyebrow">REVIEW BAGGAGE</span><h2>거북이의 짐가방</h2><p>헷갈렸던 단어는 여기 모아두고 가볍게 다시 꺼내봐요.</p></div><img src="/assets/turtle-b.png" alt="짐가방을 챙기는 거북이" /></div>{words.length ? <div className="vocab-list">{words.map((word) => { const dynamicItem = items.find((entry) => entry.target_word === word); const sampleItem = sampleVocab.find((entry) => entry.word === word) || sampleVocab[2]; return <div className="vocab-row" key={word}><span>{word.slice(0, 1).toUpperCase()}</span><div><h3>{word} <small>{dynamicItem?.word_type || sampleItem.pos}</small></h3><p>{dynamicItem?.definition_kr || sampleItem.meaning}</p></div><button onClick={practice}>다시 풀기 →</button></div> })}</div> : <div className="empty-state">짐가방이 비었어요. 아주 가벼운 여행이네요! 🎉</div>}</div>
}

function Vault({ sentences, remove }: { sentences: SavedSentence[]; remove: (id: number) => void }) {
  return <div className="center-panel"><div className="section-title plain"><div><span className="eyebrow">SENTENCE VAULT</span><h2>문장 금고</h2><p>마음에 닿은 문장을 모아 나만의 영어 책을 만들어요.</p></div><b>{sentences.length} 문장</b></div>{sentences.length ? <div className="sentence-list">{sentences.map((s) => <div key={s.id}><span>{s.time}</span><p>“{s.text}”</p><button onClick={() => remove(s.id)}>×</button></div>)}</div> : <div className="empty-state">아직 저장한 문장이 없어요.<br /><small>받아쓰기에서 ♡를 눌러 첫 문장을 담아보세요.</small></div>}</div>
}

function Journey({ progress }: { progress: number }) {
  const miles = [0, 25, 50, 75, 100]
  return <div className="journey-panel"><div className="journey-copy"><span className="eyebrow">SEOUL → NEW YORK</span><h2>거북이의 미국행</h2><p>오늘의 작은 공부가 뉴욕까지 이어져요.<br />꾸준히 쌓은 거리가 벌써 <b>{progress}km</b>예요.</p></div><div className="map-card"><div className="route-line"><i style={{ width: `${progress}%` }} /><img src="/assets/turtle-a.png" alt="여행 중인 거북이" style={{ left: `calc(${progress}% - 34px)` }} />{miles.map((m) => <span key={m} className={progress >= m ? 'passed' : ''} style={{ left: `${m}%` }}><b>{m === 0 ? '서울' : m === 100 ? '뉴욕' : `${m}km`}</b></span>)}</div><div className="badges"><div className="earned"><span>🌱</span><b>첫 걸음</b><small>첫 에피소드 시작</small></div><div className={progress >= 25 ? 'earned' : ''}><span>🎧</span><b>집중 청취자</b><small>25km 달성</small></div><div className={progress >= 50 ? 'earned' : ''}><span>📚</span><b>단어 수집가</b><small>50km 달성</small></div><div><span>🗽</span><b>뉴요커</b><small>100km 달성</small></div></div></div></div>
}

export default App
