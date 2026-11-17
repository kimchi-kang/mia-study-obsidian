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
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

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
