import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";

// Only Obsidian's UI boundary is replaced; the view, timers and FSRS are real.
vi.mock("obsidian", () => {
  class Element {
    children = []; handlers = new Map(); text = ""; disabled = false;
    style = { setProperty() {} }; dataset = {};
    constructor(options = {}) { this.text = options.text ?? ""; }
    createEl(tag, options = {}) { const child = new Element(options); child.tag = tag; this.children.push(child); return child; }
    createDiv(options) { return this.createEl("div", options); }
    createSpan(options) { return this.createEl("span", options); }
    empty() { this.children = []; }
    addClass() {} removeClass() {} setAttr() {}
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    get content() { return [this.text, ...this.children.map(child => child.content)].join(" "); }
    find(text) { return this.children.flatMap(child => [child, child.find(text)]).find(child => child && child.tag === "button" && child.content.trim().startsWith(text)); }
    async click() { if (!this.disabled) await this.handlers.get("click")?.(); }
  }
  return {
    ItemView: class { constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = new Element(); } },
    Component: class { load() {} unload() {} },
    Modal: class { open() {} }, Notice: class {}, Platform: { isMobile: false },
    MarkdownRenderer: { render: async (_app, text, element) => { element.text = text; } },
  };
});
import { MiaStudyView } from "../src/ui/study-view";

function setup({ failSave = false } = {}) {
  const question = { id: "q", heading: "질문", questionMarkdown: "질문", answerMarkdown: "정답", subject: "과목", questionType: "정의형", filePath: "bank.md", coreKeywords: [], subKeywords: [], followUpIds: [] };
  const reviews = {};
  const plugin = {
    fsrs: new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 }),
    index: { registered: [question], questionById: id => id === "q" ? question : undefined },
    store: {
      reviews, getReview: id => reviews[id],
      setReview: async (id, state) => { if (failSave) throw Error("disk full"); reviews[id] = state; },
      removeReview: async id => { delete reviews[id]; },
    },
  };
  let view;
  const leaf = { app: { workspace: { requestSaveLayout() {} } }, setViewState: async ({ state }) => view.setState(state, {}) };
  view = new MiaStudyView(leaf, plugin);
  view.startReview(["q"]);
  return { view, reviews, button: text => view.contentEl.find(text), content: () => view.contentEl.content };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("study view scheduling integration", () => {
  it("waits after Again, automatically hides the answer on reappearance, accumulates Good and undoes just that attempt", async () => {
    const ui = setup();
    await ui.button("정답 보기").click();
    await ui.button("못 암기").click();
    expect(ui.content()).toContain("다음 복습 대기 중");
    expect(ui.reviews.q.history).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(ui.content()).toContain("다음 복습 대기 중");
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.content()).toContain("2 / 2");
    expect(ui.button("정답 보기")).toBeDefined();
    await ui.button("정답 보기").click();
    await ui.button("암기").click();
    expect(ui.reviews.q.history.map(log => log.rating)).toEqual([Rating.Again, Rating.Good]);
    expect(ui.content()).toContain("다음 복습 대기 중");
    await ui.button("직전 평가 취소").click();
    expect(ui.reviews.q.history.map(log => log.rating)).toEqual([Rating.Again]);
    expect(ui.view.getState().queueIndex).toBe(1);
  });

  it("replacing the same appearance replaces its rating rather than adding another repetition", async () => {
    const ui = setup();
    await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    await ui.button("직전 평가 취소").click();
    expect(ui.reviews.q).toBeUndefined();
    await ui.button("너무 쉬움").click();
    expect(ui.reviews.q.history).toHaveLength(1);
    expect(ui.reviews.q.lastRating).toBe(Rating.Easy);
    expect(ui.content()).toContain("학습 완료");
    expect(ui.content()).not.toContain("다음 복습 대기 중");
  });

  it("keeps the current card and enables retry when saving fails", async () => {
    const ui = setup({ failSave: true });
    await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.reviews.q).toBeUndefined();
    expect(ui.button("못 암기").disabled).toBe(false);
  });

  it("drops a stale repeat after undoing it and correcting the first grade", async () => {
    const ui = setup();
    await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    await vi.advanceTimersByTimeAsync(60_000);
    await ui.button("정답 보기").click(); await ui.button("암기").click();
    await ui.button("직전 평가 취소").click();
    await ui.button("← 이전 문제").click(); await ui.button("너무 쉬움").click();
    expect(ui.reviews.q.history).toHaveLength(1);
    expect(ui.content()).toContain("학습 완료");
    expect(ui.view.getState().queue).toEqual(["q"]);
    await ui.button("직전 평가 취소").click();
    expect(ui.reviews.q).toBeUndefined();
  });
});
