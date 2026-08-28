"""FastAPI service for turning YouTube captions into C1 learning items."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import tempfile
import time
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urlparse

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from openai import APIConnectionError, APIStatusError, AuthenticationError, OpenAI, RateLimitError
from pydantic import BaseModel, ConfigDict, Field
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    CouldNotRetrieveTranscript,
    IpBlocked,
    NoTranscriptFound,
    RequestBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
)
from youtube_transcript_api.proxies import GenericProxyConfig, WebshareProxyConfig

load_dotenv()

VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
TRANSCRIPT_CHUNK_CHARACTER_LIMIT = 28_000
OPENAI_ANALYSIS_MODEL = os.getenv(
    "OPENAI_ANALYSIS_MODEL", os.getenv("OPENAI_MODEL", "gpt-5-mini")
)
OPENAI_TRANSLATION_MODEL = os.getenv("OPENAI_TRANSLATION_MODEL", "gpt-5-mini")
OPENAI_LOOKUP_MODEL = os.getenv("OPENAI_LOOKUP_MODEL", "gpt-5-mini")
OPENAI_MODEL = OPENAI_ANALYSIS_MODEL
ANALYSIS_VERSION = "korean-expression-ranges-v2"
TRANSLATION_VERSION = "ko-editorial-v1"
IS_VERCEL = bool(os.getenv("VERCEL"))
SUPADATA_API_URL = os.getenv(
    "SUPADATA_API_URL", "https://api.supadata.ai/v1"
).rstrip("/")
SUPADATA_POLL_TIMEOUT_SECONDS = 45
CACHE_DIRECTORY = Path(
    os.getenv("TURTLE_CACHE_DIRECTORY")
    or (
        Path(tempfile.gettempdir()) / "turtle-english"
        if IS_VERCEL
        else Path(__file__).resolve().parent / ".cache"
    )
)
WORD_CACHE_VERSION = "context-dictionary-v2"
WORD_CACHE_PATH = CACHE_DIRECTORY / f"{WORD_CACHE_VERSION}.json"


class CaptionUnavailableError(Exception):
    """Raised when a transcript exists but contains no usable caption text."""


class SupadataAuthenticationError(Exception):
    """Raised when the configured Supadata key is missing permissions or invalid."""


class SupadataRateLimitError(Exception):
    """Raised when the Supadata plan has no credits or is being rate limited."""


class SupadataServiceError(Exception):
    """Raised when Supadata cannot complete a transcript request."""


class AnalyzeEpisodeRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    youtube_url: str = Field(min_length=1, max_length=2_048)


class LearningItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    timestamp_sec: float = Field(ge=0)
    timestamp_display: str
    full_sentence_original: str
    masked_sentence: str
    target_word: str
    word_type: str
    definition_kr: str
    hint_for_tap: str
    level: Literal["B2", "C1"] = "C1"
    is_phrasal_verb: bool = False
    sentence_index: int = -1
    expression: str = ""
    expression_type: Literal[
        "vocabulary", "phrasal_verb", "idiom", "collocation"
    ] = "vocabulary"
    anchor_words: list[str] = Field(default_factory=list)
    literal_meaning_kr: str = ""
    learner_note_kr: str = ""
    grammar_pattern: str = ""
    register_label: str = Field(
        default="neutral", alias="register", serialization_alias="register"
    )
    example_en: str = ""
    example_kr: str = ""
    start_char: int = -1
    end_char: int = -1
    is_dictation_target: bool = True


class LearningItemsPayload(BaseModel):
    learning_items: list[LearningItem]


class TranscriptBlock(BaseModel):
    timestamp_sec: float = Field(ge=0)
    end_sec: float = Field(ge=0)
    timestamp_display: str
    text: str


class AnalyzeEpisodeResponse(BaseModel):
    episode_id: str
    title: str
    source_name: str
    duration_sec: float = Field(ge=0)
    transcript: list[TranscriptBlock]
    learning_items: list[LearningItem] = Field(default_factory=list)
    analysis_status: Literal["waiting_for_key", "pending", "running", "complete", "error"]
    analysis_version: str
    cached: bool = False
    completed_chunks: int = 0
    total_chunks: int = 0


class AnalysisStatusResponse(BaseModel):
    episode_id: str
    analysis_status: Literal["waiting_for_key", "pending", "running", "complete", "error"]
    analysis_version: str
    learning_items: list[LearningItem] = Field(default_factory=list)
    completed_chunks: int = 0
    total_chunks: int = 0
    error: str | None = None


class AnalyzeChunkRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    episode_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    chunk_index: int = Field(ge=0)
    total_chunks: int = Field(ge=1, le=100)
    transcript_chunk: str = Field(min_length=1, max_length=40_000)


class AnalyzeChunkResponse(BaseModel):
    chunk_index: int
    total_chunks: int
    analysis_version: str
    learning_items: list[LearningItem] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str


class OpenAIConnectionResponse(BaseModel):
    status: Literal["connected"]
    model: str


class DefineWordRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    word: str = Field(min_length=1, max_length=80)
    context: str = Field(min_length=1, max_length=1_000)
    clicked_offset: int = Field(default=-1, ge=-1, le=10_000)
    sentence_hash: str = Field(default="", max_length=128)


class WordDefinition(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    word: str
    word_type: str
    definition_kr: str
    expression_type: Literal[
        "vocabulary", "phrasal_verb", "idiom", "collocation"
    ] = "vocabulary"
    literal_meaning_kr: str = ""
    learner_note_kr: str = ""
    grammar_pattern: str = ""
    register_label: str = Field(
        default="neutral", alias="register", serialization_alias="register"
    )
    example_en: str = ""
    example_kr: str = ""


class TranslateSentenceRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    text: str = Field(min_length=1, max_length=2_000)


class TranslationResponse(BaseModel):
    translation_kr: str


class TranslationSentence(BaseModel):
    sentence_index: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=3_000)
    previous_text: str = Field(default="", max_length=3_000)
    next_text: str = Field(default="", max_length=3_000)


class TranslationItem(BaseModel):
    sentence_index: int = Field(ge=0)
    translation_kr: str


class TranslationItemsPayload(BaseModel):
    translations: list[TranslationItem]


class TranslationCacheRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    video_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    transcript_hash: str = Field(min_length=8, max_length=128)
    translation_version: str = Field(default=TRANSLATION_VERSION, max_length=80)
    total_sentences: int = Field(ge=0, le=20_000)


class TranslationBatchRequest(TranslationCacheRequest):
    title: str = Field(default="", max_length=500)
    channel_name: str = Field(default="", max_length=500)
    topic: str = Field(default="", max_length=1_000)
    sentences: list[TranslationSentence] = Field(min_length=1, max_length=30)


class TranslationCacheResponse(BaseModel):
    video_id: str
    transcript_hash: str
    translation_version: str
    translations: list[TranslationItem] = Field(default_factory=list)
    completed: int = 0
    total: int = 0
    persistent: bool = False


class BatchDefineWordsRequest(BaseModel):
    items: list[DefineWordRequest] = Field(min_length=1, max_length=30)


class WordDefinitionsPayload(BaseModel):
    definitions: list[WordDefinition]


app = FastAPI(title="Turtle English API", version="1.0.0")
app.state.analysis_jobs = {}
app.state.analysis_tasks = set()
app.state.word_definition_cache = None
app.state.translation_cache = {}
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4173", "http://127.0.0.1:4173"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


def extract_video_id(value: str) -> str:
    """Extract an 11-character video ID from common YouTube URL formats."""
    candidate = value.strip()
    if VIDEO_ID_PATTERN.fullmatch(candidate):
        return candidate

    parsed = urlparse(candidate if "://" in candidate else f"https://{candidate}")
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if hostname.startswith("www."):
        hostname = hostname[4:]

    video_id: str | None = None
    if hostname in {"youtu.be"}:
        video_id = parsed.path.strip("/").split("/", 1)[0]
    elif hostname in {"youtube.com", "m.youtube.com", "music.youtube.com"}:
        path_parts = [part for part in parsed.path.split("/") if part]
        if parsed.path.rstrip("/") == "/watch":
            video_id = parse_qs(parsed.query).get("v", [None])[0]
        elif len(path_parts) >= 2 and path_parts[0] in {
            "embed",
            "shorts",
            "live",
            "v",
        }:
            video_id = path_parts[1]

    if not video_id or not VIDEO_ID_PATTERN.fullmatch(video_id):
        raise ValueError("유효한 YouTube 영상 URL 또는 영상 ID를 입력해 주세요.")
    return video_id


def format_timestamp(seconds: float) -> str:
    total_seconds = max(0, round(seconds))
    hours, remainder = divmod(total_seconds, 3_600)
    minutes, secs = divmod(remainder, 60)
    return (
        f"{hours:02d}:{minutes:02d}:{secs:02d}"
        if hours
        else f"{minutes:02d}:{secs:02d}"
    )


def supadata_error_detail(response: requests.Response) -> str:
    try:
        payload = response.json()
    except (requests.JSONDecodeError, ValueError):
        return ""
    if not isinstance(payload, dict):
        return ""
    detail = payload.get("message") or payload.get("error") or payload.get("detail")
    if isinstance(detail, dict):
        detail = detail.get("message") or detail.get("code")
    return str(detail or "").strip()


def parse_supadata_entries(payload: dict) -> list[tuple[float, str]]:
    """Convert Supadata millisecond offsets into the app's second-based format."""
    result = payload.get("result") if isinstance(payload.get("result"), dict) else payload
    content = result.get("content") if isinstance(result, dict) else None
    if not isinstance(content, list):
        raise CaptionUnavailableError

    entries: list[tuple[float, str]] = []
    for segment in content:
        if not isinstance(segment, dict):
            continue
        text = re.sub(r"\s+", " ", str(segment.get("text") or "")).strip()
        try:
            timestamp_sec = max(0, float(segment.get("offset", 0)) / 1_000)
        except (TypeError, ValueError):
            continue
        if text:
            entries.append((timestamp_sec, text))

    if not entries:
        raise CaptionUnavailableError
    return entries


