# Turtle English API

YouTube 영어 자막을 가져와 OpenAI로 교정하고 C1 받아쓰기 학습 항목을 만드는 FastAPI 백엔드입니다.

## 실행

Python 3.11 이상을 권장합니다.

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

`.env`의 `OPENAI_API_KEY`를 실제 키로 교체한 다음 실행합니다. 기본 모델은 `gpt-5-mini`입니다.

```powershell
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

API 문서는 `http://127.0.0.1:8000/docs`에서 확인할 수 있습니다.

## 엔드포인트

- `GET /api/health`: 서버 상태 확인
- `POST /api/episodes/analyze`: 자막 추출 및 C1 학습 데이터 생성
- `POST /api/settings/openai-key`: 현재 서버 프로세스 메모리에 OpenAI 키 설정
- `DELETE /api/settings/openai-key`: 메모리에 설정한 OpenAI 키 삭제
- `POST /api/vocabulary/define`: 문맥에 맞는 일반 단어 뜻과 품사 생성

요청 예시:

```json
{
  "youtube_url": "https://youtu.be/QT_XAplb4IQ"
}
```

응답은 실제 영상 제목과 채널명, 전체 문장 블록인 `transcript`, C1 표시용 메타데이터인 `learning_items`를 반환합니다. `learning_items`는 스크립트를 필터링하지 않으며 표시와 퀴즈에만 사용됩니다. 긴 영상은 자막 항목 경계에서 자동으로 분할 분석한 뒤 결과를 병합합니다.

브라우저에서 키를 설정해야 한다면 다음 요청을 사용할 수 있습니다.

```json
{
  "api_key": "your_openai_api_key_here"
}
```

설정 API는 키 자체를 응답하지 않으며 로그나 파일에 기록하지 않습니다. 키는 실행 중인 서버 프로세스 메모리에만 존재하므로 서버를 재시작하면 사라집니다. 메모리에 설정된 키가 있으면 환경 변수 `OPENAI_API_KEY`보다 우선 사용됩니다.

## 오류 응답

- `400`: 잘못된 YouTube URL, 비공개/사용 불가 영상, 영어 자막 없음
- `401`: OpenAI API 키 인증 실패
- `429`: OpenAI 사용량 또는 요청 한도 초과
- `502`: YouTube 또는 OpenAI 외부 서비스 오류
- `503`: `OPENAI_API_KEY` 미설정

API 키는 백엔드 환경 변수에만 저장하며 요청, 응답 또는 프런트엔드 코드에 포함하지 마세요.
