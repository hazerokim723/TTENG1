# 학습 재생목록·이용량·토스 테스트 구독

## 구현된 흐름

- 추천 목록 및 YouTube 재생: 로그인/이용권 없이 공개.
- AI 학습 시작: Supabase Google 사용자 확인 → 영상별 권한 예약 → 전체 자막 제공 → 첫 분석 구간 저장 후 차감 확정.
- 무료 10개는 서로 다른 영상 기준. 같은 영상 복습/새로고침은 다시 차감하지 않음.
- 이전 `learning_progress` 영상은 마이그레이션 시 별도 legacy 권한으로 보존. 이후 사용자가 진도 행을 만들어도 무료 권한이 생기지 않음.
- 추천 영상의 소개글/순서/공개 상태는 `platform_admins`에 지정된 관리자만 서버를 통해 수정.
- 관리자는 링크 등록 → 소개 작성 → 학습 자료 준비 → 전체 분석·번역 완료 확인 → 공개 순서로 진행.
- 단순 재생은 AI 자료 준비와 다름. 로그인 재생은 개인 진도를 저장하지만 AI 횟수는 차감하지 않음.
- `내 영상` 숨김은 진도 행의 hidden만 변경. 이용 권한과 차감 이력은 별도 보존.

## 저장·보안

`learning_artifacts`에는 전체 원문/타임스탬프/원문 해시/버전을 저장하고 `artifact_chunks`에는 분석·번역 결과와 작업 상태를 저장한다. 계정의 영상 권한은 해당 자료 버전에 고정된다. 영상 길이 제한이나 전체 청크 수 제한을 상품에 두지 않는다.

구간은 서버가 저장한 원문에서만 생성한다. 브라우저가 임의의 프롬프트나 자막을 보내 AI 비용을 우회하지 못하도록 이전 `/api/episodes/*`, `/api/translations*`, `/api/vocabulary/*` 경로는 410으로 폐쇄했다. 새 클라이언트는 `/api/learning/*`를 사용한다.

학습 횟수는 사용자별 DB 트랜잭션 잠금, 구간 처리는 자료별 잠금 및 최대 2개 임대(5분)로 보호한다. 실패한 임대는 재시도하며, 3회 실패하면 중단한다. 5분 이후 같은 영상의 학습 시작을 누르면 실패 구간을 다시 준비할 수 있다. 완료 구간은 다시 생성하지 않는다.

결제/권한/공용 자료 테이블은 RLS + 브라우저 역할 권한 제거로 서버 전용이다. 기존 saved_words/saved_sentences/learning_progress의 사용자별 RLS는 유지한다. Service Role, 빌링키, 토스 Secret Key는 클라이언트 응답에 넣지 않는다.

## 운영자가 완료해야 할 설정

### 관리자 지정

관리자 본인이 먼저 Google 로그인한 뒤 Supabase SQL Editor에서 **확인한 본인 이메일**로 실행한다. 앱에서 관리자 권한을 자가 부여하는 기능은 없다.

```sql
insert into public.platform_admins(user_id)
select id from auth.users where email = '확인한 관리자 이메일'
on conflict do nothing;
```

### Vercel 환경변수

Production에 서버 전용 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `SUPADATA_API_KEY`를 유지한다. 공개 Google 로그인 설정에는 기존 `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`만 사용한다. 서버 키에 `VITE_` 접두사를 붙이지 않는다.

URL만 빠졌다면 기존 `VITE_SUPABASE_URL`을 서버에서도 재사용하지만, 공개 키로 Service Role을 대체하지는 않는다. 배포 후 `/api/library`가 503이라면 응답에 표시된 서버 변수를 먼저 등록해야 한다. 화면 배포 성공과 서버 설정 완료는 별개다.

토스 테스트를 시작할 때 추가:

- `TOSS_CLIENT_KEY`: API 개별 연동 테스트 클라이언트 키 (`test_ck_…`)
- `TOSS_SECRET_KEY`: 같은 상점 테스트 시크릿 키 (`test_sk_…`)
- `BILLING_ENCRYPTION_KEY`: Fernet 키. 빌링키 암호화에 사용하므로 안전하게 보관하고 임의 교체하지 않는다.
- `INTERNAL_WORKER_SECRET`: 충분히 긴 무작위 비밀값, 예약 작업 인증용.

