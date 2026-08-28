import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { User } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './supabase'

type Tab = 'dictation' | 'quiz' | 'bag' | 'vault' | 'journey' | 'my'
type SavedSentence = {
  id: number | string
  remoteId?: number
  time: string
  text: string
  savedAt?: string
  videoId?: string
  videoTitle?: string
  channelName?: string
  timestampSec?: number
}
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
  sentence_index?: number
  expression?: string
  expression_type?: 'vocabulary' | 'phrasal_verb' | 'idiom' | 'collocation'
  anchor_words?: string[]
  literal_meaning_kr?: string
  learner_note_kr?: string
  grammar_pattern?: string
  register?: string
  example_en?: string
  example_kr?: string
  start_char?: number
  end_char?: number
  is_dictation_target?: boolean
}
type TranscriptBlock = { timestamp_sec: number; end_sec: number; timestamp_display: string; text: string }
type WordDefinition = {
  word: string
  word_type: string
  definition_kr: string
  expression_type?: 'vocabulary' | 'phrasal_verb' | 'idiom' | 'collocation'
  literal_meaning_kr?: string
  learner_note_kr?: string
  grammar_pattern?: string
  register?: string
  example_en?: string
  example_kr?: string
}
type SavedWordDetails = Record<string, WordDefinition>
type LearningProgressRecord = {
  video_id: string
  video_title: string | null
  channel_name: string | null
  duration_sec: number
  last_position_sec: number
  progress_percent: number
  status: 'started' | 'in_progress' | 'completed'
  started_at: string
  last_studied_at: string
  completed_at: string | null
}
type TranslationItem = { sentence_index: number; translation_kr: string }
type TranslationCacheResponse = {
  video_id: string
  transcript_hash: string
  translation_version: string
  translations: TranslationItem[]
  completed: number
  total: number
  persistent: boolean
}
type OpenAIConnectionResponse = { status: 'connected'; model: string }
type ApiErrorResponse = { detail?: string }
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
type AnalyzeChunkResponse = Pick<AnalyzeResponse, 'analysis_version' | 'learning_items' | 'total_chunks'> & { chunk_index: number }
type EpisodeAnalysisCache = {
  analysisVersion: string
  episodeId: string
  title: string
  sourceName: string
  durationSec: number
  transcript: TranscriptBlock[]
  learningItems: LearningItem[]
}
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
const WORD_CACHE_STORAGE_KEY = 'turtle-word-definitions-v2'
const SAVED_WORD_DETAILS_STORAGE_KEY = 'turtle-saved-word-details-v1'
const AI_CONNECTION_STORAGE_KEY = 'turtle-openai-connection-v1'
const ANALYSIS_VERSION = 'korean-expression-ranges-v3'
const TRANSLATION_VERSION = 'ko-editorial-v1'
const EPISODE_CACHE_PREFIX = 'turtle-episode-analysis'
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

function normalizeWordKey(word: string) {
  return word.trim().toLocaleLowerCase().slice(0, 120)
}