def request_supadata_json(
    path: str, api_key: str, *, params: dict[str, str] | None = None
) -> tuple[int, dict]:
    try:
        response = requests.get(
            f"{SUPADATA_API_URL}{path}",
            headers={"x-api-key": api_key, "Accept": "application/json"},
            params=params,
            timeout=(10, 35),
        )
    except requests.RequestException as error:
        raise SupadataServiceError from error

    detail = supadata_error_detail(response)
    if response.status_code in {401, 403}:
        raise SupadataAuthenticationError(detail)
    if response.status_code in {402, 429}:
        raise SupadataRateLimitError(detail)
    if response.status_code in {400, 404, 422}:
        raise CaptionUnavailableError(detail)
    if response.status_code >= 500:
        raise SupadataServiceError(detail)
    try:
        payload = response.json()
    except (requests.JSONDecodeError, ValueError) as error:
        raise SupadataServiceError from error
    if not isinstance(payload, dict):
        raise SupadataServiceError
    return response.status_code, payload


def fetch_caption_entries_from_supadata(
    video_id: str, api_key: str
) -> list[tuple[float, str]]:
    """Fetch existing English captions without triggering paid AI transcription."""
    status_code, payload = request_supadata_json(
        "/transcript",
        api_key,
        params={
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "lang": "en",
            "text": "false",
            "mode": "native",
        },
    )
    if status_code != 202 and "jobId" not in payload:
        return parse_supadata_entries(payload)

    job_id = str(payload.get("jobId") or "").strip()
    if not job_id:
        raise SupadataServiceError
    deadline = time.monotonic() + SUPADATA_POLL_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        _, job_payload = request_supadata_json(f"/transcript/{job_id}", api_key)
        job_status = str(job_payload.get("status") or "").lower()
        if job_status in {"completed", "complete", "succeeded", "success"}:
            return parse_supadata_entries(job_payload)
        if job_status in {"failed", "error", "cancelled", "canceled"}:
            detail = str(job_payload.get("error") or job_payload.get("message") or "")
            if "transcript" in detail.lower() or "caption" in detail.lower():
                raise CaptionUnavailableError(detail)
            raise SupadataServiceError(detail)
        time.sleep(1)
    raise SupadataServiceError("Supadata transcript job timed out")


