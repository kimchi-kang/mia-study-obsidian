import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { QuestionIndex } from "../src/services/question-index";

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
    setText(text) { this.text = text; }
    addClass() {} removeClass() {} setAttr() {} focus() {}
    querySelector() { return null; }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    get content() { return [this.text, ...this.children.map(child => child.content)].join(" "); }
    find(text, exact = false) { return this.children.flatMap(child => [child, child.find(text, exact)]).find(child => child && child.tag === "button" && (exact ? child.content.trim() === text : child.content.trim().startsWith(text))); }
    async click() { if (!this.disabled) await this.handlers.get("click")?.(); }
  }
  return {
    ItemView: class { constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = new Element(); } },
    Component: class { load() {} unload() {} },
    Modal: class { setTitle() {} open = vi.fn(); close = vi.fn(); }, Notice: class {}, Platform: { isMobile: false },
    MarkdownRenderer: { render: async (_app, text, element) => { element.text = text; } },
  };
});
import { StudyUiStore } from "../src/services/study-ui-store";
import { MiaStudyView } from "../src/ui/study-view";
import { MiaDataStore } from "../src/services/data-store";
import { buildReviewQueue } from "../src/core/recommendation-engine";
import { calculateProgress } from "../src/core/progress";

function setup({ failSave = false, start = true, linked = false } = {}) {
  const question = { id: "q", heading: "질문", questionMarkdown: "질문", answerMarkdown: "정답", subject: "과목", questionType: "정의형", filePath: "bank.md", coreKeywords: [], subKeywords: [], followUpIds: [] };
  const reviews = {};
  const questions = linked ? [{ ...question, followUpIds: ["related"] }, { ...question, id: "related", heading: "꼬리질문" }] : [question];
  const files = new Map();
  const studyApp = { loadLocalStorage: () => null, saveLocalStorage() {}, vault: { adapter: { exists: async path => files.has(path), read: async path => files.get(path), write: async (path, data) => { files.set(path, data); } } } };
  const plugin = {
    studyUi: new StudyUiStore(studyApp, "ui-state.json"),
    openQuestionPreview: vi.fn().mockResolvedValue(undefined),
    listSubjects: () => [],
    fsrs: new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 }),
    index: { diagnostics: [], candidates: [], isReady: true, registered: questions, questionById: id => questions.find(item => item.id === id) },
    store: {
      reviews, getReview: id => reviews[id],
      setReview: async (id, state) => { if (failSave) throw Error("disk full"); reviews[id] = state; },
      removeReview: async id => { delete reviews[id]; },
    },
  };
  let view;
  const leaf = { app: { workspace: { requestSaveLayout() {} } }, setViewState: async ({ state }) => view.setState(state, {}) };
  view = new MiaStudyView(leaf, plugin);
  if (start) view.startReview(["q"]);
  return { view, plugin, reviews, files, studyApp, button: text => view.contentEl.find(text), exactButton: text => view.contentEl.find(text, true), content: () => view.contentEl.content };
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("study view scheduling integration", () => {
  it.each([
    ["시험 모드 시작", "recall", false], ["전체 암기 모드", "browse", false],
    ["시험", "recall", true], ["암기", "browse", true],
  ])("uses due-first randomized eligibility from %s", async (label, mode, subjectOnly) => {
    const ui = setup({ start: false }); const template = ui.plugin.index.registered[0];
    const ids = ["new-a", "due-a", "future", "due-b", "new-b", "other"];
    ui.plugin.index.registered.splice(0, 1, ...ids.map(id => ({ ...template, id, heading: id, subject: id === "other" ? "다른 과목" : "과목" })));
    const mature = ui.plugin.fsrs.rate(undefined, Rating.Easy, new Date(Date.now() - 30 * 86_400_000));
    for (const id of ["due-a", "due-b"]) ui.reviews[id] = structuredClone(mature);
    ui.reviews.future = ui.plugin.fsrs.rate(undefined, Rating.Easy);
    Math.random.mockReturnValue(0);
    ui.view.showDashboard(); await ui.exactButton(label).click();
    const state = ui.view.getState();
    expect(state.sessionMode).toBe(mode);
    expect(state.answerVisible).toBe(mode === "browse");
    expect(state.queue.slice(0, 2)).toEqual(["due-b", "due-a"]);
    expect(state.queue.slice(2)).toEqual(subjectOnly ? ["new-b", "new-a"] : ["new-b", "other", "new-a"]);
    expect(state.queue).not.toContain("future");
    const fixed = [...state.queue];
    await ui.view.setState(ui.view.getState(), {});
    expect(ui.view.getState().queue).toEqual(fixed);
    ui.view.showDashboard(); await ui.button("이어하기").click();
    expect(ui.view.getState().queue).toEqual(fixed);
    expect(ui.reviews[fixed[0]].history).toHaveLength(1);
  });

  it.each(["시험 모드 시작", "전체 암기 모드", "시험", "암기"])("disables %s when every review is still in the future", label => {
    const ui = setup({ start: false }); ui.reviews.q = ui.plugin.fsrs.rate(undefined, Rating.Easy);
    ui.view.showDashboard(); expect(ui.exactButton(label).disabled).toBe(true);
  });

  it("graduates Again → Good → Good and clears resume without pulling a future review into today", async () => {
    const ui = setup();
    for (const label of ["못 암기", "암기", "암기"]) {
      await ui.button("정답 보기").click(); await ui.button(label).click();
      if (label !== "암기" || ui.reviews.q.history.length < 3) {
        expect(ui.content()).toContain("다음 복습 대기 중");
        const wait = Date.parse(ui.reviews.q.card.due) - Date.now();
        await vi.advanceTimersByTimeAsync(wait);
      }
    }
    expect(ui.reviews.q.history.map(log => log.rating)).toEqual([Rating.Again, Rating.Good, Rating.Good]);
    expect(ui.content()).toContain("학습 완료");
    expect(ui.content()).not.toContain("다음 복습 대기 중");
    await ui.plugin.studyUi.load(); expect(ui.plugin.studyUi.resume).toBeNull();
    expect(buildReviewQueue(ui.plugin.index.registered, ui.reviews, ui.plugin.fsrs)).toEqual([]);
  });

  it("retries a failed rating without skipping a question or duplicating its history", async () => {
    const ui = setup(); let saves = 0;
    ui.plugin.store.setReview = async (id, state) => { if (++saves === 1) throw Error("disk full"); ui.reviews[id] = state; };
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    expect(ui.view.getState()).toMatchObject({ queueIndex: 0, answerVisible: true });
    expect(ui.reviews).toEqual({});
    await ui.button("암기").click();
    expect(ui.reviews.q.history.map(log => log.rating)).toEqual([Rating.Good]);
    expect(ui.content()).toContain("다음 복습 대기 중");
  });

  it("keeps undo available after a failed undo write, then restores the original state on retry", async () => {
    const ui = setup(); await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    let attempts = 0;
    ui.plugin.store.removeReview = async id => { if (++attempts === 1) throw Error("disk full"); delete ui.reviews[id]; };
    await ui.button("직전 평가 취소").click();
    await vi.waitFor(() => expect(ui.view.isMutatingReview).toBe(false));
    expect(ui.reviews.q.history).toHaveLength(1);
    expect(ui.view.getState().queueIndex).toBe(1);
    await ui.button("직전 평가 취소").click();
    await vi.waitFor(() => expect(ui.view.getState().queueIndex).toBe(0));
    expect(ui.reviews.q).toBeUndefined(); expect(ui.view.getState().answerVisible).toBe(true);
  });
  it("keeps a follow-up added after a rating when that rating is undone", async () => {
    const ui = setup({ linked: true });
    const related = ui.plugin.index.registered[1];
    related.followUpIds = ["third"];
    ui.plugin.index.registered.push({ ...related, id: "third", heading: "새 꼬리질문", followUpIds: [] });
    ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    await ui.button("정답 보기").click(); await ui.button("다음 순서에 추가").click();
    expect(ui.view.getState().queue).toEqual(["q", "related", "third"]);
    await ui.button("직전 평가 취소").click();
    expect(ui.view.getState().queue).toEqual(["q", "related", "third"]);
    expect(ui.reviews.q).toBeUndefined();
    await ui.button("너무 쉬움").click();
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    expect(ui.content()).toContain("새 꼬리질문");
    expect(ui.view.getState().queueIndex).toBe(2);
  });

  it("keeps added follow-ups before the next existing question across undo without duplicates", async () => {
    const ui = setup({ linked: true });
    const related = ui.plugin.index.registered[1]; related.followUpIds = ["third"];
    ui.plugin.index.registered.push({ ...related, id: "third", heading: "추가 질문", followUpIds: ["fourth"] });
    ui.plugin.index.registered.push({ ...related, id: "fourth", heading: "두 번째 추가 질문", followUpIds: [] });
    ui.plugin.index.registered.push({ ...related, id: "last", heading: "마지막 질문", followUpIds: [] });
    ui.view.startReview(["q", "related", "last"]);
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    await ui.button("정답 보기").click(); await ui.button("다음 순서에 추가").click();
    await ui.button("다음 문제 →").click();
    await ui.button("정답 보기").click(); await ui.button("다음 순서에 추가").click();
    await ui.button("직전 평가 취소").click();
    expect(ui.view.getState().queue).toEqual(["q", "related", "third", "fourth", "last"]);
    expect(ui.reviews).toEqual({});
  });

  it.each([0, 60_000])("retains pending learning when the last remaining question is deleted after %s ms", async elapsed => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    vi.setSystemTime(Date.now() + elapsed);
    ui.plugin.index.registered.splice(1, 1);
    await ui.view.setState(ui.view.getState(), {});
    expect(ui.content()).not.toContain("학습 완료");
    if (!elapsed) {
      expect(ui.content()).toContain("다음 복습 대기 중");
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(ui.view.getState().queue.at(-1)).toBe("q");
    expect(ui.button("정답 보기")).toBeDefined();
    expect(ui.reviews.q.history).toHaveLength(1);
  });

  it("preserves a scheduled retry when moving forward through an already rated question", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    await ui.button("← 이전 문제").click();
    expect(ui.view.getState().answerVisible).toBe(true);
    await ui.button("다음 문제 →").click();
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    expect(ui.content()).toContain("다음 복습 대기 중");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ui.content()).toContain("질문"); expect(ui.button("정답 보기")).toBeDefined();
    expect(ui.view.getState().queue.at(-1)).toBe("q");
  });

  it("can explicitly skip a new ungraded retry without deleting its stored review", async () => {
    const ui = setup(); await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    await vi.advanceTimersByTimeAsync(60_000);
    await ui.button("다음 문제 →").click();
    expect(ui.content()).toContain("학습 완료");
    expect(ui.reviews.q.history.map(log => log.rating)).toEqual([Rating.Again]);
  });
  it("runs twenty mixed-grade questions, corrects mistakes, resumes after restart and reviews only due cards the next day", async () => {
    let persisted = {};
    const disk = { loadData: async () => structuredClone(persisted), saveData: async data => { persisted = structuredClone(data); } };
    const makeSession = async () => {
      const ui = setup({ start: false });
      const template = ui.plugin.index.registered[0];
      ui.plugin.index.registered.splice(0, 1, ...Array.from({ length: 20 }, (_, i) => ({ ...template, id: `routine-${i}`, heading: `질문 ${i + 1}` })));
      ui.plugin.store = new MiaDataStore(disk); await ui.plugin.store.load();
      return ui;
    };
    let ui = await makeSession(); ui.view.startReview();
    const expectedGrades = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
    for (let i = 0; i < 20; i++) {
      if (i === 10) {
        await ui.plugin.studyUi.load(); await ui.view.onClose();
        const first = ui; ui = await makeSession();
        ui.plugin.studyUi = new StudyUiStore(first.studyApp, "ui-state.json"); await ui.plugin.studyUi.load();
        ui.view.showDashboard(); await ui.button("이어하기").click();
        expect(ui.view.getState().queueIndex).toBe(10);
      }
      expect(ui.view.getState().answerVisible).toBe(false);
      await ui.button("정답 보기").click();
      if (i === 5 || i === 11) {
        await ui.button("너무 쉬움").click(); await ui.button("직전 평가 취소").click();
        await vi.waitFor(() => expect(ui.view.getState().queueIndex).toBe(i));
        expect(ui.plugin.store.getReview(`routine-${i}`)).toBeUndefined();
      }
      const grade = expectedGrades[i % 4];
      const rating = ui.button({ 1: "못 암기", 2: "애매", 3: "암기", 4: "너무 쉬움" }[grade]);
      expect(rating, `step ${i}: ${ui.content()}`).toBeDefined();
      await rating.click();
      expect(ui.plugin.store.getReview(`routine-${i}`).history).toHaveLength(1);
    }
    expect(Object.keys(persisted.reviews)).toHaveLength(20);
    expect(calculateProgress(ui.plugin.index.registered, ui.plugin.store.reviews, ui.plugin.fsrs).today).toBe(20);
    await ui.view.onClose();
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
    ui = await makeSession();
    const due = buildReviewQueue(ui.plugin.index.registered, ui.plugin.store.reviews, ui.plugin.fsrs);
    expect(due).toHaveLength(15);
    expect(due.every(question => ui.plugin.store.getReview(question.id).lastRating !== Rating.Easy)).toBe(true);
    ui.view.startReview();
    for (const question of due) {
      const state = ui.view.getState(); expect(state.queue[state.queueIndex]).toBe(question.id);
      await ui.button("정답 보기").click(); await ui.button("암기").click();
      expect(ui.plugin.store.getReview(question.id).history).toHaveLength(2);
    }
    const counts = calculateProgress(ui.plugin.index.registered, ui.plugin.store.reviews, ui.plugin.fsrs);
    expect(counts.today).toBe(15);
    expect(Object.values(persisted.reviews).reduce((sum, review) => sum + review.history.length, 0)).toBe(35);
  });
  it("undoes with the physical U key while the Korean keyboard layout is active", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    const preventDefault = vi.fn();
    ui.view.handleStudyShortcut({ key: "ㅕ", code: "KeyU", target: null, preventDefault });
    await Promise.resolve();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(ui.reviews.q).toBeUndefined();
    expect(ui.view.getState().queueIndex).toBe(0);
  });
  it("does not apply another session's baseline when restoring a different queue", async () => {
    const ui = setup({ linked: true });
    ui.reviews.q = ui.plugin.fsrs.rate(undefined, Rating.Good, new Date(Date.now() - 86_400_000));
    ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    await ui.view.setState({ route: "study", queue: ["related"], queueIndex: 0, answerVisible: true, sessionMode: "recall" }, {});
    expect(ui.button("직전 평가 취소")).toBeUndefined();
    await ui.button("암기").click();
    expect(ui.reviews.related.history).toHaveLength(1);
  });
  it("reveals keyword hints without grading or exposing the answer, then resets hints on the next card", async () => {
    const ui = setup({ linked: true });
    ui.plugin.index.registered[0].coreKeywords = [{ target: "키워드", label: "키워드", raw: "키워드" }];
    ui.view.startReview(["q", "related"]);
    await ui.button("키워드 힌트").click();
    expect(ui.content()).toContain("키워드"); expect(ui.button("정답 보기")).toBeDefined();
    expect(ui.view.getState().answerVisible).toBe(false); expect(ui.reviews).toEqual({});
    await ui.button("다음 →").click(); await ui.exactButton("← 이전").click();
    expect(ui.button("키워드 힌트 접기")).toBeUndefined();
    expect(ui.button("키워드 힌트")).toBeDefined();
  });
  it("offers resume on the dashboard and restores position and answer on a fresh device/view", async () => {
    const first = setup({ linked: true }); first.view.startReview(["q", "related"]);
    await first.button("다음 →").click(); await first.button("정답 보기").click();
    await first.plugin.studyUi.load();
    const next = setup({ linked: true, start: false });
    next.plugin.studyUi = new StudyUiStore(first.studyApp, "ui-state.json"); await next.plugin.studyUi.load();
    next.view.showDashboard();
    expect(next.content()).toContain("마지막 학습"); expect(next.content()).toContain("2 / 2");
    await next.button("이어하기").click();
    expect(next.view.getState()).toMatchObject({ route: "study", queue: ["q", "related"], queueIndex: 1, answerVisible: true });
    expect(next.reviews).toEqual({});
  });

  it("resumes the same in-memory session without losing undo", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    ui.view.showDashboard(); await ui.plugin.studyUi.load();
    await ui.button("이어하기").click(); await ui.button("직전 평가 취소").click();
    expect(ui.view.getState().queueIndex).toBe(0); expect(ui.reviews.q).toBeUndefined();
  });

  it("does not offer a completed session as resume", async () => {
    const ui = setup(); await ui.button("다음 문제 →").click();
    await ui.plugin.studyUi.load(); expect(ui.plugin.studyUi.resume).toBeNull();
    ui.view.showDashboard(); expect(ui.button("이어하기")).toBeUndefined();
  });

  it("reads a newer synced position before resuming instead of overwriting it with the current view", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]); await ui.plugin.studyUi.load();
    const remote = new StudyUiStore(ui.studyApp, "ui-state.json"); await remote.load();
    await remote.saveResume({ ...remote.resume, queueIndex: 1, answerVisible: true });
    ui.view.showDashboard(); await ui.button("이어하기").click();
    expect(ui.view.getState()).toMatchObject({ queueIndex: 1, answerVisible: true });
    expect(ui.reviews).toEqual({});
  });

  it("keeps reading preferences without resetting the current answer, queue or content tree", async () => {
    const ui = setup(); await ui.button("정답 보기").click();
    const before = ui.view.getState(), tree = ui.view.contentEl.children;
    ui.plugin.studyUi.updateAppearance({ size: "large", density: "compact" }); ui.view.refreshAppearance();
    expect(ui.view.contentEl.dataset).toMatchObject({ readingSize: "large", density: "compact" });
    expect(ui.view.contentEl.children).toBe(tree); expect(ui.view.getState()).toEqual(before); expect(ui.reviews).toEqual({});
  });

  it("offers the same ungraded movement through the thumb controls", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    expect(ui.exactButton("← 이전").disabled).toBe(true);
    await ui.button("다음 →").click();
    expect(ui.view.getState().queueIndex).toBe(1);
    await ui.exactButton("← 이전").click();
    expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.reviews).toEqual({});
  });

  it.each([Rating.Again, Rating.Easy])("undoes by U from waiting/completed state for grade %s", async grade => {
    const ui = setup();
    await ui.button("정답 보기").click();
    ui.view.handleStudyShortcut({ key: String(grade), target: null, preventDefault() {} });
    await Promise.resolve();
    expect(ui.reviews.q.history).toHaveLength(1);
    ui.view.handleStudyShortcut({ key: "U", target: null, preventDefault() {} });
    await Promise.resolve();
    expect(ui.reviews.q).toBeUndefined();
    expect(ui.view.getState()).toMatchObject({ queueIndex: 0, answerVisible: true });
  });

  it.each([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy])("reveals with Space, then rates with keyboard %s exactly once", async grade => {
    const ui = setup();
    const key = value => ({ key: value, preventDefault: vi.fn(), target: null });
    ui.view.handleStudyShortcut(key(String(grade)));
    expect(ui.reviews).toEqual({});
    ui.view.handleStudyShortcut(key(" "));
    expect(ui.button("정답 보기")).toBeUndefined();
    const event = key(String(grade));
    ui.view.handleStudyShortcut({ ...event, repeat: true });
    expect(ui.reviews).toEqual({});
    ui.view.handleStudyShortcut(event);
    await Promise.resolve();
    expect(ui.reviews.q.history).toHaveLength(1);
    expect(ui.reviews.q.lastRating).toBe(grade);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves typing, composition, modified keys and native button Space untouched", () => {
    const ui = setup();
    for (const options of [
      { target: { closest: () => ({}) } },
      { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
      { target: { closest: selector => selector === "button, summary" ? {} : null } },
    ]) {
      const event = { key: " ", preventDefault: vi.fn(), target: null, ...options };
      ui.view.handleStudyShortcut(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(ui.button("정답 보기")).toBeDefined();
    }
    expect(ui.reviews).toEqual({});
  });

  it("navigates with arrows, resets reading position for the new card and keeps the answer hidden in recall mode", () => {
    const ui = setup({ linked: true });
    ui.view.startReview(["q", "related"]);
    ui.view.contentEl.scrollTop = 700;
    ui.view.handleStudyShortcut({ key: "ArrowRight", target: null, preventDefault() {} });
    expect(ui.view.getState()).toMatchObject({ queueIndex: 1, answerVisible: false });
    expect(ui.view.contentEl.scrollTop).toBe(0);
    ui.view.handleStudyShortcut({ key: "ArrowLeft", target: null, preventDefault() {} });
    expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.reviews).toEqual({});
  });

  it("opens an already queued follow-up in browse mode without changing the current session or review", async () => {
    const ui = setup({ linked: true });
    ui.view.startReview(["q", "related"], "browse");
    const before = ui.view.getState();
    expect(ui.button("이미 학습에 포함됨").disabled).toBe(true);
    expect(ui.button("꼬리질문").disabled).toBe(false);
    await ui.button("꼬리질문").click();
    expect(ui.plugin.openQuestionPreview).toHaveBeenCalledWith(expect.objectContaining({ id: "related" }), expect.any(Function));
    expect(ui.view.getState()).toEqual(before);
    expect(ui.reviews).toEqual({});
  });

  it("separates opening a follow-up from inserting it once into the next study position", async () => {
    const ui = setup({ linked: true });
    await ui.button("정답 보기").click();
    await ui.button("꼬리질문").click();
    expect(ui.view.getState().queue).toEqual(["q"]);
    await ui.button("다음 순서에 추가").click();
    expect(ui.view.getState().queue).toEqual(["q", "related"]);
    expect(ui.button("이미 학습에 포함됨").disabled).toBe(true);
    await ui.button("이미 학습에 포함됨").click();
    expect(ui.view.getState().queue).toEqual(["q", "related"]);
    await ui.button("다음 문제 →").click();
    expect(ui.content()).toContain("꼬리질문");
    expect(ui.view.getState().queueIndex).toBe(1);
    expect(ui.reviews).toEqual({});
  });

  it("does not open or insert a follow-up during a pending rating save", async () => {
    const ui = setup({ linked: true });
    let finish;
    ui.plugin.store.setReview = (id, state) => new Promise(resolve => { finish = () => { ui.reviews[id] = state; resolve(); }; });
    await ui.button("정답 보기").click();
    const pending = ui.button("너무 쉬움").click();
    await ui.button("꼬리질문").click();
    await ui.button("다음 순서에 추가").click();
    expect(ui.plugin.openQuestionPreview).not.toHaveBeenCalled();
    expect(ui.view.getState().queue).toEqual(["q"]);
    finish(); await pending;
  });

  it("appends a new follow-up while revisiting history so recorded positions stay attached to their questions", async () => {
    const ui = setup({ linked: true });
    ui.plugin.index.registered.push({ ...ui.plugin.index.registered[0], id: "third", heading: "기존 다음 질문" });
    ui.view.startReview(["q", "third"], "browse");
    await ui.button("너무 쉬움").click();
    await ui.button("너무 쉬움").click();
    await ui.view.setState({ ...ui.view.getState(), queueIndex: 0, answerVisible: true }, {});
    await ui.button("학습 끝에 추가").click();
    expect(ui.view.getState().queue).toEqual(["q", "third", "related"]);
    await ui.button("다음 문제 →").click();
    expect(ui.content()).toContain("기존 다음 질문");
    expect(ui.content()).toContain("이번 학습 평가: 너무 쉬움");
    expect(ui.reviews.third.history).toHaveLength(1);
  });

  it("keeps session navigation and restart from replacing a card while its rating is saving", async () => {
    const ui = setup();
    let finish;
    ui.plugin.store.setReview = (id, state) => new Promise(resolve => {
      finish = () => { ui.reviews[id] = state; resolve(); };
    });
    await ui.button("정답 보기").click();
    const pending = ui.button("너무 쉬움").click();
    await ui.button("대시보드").click();
    ui.view.startReview([], "browse");
    await ui.view.setState({ route: "dashboard", queue: [], queueIndex: 0 }, {});
    expect(ui.view.getState()).toMatchObject({ route: "study", queue: ["q"], queueIndex: 0, sessionMode: "recall" });
    finish(); await pending;
    expect(ui.view.getState().queueIndex).toBe(1);
    expect(ui.reviews.q.history).toHaveLength(1);
    await ui.button("직전 평가 취소").click();
    expect(ui.reviews.q).toBeUndefined();
    expect(ui.view.getState().queueIndex).toBe(0);
  });

  it.each(["navigate", "restart", "close"])("cancels a pending completion popup on %s", async (action) => {
    const ui = setup();
    await ui.button("다음 문제 →").click();
    expect(vi.getTimerCount()).toBe(1);
    if (action === "navigate") ui.view.showDashboard();
    if (action === "restart") ui.view.startReview(["q"]);
    if (action === "close") await ui.view.onClose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runOnlyPendingTimersAsync();
    expect(ui.reviews).toEqual({});
  });

  it("marks the index ready only after its first load and retains it during a rebuild", async () => {
    let finishRead;
    const file = { path: "bank.md", extension: "md" };
    const app = { vault: {
      getMarkdownFiles: () => [file],
      cachedRead: () => new Promise(resolve => { finishRead = resolve; }),
    } };
    const bank = "### 질문\n\n> [!question] 문제\n> 질문입니다.\n\n^mia-q-ready\n\n#### 풀이\n\n정답입니다.";
    const index = new QuestionIndex(app, () => []);
    const first = index.rebuild();
    expect(index.isReady).toBe(false);
    finishRead(bank);
    await first;
    expect(index.isReady).toBe(true);
    expect(index.questionById("mia-q-ready")).toBeDefined();
    const second = index.rebuild();
    expect(index.questionById("mia-q-ready")).toBeDefined();
    finishRead(bank);
    await second;
    expect(index.questionById("mia-q-ready")).toBeDefined();
  });

  it("preserves a restored question while the initial index is loading", async () => {
    const ui = setup({ start: false });
    const loaded = ui.plugin.index;
    ui.plugin.index = { isReady: false, registered: [], questionById: () => undefined };
    const restored = { route: "study", queue: ["q"], queueIndex: 0, answerVisible: false, sessionMode: "recall" };
    await ui.view.setState(restored, {});
    expect(ui.content()).toContain("문제를 불러오는 중");
    expect(ui.content()).not.toContain("학습 완료");
    expect(ui.view.getState()).toEqual(restored);
    ui.plugin.index = loaded;
    await ui.view.setState(ui.view.getState(), {});
    expect(ui.content()).toContain("1 / 1");
    expect(ui.button("정답 보기")).toBeDefined();
    expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.reviews).toEqual({});
    await ui.button("다음 문제 →").click();
    await ui.button("같은 범위 다시 학습").click();
    expect(ui.view.getState().queue).toEqual(["q"]);
    expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.button("정답 보기")).toBeDefined();
  });

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


describe("return and quick recovery", () => {
  it("does not replace the search form on an unchanged app return", async () => {
    const ui = setup({ start: false }); ui.plugin.store.synchronize = vi.fn().mockResolvedValue(undefined);
    await ui.view.setState({route:"questions",queue:[],queueIndex:0,answerVisible:false,sessionMode:"recall"},{});
    const form = ui.view.contentEl.children;
    await ui.view.refreshAfterReturn();
    expect(ui.plugin.store.synchronize).toHaveBeenCalledOnce(); expect(ui.view.contentEl.children).toBe(form);
  });
  it("shows immediate recovery, keeps undo after the banner expires, and restores the original rating", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("암기").click();
    expect(ui.content()).toContain("암기 평가 저장됨");
    expect(ui.reviews.q.history).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(ui.view.undoFeedback).toBe(""); expect(ui.button("직전 평가 취소")).toBeDefined();
    await ui.button("직전 평가 취소").click();
    expect(ui.view.getState().queueIndex).toBe(0); expect(ui.reviews.q).toBeUndefined();
  });
});
