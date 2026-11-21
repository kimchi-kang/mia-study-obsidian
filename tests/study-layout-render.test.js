import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
vi.mock("obsidian", async () => {
  const { obsidianLayoutBoundary } = await import("./fixtures/study-layout-obsidian");
  return obsidianLayoutBoundary();
});
import { createLayoutDom, renderLayoutCase } from "./fixtures/study-layout-render";
import { layoutHarness } from "./fixtures/study-layout-harness-template";
let dom;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
  dom = createLayoutDom();
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("study layout rendered DOM", () => {
  it("creates no related rail before reveal even with recommendations", async () => {
    const { root } = await renderLayoutCase({ revealed: false });
    expect(root.querySelector(".mia-related")).toBeNull();
  });
  it("creates no related rail for zero recommendations after reveal", async () => {
    const { root } = await renderLayoutCase({ related: false });
    expect(root.querySelector(".mia-answer")).not.toBeNull();
    expect(root.querySelector(".mia-related")).toBeNull();
    expect(root.querySelector(".mia-study-layout").children).toHaveLength(1);
  });
  it("places real recommended items beside the card in the DOM after reveal", async () => {
    const { root } = await renderLayoutCase();
    expect(root.querySelector(".mia-study-layout > .mia-related > .mia-related-item")).not.toBeNull();
    expect(root.querySelectorAll(".mia-ratings > button")).toHaveLength(4);
    expect(root.querySelector(".mia-study-concepts").textContent).toContain("재료 보존");
    expect(root.querySelectorAll(".mia-answer li")).toHaveLength(3);
  });
  it("keeps all 40 lines in the long answer", async () => {
    const { root } = await renderLayoutCase({ long: true });
    expect(root.querySelectorAll(".mia-answer li")).toHaveLength(40);
  });
  it.each(["dashboard", "progress", "questions", "keywords"])("renders populated %s through the real route", async route => {
    const { root } = await renderLayoutCase({ route });
    expect(root.classList.contains(`mia-route-${route}`)).toBe(true);
    if (route === "dashboard") {
      expect(root.querySelector(".mia-resume-card")).not.toBeNull();
      expect(root.querySelectorAll(".mia-subject-card")).toHaveLength(6);
      expect(root.querySelector(".mia-weak-hint").textContent).toBe("못 암기와 애매 문제만 모아 시험합니다. 출제 순서는 학습 설정을 따릅니다.");
    }
    if (route === "progress") expect(root.querySelectorAll(".mia-progress-subject")).toHaveLength(6);
    if (route === "questions") { expect(root.querySelectorAll(".mia-row")).toHaveLength(48); expect(root.querySelector(".mia-detail-panel .mia-answer")).not.toBeNull(); expect(root.querySelector(".mia-warning")).toBeNull(); }
    if (route === "keywords") expect(root.querySelectorAll(".mia-keyword")).toHaveLength(12);
    if (route === "questions") expect(root.querySelector(".mia-status-chips").textContent).toContain("오늘 복습 24학습 전 16▲ 취약 16");
  });
  it("opens the subject question list when the subject heading is clicked", async () => {
    const { root } = await renderLayoutCase({ route: "dashboard" });
    const open = root.querySelector(".mia-subject-card > button.mia-subject-open");
    const subject = open.querySelector("strong").textContent;
    const total = Number(open.querySelector(".mia-subject-total").textContent.replace("문제", ""));
    open.click();
    await vi.runOnlyPendingTimersAsync();
    expect(root.classList.contains("mia-route-questions")).toBe(true);
    const rows = [...root.querySelectorAll(".mia-row")];
    expect(rows).toHaveLength(total);
    expect(rows.every(row => row.textContent.includes(subject))).toBe(true);
  });
  it("ships a reproducible standalone harness with real rendered study HTML", async () => {
    // The checked-in snapshot includes local dates and the study-day boundary.
    vi.stubEnv("TZ", "Asia/Seoul");
    const cases = {};
    for (const [name, options] of Object.entries({ short: {}, long: { long: true }, "no-related": { related: false } })) {
      const { root } = await renderLayoutCase(options);
      cases[name] = root.outerHTML;
      root.remove();
    }
    for (const route of ["dashboard", "progress", "questions", "keywords"]) {
      const { root } = await renderLayoutCase({ route, targets: true });
      cases[route] = root.outerHTML;
      root.remove();
    }
    const html = layoutHarness(cases);
    const path = new URL("./fixtures/study-layout-harness.html", import.meta.url);
    if (process.env.MIA_GENERATE_LAYOUT_HARNESS === "1") await writeFile(path, html);
    expect(await readFile(path, "utf8")).toBe(html);
  });
});

