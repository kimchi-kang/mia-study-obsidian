# 출처와 감사

MIA Study를 만들면서 쓰거나 참고한 알고리즘, 라이브러리, 도구입니다. 저작권 표시 의무가 없는 것도 출처를 밝혀 둡니다. 함께 배포되는 라이브러리의 라이선스 전문은 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)에 있습니다. MIA Study 자체는 [MIT 라이선스](LICENSE)입니다.

## 복습 알고리즘

- **FSRS (Free Spaced Repetition Scheduler)** — Jarrett Ye와 [Open Spaced Repetition](https://github.com/open-spaced-repetition) 커뮤니티가 만든 간격 반복 알고리즘입니다. MIA는 FSRS-6과 그 기본 가중치 21개를 씁니다.
  - Junyao Ye (Jarrett Ye), Jingyong Su, Yilong Cao. *A Stochastic Shortest Path Algorithm for Optimizing Spaced Repetition Scheduling.* KDD 2022. [doi:10.1145/3534678.3539081](https://doi.org/10.1145/3534678.3539081)
  - Jingyong Su, Junyao Ye, Liqiang Nie, Yilong Cao, Yongyong Chen. *Optimizing Spaced Repetition Schedule by Capturing the Dynamics of Memory.* IEEE TKDE, 2023. [doi:10.1109/TKDE.2023.3251721](https://doi.org/10.1109/TKDE.2023.3251721)
  - 알고리즘 설명: [FSRS 위키](https://github.com/open-spaced-repetition/fsrs4anki/wiki)
- **[ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)** (MIT) — 복습일 계산에 그대로 쓰는 FSRS TypeScript 구현입니다. 플러그인에 포함됩니다.
- **[fsrs-rs](https://github.com/open-spaced-repetition/fsrs-rs)** (BSD-3-Clause) — 1.4.19의 "내 기록으로 최적화"는 fsrs-rs의 FSRS-6 학습 절차(사전학습, 데이터 걸러내기, 손실 함수, 매개변수 범위)를 따라 TypeScript로 다시 구현했습니다. 코드를 그대로 복사하지는 않았고, 라이선스 고지는 THIRD-PARTY-NOTICES.txt에 실었습니다.
- **[@open-spaced-repetition/binding](https://github.com/open-spaced-repetition/ts-fsrs)** (MIT) — 최적화 결과를 fsrs-rs와 비교하는 테스트에만 씁니다. 플러그인에는 포함되지 않습니다.

## 참고한 앱

- **[Anki](https://apps.ankiweb.net/)** (AGPL-3.0-or-later, Ankitects) — 학습 단계, 오전 4시 하루 경계, 하루 한도, 출제 순서, 미리 학습 같은 설정 이름과 기본값, 동작을 참고했습니다. Anki 코드는 쓰지 않았습니다. 대응표는 [docs/ANKI-SETTINGS.md](docs/ANKI-SETTINGS.md)에 있습니다.
- MIA Study는 Anki, Ankitects, Obsidian, Open Spaced Repetition과 관계없는 개인 프로젝트입니다. 각 이름은 해당 소유자의 것입니다.

## 플러그인에 포함된 라이브러리

전체 목록과 라이선스 전문은 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)에 있습니다. 주요 라이브러리는 다음과 같습니다.

- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (MIT) — 복습 일정
- [markdown-it](https://github.com/markdown-it/markdown-it) (MIT) — 링크 확인과 Word 내보내기용 Markdown 해석
- [docx](https://github.com/dolanmiu/docx) (MIT) — Word 정리본 생성. 함께 들어가는 [JSZip](https://github.com/Stuk/jszip)(MIT 선택)과 [pako](https://github.com/nodeca/pako)(MIT, zlib) 포함

## 플랫폼

- **[Obsidian](https://obsidian.md/)** — 플러그인 API와 화면, Markdown·수식(MathJax) 렌더링은 Obsidian이 제공합니다.

## 소개 페이지

- 글꼴 **[Black Han Sans](https://fonts.google.com/specimen/Black+Han+Sans)** (Zess Type, SIL Open Font License 1.1) — Google Fonts에서 불러옵니다.
- 빨강·노랑·파랑과 두꺼운 테두리의 디자인은 바우하우스 양식에서 영감을 받았습니다.

## 개발 도구

- 코드와 문서 대부분을 AI 코딩 도구 **Claude Code**(Anthropic)와 **Codex**(OpenAI)로 작성했습니다. 그래서 안정성을 보장하지 않습니다. 원본 파일은 꼭 보관함 밖의 다른 장소에 백업하세요.
- 테스트와 빌드: [Vitest](https://vitest.dev/), [esbuild](https://esbuild.github.io/), [TypeScript](https://www.typescriptlang.org/), [jsdom](https://github.com/jsdom/jsdom), [PostCSS](https://postcss.org/)
