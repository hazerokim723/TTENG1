# Turtle English

Figma 와이어프레임과 PRD를 바탕으로 만든 반응형 학습 웹 프로토타입입니다.

## 실행

```bash
pnpm install
pnpm dev
```

프로덕션 빌드는 `pnpm build`로 생성합니다.

## 구현된 데모 흐름

- YouTube URL 입력 및 분석 로딩 상태
- 모의 영상 플레이어와 타임스탬프 스크립트
- C1 단어 인라인 Wordwise 힌트
- 누락 없는 전체 문장 스크립트와 재생 위치 자동 추적
- C1 두 글자 받아쓰기, 일반 단어 뜻 확인 및 단어장 자동 저장
- 문장 하이라이트와 문장 금고 저장
- 빈칸 퀴즈와 오답 짐가방
- 학습 점수에 따라 이동하는 미국행 마일스톤
- 브라우저 `localStorage` 기반 진행 상태 유지

초기 화면은 샘플 데이터를 보여주며, YouTube 링크를 제출하면 FastAPI가 실제 영어 자막을 가져와 OpenAI로 C1 학습 데이터를 생성합니다.

## 실제 분석 API 실행

Python 3.11 이상과 OpenAI API 키가 필요합니다.

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

`backend/.env`에 `OPENAI_API_KEY`를 설정한 뒤 서버를 실행합니다. 기본 모델은 `gpt-5-mini`이며 `OPENAI_MODEL`로 변경할 수 있습니다.

```powershell
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

프런트엔드는 기본적으로 `http://127.0.0.1:8000`을 사용합니다. 다른 주소가 필요하면 루트 `.env`의 `VITE_API_BASE_URL`을 변경하세요. API 상세 내용은 [backend/README.md](backend/README.md)를 참고하세요.