값은 대시보드에 직접 입력하고 채팅/GitHub에 붙여넣지 않는다. 환경변수 변경 후 새로 배포한다. 테스트 버튼은 관리자에게만 보이며, live 키는 코드와 DB에서 거부한다. 상품 가격은 테스트 1,000원으로 고정되어 있다.

### 페이지를 닫은 뒤 작업 재개·월 자동 갱신

DB 마이그레이션은 Supabase Cron을 매분 등록한다. 아래 두 Vault 값이 없으면 외부 요청을 보내지 않는다.

- `turtle_worker_origin`: `https://tteng1.vercel.app` (마지막 `/` 없음)
- `turtle_worker_secret`: Vercel의 `INTERNAL_WORKER_SECRET`과 동일한 값

Supabase Dashboard → Vault에서 등록한다. Cron은 미완료 자료가 있을 때만 `/api/internal/tick`, 갱신/확인할 주문이 있을 때만 `/api/internal/billing-tick`을 호출한다. 두 작업은 분리되어 Vercel의 300초 제한 안에서 처리한다. Vercel 배포 보호에 의해 이 서버 요청이 차단되지 않는 Production 도메인이 필요하다. 비밀값을 URL 쿼리에 넣지 않는다.

### 토스 결과 및 복구

토스 Webhook URL: `https://tteng1.vercel.app/api/billing/webhook`.
결제 성공은 브라우저 리다이렉트가 아니라 서버의 토스 조회/승인 결과로 확인한다. 주문 ID·금액·통화를 검증하고 같은 주문/기간은 한 번만 지급한다. 빌링키는 암호화 저장하며 카드번호를 수집·저장하지 않는다.

불명확한 결과는 결제 조회 후 동일 주문/멱등키로 처리한다. 이미 결제된 주문이면 재청구 없이 DB 권한만 복구한다. 결제 실패는 MY의 결과 재확인으로 재시도하며, 갱신 실패 시 새 30개를 지급하지 않는다. 해지는 현재 기간 끝까지 유효하고 다음 청구를 중단한다. 미사용 개수는 이월되지 않는다. 월말 시작일은 해당 월 마지막 날로 보정하고 다음 달에는 원래 날짜를 사용한다.

실제 판매 가격, 자동결제 계약, 라이브 키, 환불 정책, 공유 자막 이용 권한을 확정하기 전에는 라이브 결제로 전환하지 않는다. 무료/개인 학습은 테스트 결제를 요구하지 않는다.

## 검증

- `python -B -m unittest discover -s tests -v`: 서버 인증, 버전 고정, 캐시 재사용, 구간 목록 페이지 처리, 만료 예약, 테스트 키만 허용, 결제 결과 검증, 중복/불명확 응답 복구.
- `tests/platform_database.sql`: Supabase에서 실행. 모든 테스트 자료는 ROLLBACK. 무료 10개, 실패 반환, legacy 보존, 월 30개, 중복 지급, 해지, 브라우저 권한을 확인.
- 실제 DB에서 별도 임시 사용자로 마지막 무료 1회 동시 요청 검증 후 테스트 계정/기록 삭제 완료.
- 배포 후 비로그인 재생/로그인 유도/공개 목록과 인증 없는 API 차단 확인.
- 관리자 이메일/토스 테스트 키 미설정 상태에서는 실제 Google 관리자 준비 흐름과 토스 카드 등록·갱신 성공을 검증 완료로 보지 않는다.

## 배포 순서

1. DB 마이그레이션 적용 → 공용 저장·재생목록 코드 배포.
2. 무료 횟수 RPC/로그인 경계 테스트 후 프런트엔드 새 학습 API 사용.
3. 관리자 지정·Vault/Vercel 연결값 설정 후 작업 재개 점검.
4. 관리자 테스트 키 설정 → 카드 등록/첫 결제/재확인/해지/갱신 실증.
5. 라이브 전환은 별도 승인 및 별도 변경으로 진행.
