# 정책 안내·저장 겹침·설치 후보 후속 검증

2026-10-27. 기존 계산 감사와 실제 앱 감사 이후의 변경만 검증했다. 알고리즘은 **ts-fsrs 5.4.1 / FSRS-6** 그대로다. 원격 푸시·태그·릴리스 게시는 수행하지 않았다. 개인 보관함에 후보를 설치하거나 평가·편집하지 않았고 OS 시간·동기화 설정을 바꾸지 않았다.

## 완료 체크리스트

- [x] 단계 설정에 맞는 Hard 안내, 24시간 이상 단계의 Review 전환 안내, 통계와 하루 예산 차이를 실제 화면에 반영
- [x] 저장 지연·외부 파일 변경의 재현 실패를 먼저 확보하고 최소 수정 후 재검증
- [x] 관련 자동 검사 15개 파일 **450개 통과**, 실패·건너뜀 0
- [x] 타입 검사와 프로덕션 빌드, diff 공백 검사 통과
- [x] 320×740 / 390×844 / 768×950 화면 크기 검사, 최종 후보 390px 재확인
- [x] 후보 ZIP 생성·원본/ZIP/설치 파일 동일성 확인·실제 Obsidian 평가 저장 및 프로세스 재실행
- [x] 실기기·실제 동기화 미검증 항목과 5~10분 점검표 제공

**배포 준비 작업 완료. 모든 환경 검증 완료를 뜻하지 않는다.** 확인한 데스크톱 단일 기기 사용을 막는 재현 오류는 남지 않았다. 다기기 동시 쓰기의 보편적 무손실을 보장하는 정식 승인은 아래 남은 위험에 대한 실제 기기 점검과 정책 결정이 필요하다.

## 이번 수정

1. `src/ui/study-policy.ts`의 안내를 설정·조작 도움말·대시보드·학습현황에 연결했다. 자동 단계 기본 `1m 10m`에서 Hard는 두 번째 단계에서도 6분, `2m 20m`이면 11분이다. 고정 Hard 간격이 있으면 자동 6분을 약속하지 않는다. 선택될 단계 또는 계산된 Hard가 24시간 이상이면 Review 전환·일반 복습 한도를 설명한다. UI의 문구만 보완했으며 간격 계산을 바꾸지 않았다.
2. 외부 설정의 sourceRoots/keywordFolder는 바뀌었는데 문제 목록이 이전 폴더에 머물렀다. `synchronizeStudyData()`에서 동기화 전후 경로를 비교하고 달라진 경우 인덱스를 재구축한다. 외부 설정 알림과 복귀/기록 새로고침 경로가 같은 함수를 사용한다. 실패 회귀 로그: `before-root-refresh.log`.
3. 저장이 진행 중일 때 외부 기록 알림의 읽기가 저장 뒤로 밀려, 도착한 다른 문제의 기록을 읽기 전에 로컬 쓰기가 덮을 수 있었다. `MiaDataStore.synchronize()`가 쓰기 진행 중 알림을 받으면 즉시 유효 파일 관찰을 시작하고, 직렬 저장 완료 후 그 관찰본과 최신 파일을 **기존** 문제별 병합 규칙으로 합친다. 새 엔진·이력 합산 규칙을 만들지 않았다. 읽기 실패는 오류로 전달하고 재시도할 수 있다. 실패 회귀 로그: `before-pending-delivery.log`; 독립 실행 전후: `race-diagnostic-before.json` / `race-diagnostic.json`.

두 버그 모두 특정 외부 변경/저장 겹침 조건에서 발생한다. 특히 3번은 실제 기록 손실 위험이 있어 수정했다. 일반 평가 자체의 FSRS 계산 문제로 분류하지 않는다.

## 검증 구분과 결과

