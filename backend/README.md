# Turtle English API

Supadata에서 YouTube 영어 자막과 타임스탬프를 가져와 OpenAI로 C1 받아쓰기 학습 항목을 만드는 FastAPI 백엔드입니다.

## 실행

Python 3.11 이상을 권장합니다.

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

`.env`의 `OPENAI_API_KEY`와 `SUPADATA_API_KEY`를 실제 키로 교체한 다음 실행합니다. 기본 OpenAI 모델은 `gpt-5-mini`입니다.

```powershell
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

API 문서는 `http://127.0.0.1:8000/docs`에서 확인할 수 있습니다.

## 엔드포인트

- `GET /api/health`: 서버 상태 확인
- `POST /api/openai/validate`: 서버 환경변수의 OpenAI 키와 모델을 실제 최소 요청으로 확인
- `POST /api/episodes/analyze`: 전체 자막을 먼저 반환하고 청크 수 제공
- `POST /api/episodes/analyze-chunk`: 한 청크의 B2/C1·구동사 메타데이터 생성
- `POST /api/vocabulary/define`: 문맥에 맞는 일반 단어 뜻과 품사 생성

요청 예시:

```json
{
  "youtube_url": "https://youtu.be/QT_XAplb4IQ"
}
```

응답은 실제 영상 제목과 채널명, 전체 문장 블록인 `transcript`를 먼저 반환합니다. 브라우저는 전체 스크립트를 즉시 표시한 뒤 최대 2개의 분석 청크를 병렬 처리하고, 도착한 B2/C1·구동사 메타데이터를 점진적으로 적용합니다. `learning_items`는 스크립트를 필터링하지 않으며 표시와 퀴즈에만 사용됩니다. 완료된 결과는 `analysisVersion`과 영상 ID를 포함한 JSON으로 브라우저에 캐시됩니다.

Vercel과 같은 클라우드 IP는 YouTube에서 자막 요청이 차단될 수 있습니다. 배포 환경에서는 Supadata 대시보드에서 발급한 키를 Vercel의 서버 환경변수로 설정하세요.

```text
SUPADATA_API_KEY=...
```

백엔드는 Supadata에 `mode=native`를 지정하므로 YouTube에 이미 존재하는 영어 자막만 가져옵니다. 자막이 없는 영상을 AI 음성 인식으로 자동 생성하지 않아 Supadata 크레딧이 예상보다 많이 소모되는 일을 막습니다. 응답의 밀리초 단위 `offset`을 초 단위 타임스탬프로 변환한 뒤 기존 전체 스크립트·IFrame 시간 동기화 흐름에 사용합니다.

`SUPADATA_API_KEY`가 없는 로컬 환경에서는 기존 `youtube-transcript-api`를 대체 경로로 사용할 수 있습니다. 이 경로를 배포 환경에서 사용해야 한다면 회전형 주거용 프록시를 설정하세요.

```text
WEBSHARE_PROXY_USERNAME=...
WEBSHARE_PROXY_PASSWORD=...
WEBSHARE_PROXY_LOCATIONS=us,kr,jp
```

다른 프록시를 사용할 경우 인증 정보를 포함한 전체 URL을 `YOUTUBE_PROXY_URL`에 설정할 수 있습니다. 프록시 비밀번호는 프런트엔드 환경변수나 코드에 넣지 말고 Vercel 서버 환경변수로만 관리하세요.

OpenAI 키는 서버 환경변수 `OPENAI_API_KEY`에서만 읽습니다. 브라우저 입력이나 프런트엔드 코드로 키를 전달하지 않습니다.
화면의 `AI 연결 확인` 버튼은 키를 저장하지 않고 연결 성공 상태만 브라우저에 기억합니다. 이후 모든 AI 기능은 같은 서버 환경변수 키를 자동으로 재사용합니다.

## 오류 응답

- `400`: 잘못된 YouTube URL, 비공개/사용 불가 영상, 영어 자막 없음
- `401`: OpenAI API 키 인증 실패
- `429`: OpenAI 사용량 또는 요청 한도 초과
- `502`: Supadata, YouTube 또는 OpenAI 외부 서비스 오류
- `503`: `OPENAI_API_KEY` 미설정 또는 Supadata 미설정 상태에서 배포 서버 IP의 YouTube 접근 차단

API 키는 백엔드 환경 변수에만 저장하며 요청, 응답 또는 프런트엔드 코드에 포함하지 마세요.
