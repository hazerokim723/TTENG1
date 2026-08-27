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
- Supabase Auth 기반 선택형 Google 로그인과 MY 페이지

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

로컬 개발에서는 `.env.local`의 `VITE_API_BASE_URL`을 사용합니다. Vercel에서는 같은 도메인의 `/api`를 사용하므로 이 값을 비워 둡니다. API 상세 내용은 [backend/README.md](backend/README.md)를 참고하세요.

## Supabase Google 로그인

루트 `.env.local`에 다음 공개 클라이언트 값을 설정합니다. `service_role` 또는 secret key는 브라우저 환경변수에 넣지 않습니다.

```text
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
```

Supabase Dashboard의 **Authentication → Sign In / Providers → Google**에서 Google 제공자를 활성화하고 Google Client ID와 Client Secret을 입력합니다. Google Cloud Console의 Authorized redirect URI에는 다음 Supabase 콜백 주소를 사용합니다.

```text
https://your-project-ref.supabase.co/auth/v1/callback
```

Supabase Dashboard의 **Authentication → URL Configuration**에는 다음을 등록합니다.

```text
Site URL: https://your-production-domain.vercel.app

Redirect URLs:
http://localhost:4173/**
http://127.0.0.1:4173/**
https://your-production-domain.vercel.app/**
https://*-your-vercel-team-or-account.vercel.app/**
```

운영 주소는 정확한 URL을 사용하고, 마지막 와일드카드 주소는 Vercel Preview 배포에만 사용합니다.

## Vercel 배포

Vercel 프로젝트는 저장소 루트를 선택하고 Application Preset을 **Vite**로 설정합니다. `vercel.json`이 Vite 빌드와 `/api` FastAPI Function을 함께 구성합니다.

Vercel의 Production과 Preview 환경에 다음 변수를 등록합니다.

```text
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-5-mini
```

`VITE_API_BASE_URL`은 등록하지 않습니다. 배포 후 `/`는 Vite 화면, `/api/health`는 FastAPI 상태 응답을 제공해야 합니다.