| 범위 | 기대와 관찰 결과 | 근거 |
| --- | --- | --- |
| 관련 자동 검사 | 평가 직후 이동·중복 입력·실패 저장, 오래된 세션, 외부 문제 변경, 설정 변경, 다른 문제 및 같은 문제의 평가 겹침, 손상 파일, 복구·재시도 등을 검증. 450 통과 | `final-tests.json` / 아래 실행 명령 |
| 종료 자동 검사 | 별도 자식 프로세스를 종료하고 실제 임시 파일에서 복원. 모바일 OS 종료로 해석하지 않음 | `tests/crash-storage.test.js` 포함 |
| 화면 크기 검사 | 고급 설정 안내 기본6/15분, 수정2m/20m→11분, 일 단위 경고, 취소·도움말·통계 확인. 모달 client/scroll 폭 각각296/296,366/366,744/744. 콘솔 오류 없음 | `responsive-results.json`, narrow/phone/fold PNG |
| 최종 후보 UI | ZIP과 동일한 최종 main/styles로 390px 재실행. 6분/15분 안내, body scrollWidth=390 | `phone-final-candidate.png` |
| 실제 Obsidian 설치 | macOS Obsidian1.14.5, ZIP의 세 파일 SHA-256 일치 | `native-final-evidence/first.json` |
| 실제 버튼→저장 | 새 문제 Again 1회→Learning·due-last_review=60000ms·reps/history1. 메모리와 실제 data.json 동일 | first.json |
| 플러그인 재활성화 | disable/enable 뒤 전체 평가 객체 동일 | first.json |
| 실제 외부 설정 | 테스트 파일의 sourceRoots를 Remote로 변경→실제 인덱스가 remote 문제1개로 전환, 원래 설정 복원 | first.json |
| 실제 저장 겹침 | 실제 호스트 쓰기1회를 지연. 유효 peer 파일 주입+외부 알림 중 WorkspaceLeaf를 닫음→local/peer 둘 다 보존, 로컬 history1, 파일/메모리 일치 | first.json |
| 실제 앱 종료/재실행 | macOS Quit 및 프로세스 종료 확인→전체 리뷰·설정·저장 체크포인트 동일, 실제 이어하기가 저장 seed/mode 사용 | `candidate-process-exit.json`, `native-final-evidence/restart.json` |
| 도구 해제 후 일반 실행 | 검증 도구·시계 모두 비활성화 후 다시 실행, 저장 세션 및 새 통계 안내 표시 | `candidate-native-restored.png` |

실제 앱은 로컬 전용 `scheduler-native-qa-2026-10-27/MIA-Native-Scheduler-QA`를 재사용했다. 후보 전 플러그인·자료는 `native-before-candidate`에 백업했다. 테스트용 가상 문제3개와 Remote 문제1개만 추가했다. 이번 후보 검사는 **Date를 교체하지 않았다.** 이전 감사의 미래 날짜 카드·이어하기 fixture가 남아 있으므로 표기 날짜는 실제 시간이 흘렀다는 증거가 아니다. 원래 미래 갱신시각의 체크포인트가 더 최신으로 판정되어 그대로 보존되는 것도 확인했다.

별도 `mia-candidate-check` 도구가 실제 설치된 뷰 버튼에 click/input을 전달하고 실제 Obsidian 저장 어댑터를 사용했다. 범위 시작은 startReview, 외부 전달은 합성 파일을 실제 디스크에 쓴 뒤 실제 알림 진입점을 호출했다. 모든 버튼을 사람이 직접 누른 검사나 실제 iCloud 전달 검사라고 부르지 않는다. 프로덕션 번들에 도구를 넣지 않았고 끝에는 community-plugins가 mia-study 하나다. 도구 소스와 증거를 출력 폴더에 보존했다.

도구 자체의 두 잘못된 가정도 보존했다: 해시 객체의 키 순서를 문자열 비교한 실패, 저장 baseline 대신 새 문제 seed를 기대한 실패. 각각 키별 해시/저장 baseline으로 비교한 뒤 통과했다. 제품 오류로 세지 않는다(`harness-order-*`, `harness-resume-*`). 최종 first10개/restart6개 항목 모두 pass이며 ERROR 파일 없음.

기존 `SCHEDULER-NATIVE-QA.md`의 Good 학습 졸업, 재학습, 편집 후 기록 보존, 간편/고급 제한 및 04:00 한도 우회 fixture는 재사용 근거다. 이번에는 후보 설치·저장·복원을 좁게 재검증했으며 전체 장기 시뮬레이션과 모든 날짜 fixture를 다시 실행하지 않았다. 실제 기억 유지 효과 검증은 아니다.

## 정책 및 남은 제품 결정