def fetch_caption_entries_direct(video_id: str) -> list[tuple[float, str]]:
    webshare_username = os.getenv("WEBSHARE_PROXY_USERNAME", "").strip()
    webshare_password = os.getenv("WEBSHARE_PROXY_PASSWORD", "").strip()
    generic_proxy_url = os.getenv("YOUTUBE_PROXY_URL", "").strip()
    proxy_config = None
    if webshare_username and webshare_password:
        locations = [
            location.strip().lower()
            for location in os.getenv("WEBSHARE_PROXY_LOCATIONS", "us,kr,jp").split(",")
            if location.strip()
        ]
        proxy_config = WebshareProxyConfig(
            proxy_username=webshare_username,
            proxy_password=webshare_password,
            filter_ip_locations=locations or None,
            retries_when_blocked=5,
        )
    elif generic_proxy_url:
        proxy_config = GenericProxyConfig(
            http_url=generic_proxy_url,
            https_url=generic_proxy_url,
        )

    transcript = YouTubeTranscriptApi(proxy_config=proxy_config).fetch(
        video_id, languages=["en"]
    )
    entries = [
        (float(snippet.start), snippet.text.strip())
        for snippet in transcript
        if snippet.text.strip()
    ]
    if not entries:
        raise CaptionUnavailableError
    return entries


def fetch_caption_entries(video_id: str) -> list[tuple[float, str]]:
    """Use Supadata when configured, retaining direct extraction for local fallback."""
    supadata_api_key = os.getenv("SUPADATA_API_KEY", "").strip()
    if supadata_api_key:
        return fetch_caption_entries_from_supadata(video_id, supadata_api_key)
    return fetch_caption_entries_direct(video_id)


