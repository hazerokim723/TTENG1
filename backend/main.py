"""FastAPI service for turning YouTube captions into C1 learning items."""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
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
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)

load_dotenv()

VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
TRANSCRIPT_CHUNK_CHARACTER_LIMIT = 28_000
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5-mini")
ANALYSIS_VERSION = "b2-c1-phrasal-v1"
IS_VERCEL = bool(os.getenv("VERCEL"))
CACHE_DIRECTORY = Path(
    os.getenv("TURTLE_CACHE_DIRECTORY")
    or (
        Path(tempfile.gettempdir()) / "turtle-english"
        if IS_VERCEL
        else Path(__file__).resolve().parent / ".cache"
    )
)
WORD_CACHE_VERSION = "context-dictionary-v1"
WORD_CACHE_PATH = CACHE_DIRECTORY / f"{WORD_CACHE_VERSION}.json"


class CaptionUnavailableError(Exception):
    """Raised when a transcript exists but contains no usable caption text."""


class AnalyzeEpisodeRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    youtube_url: str = Field(min_length=1, max_length=2_048)


class LearningItem(BaseModel):
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


class HealthResponse(BaseModel):
    status: str


class OpenAIConnectionResponse(BaseModel):
    status: Literal["connected"]
    model: str


class DefineWordRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    word: str = Field(min_length=1, max_length=80)
    context: str = Field(min_length=1, max_length=1_000)


class WordDefinition(BaseModel):
    word: str
    word_type: str
    definition_kr: str


class TranslateSentenceRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    text: str = Field(min_length=1, max_length=2_000)


class TranslationResponse(BaseModel):
    translation_kr: str


class BatchDefineWordsRequest(BaseModel):
    items: list[DefineWordRequest] = Field(min_length=1, max_length=30)


class WordDefinitionsPayload(BaseModel):
    definitions: list[WordDefinition]


app = FastAPI(title="Turtle English API", version="1.0.0")
app.state.analysis_jobs = {}
app.state.analysis_tasks = set()
app.state.word_definition_cache = None
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


def fetch_caption_entries(video_id: str) -> list[tuple[float, str]]:
    transcript = YouTubeTranscriptApi().fetch(video_id, languages=["en"])
    entries = [
        (float(snippet.start), snippet.text.strip())
        for snippet in transcript
        if snippet.text.strip()
    ]
    if not entries:
        raise CaptionUnavailableError
    return entries


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
1. 자막의 문장부호, 대소문자, 띄어쓰기를 문맥에 맞게 교정하고 인접 자막을 자연스러운 문장으로 결합하세요.
2. B2 또는 C1 학습 가치가 높은 어휘와 실용적인 구동사를 선별하세요. 쉬운 A1~B1 단어와 고유명사는 제외하세요.
3. 각 항목은 해당 표현이 처음 발화되는 정확한 원본 타임스탬프를 사용하세요.
4. masked_sentence에는 target_word의 일부 또는 전체만 밑줄로 가리세요. 나머지 문맥은 유지하세요.
5. definition_kr에는 간결하고 문맥에 맞는 한국어 뜻을 쓰세요.
6. hint_for_tap에는 짧고 직관적인 영어 정의를 쓰세요.
7. 이 구간의 경계에서 문장이 불완전하다면 추측해서 항목을 만들지 마세요.
8. level은 반드시 B2 또는 C1로 분류하고, 구동사는 is_phrasal_verb를 true로 설정하세요.
9. 응답 스키마에 맞는 데이터만 반환하세요.

