import { describe, expect, it } from "vitest";
import { fencedCodeLines } from "../src/core/markdown-structure";
import { FsrsService } from "../src/core/fsrs-service";
import { Rating } from "ts-fsrs";

describe("코드 펜스 판별", () => {
  it("한 줄짜리 ```코드```는 펜스를 열지 않아 뒤 줄을 가리지 않는다", () => {
    expect(fencedCodeLines(["```인라인 코드```", "### 다음 문제", "본문"])).toEqual([false, false, false]);
  });

  it("정보 문자열이 있는 펜스와 물결 펜스는 그대로 연다", () => {
    expect(fencedCodeLines(["```ts", "const a = 1;", "```", "밖"])).toEqual([true, true, true, false]);
    expect(fencedCodeLines(["~~~ `괜찮음`", "안", "~~~", "밖"])).toEqual([true, true, true, false]);
  });
});

describe("손상·시계 차이 카드 방어", () => {
  const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
  const reviewedAt = new Date("2026-03-10T12:00:00Z");
  const reviewed = fsrs.rate(undefined, Rating.Good, reviewedAt, "q");

  it("다른 기기의 시계가 빨라 직전 평가가 미래에 있어도 미리보기가 오류 없이 나온다", () => {
    const before = new Date(reviewedAt.getTime() - 60 * 60 * 1000);
    const preview = fsrs.preview(reviewed, before, "q");
    expect(preview).toHaveLength(4);
    for (const item of preview) expect(Number.isFinite(item.due.getTime())).toBe(true);
    // 평가 자체는 여전히 막는다.
    expect(() => fsrs.rate(reviewed, Rating.Good, before, "q")).toThrow();
  });

  it("마지막 평가가 없거나 안정도가 0인 손상 카드의 기억률은 NaN·예외 대신 알 수 없음(null)", () => {
    const missing = { ...reviewed, card: { ...reviewed.card, last_review: undefined } };
    expect(fsrs.retrievability(missing as unknown as typeof reviewed, reviewedAt)).toBeNull();
    const zero = { ...reviewed, card: { ...reviewed.card, stability: 0 } };
    const value = fsrs.retrievability(zero, reviewedAt);
    expect(value === null || Number.isFinite(value)).toBe(true);
  });

  it("정상 카드의 기억률 계산은 그대로다", () => {
    const later = new Date(reviewedAt.getTime() + 3 * 86_400_000);
    const value = fsrs.retrievability(reviewed, later);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });
});

import { mergeSettings } from "../src/core/settings-sync";
import { DEFAULT_SETTINGS, type MiaPluginData } from "../src/core/models";
import { normalizeQuestionHeadingLevel } from "../src/core/managed-question";

describe("설정 충돌: 옛 형식(legacy) 설정과 식별된 편집", () => {
  const legacy = { settings: { ...structuredClone(DEFAULT_SETTINGS), maximumIntervalDays: 36500 } };
  const edited = {
    settings: { ...structuredClone(DEFAULT_SETTINGS), maximumIntervalDays: 180 },
    settingsSync: { id: "0f3a6c1e-0000-4000-8000-000000000000", ancestors: [], conflicts: [] },
  };
  it.each([["로컬이 옛 형식", legacy, edited], ["상대가 옛 형식", edited, legacy]])("%s이어도 식별된 편집이 활성으로 남고 옛 설정은 충돌 목록에 보관된다", (_, local, incoming) => {
    const next = structuredClone(local) as unknown as MiaPluginData;
    mergeSettings(local as unknown as MiaPluginData, incoming as unknown as MiaPluginData, next);
    expect(next.settings.maximumIntervalDays).toBe(180);
    expect(next.settingsSync?.id).toBe(edited.settingsSync.id);
    expect(next.settingsSync?.conflicts.map(item => item.settings.maximumIntervalDays)).toEqual([36500]);
  });
});

describe("문제 이동 시 제목 수준", () => {
  it("## 문제를 ###로 맞추고 안쪽 제목도 같은 만큼 내려 중첩을 지킨다(코드 안 #은 그대로)", () => {
    const block = ["## 지형이란?", "> [!question] 문제", "#### 참고", "```", "## 코드 속 주석", "```", "^mia-q-abc"].join("\n");
    expect(normalizeQuestionHeadingLevel(block).split("\n")).toEqual(["### 지형이란?", "> [!question] 문제", "##### 참고", "```", "## 코드 속 주석", "```", "^mia-q-abc"]);
  });
  it("이미 ###이면 그대로, ######를 넘게 되면 바꾸지 않는다", () => {
    expect(normalizeQuestionHeadingLevel("### 질문\n본문")).toBe("### 질문\n본문");
    expect(normalizeQuestionHeadingLevel("# 질문\n##### 깊은 제목")).toBe("# 질문\n##### 깊은 제목");
    expect(normalizeQuestionHeadingLevel("#### 질문\n##### 안")).toBe("### 질문\n#### 안");
  });
});

import { readFileSync } from "node:fs";
import { MiaDataStore } from "../src/services/data-store";

describe("모바일 창 규칙", () => {
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  it("휴대폰 상세 창의 전체 화면 높이를 내용 높이 규칙이 덮지 않는다", () => {
    const shared = styles.match(/\.is-phone \.mia-detail-modal,\s*\.is-phone \.mia-result-modal,\s*\.is-phone \.mia-keyboard-modal \{([^}]*)\}/);
    expect(shared?.[1]).toBeDefined();
    expect(shared![1]).not.toMatch(/height:\s*auto/);
    expect(styles).toMatch(/\.is-phone \.mia-result-modal,\s*\.is-phone \.mia-keyboard-modal \{ height: auto !important; \}/);
  });
  it("Word 출력 창도 모바일 안전 영역·높이 상한·내부 스크롤 규칙을 받는다", () => {
    expect(styles).toContain(".is-mobile .modal-container:not(.mia-keyboard-open):has(> :is(.mia-appearance-modal, .mia-controls-modal, .mia-preview-modal, .mia-detail-modal, .mia-result-modal, .mia-keyboard-modal, .mia-export-modal))");
    expect(styles).toContain(".is-mobile .modal-container:not(.mia-keyboard-open) > :is(.mia-appearance-modal, .mia-controls-modal, .mia-preview-modal, .mia-detail-modal, .mia-result-modal, .mia-keyboard-modal, .mia-export-modal)");
    expect(styles).toContain(".is-mobile :is(.mia-appearance-modal, .mia-controls-modal, .mia-preview-modal, .mia-detail-modal, .mia-result-modal, .mia-export-modal) .modal-content");
  });
});

describe("저장 대기열 독점 실행", () => {
  it("진행 중 저장이 끝난 뒤 실행하고, 그동안 들어온 저장은 끝날 때까지 기다린다", async () => {
    let disk: unknown = null;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstSave = new Promise<void>(resolve => { releaseFirst = resolve; });
    let saves = 0;
    const store = new MiaDataStore({
      loadData: async () => structuredClone(disk),
      saveData: async data => { saves += 1; if (saves === 1) await firstSave; order.push(`save${saves}`); disk = structuredClone(data); },
    });
    await store.load();
    const first = store.updateSettings({ targetRetention: 0.85 });
    const exclusive = store.exclusive(async () => { order.push("exclusive"); });
    const second = store.updateSettings({ maximumIntervalDays: 300 });
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, exclusive, second]);
    expect(order).toEqual(["save1", "exclusive", "save2"]);
  });
});