it("excludes visibilitychange pauses, resumes through refresh, and cleans up on close", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  dom.window.HTMLElement.prototype.hasClass = function(name) { return this.classList.contains(name); };
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  const {view,root}=await renderLayoutCase({revealed:false});
  const registrations=[],intervals=[];
  view.registerDomEvent=(target,event,fn)=>{target.addEventListener(event,fn);registrations.push(()=>target.removeEventListener(event,fn));};
  view.registerInterval=id=>intervals.push(id);
  view.plugin.index.subscribe=()=>()=>{};view.plugin.store.subscribe=()=>()=>{};
  view.plugin.synchronizeStudyData=async()=>{};
  await view.onOpen();
  vi.advanceTimersByTime(4200);
  Object.defineProperty(document,"hidden",{configurable:true,value:true});
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
  vi.advanceTimersByTime(20000);
  expect(root.querySelector(".mia-answer-timer").textContent).toBe("0:04");
  Object.defineProperty(document,"hidden",{configurable:true,value:false});
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(2300);
  expect(view.answerClock.milliseconds).toBe(6500);
  await view.refreshAfterReturn(false);vi.advanceTimersByTime(1000);
  expect(view.answerClock.milliseconds).toBe(7500);
  root.querySelector(".mia-reveal").click();vi.advanceTimersByTime(10000);
  expect(root.querySelector(".mia-answer-timer").textContent).toBe("0:07");
  const old=root.querySelector(".mia-answer-timer"),before=old.textContent;
  await view.onClose();vi.advanceTimersByTime(5000);expect(old.textContent).toBe(before);expect(view.answerTimer).toBeNull();
  registrations.forEach(dispose=>dispose());intervals.forEach(id=>window.clearInterval(id));
});

async function openWithTimers(view) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  dom.window.HTMLElement.prototype.hasClass = function(name) { return this.classList.contains(name); };
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  const cleanups = [];
  let onStoreChange;
  view.registerDomEvent = (target, event, callback) => {
    target.addEventListener(event, callback);
    cleanups.push(() => target.removeEventListener(event, callback));
  };
  view.registerInterval = id => cleanups.push(() => window.clearInterval(id));
  view.plugin.index.subscribe = () => () => {};
  view.plugin.store.subscribe = callback => { onStoreChange = callback; return () => { onStoreChange = undefined; }; };
  view.plugin.synchronizeStudyData = vi.fn(async () => {});
  await view.onOpen();
  return {
    notifyStore: () => onStoreChange?.(),
    close: async () => { await view.onClose(); cleanups.forEach(dispose => dispose()); },
  };
}

it.each(["visibilitychange", "focus", "pageshow"])("resumes the answer clock on %s even during a refresh or rating", async event => {
  const { view, root } = await renderLayoutCase({ revealed: false });
  const session = await openWithTimers(view);
  let finishRefresh;
  try {
    view.plugin.synchronizeStudyData.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    const refresh = event === "visibilitychange" ? view.refreshAfterReturn(false) : undefined;
    view.isMutatingReview = event === "focus";
    vi.advanceTimersByTime(2000);
    window.dispatchEvent(new window.Event("pagehide"));
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    window.dispatchEvent(new window.Event("focus"));
    vi.advanceTimersByTime(10_000);
    expect(view.answerClock.milliseconds).toBe(2000);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const target = event === "visibilitychange" ? document : window;
    target.dispatchEvent(new window.Event(event));
    vi.advanceTimersByTime(3200);
    expect(view.answerClock.milliseconds).toBe(5200);
    view.isMutatingReview = false;
    finishRefresh?.();
    await refresh;
    vi.advanceTimersByTime(800);
    expect(root.querySelector(".mia-answer-timer").textContent).toBe("0:06");
  } finally {
    finishRefresh?.();
    await session.close();
  }
});