| 대상 | 현재 처리 | 영향·권장안 |
| --- | --- | --- |
| 두 번째 단계 Hard / 일 단위 단계 | 고정된 상위 버전의 기본 전략. 기본1m/10m의 Hard6분, >=1440분 선택은 Review | `SCHEDULER-POLICIES.md`에 코드·예시·이력 근거. 현재 안내 유지 권장. Anki 단계 호환/장기 학습 단계는 별도 요구 결정 |
| 대시보드 vs 예산 | 오늘 평가=마지막 평가일이 달력상 오늘인 고유 문제. 오늘 복습=한도 전 기한 도래 전체. 예산은 설정한 학습일 경계 | 계산 유지, 접히는 안내 추가. 통계 자체를 학습일로 통일할지는 별도 결정 |
| 같은 문제 동시 평가 | 문제별 수정 버전(시간+UUID)으로 활성 기록 선택. 갈라진 이력은 reviewConflicts로 별도 보관, FSRS 이력 자동 합산 안 함 | ‘보관된 평가 확인’은 읽기 전용. 사용자가 활성 이력을 선택·복원하는 기능은 없음. 기기 시계와 실제 전송 순서 점검 후 별도 복구 UX 결정 권장 |
| 질문 동시 편집 | 저장 직전 원본 불일치 시 오래된 편집 거부 | 자동 원문 병합/서비스 충돌 사본 해소 없음 |
| 설정 동시 변경 | 최신으로 읽은 파일의 설정 적용, 필드별 버전 병합 없음 | 동시 변경 시 설정 덮임 위험. 평가 기록 보호와 구별. 단일 기기에서 설정 변경 후 전달 완료를 확인하는 운영 권장 |
| 이어하기 | 파일 시각과 기기 로컬 체크포인트 비교, 더 최신 위치 보호 | 시계 차이/미래 fixture에 영향. 오래된 큐는 진행 위치 스냅샷이며 새 예산의 재선택이 아님 |
| 관찰 전 파일 덮임 | 앱이 읽은 유효 파일의 평가 겹침은 보완. 서비스가 앱 통지/읽기 전에 덮어쓴 파일의 분산 원자성은 없음 | 특정 다기기 동시 쓰기의 기록 손실 가능성을 배제 못 함. 실제 iCloud/Sync 동시 오프라인 평가·복귀와 복구를 정식 다기기 안전성 승인 전 확인 |

기존 규칙의 근거는 `src/core/review-sync.ts`, `src/services/study-ui-store.ts`, `src/core/question-writer.ts / src/core/managed-question.ts`와 해당 회귀 검사다. 이번 범위에서 사용자에게 없는 ‘충돌 해결 버튼’을 안내하지 않았다.

실기기 iOS/Android, 키보드·백그라운드 강제 종료, 실제 iCloud/Obsidian Sync 두 기기 전달은 접근 가능한 안전한 환경이 없어 미검증이다. Windows/Linux와 최소 지원 Obsidian1.8.7도 미검증이다. 기본 데스크톱 사용 중단 사유로 확인되지는 않았으나, 모든 환경 및 동시 쓰기 안전성 보증의 근거로 삼을 수 없다. `MOBILE-SYNC-CHECK.md`의5~10분 절차를 별도 테스트 보관함에서 실행한다.

## 후보와 재현

공개 최신은 확인 시점1.3.4, 작업본/manifest는1.3.5다. 공개/기존 로컬 파일을 덮지 않고 `mia-study-unreleased-1daf75c59db7.zip`을 새 폴더에 만들었다. build ID는 후보 식별값이며 Git 커밋 ID로 해석하지 않는다. 패키지 메타데이터와 버전 승인 후 정식 게시가 필요하다.

후보 위치: `/Users/choikang/Desktop/전공/policy-sync-candidate-2026-10-27/candidate`.
ZIP에는 main.js·manifest.json·styles.css만 있다. 원본 빌드=ZIP=실제 설치 바이트를 비교했다. ZIP SHA-256: `3ec128fa79ca91921f410de7797008d95e7acc5d43c71df95411bf2f43da3a3f`. 세 파일 및 패키지 동봉 문서 해시는 SHA256SUMS, 후속 검증 문서는 VERIFICATION-SHA256SUMS로 구분한다.

```sh
npx vitest run tests/study-policy.test.ts tests/simple-study-settings.test.js tests/plugin-lifetime.test.js tests/storage-integrity.test.js tests/sync-refresh.test.js tests/data-store.test.ts tests/verified-plugin-storage.test.js tests/study-ui-store.test.js tests/question-index.test.ts tests/review-sync.test.ts tests/portable-study-storage.test.ts tests/crash-storage.test.js tests/study-session.test.js tests/file-mutations.test.js tests/ui-modals.test.js
npm run build
git diff --check
```

전체 Vitest 중첩 suite 수가 아니라 결과 파일의 testResults15개와 numPassedTests450을 집계했다. 기존 대규모1218개 검사 반복으로 보고하지 않는다. 네이티브 도구는 이 가상 보관함 이름에서만 실행되며 first 단계는 깨끗한 전용 가상 문제를 필요로 한다. 기존 기록이 있는 보관함에서 무작정 다시 실행하지 않는다.

## 다기기 유실 위험 후속

위 내용은 이전 후보의 결과다. 이후 설정 분기·미완료 저장 보호를 수정하고400개 관련 검사와 실제 앱 재실행/복구를 확인했다. 현재 보호 범위와 남은 무관찰 덮임은 [다기기 유실 검증](MULTI-DEVICE-SYNC-QA.md)을 따른다. 이전 ZIP은 갱신하지 않았다.
