# 남은 실패·건너뜀 검증 — 2026-10-27

`PERFORMANCE-QA.md` 후속 검사. 기존 성능 변경을 유지한 작업 트리에서 시작했다. 이번 변경은 `tests/owned-merge.test.js`, `README.md`와 검증 문서뿐이다. 제품 코드·의존성·테스트 실행 설정은 변경하지 않았다. 사용자 보관함·학습 자료는 읽거나 변경하지 않았으며 원격 푸시·릴리스 게시·배포 패키징은 하지 않았다.

## 원인과 처리

| 항목 | 재현 조건·원인 | 처리·결과 |
| --- | --- | --- |
| `owned-merge.test.js` / `consumed validated incoming merge` / `preserves an incoming winner, other reviews, settings and conflict history` | 계보 없는 기본 local 설정(.9)과 incoming 설정(.8)을 병합할 때 incoming 활성값 .8을 강제 기대. 수정 전 단독 실행과 전체 실행 모두 .9 수신으로 실패. 오래된 테스트 기대값이며 제품 버그·상태 오염·환경 의존·미구현 기능이 아니다. | `preserves an incoming review winner and both legacy settings branches without inferring edit order`로 명확히 하고, 활성 설정 전체(.9)와 보관 설정 전체(.8), 전체 리뷰와 보관 이력, 역순 수렴, 반복 전달, 입력 참조 분리를 검사. 단독·파일 전체·전체 스위트 통과. |
| `vault-audit.test.ts` / `read-only vault compatibility audit` / `parses every question callout without empty prompts, answers, or diagnostics` | `MIA_AUDIT_VAULT` 미지정 시 `describe.skipIf(!vaultPath)`로 건너뜀. 단독 파일·수정 전 전체에서 동일. 외부 보관함 지정에 의존하는 선택적 환경 검사이며 미구현 기능이 아니다. | `MIA_AUDIT_VAULT=tests/fixtures/vault`로 저장소 합성 보관함을 지정. 이 검사만 선택한 실행, 파일 전체, 전체 스위트에서 통과. 빈 질문·답안·파서 진단 검증을 유지. |
| 같은 파일·그룹 / `round-trips dummy metadata for every question entirely in memory` | 동일 환경 조건. 파일을 읽은 뒤 메모리 안에서 등록 또는 메타데이터 갱신을 하고 질문·답안 보존을 검증하는 감사. | 같은 합성 보관함 지정으로 이 검사만 선택한 실행, 파일 전체, 전체 스위트에서 통과. 실제 파일 쓰기는 하지 않음. |

기대값 수정의 근거는 `README.md`의 설정 계보·보관 사본 계약, `MULTI-DEVICE-SYNC-QA.md`의 ‘데이터·구현 범위’, `docs/releases/1.3.5.md`다. 기준을 모르는 이전 설정은 인과를 추정하거나 도착 순서대로 덮지 않고 두 전체 사본을 보존한다. 활성값은 결정적 분기 ID 순서로 수렴시키며 최신값이라는 의미가 아니다. `10e2ff2`에서 도입한 이 계약을 기존 owned-buffer 테스트가 반영하지 못했다.

단순히 .8을 .9로 바꾸는 데 그치지 않았다. 추가한 `applies a known incoming settings descendant even when its id sorts before the ancestor`는 명시된 후속 변경은 ID 정렬보다 우선해 .8을 활성화하고 불필요한 충돌을 만들지 않음을 양방향으로 검사한다. 기존 assertion 삭제·약화, timeout 증가, 새 skip은 없다.

## 최종 검사

| 실행 | 통과 | 실패 | 건너뜀 |
| --- | ---: | ---: | ---: |
| 수정 전 전체, 감사 환경 미지정 | 1,249 | 1 | 2 |
| 수정 후 owned-merge 파일 전체 | 11 | 0 | 0 |
| 감사 파일 전체, 합성 보관함 지정 | 2 | 0 | 0 |
| 수정 후 전체, 합성 보관함 지정 (75파일) | 1,253 | 0 | 0 |

합계가 1 증가한 것은 알려진 설정 후속 계보 검사 1개를 추가했기 때문이다. `-t` 단독 실행에서 선택되지 않은 다른 검사는 통과로 집계하지 않았다. 전체 최종 결과는 필터 없는 실행이며 1,253개가 실제 실행됐다.

```sh
NODE_PATH=../simple-study-flow-qa-2026-10-27/test-runtime/node_modules \
MIA_AUDIT_VAULT=tests/fixtures/vault npm test \
  -- --reporter=json --outputFile=../remaining-tests-qa-2026-10-27/after-full.json
npx tsc --noEmit
npm run build
git diff --check
```

모든 명령은 프로젝트 루트에서 실행했다. 타입 검사·프로덕션 빌드·diff 공백 검사 통과. 로컬 node_modules에 jsdom이 없어 기존 성능 검사와 동일하게 이미 있는 격리 runtime을 NODE_PATH로 지정했다. 의존성을 설치·변경하지 않았다.

전체 검사에는 기존 목록 페이지·마지막 항목 검색·전체 대상 선택·IME·느린 이전 Markdown 완료·렌더 자원 해제와 저장 실패·복구·다기기 분기·미완료 저장 보호 검사가 포함돼 통과했다. 제품 코드를 변경하지 않았고 재빌드한 `main.js`는 기존 `../performance-qa-2026-10-27/after-main.js`와 SHA-256이 같다: `a5d66445faf5a544c2f2f1fd6ef28cc888ca5af30fcb67eb66317134811a78b7`. 실제 앱에서 실행될 제품은 이전 성능 검증 제품과 동일하다. 이번에는 Obsidian 수동 검증이나 전체 성능 측정을 반복하지 않았다. 기존 실제 앱 결과는 `PERFORMANCE-QA.md` 범위 안에서만 유효하다.

## 남은 실행 조건·한계

- 일반 `npm test`에서 `MIA_AUDIT_VAULT`를 생략하면 감사 2개가 의도적으로 건너뛰어진다. 이번에는 조건을 충족해 두 검사 모두 실행했다. 외부 보관함을 자동 선택하도록 테스트를 바꾸지 않았다. README에 합성 보관함을 포함한 전체 검사 명령을 추가했다.
- 합성 보관함의 통과는 실제 사용자 보관함 호환성 통과를 뜻하지 않는다. 특정 보관함을 감사하려면 그 경로를 환경 변수로 명시해야 한다. 이번 요청의 실제 자료 보호 범위에 따라 실행하지 않았다.
- 기존의 모바일·실제 두 기기 동기화 등 미검증 범위는 그대로다. 이 항목들은 이번 건너뜀 2개의 원인이 아니다.

원시 실행 근거는 소스 저장소 밖 `../remaining-tests-qa-2026-10-27/`에 보존했다: `before-full.json/log`, `before-owned.log`, `audit-unset.log`, `audit-alone.log`, `audit-parse-alone.log`, `audit-roundtrip-alone.log`, `after-owned.log`, `after-legacy-alone.log`, `after-descendant-alone.log`, `after-full.json/log`, `typecheck.log`, `build.log`.