def fetch_video_metadata(video_id: str) -> tuple[str, str]:
    """Fetch public title and channel metadata without requiring a YouTube API key."""
    try:
        response = requests.get(
            "https://www.youtube.com/oembed",
            params={
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "format": "json",
            },
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        title = str(data.get("title") or "AI English Episode").strip()
        source_name = str(data.get("author_name") or "YouTube").strip()
        return title, source_name
    except (requests.RequestException, ValueError, TypeError):
        return "AI English Episode", "YouTube"


def build_transcript_blocks(
    entries: Sequence[tuple[float, str]],
) -> list[TranscriptBlock]:
    """Group every caption into complete, readable sentence blocks without filtering."""
    if not entries:
        return []

    sentence_boundary = re.compile(r"[.!?…](?:[\"')\]]*)?(?:\s+|$)")
    blocks: list[tuple[float, str]] = []
    current_start = entries[0][0]
    current_parts: list[str] = []
    sentence_count = 0

    def flush() -> None:
        nonlocal current_parts, sentence_count
        text = re.sub(r"\s+", " ", " ".join(current_parts)).strip()
        if text:
            blocks.append((current_start, text))
        current_parts = []
        sentence_count = 0

    def split_caption(text: str) -> list[tuple[str, bool]]:
        """Keep punctuation while exposing sentence ends inside one caption."""
        pieces: list[tuple[str, bool]] = []
        cursor = 0
        for match in sentence_boundary.finditer(text):
            piece = text[cursor : match.end()].strip()
            if piece:
                pieces.append((piece, True))
            cursor = match.end()
        trailing = text[cursor:].strip()
        if trailing:
            pieces.append((trailing, False))
        return pieces or [(text, False)]

    previous_timestamp = entries[0][0]
    previous_ended_sentence = False
    for timestamp, caption in entries:
        cleaned = re.sub(r"\s+", " ", caption).strip()
        if not cleaned:
            continue
        gap = max(0, timestamp - previous_timestamp)
        word_count = len(" ".join(current_parts).split())
        # Start a new block only at a real sentence boundary. Pauses and length
        # help keep blocks compact, but never split an unfinished sentence.
        if current_parts and previous_ended_sentence and (
            sentence_count >= 2 or word_count >= 24 or gap >= 1.15
        ):
            flush()
        elif current_parts and not previous_ended_sentence and (
            (word_count >= 36 and gap >= 1.35)
            or (word_count >= 65 and gap >= 0.65)
        ):
            # Auto-generated captions sometimes omit every punctuation mark.
            # A clear subtitle pause is then the least destructive boundary.
            flush()
        for piece, ended_sentence in split_caption(cleaned):
            if not current_parts:
                current_start = timestamp
            current_parts.append(piece)
            previous_ended_sentence = ended_sentence
            if ended_sentence:
                sentence_count += 1

            word_count = len(" ".join(current_parts).split())
            # Prefer one complete long sentence or two short natural sentences.
            if ended_sentence and (
                sentence_count >= 2 or (sentence_count == 1 and word_count >= 18)
            ):
                flush()
                previous_ended_sentence = False
        previous_timestamp = timestamp

    if current_parts:
        flush()

    result: list[TranscriptBlock] = []
    final_end = max(entries[-1][0] + 5, blocks[-1][0] + 1)
    for index, (timestamp, text) in enumerate(blocks):
        end_sec = blocks[index + 1][0] if index + 1 < len(blocks) else final_end
        result.append(
            TranscriptBlock(
                timestamp_sec=timestamp,
                end_sec=max(timestamp, end_sec),
                timestamp_display=format_timestamp(timestamp),
                text=text,
            )
        )
    return result


def chunk_transcript(
    entries: Sequence[tuple[float, str]],
    character_limit: int = TRANSCRIPT_CHUNK_CHARACTER_LIMIT,
) -> list[str]:
    """Chunk only between caption entries so timestamps and text stay intact."""
    chunks: list[str] = []
    current_lines: list[str] = []
    current_size = 0

    for timestamp, caption in entries:
        line = f"[{timestamp:.3f}s] {caption}"
        line_size = len(line) + 1
        if current_lines and current_size + line_size > character_limit:
            chunks.append("\n".join(current_lines))
            current_lines = []
            current_size = 0
        current_lines.append(line)
        current_size += line_size

    if current_lines:
        chunks.append("\n".join(current_lines))
    return chunks


def make_prompt(transcript_chunk: str, chunk_index: int, chunk_count: int) -> str:
    return f"""
당신은 B2~C1 레벨의 시사/교양 영어 학습 앱 AI 엔진이자 영어교육 전문가입니다.
아래는 YouTube 영어 자막 전체 중 {chunk_index}/{chunk_count} 구간입니다.

요구사항:
1. 입력 문장은 화면에 그대로 표시되는 최종 전사문입니다. 문장을 고치거나 다시 쓰지 마세요.
2. 일반 단어는 B2~C1 중 학습 가치가 높은 것만 고르세요. 쉬운 A1~B1 일반 단어와 고유명사는 제외하세요.
3. 구동사·이디엄·콜로케이션은 CEFR 난이도가 낮아도 한국인 학습자가 문맥상 혼동하기 쉽거나 활용 가치가 높으면 포함하세요.
4. 각 줄의 sentence_index와 원본 타임스탬프를 그대로 반환하세요. expression과 target_word에는 동일한 실제 표현을 넣으세요.
5. start_char와 end_char는 해당 줄의 문장 문자열에서 expression이 차지하는 0 기반 문자 범위이며 end_char는 포함하지 않습니다.
6. expression_type은 vocabulary, phrasal_verb, idiom, collocation 중 하나로 분류하세요. 구동사는 is_phrasal_verb도 true로 설정하세요.
7. definition_kr은 문맥상 뜻, literal_meaning_kr은 직역 의미, learner_note_kr은 한국인이 혼동하기 쉬운 점을 짧게 쓰세요.
8. grammar_pattern, register, 자연스러운 example_en/example_kr, anchor_words를 제공하세요.
9. 실제 받아쓰기에 적합한 핵심 B2/C1 항목만 is_dictation_target=true로 하고, 보조 설명용 표현은 false로 하세요.
10. masked_sentence에는 받아쓰기 항목일 때만 expression 일부를 밑줄로 가리고 나머지 문맥은 유지하세요.
11. level은 B2 또는 C1 중 가까운 수준으로 분류하고 응답 스키마에 맞는 데이터만 반환하세요.

자막:
{transcript_chunk}
""".strip()


def analyze_chunk(
    transcript_chunk: str, chunk_index: int, chunk_count: int, api_key: str
) -> list[LearningItem]:
    client = OpenAI(api_key=api_key)
    response = client.responses.parse(
        model=OPENAI_ANALYSIS_MODEL,
        input=make_prompt(transcript_chunk, chunk_index, chunk_count),
        text_format=LearningItemsPayload,
        reasoning={"effort": "low"},
        store=False,
    )
    parsed = response.output_parsed
    if parsed is None:
        if not response.output_text:
            raise RuntimeError("OpenAI가 빈 응답을 반환했습니다.")
        parsed = LearningItemsPayload.model_validate_json(response.output_text)
    return normalize_items(parsed.learning_items)


def cache_path(video_id: str) -> Path:
    return CACHE_DIRECTORY / f"{video_id}-{ANALYSIS_VERSION}.json"


def read_episode_cache(video_id: str) -> dict | None:
    path = cache_path(video_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("analysisVersion") != ANALYSIS_VERSION:
            return None
        return data
    except (OSError, ValueError, TypeError):
        return None


def write_episode_cache(
    video_id: str,
    title: str,
    source_name: str,
    duration_sec: float,
    transcript: Sequence[TranscriptBlock],
    items: Sequence[LearningItem],
) -> None:
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    vocabulary = [item for item in items if not item.is_phrasal_verb]
    phrasal_verbs = [item for item in items if item.is_phrasal_verb]
    payload = {
        "videoId": video_id,
        "analysisVersion": ANALYSIS_VERSION,
        "title": title,
        "sourceName": source_name,
        "durationSec": duration_sec,
        "transcript": [block.model_dump() for block in transcript],
        "vocabulary": [item.model_dump() for item in vocabulary],
        "phrasalVerbs": [item.model_dump() for item in phrasal_verbs],
    }
    path = cache_path(video_id)
    temporary_path = path.with_suffix(".tmp")
    temporary_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary_path.replace(path)


def public_analysis_error(error: Exception) -> str:
    if isinstance(error, AuthenticationError):
        return "OpenAI API 키가 유효하지 않습니다."
    if isinstance(error, RateLimitError):
        return "OpenAI 사용 한도 또는 요청 한도를 초과했습니다."
    if isinstance(error, APIConnectionError):
        return "OpenAI API에 연결할 수 없습니다."
    if isinstance(error, APIStatusError):
        return f"OpenAI API 요청이 실패했습니다. (상태 {error.status_code})"
    return "학습 단어 분석을 완료하지 못했습니다."


def validate_openai_connection(api_key: str) -> None:
    """Make a minimal model request so auth, model access, and quota are verified."""
    client = OpenAI(api_key=api_key)
    client.responses.create(
        model=OPENAI_MODEL,
        input="Reply exactly with OK.",
        max_output_tokens=16,
        store=False,
    )


async def run_analysis_job(
    video_id: str,
    title: str,
    source_name: str,
    transcript: list[TranscriptBlock],
    chunks: list[str],
    api_key: str,
) -> None:
    job = app.state.analysis_jobs[video_id]
    job["status"] = "running"
    semaphore = asyncio.Semaphore(2)

    async def run_one(index: int, chunk: str) -> tuple[int, list[LearningItem]]:
        async with semaphore:
            result = await asyncio.to_thread(
                analyze_chunk, chunk, index + 1, len(chunks), api_key
            )
            return index, result

    try:
        tasks = [asyncio.create_task(run_one(index, chunk)) for index, chunk in enumerate(chunks)]
        completed_by_index: dict[int, list[LearningItem]] = {}
        for future in asyncio.as_completed(tasks):
            index, items = await future
            completed_by_index[index] = items
            job["completed_chunks"] = len(completed_by_index)
            job["items"] = normalize_items(
                item
                for chunk_index in sorted(completed_by_index)
                for item in completed_by_index[chunk_index]
            )
        job["status"] = "complete"
        duration_sec = transcript[-1].end_sec if transcript else 0
        await asyncio.to_thread(
            write_episode_cache,
            video_id,
            title,
            source_name,
            duration_sec,
            transcript,
            job["items"],
        )
    except Exception as error:
        job["status"] = "error"
        job["error"] = public_analysis_error(error)


def define_word(
    word: str, context: str, clicked_offset: int, api_key: str
) -> WordDefinition:
    client = OpenAI(api_key=api_key)
    response = client.responses.parse(
        model=OPENAI_LOOKUP_MODEL,
        input=(
            "당신은 한국인 영어 학습자를 위한 문맥 사전입니다. 클릭한 단어가 포함된 "
            "구동사·이디엄·콜로케이션이 있으면 단어 하나가 아니라 가장 긴 실제 표현을 우선 반환하세요. "
            "그런 표현이 없을 때만 일반 단어를 반환하세요. definition_kr은 문맥상 자연스러운 뜻, "
            "learner_note_kr은 한국인이 혼동하기 쉬운 점, grammar_pattern은 결합 형태를 간결하게 씁니다.\n\n"
            f"클릭 단어: {word}\n클릭 문자 위치: {clicked_offset}\n문장: {context}"
        ),
        text_format=WordDefinition,
        reasoning={"effort": "low"},
        store=False,
    )
    if response.output_parsed is not None:
        return response.output_parsed
    if not response.output_text:
        raise RuntimeError("OpenAI가 빈 응답을 반환했습니다.")
    return WordDefinition.model_validate_json(response.output_text)


def translate_sentence(text: str, api_key: str) -> TranslationResponse:
    client = OpenAI(api_key=api_key)
    response = client.responses.parse(
        model=OPENAI_TRANSLATION_MODEL,
        input=(
            "다음 영어 문장을 문맥과 어조를 살린 자연스러운 한국어로 번역하세요. "
            "단어 대 단어 직역을 피하고, 설명이나 따옴표 없이 번역문만 반환하세요.\n\n"
            f"영어 문장: {text}"
        ),
        text_format=TranslationResponse,
        reasoning={"effort": "low"},
        store=False,
    )
    if response.output_parsed is not None:
        return response.output_parsed
    if not response.output_text:
        raise RuntimeError("OpenAI가 빈 번역을 반환했습니다.")
    return TranslationResponse.model_validate_json(response.output_text)


def define_words(
    items: Sequence[DefineWordRequest], api_key: str
) -> list[WordDefinition]:
    client = OpenAI(api_key=api_key)
    input_items = [item.model_dump() for item in items]
    response = client.responses.parse(
        model=OPENAI_LOOKUP_MODEL,
        input=(
            "아래 영어 단어들을 각각 주어진 문맥에 맞춰 한국어 학습자용으로 설명하세요. "
            "입력된 모든 단어를 정확히 한 번씩 반환하고, word는 입력 철자를 유지하세요. "
            "word_type은 영어 품사로 간결하게, definition_kr은 가장 적절한 한국어 뜻 한 줄로 쓰세요.\n\n"
            f"입력: {json.dumps(input_items, ensure_ascii=False)}"
        ),
        text_format=WordDefinitionsPayload,
        reasoning={"effort": "low"},
        store=False,
    )
    parsed = response.output_parsed
    if parsed is None:
        if not response.output_text:
            raise RuntimeError("OpenAI가 빈 응답을 반환했습니다.")
        parsed = WordDefinitionsPayload.model_validate_json(response.output_text)
    return parsed.definitions


def read_word_definition_cache() -> dict[str, WordDefinition]:
    if not WORD_CACHE_PATH.exists():
        return {}
    try:
        payload = json.loads(WORD_CACHE_PATH.read_text(encoding="utf-8"))
        if payload.get("version") != WORD_CACHE_VERSION:
            return {}
        return {
            key: WordDefinition.model_validate(value)
            for key, value in payload.get("definitions", {}).items()
        }
    except (OSError, ValueError, TypeError):
        return {}


def write_word_definition_cache(cache: dict[str, WordDefinition]) -> None:
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": WORD_CACHE_VERSION,
        "definitions": {
            key: definition.model_dump() for key, definition in cache.items()
        },
    }
    temporary_path = WORD_CACHE_PATH.with_suffix(".tmp")
    temporary_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary_path.replace(WORD_CACHE_PATH)


def get_word_definition_cache(request: Request) -> dict[str, WordDefinition]:
    cache = getattr(request.app.state, "word_definition_cache", None)
    if cache is None:
        cache = read_word_definition_cache()
        request.app.state.word_definition_cache = cache
    return cache


def stable_text_hash(text: str) -> str:
    normalized = re.sub(r"\s+", " ", text).strip().casefold()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def word_cache_key(word: str, context: str, supplied_hash: str = "") -> str:
    sentence_hash = supplied_hash.strip() or stable_text_hash(context)
    return f"{word.casefold().strip()}:{sentence_hash}"


def supabase_server_config() -> tuple[str, str] | None:
    url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        return None
    return url, key


def supabase_headers(prefer: str = "") -> dict[str, str]:
    config = supabase_server_config()
    if not config:
        return {}
    _, key = config
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def read_supabase_translations(
    video_id: str, transcript_hash: str, translation_version: str
) -> list[TranslationItem]:
    config = supabase_server_config()
    if not config:
        return []
    url, _ = config
    response = requests.get(
        f"{url}/rest/v1/episode_translations",
        headers=supabase_headers(),
        params={
            "select": "sentence_index,translation_kr",
            "video_id": f"eq.{video_id}",
            "transcript_hash": f"eq.{transcript_hash}",
            "translation_version": f"eq.{translation_version}",
            "order": "sentence_index.asc",
        },
        timeout=15,
    )
    response.raise_for_status()
    return [TranslationItem.model_validate(row) for row in response.json()]


def write_supabase_translations(
    request_payload: TranslationBatchRequest, items: Sequence[TranslationItem]
) -> None:
    config = supabase_server_config()
    if not config or not items:
        return
    url, _ = config
    source_by_index = {
        sentence.sentence_index: sentence.text for sentence in request_payload.sentences
    }
    rows = [
        {
            "video_id": request_payload.video_id,
            "transcript_hash": request_payload.transcript_hash,
            "translation_version": request_payload.translation_version,
            "sentence_index": item.sentence_index,
            "source_text_hash": stable_text_hash(source_by_index[item.sentence_index]),
            "translation_kr": item.translation_kr,
            "model": OPENAI_TRANSLATION_MODEL,
        }
        for item in items
        if item.sentence_index in source_by_index
    ]
    response = requests.post(
        f"{url}/rest/v1/episode_translations",
        headers=supabase_headers("resolution=merge-duplicates,return=minimal"),
        params={
            "on_conflict": "video_id,transcript_hash,translation_version,sentence_index"
        },
        json=rows,
        timeout=20,
    )
    response.raise_for_status()


def translate_sentences(
    payload: TranslationBatchRequest, api_key: str
) -> list[TranslationItem]:
    client = OpenAI(api_key=api_key)
    input_rows = [sentence.model_dump() for sentence in payload.sentences]
    response = client.responses.parse(
        model=OPENAI_TRANSLATION_MODEL,
        reasoning={"effort": "low"},
        input=(
            "당신은 한국의 시사·교양 콘텐츠 자막 편집자입니다. 영어 어순을 유지하는 직역을 피하고 "
            "한국어 화자가 실제로 말하고 읽는 자연스러운 어순으로 재구성하세요. 고유명사, 수치, "
            "인과관계와 화자의 확신 정도는 유지하고, 이디엄과 구동사는 문맥상 의미로 의역하세요. "
            "각 현재 문장은 previous_text와 next_text를 문맥으로만 참고하고 번역 결과에는 현재 문장만 넣으세요. "
            "입력 sentence_index를 그대로 보존하고 모든 입력을 정확히 한 번 반환하세요.\n\n"
            f"영상 제목: {payload.title}\n채널: {payload.channel_name}\n주제: {payload.topic or payload.title}\n"
            f"문장: {json.dumps(input_rows, ensure_ascii=False)}"
        ),
        text_format=TranslationItemsPayload,
        store=False,
    )
    parsed = response.output_parsed
    if parsed is None:
        if not response.output_text:
            raise RuntimeError("OpenAI가 빈 번역을 반환했습니다.")
        parsed = TranslationItemsPayload.model_validate_json(response.output_text)
    allowed = {sentence.sentence_index for sentence in payload.sentences}
    unique: dict[int, TranslationItem] = {}
    for item in parsed.translations:
        if item.sentence_index in allowed and item.translation_kr.strip():
            unique[item.sentence_index] = item
    return [unique[index] for index in sorted(unique)]


def normalize_items(items: Iterable[LearningItem]) -> list[LearningItem]:
    """Sort results and remove likely duplicates created at chunk boundaries."""
    unique: dict[tuple[int, str], LearningItem] = {}
    for item in items:
        item.expression = (item.expression or item.target_word).strip()
        item.target_word = item.expression
        item.anchor_words = item.anchor_words or re.findall(
            r"[A-Za-z][A-Za-z'’-]*", item.expression
        )
        item.is_phrasal_verb = item.expression_type == "phrasal_verb"
        sentence = item.full_sentence_original
        if sentence:
            expected = sentence[item.start_char : item.end_char]
            if (
                item.start_char < 0
                or item.end_char <= item.start_char
                or expected.casefold() != item.expression.casefold()
            ):
                start = sentence.casefold().find(item.expression.casefold())
                if start >= 0:
                    item.start_char = start
                    item.end_char = start + len(item.expression)
                else:
                    item.start_char = -1
                    item.end_char = -1
        item.timestamp_display = format_timestamp(item.timestamp_sec)
        key = (item.sentence_index, item.expression.casefold().strip())
        unique.setdefault(key, item)
    return sorted(unique.values(), key=lambda item: item.timestamp_sec)


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/api/openai/validate", response_model=OpenAIConnectionResponse)
async def validate_openai() -> OpenAIConnectionResponse:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="서버에 OpenAI API 키가 설정되지 않았습니다.",
        )

    try:
        await asyncio.to_thread(validate_openai_connection, api_key)
    except AuthenticationError as error:
        raise HTTPException(
            status_code=401,
            detail="OpenAI API 키가 유효하지 않습니다.",
        ) from error
    except RateLimitError as error:
        raise HTTPException(
            status_code=429,
            detail="OpenAI 결제 크레딧 또는 사용 한도를 확인해 주세요.",
        ) from error
    except APIConnectionError as error:
        raise HTTPException(
            status_code=502,
            detail="OpenAI API에 연결할 수 없습니다.",
        ) from error
    except APIStatusError as error:
        detail = (
            f"OpenAI 모델({OPENAI_MODEL}) 사용 권한 또는 설정을 확인해 주세요."
            if error.status_code in {400, 403, 404}
            else f"OpenAI 연결 확인에 실패했습니다. (상태 {error.status_code})"
        )
        raise HTTPException(status_code=error.status_code, detail=detail) from error
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="OpenAI 연결 확인 중 알 수 없는 오류가 발생했습니다.",
        ) from error

    return OpenAIConnectionResponse(status="connected", model=OPENAI_MODEL)


