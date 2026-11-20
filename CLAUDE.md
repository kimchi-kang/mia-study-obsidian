# MIA Study (Obsidian 플러그인)

Markdown 문제은행 + 키워드 연결 + FSRS-6 복습을 Obsidian 안에서 하는 플러그인. 공개 GitHub 저장소 `kimchi-kang/mia-study-obsidian`, 플러그인 id `mia-study`, 데스크톱·모바일 모두 지원(`isDesktopOnly: false`).

## 명령어

```bash
npm run dev            # esbuild watch (인라인 소스맵)
npm run build          # tsc --noEmit + 프로덕션 번들 → main.js
npm test               # vitest run
npm run verify:full    # CI와 동일한 전체 검증 (필터 인수 불가, 실패·생략 0 요구 + build)
npx vitest run tests/<파일>   # 단일 테스트 파일
npm run install:local -- --vault "/절대경로/보관함"   # 로컬 보관함에 3개 파일 설치
npm run package:release -- --release                  # artifacts/<버전>/ 에 릴리스 ZIP 생성
```

- CI(`.github/workflows/ci.yml`)는 Node 24에서 `npm ci && npm run verify:full`만 실행한다.
- `verify:full`은 `tests/fixtures/vault` 합성 보관함만 사용한다. 실제 사용자 보관함 감사는 `MIA_AUDIT_VAULT=<경로> npx vitest run tests/vault-audit.test.ts`(읽기 전용).

## 구조와 계층 규칙

`src/main.ts`(플러그인 진입점) + `src/core/` · `src/services/` · `src/ui/` 세 층. 하위 폴더는 만들지 않는다.
`tests/architecture.test.ts`가 아래 경계를 강제한다:

- `core/`: `obsidian` import 금지, services·ui·main import 금지, Web Storage 금지 (순수 로직: 파서, FSRS, 질의, 추천)
- `services/`: ui import 금지, `localStorage` 금지 (보관함 읽기·쓰기, 인덱스, data.json 저장)
- `ui/`: `saveData`·`vault.process` 직접 호출 금지 — 저장은 services 경유
- 기기 로컬 저장은 `main.ts`에서 Obsidian `app.loadLocalStorage/saveLocalStorage`를 주입하는 방식만 허용

## 반드시 지킬 것

- **저장 형식 불변**: `data.json`, Sync 파일, Markdown 문제·키워드 노트 형식(`> [!question]`, `^mia-q-…`, `> [!mia]- 학습 정보`)을 바꾸지 않는다. 바꿔야 하면 먼저 사용자에게 확인.
- **FSRS 일정 계산 불변**: 요청이 없으면 복습 간격·하루 경계(기본 04:00) 계산을 건드리지 않는다.
- **기존 테스트 기대값을 고치지 않는다.** 불가피하면 이유를 보고한다. `tests/stabilize-bundle-equivalence.test.js`는 1.4.26 픽스처 기준이며, 새 명령 등은 따로 확인한다.
- **공개 저장소**: 테스트·예시·문서에 개인정보, 실제 학습 자료, 실제 전공 과목명(전자·회로·공학 계열)을 넣지 않는다. 지리학·통계이론·레시피 같은 중립 예시를 쓴다.
- UI 문구는 한국어. 디자인은 바우하우스 스타일(원색·두꺼운 테두리·각진 모서리).
- `styles.css`는 화면별 번호 섹션(1. 공통, 2. 오늘, 3. 학습현황, 4. 문제, 5. 키워드, 6. 학습 카드 …)으로 나뉜다. 새 규칙은 해당 섹션 안에 넣고, 파일 끝에 덧붙이거나 새 `!important`를 추가하지 않는다.
- `main.js`는 빌드 산출물이지만 **커밋 대상**이다(Obsidian은 `main.js`·`styles.css`·`manifest.json` 세 파일만 설치). 직접 수정하지 말고 빌드로 갱신한다.
- 화면 레이아웃을 바꾸면 `tests/fixtures/study-layout-harness.html` 재생성이 필요할 수 있다(`scripts/generate-study-layout-harness.mjs`). 브라우저 확인은 `.claude/launch.json`의 `mia-ui-harness`(포트 8765).
- 커밋·푸시·버전 변경·태그·릴리스는 사용자가 요청할 때만.

## 릴리스 절차 (요청 시)

1. 버전을 `package.json`, `package-lock.json`(두 곳), `manifest.json`, `versions.json`에 함께 맞춘다 — `package-release.mjs`가 불일치를 거부한다.
2. `docs/releases/<버전>.md` 작성(사용자 대상 한국어, 검증 결과와 **미확인 항목**을 명시). 같이 갱신: `STATUS.md` 맨 위 항목, `README.md`, `INSTALL.md`, `docs/index.html`.
3. `npm run verify:full` 통과 → `npm run package:release -- --release`.
4. 커밋 메시지 `release: MIA Study <버전>` + 한국어 변경 요약. 태그 `<버전>`, GitHub 릴리스에 ZIP·세 파일·SHA256SUMS 등 `artifacts/<버전>/` 내용을 올린다.

## 문서 위치

- `README.md` 사용자 안내 · `INSTALL.md` 설치·복구 · `STATUS.md` 버전별 작업·검증 상태(최신이 위)
- `MIA-AGENT.md` 외부 GPT/에이전트용 문제은행 형식 가이드 (`tests/agent-guide.test.ts`가 예제를 검증)
- `docs/releases/` 버전별 변경 내역 · `docs/qa/` 검증 기록 · `docs/SAFETY-QA.md` 수동 QA 순서 · `docs/SCHEDULER-POLICIES.md` 스케줄러 정책
- `.claude/codex-brief-*.md` / `codex-report-*.md`: 외부 에이전트(Codex)에게 준 작업 지침과 결과 보고. 비슷한 작업을 맡길 때 형식 참고. git에는 올리지 않는다.
- `artifacts/`는 gitignore된 빌드·검증 산출물 폴더.
