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
    if (route === "dashboard") { expect(root.querySelector(".mia-resume-card")).not.toBeNull(); expect(root.querySelectorAll(".mia-subject-card")).toHaveLength(6); }
    if (route === "progress") expect(root.querySelectorAll(".mia-progress-subject")).toHaveLength(6);
    if (route === "questions") { expect(root.querySelectorAll(".mia-row")).toHaveLength(48); expect(root.querySelector(".mia-detail-panel .mia-answer")).not.toBeNull(); expect(root.querySelector(".mia-warning")).toBeNull(); }
    if (route === "keywords") expect(root.querySelectorAll(".mia-keyword")).toHaveLength(12);
    if (route === "questions") expect(root.querySelector(".mia-status-chips").textContent).toContain("오늘 복습 24학습 전 16▲ 취약 16");
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
      const { root } = await renderLayoutCase({ route });
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