@app.post("/api/vocabulary/define", response_model=WordDefinition)
async def get_word_definition(
    payload: DefineWordRequest, request: Request
) -> WordDefinition:
    cache = get_word_definition_cache(request)
    cache_key = word_cache_key(payload.word, payload.context, payload.sentence_hash)
    if cache_key in cache:
        return cache[cache_key]
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="서버의 AI 기능이 아직 준비되지 않았습니다.",
        )
    try:
        definition = await asyncio.to_thread(
            define_word, payload.word, payload.context, payload.clicked_offset, api_key
        )
        cache[cache_key] = definition
        await asyncio.to_thread(write_word_definition_cache, cache.copy())
        return definition
    except AuthenticationError as error:
        raise HTTPException(
            status_code=401,
            detail="OpenAI API 키가 유효하지 않습니다.",
        ) from error
    except RateLimitError as error:
        raise HTTPException(
            status_code=429,
            detail="OpenAI 사용 한도를 초과했습니다.",
        ) from error
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="단어 뜻을 불러오지 못했습니다.",
        ) from error


@app.post("/api/vocabulary/lookup", response_model=WordDefinition)
async def lookup_vocabulary_expression(
    payload: DefineWordRequest, request: Request
) -> WordDefinition:
    return await get_word_definition(payload, request)