it("starts a visible new card after pagehide without needing a return event", async () => {
  const { view, root } = await renderLayoutCase({ revealed: false });
  const session = await openWithTimers(view);
  try {
    window.dispatchEvent(new window.Event("pagehide"));
    vi.advanceTimersByTime(15_000);
    expect(root.querySelector(".mia-answer-timer").textContent).toBe("0:00");
    view.startReview(["related"]);
    vi.advanceTimersByTime(2200);
    expect(root.querySelector(".mia-answer-timer").textContent).toBe("0:02");
  } finally {
    await session.close();
  }
});

it.each(["dashboard", "progress"])("keeps %s DOM when synchronized values agree, then redraws when a review becomes due", async route => {
  vi.setSystemTime(new Date(2026, 10, 16, 14, 0));
  const { view, root } = await renderLayoutCase({ route });
  const { fsrs, store } = view.plugin;
  const pending = fsrs.rate(undefined, 1, new Date(Date.now() - 15_000), "q");
  pending.card.due = new Date(Date.now() + 45_000).toISOString();
  store.reviews = { q: pending };
  const session = await openWithTimers(view);
  try {
    const focused = root.querySelector(".mia-progress-stat");
    focused.focus();
    root.scrollTop = 63;
    view.plugin.synchronizeStudyData.mockImplementationOnce(async () => {
      store.reviews = { ...store.reviews, unindexed: fsrs.rate(undefined, 4, new Date(2026, 10, 12, 14)) };
      session.notifyStore();
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(view.plugin.synchronizeStudyData).toHaveBeenCalledOnce();
    expect(document.activeElement === focused).toBe(true);
    expect(root.querySelector(".mia-progress-stat") === focused).toBe(true);
    expect(root.scrollTop).toBe(63);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector(".mia-progress-stat")).not.toBe(focused);
    const due = [...root.querySelectorAll(".mia-progress-stat")].find(node => node.textContent.endsWith("오늘 복습"));
    expect(due.querySelector("strong").textContent).toBe("1");
  } finally { await session.close(); }
});

it.each(["dashboard", "progress"])("redraws %s at the configured study-day boundary", async route => {
  vi.setSystemTime(new Date(2026, 10, 16, 3, 59, 45));
  const { view, root } = await renderLayoutCase({ route });
  view.plugin.store.reviews = {};
  const session = await openWithTimers(view);
  try {
    const stats = root.querySelector(".mia-stats");
    const date = root.querySelector(".mia-hero-date")?.textContent;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector(".mia-stats")).not.toBe(stats);
    if (date) expect(root.querySelector(".mia-hero-date").textContent).not.toBe(date);
  } finally { await session.close(); }
});