자막:
{transcript_chunk}
""".strip()


def analyze_chunk(
    transcript_chunk: str, chunk_index: int, chunk_count: int, api_key: str
) -> list[LearningItem]:
    client = OpenAI(api_key=api_key)
    response = client.responses.parse(
        model=OPENAI_MODEL,
        input=make_prompt(transcript_chunk, chunk_index, chunk_count),
        text_format=LearningItemsPayload,
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


def define_word(word: str, context: str, api_key: str) -> WordDefinition:
    client = OpenAI(api_key=api_key)
    response = client.responses.parse(
        model=OPENAI_MODEL,
        input=(
            "다음 영어 단어를 주어진 문맥에 맞춰 한국어 학습자용으로 설명하세요. "
            "품사는 영어로 간결하게 쓰고, 뜻은 한국어 한 줄로 쓰세요.\n\n"
            f"단어: {word}\n문맥: {context}"
        ),
        text_format=WordDefinition,
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
        model=OPENAI_MODEL,
        input=(
            "다음 영어 문장을 문맥과 어조를 살린 자연스러운 한국어로 번역하세요. "
            "단어 대 단어 직역을 피하고, 설명이나 따옴표 없이 번역문만 반환하세요.\n\n"
            f"영어 문장: {text}"
        ),
        text_format=TranslationResponse,
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
        model=OPENAI_MODEL,
        input=(
            "아래 영어 단어들을 각각 주어진 문맥에 맞춰 한국어 학습자용으로 설명하세요. "
            "입력된 모든 단어를 정확히 한 번씩 반환하고, word는 입력 철자를 유지하세요. "
            "word_type은 영어 품사로 간결하게, definition_kr은 가장 적절한 한국어 뜻 한 줄로 쓰세요.\n\n"
            f"입력: {json.dumps(input_items, ensure_ascii=False)}"
        ),
        text_format=WordDefinitionsPayload,
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


def normalize_items(items: Iterable[LearningItem]) -> list[LearningItem]:
    """Sort results and remove likely duplicates created at chunk boundaries."""
    unique: dict[tuple[int, str], LearningItem] = {}
    for item in items:
        item.timestamp_display = format_timestamp(item.timestamp_sec)
        key = (round(item.timestamp_sec), item.target_word.casefold().strip())
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
    cache_key = payload.word.casefold().strip()
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
            define_word, payload.word, payload.context, api_key
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
        requested.setdefault(item.word.casefold().strip(), item)

    missing = [item for key, item in requested.items() if key not in cache]
    if missing:
        api_key = os.getenv("OPENAI_API_KEY", "").strip()
        if api_key:
            try:
                definitions = await asyncio.to_thread(define_words, missing, api_key)
                for definition in definitions:
                    key = definition.word.casefold().strip()
                    if key in requested:
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


@app.post("/api/episodes/analyze", response_model=AnalyzeEpisodeResponse)
async def analyze_episode(
    payload: AnalyzeEpisodeRequest, request: Request
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
    except CouldNotRetrieveTranscript as error:
        raise HTTPException(
            status_code=400,
            detail="YouTube 자막을 가져오지 못했습니다. 영상 공개 상태와 자막을 확인해 주세요.",
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
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="서버의 AI 분석 기능이 아직 준비되지 않았습니다.",
        )

    existing_job = request.app.state.analysis_jobs.get(video_id)
    if existing_job and existing_job["status"] in {"pending", "running", "complete"}:
        job = existing_job
    else:
        job = {
            "status": "pending",
            "items": [],
            "completed_chunks": 0,
            "total_chunks": len(chunks),
            "error": None,
        }
        request.app.state.analysis_jobs[video_id] = job
        if IS_VERCEL:
            # A Vercel Function can be frozen as soon as its response is returned.
            # Finish the analysis in this invocation instead of relying on an
            # in-memory background task that may disappear between requests.
            await run_analysis_job(
                video_id, title, source_name, transcript, chunks, api_key
            )
        else:
            task = asyncio.create_task(
                run_analysis_job(
                    video_id, title, source_name, transcript, chunks, api_key
                )
            )
            request.app.state.analysis_tasks.add(task)
            task.add_done_callback(request.app.state.analysis_tasks.discard)
    return AnalyzeEpisodeResponse(
        episode_id=video_id,
        title=title,
        source_name=source_name,
        duration_sec=transcript[-1].end_sec if transcript else 0,
        transcript=transcript,
        learning_items=job["items"],
        analysis_status=job["status"],
        analysis_version=ANALYSIS_VERSION,
        cached=False,
        completed_chunks=job["completed_chunks"],
        total_chunks=job["total_chunks"],
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