@app.post("/api/translations", response_model=TranslationResponse)
async def translate_transcript_sentence(
    payload: TranslateSentenceRequest, request: Request
) -> TranslationResponse:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="서버의 AI 기능이 아직 준비되지 않았습니다.",
        )
    try:
        return await asyncio.to_thread(translate_sentence, payload.text, api_key)
    except AuthenticationError as error:
        raise HTTPException(status_code=401, detail="OpenAI API 키가 유효하지 않습니다.") from error
    except RateLimitError as error:
        raise HTTPException(status_code=429, detail="OpenAI 사용 한도를 초과했습니다.") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail="문장 번역을 불러오지 못했습니다.") from error


@app.post("/api/vocabulary/prefetch", response_model=WordDefinitionsPayload)
async def prefetch_word_definitions(
    payload: BatchDefineWordsRequest, request: Request
) -> WordDefinitionsPayload:
    cache = get_word_definition_cache(request)
    requested: dict[str, DefineWordRequest] = {}
    for item in payload.items:
        requested.setdefault(
            word_cache_key(item.word, item.context, item.sentence_hash), item
        )

    missing = [item for key, item in requested.items() if key not in cache]
    if missing:
        api_key = os.getenv("OPENAI_API_KEY", "").strip()
        if api_key:
            try:
                definitions = await asyncio.to_thread(define_words, missing, api_key)
                for request_item, definition in zip(missing, definitions, strict=False):
                    key = word_cache_key(
                        request_item.word,
                        request_item.context,
                        request_item.sentence_hash,
                    )
                    cache[key] = definition
                await asyncio.to_thread(write_word_definition_cache, cache.copy())
            except AuthenticationError as error:
                raise HTTPException(
                    status_code=401, detail="OpenAI API 키가 유효하지 않습니다."
                ) from error
            except RateLimitError as error:
                raise HTTPException(
                    status_code=429, detail="OpenAI 사용 한도를 초과했습니다."
                ) from error
            except Exception as error:
                raise HTTPException(
                    status_code=502, detail="단어 뜻 미리 준비를 완료하지 못했습니다."
                ) from error

    return WordDefinitionsPayload(
        definitions=[cache[key] for key in requested if key in cache]
    )