it("refreshes dashboard resume text only when the visible position changes", async () => {
  const { view, root } = await renderLayoutCase({ route: "dashboard" });
  const session = await openWithTimers(view);
  try {
    const card = root.querySelector(".mia-resume-card");
    const current = view.plugin.studyUi.resume;
    view.plugin.synchronizeStudyData.mockImplementationOnce(async () => {
      await view.plugin.studyUi.saveResume({ ...current, queueIndex: current.queueIndex + 1 });
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector(".mia-resume-card")).not.toBe(card);
    expect(root.querySelector(".mia-resume-card").textContent).toContain("3 / 3");
  } finally { await session.close(); }
});

it.each([true, false])("excludes modal time from saved answer_ms with timer display %s", async answerTimer => {
  const { view, root } = await renderLayoutCase({ revealed: false });
  view.plugin.studyUi.updateAppearance({ answerTimer, autoQuestionSeconds: 15 });
  view.startReview(["q", "related"]);
  const session = await openWithTimers(view);
  try {
    const save = vi.fn(async (id, state) => { view.plugin.store.reviews[id] = state; });
    view.plugin.store.setReview = save;
    root.querySelector(".mia-auto-advance").click();
    await vi.advanceTimersByTimeAsync(2000);
    const modal = document.body.createDiv({ cls: "modal-container" });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(view.answerClock.milliseconds).toBe(3000);
    expect(root.querySelector(".mia-answer-timer")?.textContent).toBe(answerTimer ? "0:03" : undefined);
    modal.remove();
    await vi.advanceTimersByTimeAsync(4000);
    expect(root.querySelector(".mia-auto-advance").textContent).toBe("자동 ∥");
    expect(root.querySelector(".mia-answer-timer")?.textContent).toBe(answerTimer ? "0:06" : undefined);
    root.querySelector(".mia-reveal").click();
    root.querySelector(".mia-ratings button[data-grade='4']").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(save.mock.calls[0][1].history[0].answer_ms).toBe(6000);
  } finally { await session.close(); }
  expect(view.answerTimer).toBeNull();
});

describe("target and radar routes", () => {
  const button = (root, label) => [...root.querySelectorAll("button")].find(item => item.textContent === label);
  it("shows the closest goal, forecasts all 30 study days, and folds past goals", async () => {
    const { view, root } = await renderLayoutCase({ route: "dashboard", targets: true });
    expect(root.querySelector(".mia-target-strip").textContent).toMatch(/D-\d+ 첫 면접 · 위험 문제 \d+개/);
    await view.setState({ route: "progress" }, {});
    expect([...root.querySelectorAll(".mia-target-dates > article h4")].map(el => el.textContent)).toEqual(["첫 면접", "연습 시험"]);
    expect(root.querySelector(".mia-target-past").open).toBe(false);
    expect(root.querySelector(".mia-target-past").textContent).toContain("지남");
    expect(root.querySelectorAll(".mia-forecast-bar")).toHaveLength(30);
    expect(root.querySelectorAll(".mia-forecast-marker")).toHaveLength(2);
    expect(root.querySelector(".mia-review-forecast").textContent).toContain("하루 복습 상한 적용 전");
  });

  it("hides the dashboard goal strip and the radar when no relevant records exist", async () => {
    const { view, root } = await renderLayoutCase({ route: "dashboard" });
    expect(root.querySelector(".mia-target-strip")).toBeNull();
    view.plugin.store.reviews = {};
    await view.setState({ route: "keywords" }, {});
    expect(root.querySelector(".mia-keyword-radar")).toBeNull();
    expect(root.querySelectorAll(".mia-keyword")).toHaveLength(12);
    await view.setState({ route: "progress" }, {});
    expect(root.querySelector(".mia-target-card")).toBeNull();
    expect(button(root, "목표일 추가")).toBeDefined();
  });

  it.each(["dashboard", "progress"])("starts early recall from the %s goal, even with a zero daily limit", async route => {
    const { view, root } = await renderLayoutCase({ route, targets: true });
    const plugin = view.plugin;
    const [first, second] = plugin.index.registered;
    const future = (q, stability) => {
      const state = plugin.fsrs.rate(undefined, 3, new Date(Date.now() - 3 * 86_400_000), q.id);
      return { ...state, card: { ...state.card, stability, due: new Date(Date.now() + 3 * 86_400_000).toISOString() } };
    };
    plugin.store.reviews = { [first.id]: future(first, 2), [second.id]: future(second, 1) };
    plugin.store.settings.studyManagement.reviewsPerDay = 0;
    const baseline = structuredClone(plugin.store.reviews);
    view.render();
    expect(plugin.fsrs.isDue(baseline[second.id], new Date())).toBe(false);
    button(root, "위험 문제 학습").click();
    expect(view.getState()).toMatchObject({ queue: [second.id, first.id], sessionMode: "recall", answerVisible: false });
    expect(root.querySelector(".mia-study-card").textContent).toContain(second.heading);
    expect(plugin.store.reviews).toEqual(baseline);
  });

  it("renders and sorts the radar, opens the existing meaning popup, and grades an early concept question through FSRS", async () => {
    const { view, root } = await renderLayoutCase({ route: "keywords" });
    const plugin = view.plugin;
    const [first, second, fresh] = plugin.index.registered;
    second.coreKeywords = first.coreKeywords;
    fresh.subKeywords = first.coreKeywords;
    const reviewed = new Date(Date.now() - 3 * 86_400_000);
    const state = plugin.fsrs.rate(undefined, 3, reviewed, second.id);
    const withDue = stability => ({ ...state, card: { ...state.card, stability, due: new Date(Date.now() + 3 * 86_400_000).toISOString() } });
    plugin.store.reviews = { [first.id]: withDue(2), [second.id]: withDue(1) };
    plugin.store.settings.studyManagement.newCardsPerDay = 0;
    plugin.store.settings.studyManagement.reviewsPerDay = 0;
    plugin.showKeywordMeaning = vi.fn();
    plugin.store.setReview = vi.fn(async (id, review) => { plugin.store.reviews[id] = review; });
    view.render();
    const radar = root.querySelector(".mia-keyword-radar");
    expect(radar.querySelectorAll("li")).toHaveLength(1);
    expect(radar.textContent).toContain("2/6 학습");
    button(radar, first.coreKeywords[0].label).click();
    expect(plugin.showKeywordMeaning).toHaveBeenCalledWith(first.coreKeywords[0].target, first.coreKeywords[0].label, first.filePath);
    const sort = root.querySelector(".mia-keyword-toolbar select");
    sort.value = "weak";
    sort.dispatchEvent(new window.Event("change"));
    expect(root.querySelector(".mia-keyword strong").textContent).toBe(first.coreKeywords[0].label);
    expect(plugin.fsrs.isDue(plugin.store.reviews[second.id], new Date())).toBe(false);
    // The existing connected-question test still uses the managed eligibility rules.
    button(root, "연결 문제 시험").click();
    expect(view.getState().queue).toEqual([]);
    await view.setState({ route: "keywords" }, {});
    button(root, "이 개념 학습").click();
    expect(view.getState().queue.slice(0, 2)).toEqual([second.id, first.id]);
    expect(view.getState().queue).toContain(fresh.id);
    root.querySelector(".mia-reveal").click();
    const expected = plugin.fsrs.rate(plugin.store.reviews[second.id], 3, new Date(), second.id);
    root.querySelector(".mia-ratings [data-grade='3']").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.store.setReview.mock.calls[0][1].card).toEqual(expected.card);
    expect(view.getState().queue[view.getState().queueIndex]).toBe(first.id);
  });
});

it.each(["dashboard", "progress"])("only redraws for visible target or forecast changes during %s polling", async route => {
  const { view, root } = await renderLayoutCase({ route, targets: true });
  const { store, fsrs } = view.plugin;
  const session = await openWithTimers(view);
  try {
    const selector = route === "dashboard" ? ".mia-target-strip" : ".mia-review-forecast";
    const before = root.querySelector(selector);
    const forecastCount = element => Number(element.querySelectorAll(".mia-forecast-column")[6].title.match(/(\d+)문제/)[1]);
    const count = route === "progress" ? forecastCount(before) : 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector(selector)).toBe(before);
    if (route === "dashboard") {
      store.settings.targetDates[1].label = "모의 면접";
    } else {
      const rated = { ...store.reviews["q-1"], card: { ...store.reviews["q-1"].card } };
      rated.card.due = new Date(Date.now() + 6 * 86_400_000).toISOString();
      store.reviews = { ...store.reviews, "q-1": rated };
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector(selector)).not.toBe(before);
    if (route === "dashboard") expect(root.querySelector(selector).textContent).toContain("모의 면접");
    else expect(forecastCount(root.querySelector(selector))).toBe(count + 1);
  } finally { await session.close(); }
});
