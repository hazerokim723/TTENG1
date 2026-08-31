// Development-only fixture: not an entry point in the production build.
// API and player are deterministic mocks; no credentials or paid calls.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Dictation, type LearningItem } from '../src/App'
import '../src/styles.css'

let failLookup = false
let lookupCount = 0
let prefetchCount = 0
window.fetch = async (input, options) => {
  if (String(input).endsWith('/learning/definitions')) prefetchCount++
  else lookupCount++
  const counter = document.getElementById('lookup-counter')
  if (counter) counter.textContent = `미리 준비 ${prefetchCount}회 / 개별 조회 ${lookupCount}회`
  const word = JSON.parse(String(options?.body || '{}')).word || 'word'
  await new Promise(resolve => setTimeout(resolve, 250))
  if (String(input).endsWith('/learning/definitions')) return Response.json({ definitions: [{ lookup_word: 'bank', definition: { word: 'bank', word_type: 'noun', definition_kr: '강둑. 이 문맥에서는 은행이 아닌 강가를 가리키며 긴 해설은 읽기 화면에서 표시하지 않습니다.', expression_type: 'vocabulary' } }] })
  return Response.json(failLookup ? { detail: '테스트: 뜻 조회 실패' } : { word, word_type: 'noun', definition_kr: word === 'bank' ? '강둑 (문맥상 뜻)' : '계획 (테스트 뜻)' }, { status: failLookup ? 503 : 200 })
}
window.YT = { Player: class {
  time = 0
  events: any
  constructor(_element: HTMLElement, options: any) { this.events = options.events; setTimeout(() => this.events.onReady(), 0) }
  getCurrentTime() { return this.time }
  getDuration() { return 120 }
  playVideo() { this.events.onStateChange({ data: 1 }) }
  pauseVideo() { this.events.onStateChange({ data: 2 }) }
  seekTo(value: number) { this.time = value }
  destroy() {}
} }
const text = 'We need GOOD WILL and come up with a plan near the bank.'
const target = (expression: string, dictation: boolean): LearningItem => ({
  expression, target_word: expression, is_dictation_target: dictation,
  expression_type: dictation ? 'vocabulary' : 'phrasal_verb',
  definition_kr: dictation ? '선의' : '아이디어나 해결책을 생각해 내다',
  word_type: dictation ? 'noun' : 'phrasal verb', sentence_index: 0,
  start_char: text.indexOf(expression), end_char: text.indexOf(expression) + expression.length,
  timestamp_sec: 0, timestamp_display: '00:00', full_sentence_original: text,
  masked_sentence: '', hint_for_tap: '',
})
const items = [target('GOOD WILL', true), target('come up with', false)]
const transcript = [{ text, timestamp_sec: 0, end_sec: 120, timestamp_display: '00:00' }]
function Fixture() {
  const [playing, setPlaying] = useState(false)
  const [words, setWords] = useState<string[]>([])
  const [completed, setCompleted] = useState<string[]>([])
  const [goodCount, setGoodCount] = useState(0)
  const [highlights, setHighlights] = useState<any[]>([])
  const [failed, setFailed] = useState(false)
  return <main style={{ padding: 16 }}>
    <h1>UI 테스트 · API/영상은 모의 응답</h1>
    <label><input type="checkbox" checked={failed} onChange={event => { failLookup = event.target.checked; setFailed(failLookup) }} />뜻 조회 실패 재현</label>
    <p>저장한 단어: {words.join(', ') || '없음'} · 입력 정답 완료: {goodCount}</p>
    <button onClick={() => alert(`조회 요청 ${lookupCount}회`)}>테스트 요청 수</button>
    <output id="lookup-counter">미리 준비 0회 / 개별 조회 0회</output>
    <Dictation artifactId={'f'.repeat(64)} serverTranslations={[]} onTranslation={async () => {}} onVisibleSentence={() => {}} episodeId="TEST0000001" title="학습 인터랙션 테스트" sourceName="테스트 채널" durationSec={120} transcript={transcript} items={items} playing={playing} setPlaying={setPlaying} highlights={highlights} toggleHighlight={mark => setHighlights(value => value.length ? [] : [{ ...mark, id: 1 }])} savedSentences={[]} saveSentence={() => {}} savedWords={words} saveWord={word => setWords(value => [...new Set([...value, word])])} completedWords={completed} completeWord={word => { setCompleted(value => [...value, word.toLowerCase()]); setGoodCount(value => value + 1) }} episodeProgress={0} analysisStatus="complete" analysisProgress={{ completed: 1, total: 1 }} initialPositionSec={0} onProgress={() => {}} />
  </main>
}
createRoot(document.getElementById('fixture')!).render(<Fixture />)