def translation_memory_key(
    video_id: str, transcript_hash: str, translation_version: str
) -> str:
    return f"{video_id}:{transcript_hash}:{translation_version}"


@app.post("/api/translations/cache", response_model=TranslationCacheResponse)
async def get_translation_cache(
    payload: TranslationCacheRequest, request: Request
) -> TranslationCacheResponse:
    key = translation_memory_key(
        payload.video_id, payload.transcript_hash, payload.translation_version
    )
    memory: dict[int, TranslationItem] = request.app.state.translation_cache.setdefault(
        key, {}
    )
    persistent = bool(supabase_server_config())
    if persistent:
        try:
            remote = await asyncio.to_thread(
                read_supabase_translations,
                payload.video_id,
                payload.transcript_hash,
                payload.translation_version,
            )
            memory.update({item.sentence_index: item for item in remote})
        except requests.RequestException as error:
            raise HTTPException(
                status_code=502,
                detail="Supabase 번역 캐시를 불러오지 못했습니다.",
            ) from error
    items = [memory[index] for index in sorted(memory)]
    return TranslationCacheResponse(
        video_id=payload.video_id,
        transcript_hash=payload.transcript_hash,
        translation_version=payload.translation_version,
        translations=items,
        completed=len(items),
        total=payload.total_sentences,
        persistent=persistent,
    )


async def run_translation_batch(
    payload: TranslationBatchRequest, request: Request
) -> TranslationCacheResponse:
    key = translation_memory_key(
        payload.video_id, payload.transcript_hash, payload.translation_version
    )
    memory: dict[int, TranslationItem] = request.app.state.translation_cache.setdefault(
        key, {}
    )
    requested_indices = {sentence.sentence_index for sentence in payload.sentences}
    if supabase_server_config():
        try:
            remote = await asyncio.to_thread(
                read_supabase_translations,
                payload.video_id,
                payload.transcript_hash,
                payload.translation_version,
            )
            memory.update({item.sentence_index: item for item in remote})
        except requests.RequestException:
            pass
    missing_sentences = [
        sentence
        for sentence in payload.sentences
        if sentence.sentence_index not in memory
    ]
    if missing_sentences:
        api_key = os.getenv("OPENAI_API_KEY", "").strip()
        if not api_key:
            raise HTTPException(
                status_code=503, detail="서버의 AI 번역 기능이 아직 준비되지 않았습니다."
            )
        translation_payload = payload.model_copy(
            update={"sentences": missing_sentences}
        )
        try:
            generated = await asyncio.to_thread(
                translate_sentences, translation_payload, api_key
            )
            memory.update({item.sentence_index: item for item in generated})
            if supabase_server_config():
                await asyncio.to_thread(
                    write_supabase_translations, translation_payload, generated
                )
        except AuthenticationError as error:
            raise HTTPException(
                status_code=401, detail="OpenAI API 키가 유효하지 않습니다."
            ) from error
        except RateLimitError as error:
            raise HTTPException(
                status_code=429, detail="OpenAI 사용 한도를 초과했습니다."
            ) from error
        except requests.RequestException as error:
            raise HTTPException(
                status_code=502, detail="번역은 생성했지만 Supabase 저장에 실패했습니다."
            ) from error
        except Exception as error:
            raise HTTPException(
                status_code=502, detail="문장 번역을 완료하지 못했습니다."
            ) from error
    response_items = [
        memory[index] for index in sorted(requested_indices) if index in memory
    ]
    return TranslationCacheResponse(
        video_id=payload.video_id,
        transcript_hash=payload.transcript_hash,
        translation_version=payload.translation_version,
        translations=response_items,
        completed=len(memory),
        total=payload.total_sentences,
        persistent=bool(supabase_server_config()),
    )


@app.post("/api/translations/batch", response_model=TranslationCacheResponse)
async def translate_transcript_batch(
    payload: TranslationBatchRequest, request: Request
) -> TranslationCacheResponse:
    return await run_translation_batch(payload, request)


@app.post("/api/translations/lookup", response_model=TranslationCacheResponse)
async def translate_transcript_lookup(
    payload: TranslationBatchRequest, request: Request
) -> TranslationCacheResponse:
    if len(payload.sentences) != 1:
        raise HTTPException(
            status_code=400, detail="즉시 번역 요청에는 한 문장만 포함할 수 있습니다."
        )
    return await run_translation_batch(payload, request)