function fastTextHash(text: string) {
  let hash = 2166136261
  for (const character of text.replace(/\s+/g, ' ').trim().toLocaleLowerCase()) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

async function transcriptDigest(blocks: TranscriptBlock[]) {
  const normalized = blocks.map((block) => `${block.timestamp_sec.toFixed(3)}|${block.text.replace(/\s+/g, ' ').trim()}`).join('\n')
  if (!globalThis.crypto?.subtle) return fastTextHash(normalized)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function contextualWordKey(word: string, sentence: string) {
  return `${normalizeWordKey(word)}:${fastTextHash(sentence)}`
}

function savedSentenceKey(videoId: string | undefined, sentence: Pick<SavedSentence, 'time' | 'text' | 'timestampSec'>) {
  let hash = 2166136261
  for (const character of sentence.text.trim().toLocaleLowerCase()) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  const timestamp = Math.round((sentence.timestampSec || 0) * 1000) || sentence.time.replace(/\D/g, '') || '0'
  return `${videoId || 'unknown'}:${timestamp}:${(hash >>> 0).toString(36)}`
}

function formatSavedDate(value?: string) {
  if (!value) return '저장 일자 없음'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '저장 일자 없음'
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function loadStoredAIConnection() {
  try {
    const stored = JSON.parse(localStorage.getItem(AI_CONNECTION_STORAGE_KEY) || 'null') as OpenAIConnectionResponse | null
    return stored?.status === 'connected' && typeof stored.model === 'string' ? stored : null
  } catch {
    return null
  }
}

function extractYouTubeVideoId(value: string) {
  const match = value.trim().match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/)
  return match?.[1] || (/^[A-Za-z0-9_-]{11}$/.test(value.trim()) ? value.trim() : '')
}

function episodeCacheKey(videoId: string) {
  return `${EPISODE_CACHE_PREFIX}-${videoId}-${ANALYSIS_VERSION}`
}

function loadEpisodeAnalysisCache(videoId: string): AnalyzeResponse | null {
  try {
    const cached = JSON.parse(localStorage.getItem(episodeCacheKey(videoId)) || 'null') as EpisodeAnalysisCache | null
    if (!cached || cached.analysisVersion !== ANALYSIS_VERSION || !Array.isArray(cached.transcript) || !cached.transcript.length || !Array.isArray(cached.learningItems)) return null
    return {
      episode_id: cached.episodeId,
      title: cached.title,
      source_name: cached.sourceName,
      duration_sec: cached.durationSec,
      transcript: cached.transcript,
      learning_items: cached.learningItems,
      analysis_status: 'complete',
      analysis_version: cached.analysisVersion,
      cached: true,
      completed_chunks: 1,
      total_chunks: 1,
    }
  } catch {
    return null
  }
}

function storeEpisodeAnalysisCache(data: AnalyzeResponse, learningItems: LearningItem[]) {
  try {
    const cache: EpisodeAnalysisCache = {
      analysisVersion: data.analysis_version,
      episodeId: data.episode_id,
      title: data.title,
      sourceName: data.source_name,
      durationSec: data.duration_sec,
      transcript: data.transcript,
      learningItems,
    }
    localStorage.setItem(episodeCacheKey(data.episode_id), JSON.stringify(cache))
  } catch {
    // Learning still works when browser storage is unavailable.
  }
}

function chunkTranscriptBlocks(blocks: TranscriptBlock[], characterLimit = 24_000) {
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  for (const [sentenceIndex, block] of blocks.entries()) {
    const line = `[sentence_index=${sentenceIndex}] [${block.timestamp_sec.toFixed(3)}s] ${block.text}`
    if (current.length && size + line.length + 1 > characterLimit) {
      chunks.push(current.join('\n'))
      current = []
      size = 0
    }
    current.push(line)
    size += line.length + 1
  }
  if (current.length) chunks.push(current.join('\n'))
  return chunks
}

function mergeLearningItems(current: LearningItem[], incoming: LearningItem[]) {
  const unique = new Map<string, LearningItem>()
  for (const item of [...current, ...incoming]) unique.set(`${Math.round(item.timestamp_sec)}:${item.target_word.toLocaleLowerCase()}`, item)
  return [...unique.values()].sort((a, b) => a.timestamp_sec - b.timestamp_sec)
}

async function readApiJson<T>(response: Response): Promise<T | ApiErrorResponse | null> {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return await response.json().catch(() => null) as T | ApiErrorResponse | null
  }

  const body = await response.text().catch(() => '')
  const looksLikeLoginPage = /<html|<!doctype/i.test(body) && /log\s*in|sign\s*in|vercel authentication|sso/i.test(body)
  if (looksLikeLoginPage) {
    throw new Error('배포 서버가 API 대신 로그인 페이지를 반환했습니다. Vercel 배포 보호 설정을 확인해 주세요.')
  }
  if (response.status === 404) {
    throw new Error('배포 서버에서 API 경로를 찾지 못했습니다. 최신 배포가 완료되었는지 확인해 주세요.')
  }
  throw new Error(`API 서버가 예상하지 못한 형식으로 응답했습니다. (상태 ${response.status})`)
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
  const [savedWordDetails, setSavedWordDetails] = useState<SavedWordDetails>(() => JSON.parse(localStorage.getItem(SAVED_WORD_DETAILS_STORAGE_KEY) || '{}'))
  const [completedWords, setCompletedWords] = useState<string[]>(() => JSON.parse(localStorage.getItem('turtle-completed-words') || '[]'))
  const [answer, setAnswer] = useState('')
  const [quizState, setQuizState] = useState<'idle' | 'correct' | 'wrong'>('idle')
  const [quizIndex, setQuizIndex] = useState(0)
  const [toast, setToast] = useState('')
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [learningProgressByVideo, setLearningProgressByVideo] = useState<Record<string, LearningProgressRecord>>({})
  const [aiConnection, setAiConnection] = useState<'unknown' | 'checking' | 'connected' | 'error'>(() => loadStoredAIConnection() ? 'connected' : 'unknown')
  const [aiConnectionMessage, setAiConnectionMessage] = useState('')
  const analysisControllerRef = useRef<AbortController | null>(null)
  const previousAuthUserIdRef = useRef<string | null>(null)

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
  useEffect(() => { localStorage.setItem(SAVED_WORD_DETAILS_STORAGE_KEY, JSON.stringify(savedWordDetails)) }, [savedWordDetails])
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
    if (!supabase || !authUser) return
    let active = true

    void Promise.all([
      supabase.from('saved_words').select('word, word_key, word_type, definition_kr').eq('user_id', authUser.id).order('created_at', { ascending: true }),
      supabase.from('saved_sentences').select('id, sentence_key, sentence_text, video_id, video_title, channel_name, timestamp_sec, timestamp_display, created_at').eq('user_id', authUser.id).order('created_at', { ascending: false }),
      supabase.from('learning_progress').select('video_id, video_title, channel_name, duration_sec, last_position_sec, progress_percent, status, started_at, last_studied_at, completed_at').eq('user_id', authUser.id).order('last_studied_at', { ascending: false }),
    ]).then(([wordsResult, sentencesResult, progressResult]) => {
      if (!active) return
      if (wordsResult.error || sentencesResult.error || progressResult.error) {
        flash('계정 저장 내용을 불러오지 못했어요. 잠시 후 다시 시도해 주세요')
        return
      }

      const remoteWords = wordsResult.data || []
      setBag(Array.from(new Set(remoteWords.map((row) => row.word_key))))
      setSavedWordDetails(() => {
        const next: SavedWordDetails = {}
        remoteWords.forEach((row) => {
          next[row.word_key] = {
            word: row.word,
            word_type: row.word_type || 'word',
            definition_kr: row.definition_kr || '저장된 단어',
          }
        })
        return next
      })

      const remoteSentences: SavedSentence[] = (sentencesResult.data || []).map((row) => ({
        id: `remote-${row.id}`,
        remoteId: row.id,
        time: row.timestamp_display || formatPlayerTime(row.timestamp_sec || 0),
        text: row.sentence_text,
        savedAt: row.created_at,
        videoId: row.video_id || undefined,
        videoTitle: row.video_title || undefined,
        channelName: row.channel_name || undefined,
        timestampSec: row.timestamp_sec || 0,
      }))
      setSaved(remoteSentences)
      setLearningProgressByVideo(Object.fromEntries((progressResult.data || []).map((row) => [row.video_id, row as LearningProgressRecord])))
    })

    return () => { active = false }
  }, [authUser])

  useEffect(() => {
    if (authLoading) return
    const previousUserId = previousAuthUserIdRef.current
    const nextUserId = authUser?.id || null
    if (previousUserId && !nextUserId) {
      setBag([])
      setSavedWordDetails({})
      setSaved([])
      setLearningProgressByVideo({})
    }
    previousAuthUserIdRef.current = nextUserId
  }, [authLoading, authUser])

  useEffect(() => () => analysisControllerRef.current?.abort(), [])

  const episodeProgress = useMemo(() => Math.min(100, Math.round((progress / 100) * 100)), [progress])
  const dictationItems = useMemo(() => learningItems.filter((item) => item.is_dictation_target !== false), [learningItems])

  function persistLearningProgress(videoId: string, title: string, channel: string, duration: number, position = 0) {
    if (!supabase || !authUser || !videoId) return
    const safeDuration = Math.max(0, duration || 0)
    const safePosition = Math.max(0, Math.min(position || 0, safeDuration || position || 0))
    const progressPercent = safeDuration > 0 ? Math.min(100, Number(((safePosition / safeDuration) * 100).toFixed(2))) : 0
    const status: LearningProgressRecord['status'] = progressPercent >= 95 ? 'completed' : safePosition > 0 ? 'in_progress' : 'started'
    const now = new Date().toISOString()
    const existing = learningProgressByVideo[videoId]
    const record: LearningProgressRecord = {
      video_id: videoId,
      video_title: title || null,
      channel_name: channel || null,
      duration_sec: safeDuration,
      last_position_sec: safePosition,
      progress_percent: progressPercent,
      status,
      started_at: existing?.started_at || now,
      last_studied_at: now,
      completed_at: status === 'completed' ? (existing?.completed_at || now) : null,
    }
    setLearningProgressByVideo((current) => ({ ...current, [videoId]: record }))
    void supabase.from('learning_progress').upsert({
      user_id: authUser.id,
      ...record,
    }, { onConflict: 'user_id,video_id' }).then(({ error }) => {
      if (error) flash('학습 기록을 계정에 저장하지 못했어요')
    })
  }

  async function checkOpenAIConnection() {
    setAiConnection('checking')
    setAiConnectionMessage('')
    try {
      const response = await fetch(`${API_BASE_URL}/api/openai/validate`, { method: 'POST' })
      const data = await readApiJson<OpenAIConnectionResponse>(response)
      if (!response.ok) throw new Error((data && 'detail' in data && data.detail) || 'OpenAI 연결 확인에 실패했습니다.')
      if (!data || !('status' in data) || data.status !== 'connected') throw new Error('OpenAI 연결 결과를 확인하지 못했습니다.')

      localStorage.setItem(AI_CONNECTION_STORAGE_KEY, JSON.stringify(data))
      setAiConnection('connected')
      setAiConnectionMessage('')
      flash('OpenAI 연결을 확인했어요')
    } catch (error) {
      localStorage.removeItem(AI_CONNECTION_STORAGE_KEY)
      setAiConnection('error')
      setAiConnectionMessage(error instanceof Error ? error.message : 'OpenAI 연결 확인 중 오류가 발생했습니다.')
    }
  }

  async function runProgressiveAnalysis(data: AnalyzeResponse) {
    const chunks = chunkTranscriptBlocks(data.transcript)
    if (!chunks.length) return
    analysisControllerRef.current?.abort()
    const controller = new AbortController()
    analysisControllerRef.current = controller
    setAnalysisStatus('running')
    setAnalysisProgress({ completed: 0, total: chunks.length })
    let cursor = 0
    let completed = 0
    let collected = [...data.learning_items]

    const worker = async () => {
      while (!controller.signal.aborted) {
        const chunkIndex = cursor++
        if (chunkIndex >= chunks.length) return
        const response = await fetch(`${API_BASE_URL}/api/episodes/analyze-chunk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            episode_id: data.episode_id,
            chunk_index: chunkIndex,
            total_chunks: chunks.length,
            transcript_chunk: chunks[chunkIndex],
          }),
          signal: controller.signal,
        })
        const result = await readApiJson<AnalyzeChunkResponse>(response)
        if (!response.ok || !result || !('learning_items' in result)) {
          throw new Error((result && 'detail' in result && result.detail) || '학습 단어 분석에 실패했습니다.')
        }
        collected = mergeLearningItems(collected, result.learning_items)
        completed += 1
        setLearningItems([...collected])
        setAnalysisProgress({ completed, total: chunks.length })
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, () => worker()))
      if (controller.signal.aborted) return
      setAnalysisStatus('complete')
      storeEpisodeAnalysisCache(data, collected)
      flash(`B2·C1 학습 표현 ${collected.length}개를 준비했어요`)
    } catch (error) {
      if (controller.signal.aborted) return
      setAnalysisStatus('error')
      setLoadError(error instanceof Error ? error.message : '학습 단어 분석에 실패했습니다.')
    }
  }

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
      const videoId = extractYouTubeVideoId(value)
      const browserCache = videoId ? loadEpisodeAnalysisCache(videoId) : null
      if (browserCache) {
        analysisControllerRef.current?.abort()
        setEpisodeId(browserCache.episode_id)
        setEpisodeTitle(browserCache.title)
        setSourceName(browserCache.source_name)
        setDurationSec(browserCache.duration_sec)
        setTranscript(browserCache.transcript)
        setLearningItems(browserCache.learning_items)
        setAnalysisStatus('complete')
        setAnalysisProgress({ completed: 1, total: 1 })
        setLoaded(true)
        navigateTo('dictation')
        persistLearningProgress(browserCache.episode_id, browserCache.title, browserCache.source_name, browserCache.duration_sec, learningProgressByVideo[browserCache.episode_id]?.last_position_sec || 0)
        flash('저장된 분석 결과를 바로 불러왔어요')
        return
      }
      const response = await fetch(`${API_BASE_URL}/api/episodes/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtube_url: value }),
      })
      const data = await readApiJson<AnalyzeResponse>(response)
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
      persistLearningProgress(data.episode_id, data.title, data.source_name, data.duration_sec, learningProgressByVideo[data.episode_id]?.last_position_sec || 0)
      if (data.analysis_status === 'complete') {
        storeEpisodeAnalysisCache(data, data.learning_items)
        flash(`B2·C1 학습 표현 ${data.learning_items.length}개를 준비했어요`)
      } else {
        flash('전체 스크립트를 먼저 준비했어요')
        if (data.analysis_status === 'pending') void runProgressiveAnalysis(data)
      }
    } catch (error) {
      const message = error instanceof TypeError
        ? '분석 서버에 연결할 수 없습니다. 백엔드가 실행 중인지 확인해 주세요.'
        : error instanceof Error ? error.message : '영상 분석 중 오류가 발생했습니다.'
      setLoadError(message)
      const failedVideoId = extractYouTubeVideoId(value)
      if (failedVideoId && message.includes('자막')) {
        analysisControllerRef.current?.abort()
        setEpisodeId(failedVideoId)
        setEpisodeTitle('YouTube 영상')
        setSourceName('YouTube · 사용할 수 있는 영어 자막 없음')
        setDurationSec(0)
        setTranscript([])
        setLearningItems([])
        setAnalysisStatus('error')
        setAnalysisProgress({ completed: 0, total: 0 })
        setLoaded(true)
        navigateTo('dictation')
      }
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

  function saveSentence(block: TranscriptBlock) {
    const sentence: SavedSentence = {
      id: Date.now(),
      time: block.timestamp_display,
      text: block.text,
      savedAt: new Date().toISOString(),
      videoId: episodeId,
      videoTitle: episodeTitle,
      channelName: sourceName,
      timestampSec: block.timestamp_sec,
    }
    const key = savedSentenceKey(episodeId, sentence)
    if (saved.some((item) => savedSentenceKey(item.videoId, item) === key)) {
      flash('이미 문장 금고에 저장되어 있어요')
      return
    }

    setSaved((current) => [sentence, ...current])
    flash('문장 금고에 안전하게 보관했어요')

    if (supabase && authUser) {
      void supabase.from('saved_sentences').upsert({
        user_id: authUser.id,
        sentence_key: key,
        sentence_text: sentence.text,
        video_id: sentence.videoId,
        video_title: sentence.videoTitle,
        channel_name: sentence.channelName,
        timestamp_sec: sentence.timestampSec,
        timestamp_display: sentence.time,
      }, { onConflict: 'user_id,sentence_key' }).select('id, created_at').single().then(({ data, error }) => {
        if (error || !data) {
          flash('문장은 기기에 저장했지만 계정 동기화에 실패했어요')
          return
        }
        setSaved((current) => current.map((item) => item.id === sentence.id ? { ...item, remoteId: data.id, savedAt: data.created_at } : item))
      })
    }
  }

  function saveWord(word: string, details?: WordDefinition) {
    const normalized = normalizeWordKey(word)
    if (!normalized) return
    const definition = details || savedWordDetails[normalized]
    setBag((current) => current.some((item) => normalizeWordKey(item) === normalized) ? current : [...current, normalized])
    if (definition) setSavedWordDetails((current) => ({ ...current, [normalized]: definition }))
    flash(`${word} 단어를 짐가방에 저장했어요`)

    if (supabase && authUser) {
      void supabase.from('saved_words').upsert({
        user_id: authUser.id,
        word,
        word_key: normalized,
        word_type: definition?.word_type || null,
        definition_kr: definition?.definition_kr || null,
        video_id: episodeId || null,
        video_title: episodeTitle || null,
        channel_name: sourceName || null,
      }, { onConflict: 'user_id,word_key' }).then(({ error }) => {
        if (error) flash('단어는 기기에 저장했지만 계정 동기화에 실패했어요')
      })
    }
  }

  function removeSavedSentence(id: SavedSentence['id']) {
    const sentence = saved.find((item) => item.id === id)
    setSaved((current) => current.filter((item) => item.id !== id))
    if (!sentence || !supabase || !authUser) return
    void supabase.from('saved_sentences').delete().eq('user_id', authUser.id).eq('sentence_key', savedSentenceKey(sentence.videoId, sentence)).then(({ error }) => {
      if (error) flash('기기에서는 삭제했지만 계정 동기화에 실패했어요')
    })
  }

  function completeWord(word: string) {
    const normalized = word.toLocaleLowerCase().trim()
    setCompletedWords((now) => now.includes(normalized) ? now : [...now, normalized])
  }

  function submitQuiz() {
    const item = dictationItems[quizIndex]
    if (!item) return
    if (answer.trim().toLowerCase() === item.target_word.toLowerCase()) {
      setQuizState('correct')
      setProgress((p) => Math.min(100, p + 4))
      setBag((now) => now.filter((w) => w !== item.target_word))
    } else {
      setQuizState('wrong')
      saveWord(item.target_word, { word: item.target_word, word_type: item.word_type, definition_kr: item.definition_kr })
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
          <div><span className="eyebrow">YOUR ENGLISH JOURNEY</span><h1>천천히, 하지만 꾸준히<br /><strong>오늘도 미국으로 한 걸음.</strong></h1><p>생생한 영어를 들으며 즐겁게 공부해요</p></div>
          <div className="mini-journey"><img src="/assets/turtle-b.png" alt="달리는 거북이" /><div><span><b>뉴욕까지</b><b>{100 - progress} km</b></span><div className="journey-track"><i style={{ width: `${progress}%` }} /></div><small>이번 주 18km 전진 · 상위 12%</small></div></div>
        </section>

        <section className="url-card" aria-label="유튜브 에피소드 불러오기">
          <div className="url-card-head">
            <div className="url-copy"><span className="play-dot">▶</span><div><b>오늘 함께 듣고 싶은 영상을 공유해주세요</b><small>AI가 영상 스크립트의 단어를 받아쓰기할 수 있게 도와줍니다.</small></div></div>
            <button className={`ai-connection-button ${aiConnection}`} type="button" onClick={checkOpenAIConnection} disabled={aiConnection === 'checking'} aria-label="OpenAI 연결 확인">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="12" r="4"/><path d="M12 12h8M17 12v3M20 12v2"/></svg>
              {aiConnection === 'checking' ? '연결 확인 중…' : aiConnection === 'connected' ? 'AI 연결됨' : aiConnection === 'error' ? '다시 확인' : 'AI 연결 확인'}
            </button>
          </div>
          {aiConnection === 'error' && aiConnectionMessage && <p className={`ai-connection-message ${aiConnection}`} role="status">{aiConnectionMessage}</p>}
          <div className="url-form"><input value={url} onChange={(e) => { setUrl(e.target.value); setLoadError('') }} onKeyDown={(e) => e.key === 'Enter' && !loading && startLearning()} placeholder="YouTube 링크를 붙여넣으세요" aria-label="유튜브 링크" aria-invalid={Boolean(loadError)} /><button onClick={startLearning} disabled={loading}>{loading ? <><span className="spinner" />분석 중</> : '학습 시작 →'}</button></div>
          {loadError && <p className="url-error" role="alert">{loadError}</p>}
        </section>

        {loaded && <section className="workspace">
          {tab === 'dictation' && <Dictation episodeId={episodeId} title={episodeTitle} sourceName={sourceName} durationSec={durationSec} transcript={transcript} items={learningItems} playing={playing} setPlaying={setPlaying} highlights={highlights} toggleHighlight={toggleHighlight} savedSentences={saved} saveSentence={saveSentence} savedWords={bag} saveWord={saveWord} completedWords={completedWords} completeWord={completeWord} episodeProgress={episodeProgress} analysisStatus={analysisStatus} analysisProgress={analysisProgress} initialPositionSec={learningProgressByVideo[episodeId]?.last_position_sec || 0} onProgress={(position, duration) => persistLearningProgress(episodeId, episodeTitle, sourceName, duration, position)} />}
          {tab === 'quiz' && <Quiz item={dictationItems[quizIndex]} index={quizIndex} total={dictationItems.length} answer={answer} setAnswer={setAnswer} state={quizState} submit={submitQuiz} next={() => { setAnswer(''); setQuizState('idle'); setQuizIndex((quizIndex + 1) % Math.max(1, dictationItems.length)) }} />}
          {tab === 'bag' && <Bag words={bag} items={learningItems} details={savedWordDetails} practice={() => navigateTo('quiz')} />}
          {tab === 'vault' && <Vault sentences={saved} remove={removeSavedSentence} />}
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

function C1Token({ item, tokenId, focusRequested, onSave, onComplete, onResolved }: { item: LearningItem; tokenId: string; focusRequested: boolean; onSave: (word: string, details?: WordDefinition) => void; onComplete: (word: string) => void; onResolved: (tokenId: string, typed: boolean) => void }) {
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
  useEffect(() => { if (editing) inputRef.current?.focus({ preventScroll: true }) }, [editing])
  useEffect(() => {
    if (!focusRequested || revealed) return
    setEditing(true)
    window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
  }, [focusRequested, revealed])

  function reveal() {
    window.clearTimeout(clickTimer.current)
    setRevealed(true)
    setEditing(false)
    onResolved(tokenId, false)
    onSave(phrase, { word: phrase, word_type: item.word_type, definition_kr: item.definition_kr })
  }

  function updateAnswer(nextValue: string) {
    setValue(nextValue)
    setResult('idle')
    if (nextValue.trim().toLocaleLowerCase() === phrase.toLocaleLowerCase()) {
      setResult('correct')
      setRevealed(true)
      setEditing(false)
      setShowGood(true)
      onResolved(tokenId, true)
      window.clearTimeout(goodTimer.current)
      goodTimer.current = window.setTimeout(() => { setShowGood(false); onComplete(phrase) }, 1400)
      onSave(phrase, { word: phrase, word_type: item.word_type, definition_kr: item.definition_kr })
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

function InteractiveScriptText({ text, sentenceIndex, items, highlights, completedWords, onWordClick, onSaveWord, onCompleteWord }: { text: string; sentenceIndex: number; items: LearningItem[]; highlights: Highlight[]; completedWords: string[]; onWordClick: (word: string, event: MouseEvent<HTMLElement>, charOffset: number) => void; onSaveWord: (word: string, details?: WordDefinition) => void; onCompleteWord: (word: string) => void }) {
  const [focusTokenId, setFocusTokenId] = useState('')
  const [sentenceComplete, setSentenceComplete] = useState(false)
  const resolvedTokenIds = useRef(new Set<string>())
  const targets = useMemo(() => items
    .filter((item) => item.is_dictation_target !== false)
    .map((item) => {
      const expression = (item.expression || item.target_word).trim()
      const declaredStart = item.start_char ?? -1
      const start = declaredStart >= 0 ? declaredStart : text.toLocaleLowerCase().indexOf(expression.toLocaleLowerCase())
      return { item, expression, start, id: `${sentenceIndex}:${start}:${expression.toLocaleLowerCase()}` }
    })
    .filter((target) => target.start >= 0)
    .sort((a, b) => a.start - b.start || b.expression.length - a.expression.length), [items, sentenceIndex, text])

  useEffect(() => {
    resolvedTokenIds.current = new Set()
    setFocusTokenId('')
    setSentenceComplete(false)
  }, [sentenceIndex, text])

  function handleResolved(tokenId: string, typed: boolean) {
    resolvedTokenIds.current.add(tokenId)
    if (!typed) return
    const currentPosition = targets.findIndex((target) => target.id === tokenId)
    const incomplete = (target: typeof targets[number]) => !resolvedTokenIds.current.has(target.id) && !completedWords.includes(target.expression.toLocaleLowerCase())
    const next = targets.slice(currentPosition + 1).find(incomplete) || targets.find(incomplete)
    if (!next) setSentenceComplete(true)
    window.setTimeout(() => setFocusTokenId(next?.id || ''), 200)
  }

  const renderSegment = (value: string, offset: number, key: string) => {
    const nodes: ReactNode[] = []
    let cursor = 0
    while (cursor < value.length) {
      const remaining = value.slice(cursor)
      const absoluteOffset = offset + cursor
      const learningTarget = targets.find((target) => {
        if (target.start !== absoluteOffset) return false
        if (!remaining.toLocaleLowerCase().startsWith(target.expression.toLocaleLowerCase())) return false
        const before = cursor === 0 ? '' : value[cursor - 1]
        const after = value[cursor + target.expression.length] || ''
        return !/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after)
      })
      if (learningTarget) {
        const { item: learningItem, expression: target, id } = learningTarget
        if (completedWords.includes(target.toLocaleLowerCase())) {
          nodes.push(<span key={`${key}-learned-${absoluteOffset}`} className="script-word learned-word" onClick={(event) => onWordClick(target, event, absoluteOffset)}>{target}</span>)
        } else {
          nodes.push(<C1Token key={`${key}-target-${absoluteOffset}`} item={learningItem} tokenId={id} focusRequested={focusTokenId === id} onSave={onSaveWord} onComplete={onCompleteWord} onResolved={handleResolved} />)
        }
        cursor += target.length
        continue
      }
      const word = remaining.match(/^[A-Za-z][A-Za-z'’-]*/)?.[0]
      if (word) {
        nodes.push(<span key={`${key}-word-${absoluteOffset}`} className="script-word" onClick={(event) => onWordClick(word, event, absoluteOffset)}>{word}</span>)
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
  return <>{nodes}{sentenceComplete && <span className="dictation-sentence-complete" role="status" aria-label="문장 받아쓰기 완료">✓</span>}</>
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
  savedSentences: SavedSentence[]
  saveSentence: (block: TranscriptBlock) => void
  savedWords: string[]
  saveWord: (word: string, details?: WordDefinition) => void
  completedWords: string[]
  completeWord: (word: string) => void
  episodeProgress: number
  analysisStatus: AnalysisStatus
  analysisProgress: { completed: number; total: number }
  initialPositionSec: number
  onProgress: (position: number, duration: number) => void
}

function Dictation({ episodeId, title, sourceName, durationSec, transcript, items, playing, setPlaying, highlights, toggleHighlight, savedSentences, saveSentence, savedWords, saveWord, completedWords, completeWord, episodeProgress, analysisStatus, analysisProgress, initialPositionSec, onProgress }: DictationProps) {
  const [palette, setPalette] = useState<null | { line: number; start: number; end: number; text: string; x: number; y: number; placement: 'above' | 'below' }>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [playerDuration, setPlayerDuration] = useState(0)
  const [playerReady, setPlayerReady] = useState(false)
  const [videoCollapsed, setVideoCollapsed] = useState(false)
  const [wordPopover, setWordPopover] = useState<null | { wordKey: string; x: number; y: number; loading: boolean; saved: boolean; data: WordDefinition; error?: string }>(null)
  const [translations, setTranslations] = useState<Record<number, string>>({})
  const [expandedTranslations, setExpandedTranslations] = useState<Set<number>>(new Set())
  const [translationLoading, setTranslationLoading] = useState<Set<number>>(new Set())
  const [translationHash, setTranslationHash] = useState('')
  const [translationProgress, setTranslationProgress] = useState({ completed: 0, total: transcript.length, persistent: false })
  const [visibleLineIndex, setVisibleLineIndex] = useState(0)
  const visibleLineIndexRef = useRef(0)
  const lineRefs = useRef<Array<HTMLDivElement | null>>([])
  const readingBodyRef = useRef<HTMLDivElement | null>(null)
  const playerHostRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YouTubePlayerInstance | null>(null)
  const definitionCache = useRef(loadStoredWordDefinitions())
  const translationCache = useRef<Record<number, string>>({})
  const translationControllerRef = useRef<AbortController | null>(null)
  const translationSlotsRef = useRef<{ active: number; waiters: Array<() => void> }>({ active: 0, waiters: [] })
  const dragGuardUntilRef = useRef(0)
  const pointerStartRef = useRef({ x: 0, y: 0 })
  const onProgressRef = useRef(onProgress)
  const lastProgressSyncRef = useRef({ episodeId: '', syncedAt: 0, position: -1 })
  const restoredEpisodeRef = useRef('')
  const duration = Math.max(playerDuration, durationSec, transcript.at(-1)?.end_sec || 0, 1)
  const currentIndex = useMemo(() => {
    if (!transcript.length) return -1
    let active = 0
    transcript.forEach((line, index) => {
      if (currentTime >= line.timestamp_sec) active = index
    })
    return active
  }, [currentTime, transcript])

  useEffect(() => { onProgressRef.current = onProgress }, [onProgress])

  useEffect(() => {
    let changed = false
    items.forEach((item) => {
      const sentence = item.full_sentence_original || ''
      const key = contextualWordKey(item.expression || item.target_word, sentence)
      if (!definitionCache.current.has(key)) {
        definitionCache.current.set(key, {
          word: item.expression || item.target_word,
          word_type: `${item.level || 'C1'} · ${item.word_type}`,
          definition_kr: item.definition_kr,
          expression_type: item.expression_type,
          literal_meaning_kr: item.literal_meaning_kr,
          learner_note_kr: item.learner_note_kr,
          grammar_pattern: item.grammar_pattern,
          register: item.register,
          example_en: item.example_en,
          example_kr: item.example_kr,
        })
        changed = true
      }
    })
    if (changed) storeWordDefinitions(definitionCache.current)
  }, [items])

  useEffect(() => {
    let active = true
    setTranslationHash('')
    setTranslations({})
    translationCache.current = {}
    setExpandedTranslations(new Set())
    setTranslationProgress({ completed: 0, total: transcript.length, persistent: false })
    if (!episodeId || !transcript.length) return () => { active = false }
    void transcriptDigest(transcript).then((hash) => {
      if (!active) return
      setTranslationHash(hash)
    })
    return () => { active = false }
  }, [episodeId, transcript])

  useEffect(() => {
    if (!translationHash || !transcript.length) return
    const controller = new AbortController()
    translationControllerRef.current?.abort()
    translationControllerRef.current = controller
    const localKey = `turtle-translations-${episodeId}-${translationHash}-${TRANSLATION_VERSION}`
    try {
      const stored = JSON.parse(localStorage.getItem(localKey) || '{}') as Record<number, string>
      translationCache.current = stored
      setTranslations(stored)
    } catch {
      translationCache.current = {}
    }

    const prepare = async () => {
      try {
        const cacheResponse = await fetch(`${API_BASE_URL}/api/translations/cache`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video_id: episodeId, transcript_hash: translationHash, translation_version: TRANSLATION_VERSION, total_sentences: transcript.length }),
          signal: controller.signal,
        })
        const cacheData = await readApiJson<TranslationCacheResponse>(cacheResponse)
        if (!cacheResponse.ok || !cacheData || !('translations' in cacheData)) throw new Error((cacheData && 'detail' in cacheData && cacheData.detail) || '번역 캐시를 불러오지 못했습니다.')
        cacheData.translations.forEach((item) => { translationCache.current[item.sentence_index] = item.translation_kr })
        setTranslations({ ...translationCache.current })
        setTranslationProgress({ completed: Object.keys(translationCache.current).length, total: transcript.length, persistent: cacheData.persistent })
        localStorage.setItem(localKey, JSON.stringify(translationCache.current))

        const chunks: number[][] = []
        for (let index = 0; index < transcript.length; index += 25) {
          const indices = Array.from({ length: Math.min(25, transcript.length - index) }, (_, offset) => index + offset)
            .filter((sentenceIndex) => !translationCache.current[sentenceIndex])
          if (indices.length) chunks.push(indices)
        }
        const worker = async () => {
          while (!controller.signal.aborted) {
            chunks.sort((a, b) => Math.abs((a[0] || 0) - visibleLineIndexRef.current) - Math.abs((b[0] || 0) - visibleLineIndexRef.current))
            const indices = chunks.shift()
            if (!indices) return
            await requestTranslationBatch(indices, '/api/translations/batch', controller.signal)
            localStorage.setItem(localKey, JSON.stringify(translationCache.current))
          }
        }
        await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, () => worker()))
      } catch (error) {
        if (!controller.signal.aborted) console.warn('Background translation paused:', error)
      }
    }
    void prepare()
    return () => controller.abort()
  }, [episodeId, sourceName, title, transcript, translationHash])

  useEffect(() => {
    const controller = new AbortController()
    const candidates: Array<{ word: string; context: string; sentence_hash: string }> = []
    const scheduled = new Set<string>()
    for (const block of transcript) {
      const words = block.text.match(/[A-Za-z][A-Za-z'’-]*/g) || []
      for (const word of words) {
        const normalized = word.toLocaleLowerCase()
        const context = block.text.slice(0, 700)
        const cacheKey = contextualWordKey(word, context)
        if (word.length < 4 || PREFETCH_STOP_WORDS.has(normalized) || scheduled.has(cacheKey) || definitionCache.current.has(cacheKey)) continue
        scheduled.add(cacheKey)
        candidates.push({ word, context, sentence_hash: fastTextHash(context) })
        if (candidates.length >= 90) break
      }
      if (candidates.length >= 90) break
    }

    const prefetch = async () => {
      for (let index = 0; index < candidates.length; index += 30) {
        if (controller.signal.aborted) return
        try {
          const batch = candidates.slice(index, index + 30)
          const response = await fetch(`${API_BASE_URL}/api/vocabulary/prefetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: batch }),
            signal: controller.signal,
          })
          if (!response.ok) return
          const data = await response.json() as { definitions?: WordDefinition[] }
          data.definitions?.forEach((definition, definitionIndex) => {
            const source = batch[definitionIndex]
            if (source) definitionCache.current.set(contextualWordKey(source.word, source.context), definition)
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
            if (disposed) return
            setPlaying(event.data === 1)
            if (event.data === 2 || event.data === 0) {
              const position = player.getCurrentTime() || 0
              const total = player.getDuration() || durationSec || 0
              onProgressRef.current(position, total)
            }
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
    if (!playerReady || restoredEpisodeRef.current === episodeId || initialPositionSec <= 0) return
    const player = playerRef.current
    if (!player || typeof player.seekTo !== 'function') return
    player.seekTo(initialPositionSec, true)
    setCurrentTime(initialPositionSec)
    restoredEpisodeRef.current = episodeId
  }, [episodeId, initialPositionSec, playerReady])

  useEffect(() => {
    if (!playerReady) return
    const timer = window.setInterval(() => {
      const player = playerRef.current
      if (!player || typeof player.getCurrentTime !== 'function' || typeof player.getDuration !== 'function') return
      const position = player.getCurrentTime() || 0
      setCurrentTime(position)
      const actualDuration = player.getDuration()
      if (actualDuration) setPlayerDuration(actualDuration)
      const sync = lastProgressSyncRef.current
      const now = Date.now()
      if (playing && (sync.episodeId !== episodeId || now - sync.syncedAt >= 10_000) && Math.abs(position - sync.position) >= 1) {
        sync.episodeId = episodeId
        sync.syncedAt = now
        sync.position = position
        onProgressRef.current(position, actualDuration || durationSec || 0)
      }
    }, 350)
    return () => window.clearInterval(timer)
  }, [durationSec, episodeId, playerReady, playing])

  useEffect(() => {
    if (playing && autoFollow && currentIndex >= 0) lineRefs.current[currentIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [autoFollow, currentIndex, playing])

  function itemsForBlock(block: TranscriptBlock, sentenceIndex: number) {
    return items.filter((item) => {
      const expression = item.expression || item.target_word
      const assignedToSentence = item.sentence_index === sentenceIndex
      const assignedByTime = (item.sentence_index ?? -1) < 0 && item.timestamp_sec >= block.timestamp_sec && item.timestamp_sec < block.end_sec
      return (assignedToSentence || assignedByTime) && block.text.toLocaleLowerCase().includes(expression.toLocaleLowerCase())
    })
  }

  async function withTranslationSlot<T>(task: () => Promise<T>) {
    const slots = translationSlotsRef.current
    if (slots.active >= 2) await new Promise<void>((resolve) => slots.waiters.push(resolve))
    slots.active += 1
    try {
      return await task()
    } finally {
      slots.active -= 1
      slots.waiters.shift()?.()
    }
  }

  async function requestTranslationBatch(indices: number[], endpoint: '/api/translations/batch' | '/api/translations/lookup', signal?: AbortSignal) {
    const uniqueIndices = [...new Set(indices)].filter((index) => transcript[index] && !translationCache.current[index])
    if (!uniqueIndices.length) return
    const sentences = uniqueIndices.map((index) => ({
      sentence_index: index,
      text: transcript[index].text,
      previous_text: transcript[index - 1]?.text || '',
      next_text: transcript[index + 1]?.text || '',
    }))
    const response = await withTranslationSlot(() => fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: episodeId,
        transcript_hash: translationHash,
        translation_version: TRANSLATION_VERSION,
        total_sentences: transcript.length,
        title,
        channel_name: sourceName,
        topic: title,
        sentences,
      }),
      signal,
    }))
    const data = await readApiJson<TranslationCacheResponse>(response)
    if (!response.ok || !data || !('translations' in data)) throw new Error((data && 'detail' in data && data.detail) || '번역을 불러오지 못했습니다.')
    data.translations.forEach((item) => { translationCache.current[item.sentence_index] = item.translation_kr })
    setTranslations({ ...translationCache.current })
    setTranslationProgress({ completed: Object.keys(translationCache.current).length, total: transcript.length, persistent: data.persistent })
  }

  function handleReadingScroll() {
    const container = readingBodyRef.current
    if (!container) return
    const top = container.getBoundingClientRect().top
    let closest = visibleLineIndexRef.current
    let distance = Number.POSITIVE_INFINITY
    lineRefs.current.forEach((element, index) => {
      if (!element) return
      const nextDistance = Math.abs(element.getBoundingClientRect().top - top - 12)
      if (nextDistance < distance) {
        distance = nextDistance
        closest = index
      }
    })
    visibleLineIndexRef.current = closest
    setVisibleLineIndex(closest)
  }

  function handlePointerDown(event: PointerEvent<HTMLParagraphElement>) {
    pointerStartRef.current = { x: event.clientX, y: event.clientY }
    setPalette(null)
  }

  function finishPointerSelection(event: PointerEvent<HTMLParagraphElement>, line: number, rawText: string) {
    const movement = Math.hypot(event.clientX - pointerStartRef.current.x, event.clientY - pointerStartRef.current.y)
    const isMouseDrag = event.pointerType === 'mouse' && movement > 4
    const isTouchSelection = event.pointerType !== 'mouse'
    if (!isMouseDrag && !isTouchSelection) {
      setPalette(null)
      return
    }
    dragGuardUntilRef.current = performance.now() + 350
    handleSelection(event, line, rawText)
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

  function playFromTranscript(event: MouseEvent<HTMLDivElement>, seconds: number) {
    if (performance.now() < dragGuardUntilRef.current) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, a, .hint-wrap, .wordwise')) return
    seekTo(seconds, true)
  }

  function handleSelection(event: PointerEvent<HTMLParagraphElement>, line: number, rawText: string) {
    const paragraph = event.currentTarget
    const pointerX = event.clientX
    const pointerY = event.clientY

    // Native selection settles after pointerup. Read it on the next frame so the
    // palette always follows the actual release end, including multi-line ranges.
    window.requestAnimationFrame(() => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        setPalette(null)
        return
      }
      const range = selection.getRangeAt(0)
      if (!paragraph.contains(range.commonAncestorContainer)) {
        setPalette(null)
        return
      }
      const prefix = range.cloneRange()
      prefix.selectNodeContents(paragraph)
      prefix.setEnd(range.startContainer, range.startOffset)
      const start = prefix.toString().length
      const selectedLength = range.toString().length
      if (!selectedLength || !range.toString().trim()) {
        setPalette(null)
        return
      }
      const end = Math.min(rawText.length, start + selectedLength)
      dragGuardUntilRef.current = performance.now() + 350
      const selectionRects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
      const rangeRect = range.getBoundingClientRect()
      const releaseX = pointerX || rangeRect.right
      const releaseY = pointerY || rangeRect.bottom
      const releaseLine = selectionRects.reduce<DOMRect | null>((closest, rect) => {
        if (!closest) return rect
        const distance = releaseY < rect.top ? rect.top - releaseY : releaseY > rect.bottom ? releaseY - rect.bottom : 0
        const closestDistance = releaseY < closest.top ? closest.top - releaseY : releaseY > closest.bottom ? releaseY - closest.bottom : 0
        return distance < closestDistance ? rect : closest
      }, null) || rangeRect
      const edgePadding = window.innerWidth < 520 ? 48 : 52
      const x = Math.max(edgePadding, Math.min(releaseX, window.innerWidth - edgePadding))
      const placement = releaseLine.top < 58 ? 'below' : 'above'
      const y = placement === 'below' ? releaseLine.bottom + 12 : releaseLine.top
      setPalette({ line, start, end, text: rawText.slice(start, end), x, y, placement })
    })
  }

  function colorSelection() {
    if (!palette) return
    toggleHighlight({ line: palette.line, start: palette.start, end: palette.end, text: palette.text, color: 'yellow' })
    window.getSelection()?.removeAllRanges()
    setPalette(null)
  }

  async function toggleLineTranslation(lineIndex: number) {
    const block = transcript[lineIndex]
    window.getSelection()?.removeAllRanges()
    setPalette(null)
    if (!block) return
    if (expandedTranslations.has(lineIndex)) {
      setExpandedTranslations((current) => { const next = new Set(current); next.delete(lineIndex); return next })
      return
    }
    const cached = translationCache.current[lineIndex]
    if (cached) {
      setExpandedTranslations((current) => new Set(current).add(lineIndex))
      return
    }
    setTranslationLoading((current) => new Set(current).add(lineIndex))
    try {
      await requestTranslationBatch([lineIndex], '/api/translations/lookup')
      setExpandedTranslations((current) => new Set(current).add(lineIndex))
    } catch (error) {
      const message = error instanceof Error ? error.message : '번역을 불러오지 못했습니다.'
      setTranslations((current) => ({ ...current, [lineIndex]: message }))
      setExpandedTranslations((current) => new Set(current).add(lineIndex))
    } finally {
      setTranslationLoading((current) => { const next = new Set(current); next.delete(lineIndex); return next })
    }
  }

  async function openWord(word: string, event: MouseEvent<HTMLElement>, context: string, charOffset: number, sentenceIndex: number) {
    event.stopPropagation()
    if (performance.now() < dragGuardUntilRef.current) return
    window.getSelection()?.removeAllRanges()
    const matchingExpressions = itemsForBlock(transcript[sentenceIndex], sentenceIndex)
      .map((item) => {
        const expression = item.expression || item.target_word
        const start = (item.start_char ?? -1) >= 0 ? item.start_char! : context.toLocaleLowerCase().indexOf(expression.toLocaleLowerCase())
        return { item, expression, start, end: start + expression.length }
      })
      .filter((candidate) => candidate.start >= 0 && charOffset >= candidate.start && charOffset < candidate.end)
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    const analyzed = matchingExpressions[0]
    const lookupWord = analyzed?.expression || word
    const cacheKey = contextualWordKey(lookupWord, context)
    if (wordPopover?.wordKey === cacheKey) {
      if (wordPopover.loading) return
      if (wordPopover.saved) {
        return
      }
      saveWord(wordPopover.data.word, wordPopover.data)
      setWordPopover((current) => current?.wordKey === cacheKey ? { ...current, saved: true } : current)
      return
    }
    const x = Math.max(130, Math.min(event.clientX, window.innerWidth - 130))
    const y = Math.max(90, event.clientY - 12)
    const alreadySaved = savedWords.some((item) => normalizeWordKey(item) === normalizeWordKey(lookupWord))
    const analyzedDefinition: WordDefinition | null = analyzed ? {
      word: analyzed.expression,
      word_type: analyzed.item.word_type,
      definition_kr: analyzed.item.definition_kr,
      expression_type: analyzed.item.expression_type,
      literal_meaning_kr: analyzed.item.literal_meaning_kr,
      learner_note_kr: analyzed.item.learner_note_kr,
      grammar_pattern: analyzed.item.grammar_pattern,
      register: analyzed.item.register,
      example_en: analyzed.item.example_en,
      example_kr: analyzed.item.example_kr,
    } : null
    const cached = analyzedDefinition || definitionCache.current.get(cacheKey)
    if (cached) return setWordPopover({ wordKey: cacheKey, x, y, loading: false, saved: alreadySaved, data: cached })
    const fallback: WordDefinition = { word: lookupWord, word_type: 'word', definition_kr: '문맥에 맞는 뜻을 불러오는 중이에요.' }
    setWordPopover({ wordKey: cacheKey, x, y, loading: true, saved: alreadySaved, data: fallback })
    try {
      const response = await fetch(`${API_BASE_URL}/api/vocabulary/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word, context, clicked_offset: charOffset, sentence_hash: fastTextHash(context) }),
      })
      const data = await response.json().catch(() => null) as WordDefinition | { detail?: string } | null
      if (!response.ok || !data || !('word' in data)) throw new Error(data && 'detail' in data ? data.detail : '뜻을 불러오지 못했습니다.')
      definitionCache.current.set(cacheKey, data)
      storeWordDefinitions(definitionCache.current)
      setWordPopover((current) => current?.wordKey === cacheKey ? { ...current, loading: false, data } : current)
    } catch (error) {
      setWordPopover((current) => current?.wordKey === cacheKey ? { ...current, loading: false, data: fallback, error: error instanceof Error ? error.message : '뜻을 불러오지 못했습니다.' } : current)
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
      <div className="now-listening"><span className={`wave ${playing ? 'active' : ''}`}>▮▰▮▰</span><span>{transcript.length ? (playing ? '현재 발화를 따라가고 있어요' : '재생하면 현재 문장을 표시해요') : '이 영상에는 동기화할 영어 자막이 없어요'}</span>{['pending', 'running'].includes(analysisStatus) && <em>학습 표현 {analysisProgress.completed}/{analysisProgress.total}</em>}{translationProgress.total > 0 && translationProgress.completed < translationProgress.total && <em>한국어 자막 {translationProgress.completed}/{translationProgress.total}</em>}{analysisStatus === 'waiting_for_key' && <em>AI 분석 서버를 준비하고 있어요</em>}<b>{Math.max(0, currentIndex + 1)} / {transcript.length}</b></div>
      <div ref={readingBodyRef} className="transcript-body reading-body" onScroll={handleReadingScroll}>
        {!transcript.length && <div className="empty-state">YouTube에서 사용할 수 있는 영어 자막을 제공하지 않아 전체 스크립트를 만들 수 없습니다.<br /><small>영상은 위 플레이어에서 그대로 재생할 수 있어요.</small></div>}
        {transcript.map((line, index) => {
          const sentenceSaved = savedSentences.some((sentence) => savedSentenceKey(sentence.videoId, sentence) === savedSentenceKey(episodeId, { time: line.timestamp_display, text: line.text, timestampSec: line.timestamp_sec }))
          return <div ref={(element) => { lineRefs.current[index] = element }} key={`${line.timestamp_sec}-${index}`} className={`script-line reading-line ${index === currentIndex ? 'current' : ''}`} onClick={(event) => playFromTranscript(event, line.timestamp_sec)}>
            <span className="timestamp">{line.timestamp_display}</span>
            <div className="script-copy"><p onPointerDown={handlePointerDown} onPointerUp={(event) => finishPointerSelection(event, index, line.text)}><InteractiveScriptText text={line.text} sentenceIndex={index} items={itemsForBlock(line, index)} highlights={highlights.filter((item) => item.line === index)} completedWords={completedWords} onWordClick={(word, event, charOffset) => openWord(word, event, line.text, charOffset, index)} onSaveWord={saveWord} onCompleteWord={completeWord} /></p>{translationLoading.has(index) && <span className="line-translation loading">자연스러운 번역을 준비하고 있어요…</span>}{expandedTranslations.has(index) && translations[index] && <span className="line-translation">{translations[index]}</span>}</div>
            <div className="sentence-actions">
              <button type="button" className={`sentence-translation-button ${expandedTranslations.has(index) ? 'active' : ''} ${translations[index] ? 'ready' : ''}`} aria-label={expandedTranslations.has(index) ? '한국어 자막 접기' : '한국어 자막 펼치기'} aria-pressed={expandedTranslations.has(index)} disabled={!translationHash} onClick={(event) => { event.stopPropagation(); void toggleLineTranslation(index) }}>한</button>
              <button type="button" className={`sentence-save-button ${sentenceSaved ? 'saved' : ''}`} aria-label={sentenceSaved ? '문장 금고에 저장됨' : '문장 금고에 저장'} aria-pressed={sentenceSaved} onClick={(event) => { event.stopPropagation(); saveSentence(line) }}>{sentenceSaved ? '♥' : '♡'}</button>
            </div>
          </div>
        })}
      </div>
      <div className="script-tip"><span>⌁</span><p><b>Tip.</b> 블록의 빈 곳을 누르면 그 시점부터 재생해요. B2·C1 빈칸은 한 번 눌러 입력하고, 두 번 눌러 정답을 확인할 수 있어요.</p></div>
      {palette && createPortal(<div className={`selection-palette ${palette.placement}`} style={{ left: palette.x, top: palette.y }} role="toolbar" aria-label="선택한 텍스트 도구">
        <button className="selection-tool highlight-tool" onPointerDown={(event) => event.preventDefault()} onClick={colorSelection} aria-label="노란색 형광펜 적용 또는 해제">○</button>
      </div>, document.body)}
      {wordPopover && createPortal(<aside className="word-popover" style={{ left: wordPopover.x, top: wordPopover.y }} role="status">
        <button onClick={() => setWordPopover(null)} aria-label="단어 뜻 닫기">×</button>
        <b>{wordPopover.data.word}</b><small>{wordPopover.data.expression_type && wordPopover.data.expression_type !== 'vocabulary' ? `${wordPopover.data.expression_type.replace('_', ' ')} · ` : ''}{wordPopover.data.word_type}</small><p>{wordPopover.error || wordPopover.data.definition_kr}</p>
        {wordPopover.data.learner_note_kr && <p className="learner-note">헷갈리기 쉬운 점 · {wordPopover.data.learner_note_kr}</p>}
        {wordPopover.data.grammar_pattern && <code>{wordPopover.data.grammar_pattern}</code>}
        {wordPopover.data.example_en && <p className="word-example">{wordPopover.data.example_en}<br /><small>{wordPopover.data.example_kr}</small></p>}
        {wordPopover.loading && <i className="popover-loader" />}
        <span>{wordPopover.saved ? '짐가방에 저장됨' : wordPopover.loading ? '뜻을 불러오는 중이에요' : '같은 단어를 한 번 더 누르면 저장돼요'}</span>
      </aside>, document.body)}
    </article>
  </div>
}

function Quiz({ item, index, total, answer, setAnswer, state, submit, next }: { item?: LearningItem; index: number; total: number; answer: string; setAnswer: (v: string) => void; state: 'idle' | 'correct' | 'wrong'; submit: () => void; next: () => void }) {
  if (!item) return <div className="center-panel"><div className="empty-state">분석된 퀴즈가 없습니다.</div></div>
  const displayedSentence = state === 'correct' ? item.full_sentence_original : item.masked_sentence
  const percent = Math.round(((index + 1) / total) * 100)
  return <div className="center-panel quiz-panel"><span className="eyebrow">C1 VOCABULARY · {index + 1} / {total}</span><div className="quiz-top"><div className="quiz-progress"><i style={{ width: `${percent}%` }} /></div><b>{percent}%</b></div><h2>빈칸에 들어갈 단어는?</h2><p className="quote">“{displayedSentence}”</p><div className="hint-box"><span>💡</span><p><small>{item.word_type.toUpperCase()}</small>{item.definition_kr}<br /><span>{item.hint_for_tap}</span></p></div><input className={`answer-input ${state}`} value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="영어 단어를 입력하세요" autoFocus />{state === 'correct' && <div className="feedback good"><b>정답이에요! +4 km</b><span>{item.target_word} · {item.definition_kr}</span></div>}{state === 'wrong' && <div className="feedback bad"><b>한 번 더 생각해 볼까요?</b><span>첫 글자는 {item.target_word[0]}, 마지막은 {item.target_word.at(-1)}이에요. 짐가방에 담아둘게요.</span></div>}<button className="primary-action" onClick={state === 'correct' ? next : submit}>{state === 'correct' ? '다음 문제 →' : '정답 확인'}</button></div>
}

function Bag({ words, items, details, practice }: { words: string[]; items: LearningItem[]; details: SavedWordDetails; practice: () => void }) {
  return <div className="center-panel"><div className="section-title"><div><span className="eyebrow">REVIEW BAGGAGE</span><h2>거북이의 짐가방</h2><p>헷갈렸던 단어는 여기 모아두고 가볍게 다시 꺼내봐요.</p></div><img src="/assets/turtle-b.png" alt="짐가방을 챙기는 거북이" /></div>{words.length ? <div className="vocab-list">{words.map((word) => { const normalized = normalizeWordKey(word); const savedDetail = details[normalized]; const dynamicItem = items.find((entry) => normalizeWordKey(entry.target_word) === normalized); const sampleItem = sampleVocab.find((entry) => entry.word === normalized) || sampleVocab[2]; return <div className="vocab-row" key={word}><span>{word.slice(0, 1).toUpperCase()}</span><div><h3>{word} <small>{savedDetail?.word_type || dynamicItem?.word_type || sampleItem.pos}</small></h3><p>{savedDetail?.definition_kr || dynamicItem?.definition_kr || sampleItem.meaning}</p></div><button onClick={practice}>다시 풀기 →</button></div> })}</div> : <div className="empty-state">짐가방이 비었어요. 아주 가벼운 여행이네요! 🎉</div>}</div>
}

function Vault({ sentences, remove }: { sentences: SavedSentence[]; remove: (id: SavedSentence['id']) => void }) {
  return <div className="center-panel"><div className="section-title plain"><div><span className="eyebrow">SENTENCE VAULT</span><h2>문장 금고</h2><p>마음에 닿은 문장을 모아 나만의 영어 책을 만들어요.</p></div><b>{sentences.length} 문장</b></div>{sentences.length ? <div className="sentence-list">{sentences.map((sentence) => <article key={sentence.id}>
    <div className="sentence-meta"><time>{formatSavedDate(sentence.savedAt)}</time><span>{sentence.videoTitle || 'YouTube 영상'}</span><small>{sentence.channelName || 'YouTube'} · {sentence.time}</small></div>
    <p>“{sentence.text}”</p>
    <button onClick={() => remove(sentence.id)} aria-label="저장한 문장 삭제">×</button>
  </article>)}</div> : <div className="empty-state">아직 저장한 문장이 없어요.<br /><small>받아쓰기에서 ♡를 눌러 첫 문장을 담아보세요.</small></div>}</div>
}

function Journey({ progress }: { progress: number }) {
  const miles = [0, 25, 50, 75, 100]
  return <div className="journey-panel"><div className="journey-copy"><span className="eyebrow">SEOUL → NEW YORK</span><h2>거북이의 미국행</h2><p>오늘의 작은 공부가 뉴욕까지 이어져요.<br />꾸준히 쌓은 거리가 벌써 <b>{progress}km</b>예요.</p></div><div className="map-card"><div className="route-line"><i style={{ width: `${progress}%` }} /><img src="/assets/turtle-a.png" alt="여행 중인 거북이" style={{ left: `calc(${progress}% - 34px)` }} />{miles.map((m) => <span key={m} className={progress >= m ? 'passed' : ''} style={{ left: `${m}%` }}><b>{m === 0 ? '서울' : m === 100 ? '뉴욕' : `${m}km`}</b></span>)}</div><div className="badges"><div className="earned"><span>🌱</span><b>첫 걸음</b><small>첫 에피소드 시작</small></div><div className={progress >= 25 ? 'earned' : ''}><span>🎧</span><b>집중 청취자</b><small>25km 달성</small></div><div className={progress >= 50 ? 'earned' : ''}><span>📚</span><b>단어 수집가</b><small>50km 달성</small></div><div><span>🗽</span><b>뉴요커</b><small>100km 달성</small></div></div></div></div>
}

export default App