@app.post("/api/episodes/analyze", response_model=AnalyzeEpisodeResponse)
async def analyze_episode(
    payload: AnalyzeEpisodeRequest,
) -> AnalyzeEpisodeResponse:
    try:
        video_id = extract_video_id(payload.youtube_url)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    cached = await asyncio.to_thread(read_episode_cache, video_id)
    if cached:
        transcript = [TranscriptBlock.model_validate(block) for block in cached["transcript"]]
        items = [
            LearningItem.model_validate(item)
            for item in [*cached.get("vocabulary", []), *cached.get("phrasalVerbs", [])]
        ]
        return AnalyzeEpisodeResponse(
            episode_id=video_id,
            title=cached.get("title") or "AI English Episode",
            source_name=cached.get("sourceName") or "YouTube",
            duration_sec=cached.get("durationSec") or (transcript[-1].end_sec if transcript else 0),
            transcript=transcript,
            learning_items=normalize_items(items),
            analysis_status="complete",
            analysis_version=ANALYSIS_VERSION,
            cached=True,
            completed_chunks=1,
            total_chunks=1,
        )

    try:
        entries = await asyncio.to_thread(fetch_caption_entries, video_id)
    except (
        CaptionUnavailableError,
        TranscriptsDisabled,
        NoTranscriptFound,
        VideoUnavailable,
    ) as error:
        raise HTTPException(
            status_code=400,
            detail="이 영상에서 사용 가능한 영어 자막을 찾을 수 없습니다.",
        ) from error
    except SupadataAuthenticationError as error:
        raise HTTPException(
            status_code=401,
            detail="Supadata API 키가 유효하지 않습니다. Vercel 환경변수를 확인해 주세요.",
        ) from error
    except SupadataRateLimitError as error:
        raise HTTPException(
            status_code=429,
            detail="Supadata 무료 크레딧 또는 요청 한도를 초과했습니다.",
        ) from error
    except SupadataServiceError as error:
        raise HTTPException(
            status_code=502,
            detail="Supadata 자막 서비스에 일시적으로 연결할 수 없습니다.",
        ) from error
    except (RequestBlocked, IpBlocked) as error:
        raise HTTPException(
            status_code=503,
            detail=(
                "YouTube가 배포 서버의 자막 요청을 차단했습니다. "
                "Vercel에 SUPADATA_API_KEY를 설정해 주세요."
            ),
        ) from error
    except CouldNotRetrieveTranscript as error:
        raise HTTPException(
            status_code=400,
            detail=(
                "자막이 없거나 YouTube가 배포 서버의 자막 요청을 차단했습니다. "
                "IFrame API는 영상 재생만 제공하므로 영어 자막(CC)이 있는 영상을 사용해 주세요."
            ),
        ) from error
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="YouTube 자막 서비스에 일시적으로 연결할 수 없습니다.",
        ) from error

    title, source_name = await asyncio.to_thread(fetch_video_metadata, video_id)
    transcript = build_transcript_blocks(entries)
    chunks = chunk_transcript(entries)
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    return AnalyzeEpisodeResponse(
        episode_id=video_id,
        title=title,
        source_name=source_name,
        duration_sec=transcript[-1].end_sec if transcript else 0,
        transcript=transcript,
        learning_items=[],
        analysis_status="pending" if api_key else "waiting_for_key",
        analysis_version=ANALYSIS_VERSION,
        cached=False,
        completed_chunks=0,
        total_chunks=len(chunks),
    )


@app.post("/api/episodes/analyze-chunk", response_model=AnalyzeChunkResponse)
async def analyze_episode_chunk(payload: AnalyzeChunkRequest) -> AnalyzeChunkResponse:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="서버의 AI 분석 기능이 아직 준비되지 않았습니다.",
        )
    try:
        items = await asyncio.to_thread(
            analyze_chunk,
            payload.transcript_chunk,
            payload.chunk_index + 1,
            payload.total_chunks,
            api_key,
        )
    except AuthenticationError as error:
        raise HTTPException(
            status_code=401, detail="OpenAI API 키가 유효하지 않습니다."
        ) from error
    except RateLimitError as error:
        raise HTTPException(
            status_code=429,
            detail="OpenAI 사용 한도 또는 요청 한도를 초과했습니다.",
        ) from error
    except APIConnectionError as error:
        raise HTTPException(
            status_code=502, detail="OpenAI API에 연결할 수 없습니다."
        ) from error
    except APIStatusError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail=f"OpenAI 분석 요청이 실패했습니다. (상태 {error.status_code})",
        ) from error
    except Exception as error:
        raise HTTPException(
            status_code=502, detail="학습 단어 분석을 완료하지 못했습니다."
        ) from error

    return AnalyzeChunkResponse(
        chunk_index=payload.chunk_index,
        total_chunks=payload.total_chunks,
        analysis_version=ANALYSIS_VERSION,
        learning_items=items,
    )


@app.get(
    "/api/episodes/{video_id}/analysis", response_model=AnalysisStatusResponse
)
async def get_analysis_status(video_id: str, request: Request) -> AnalysisStatusResponse:
    if not VIDEO_ID_PATTERN.fullmatch(video_id):
        raise HTTPException(status_code=400, detail="유효한 영상 ID가 아닙니다.")
    cached = await asyncio.to_thread(read_episode_cache, video_id)
    if cached:
        items = [
            LearningItem.model_validate(item)
            for item in [*cached.get("vocabulary", []), *cached.get("phrasalVerbs", [])]
        ]
        return AnalysisStatusResponse(
            episode_id=video_id,
            analysis_status="complete",
            analysis_version=ANALYSIS_VERSION,
            learning_items=normalize_items(items),
            completed_chunks=1,
            total_chunks=1,
        )
    job = request.app.state.analysis_jobs.get(video_id)
    if not job:
        raise HTTPException(status_code=404, detail="진행 중인 분석을 찾을 수 없습니다.")
    return AnalysisStatusResponse(
        episode_id=video_id,
        analysis_status=job["status"],
        analysis_version=ANALYSIS_VERSION,
        learning_items=job["items"],
        completed_chunks=job["completed_chunks"],
        total_chunks=job["total_chunks"],
        error=job.get("error"),
    )
