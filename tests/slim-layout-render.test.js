import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
vi.mock("obsidian", async () => (await import("./fixtures/slim-layout-obsidian")).slimLayoutBoundary());
import { createLayoutDom, renderLayoutCase } from "./fixtures/study-layout-render";
import { installLayoutOptions, snapshotLayout } from "./fixtures/slim-layout-obsidian";
import { layoutHarness } from "./fixtures/study-layout-harness-template";
import { StudyAppearanceModal } from "../src/ui/study-appearance-modal";
import { StudyControlsModal } from "../src/ui/study-controls-modal";
import { StudyManagementModal } from "../src/ui/study-management-modal";
import { StudyResultModal } from "../src/ui/study-result-modal";
import { QuestionDetailModal } from "../src/ui/question-detail-modal";
import { QuestionPreviewModal } from "../src/ui/question-preview-modal";
import { KeywordMeaningModal } from "../src/ui/keyword-modal";
import { SettingsConflictModal } from "../src/ui/settings-conflict-modal";
import { ReviewConflictModal } from "../src/ui/review-conflict-modal";
import { MiaSettingTab } from "../src/ui/settings-tab";
import { ConfirmDeleteModal, SubjectEditorModal, ManagedQuestionModal, KeywordEditorModal } from "../src/ui/manage-modals";
import { QuestionMetadataModal } from "../src/ui/metadata-modal";
import { FollowUpModal } from "../src/ui/follow-up-modal";
import { SubjectExportModal } from "../src/ui/subject-export-modal";
import { bindKeyboardViewport } from "../src/ui/mobile-keyboard";
import { DEFAULT_SETTINGS } from "../src/core/models";
import { keywordReferencesFromInput } from "../src/core/keyword-path";
let dom;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-16T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(.999999);
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
  dom = createLayoutDom();
  installLayoutOptions(dom);
  vi.stubGlobal("document", dom.window.document); vi.stubGlobal("window", dom.window);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement); vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  dom.window.HTMLElement.prototype.hasClass = function(name) { return this.classList.contains(name); };
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("renders additional real screens and states for computed-style equivalence", async () => {
  const cases = {};
  const confirmationCases = {};
  const capture = (name, root) => { cases[name] = snapshotLayout(root); };
  const render = async (name, options, change) => {
    const state = await renderLayoutCase(options);
    if (change) { await change(state); await Promise.all(state.view.readingRenders); }
    capture(name, state.root);
    await state.view.onClose(); state.root.remove();
    return state;
  };
  const { view } = await render("hidden", { revealed: false });
  await render("long", { long: true });
  await render("no-related", { related: false });
  await render("browse", {}, async ({ view }) => view.setState({ ...view.getState(), sessionMode: "browse" }, {}));
  await render("focus", {}, ({ view }) => { view.plugin.studyUi.updateAppearance({ focus: true }); view.render(); });
  await render("split", {}, ({ view }) => { view.plugin.studyUi.updateAppearance({ answerLayout: "split" }); view.render(); });
  await render("compact", {}, ({ view }) => { view.plugin.studyUi.updateAppearance({ density: "compact" }); view.render(); });
  for (const size of ["small", "large"]) await render(`reading-${size}`, {}, ({ view }) => { view.plugin.studyUi.updateAppearance({ size }); view.render(); });
  await render("blocked", {}, ({ view }) => {
    view.plugin.store.reviews.q = view.plugin.fsrs.rate(undefined, 3, new Date(), "q");
    view.startReview(["q"]);
  });
  await render("waiting", {}, ({ view }) => {
    view.plugin.store.settings.studyManagement.learnAheadMinutes = 0;
    view.plugin.store.reviews.q = view.plugin.fsrs.rate(undefined, 1, new Date(), "q");
    view.queueIndex = view.queue.length; view.render();
  });
  await render("timer-off", { revealed: false }, ({ view }) => { view.plugin.studyUi.updateAppearance({ answerTimer: false }); view.render(); });
  await render("undo", {}, ({ view }) => { view.lastRated = { id: "q", queueIndex: 0, queueBefore: ["q"] }; view.undoFeedback = "암기 평가 저장됨"; view.render(); });
  await render("saving", {}, ({ view }) => { view.beginReviewSave("평가 저장 중…"); view.render(); });
  await render("complete", {}, ({ view }) => { view.resultShown = true; view.queueIndex = view.queue.length; view.render(); });
  for (const route of ["dashboard", "progress", "questions", "keywords", "study"]) {
    await render(`empty-${route}`, { route }, ({ view }) => { view.plugin.index.registered.splice(0); view.queue = []; view.render(); });
  }
  await render("keyboard", { route: "questions" }, ({ view, root }) => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: { height: 360, offsetTop: 0, addEventListener() {}, removeEventListener() {} } });
    // Exercise the real binding rather than hand-author keyboard classes/controls.
    return import("../src/ui/mobile-keyboard").then(({ bindKeyboardViewport }) => { view.keyboardViewport = bindKeyboardViewport(root); });
  });
  const plugin = view.plugin;
  const app = { ...view.app, metadataCache: { getFirstLinkpathDest: () => ({ path: "meaning.md", extension: "md" }) }, vault: { cachedRead: async () => "# 재료 보존\n\n## 의미\n\n전체 재료량은 일정하다." } };
  const question = plugin.index.registered[0];
  question.coreKeywords.forEach(item => { item.raw = item.label; });
  const review = plugin.fsrs.rate(undefined, 3, new Date("2026-11-14T00:00:00Z"), question.id);
  const noop = () => {};
  const modals = {
    "confirm-delete": () => new ConfirmDeleteModal(app, "질문 삭제", "질문과 학습 기록을 삭제합니다.", "삭제", async () => {}),
    "subject-editor": () => new SubjectEditorModal(app, "생명과학", async () => {}),
    "question-editor": () => new ManagedQuestionModal(app, ["생명과학", "통계이론"], "", question, new Map(), async () => {}, plugin.index.registered),
    "question-create": () => new ManagedQuestionModal(app, ["생명과학", "통계이론"], "", null, new Map(), async () => {}, plugin.index.registered),
    "keyword-editor": () => new KeywordEditorModal(app, { name: "재료 보존", meaning: "전체 재료량은 일정하다." }, async () => {}),
    metadata: () => new QuestionMetadataModal(app, question, "", async () => {}, id => plugin.index.questionById(id)),
    "follow-up": () => new FollowUpModal(app, question, plugin.index.registered, async () => {}),
    export: () => new SubjectExportModal(app, [{ name: "지리학", count: 2, weakCount: 0 }, { name: "통계이론", count: 0, weakCount: 0 }], async () => {}, plugin.studyUi),
    appearance: () => new StudyAppearanceModal(app, plugin.studyUi, noop),
    controls: () => new StudyControlsModal(app),
    management: () => new StudyManagementModal(app, plugin, noop),
    result: () => new StudyResultModal(app, { total: 8, again: 1, hard: 1, good: 4, easy: 1, skipped: 1, durationSeconds: 120, averageAnswerMs: 1234 }, noop, noop, noop),
    detail: () => new QuestionDetailModal(app, question, review, [], new Map(), {}),
    preview: () => new QuestionPreviewModal(app, question, noop, noop, plugin.studyUi.appearance),
    meaning: () => new KeywordMeaningModal(app, "재료 보존", "재료 보존", "bank.md", ""),
    "settings-conflict": () => new SettingsConflictModal(app, DEFAULT_SETTINGS, [{ id: "alternative", ancestors: [], settings: DEFAULT_SETTINGS }], async () => {}, async () => {}),
    "review-conflict": () => new ReviewConflictModal(app, { q: [review] }, () => question.heading, async () => {}),
  };
  for (const [name, factory] of Object.entries(modals)) {
    const modal = factory();
    await modal.onOpen();
    if (["management", "subject-editor", "question-editor", "question-create", "keyword-editor", "metadata", "follow-up"].includes(name)) { modal.containerEl.addClass("mia-keyboard-modal-container"); modal.modalEl.addClass("mia-keyboard-modal", "mia-setting-controls"); }
    await Promise.resolve();
    if (name.endsWith("-conflict")) modal.contentEl.querySelectorAll("details").forEach(detail => { detail.open = true; });
    capture(name, modal.containerEl);
    if (name.endsWith("-conflict")) {
      const removeLabel = name === "review-conflict" ? "보관 기록 모두 지우기" : "이 보관 사본 지우기";
      [...modal.contentEl.querySelectorAll("button")].find(el => el.textContent === removeLabel).click();
      const confirmation = document.querySelector(".mia-confirm-modal");
      confirmationCases[`${name}-confirm`] = snapshotLayout(confirmation.closest(".modal-container"));
      [...confirmation.querySelectorAll("button")].find(el => el.textContent === "취소").click();
    }
    if (name === "export") {
      const scope = modal.contentEl.querySelector("select");
      scope.value = "weak";
      scope.dispatchEvent(new window.Event("change"));
      capture("export-empty", modal.containerEl);
    }
    if (name === "question-editor") {
      const binding = bindKeyboardViewport(modal.containerEl, modal.contentEl);
      capture("question-editor-keyboard", modal.containerEl);
      binding.destroy();
    }
    if (name === "management") {
      [...modal.contentEl.querySelectorAll("button")].find(el => el.textContent === "고급 설정").click();
      modal.contentEl.querySelectorAll("details").forEach(el => { el.open = true; });
      capture("management-advanced", modal.containerEl);
    }
    modal.close();
  }
  const settings = new MiaSettingTab(app, plugin); settings.display();
  capture("settings", settings.containerEl);
  [...settings.containerEl.querySelectorAll("button")].find(el => el.textContent === "고급 설정").click();
  settings.containerEl.querySelectorAll("details").forEach(el => { el.open = true; });
  capture("settings-advanced", settings.containerEl);
  settings.hide();
  expect(Object.keys(cases)).toHaveLength(43);
  Object.assign(cases, confirmationCases);
  expect(cases["review-conflict-confirm"]).toContain("보관된 다른 기기 이력만 지웁니다");
  expect(cases["settings-conflict-confirm"]).toContain("선택한 보관 사본만 지웁니다");
  expect(cases.export).toContain("노트 순서");
  expect(cases["export-empty"]).toContain("부족한 문제가 없습니다.");
  expect(cases.hidden).toContain("mia-reveal"); expect(cases.browse).not.toContain("mia-ratings");
  expect(cases["follow-up"]).toContain('type="checkbox"');
  expect(cases.settings).toContain('value="20"');
  expect(cases["settings-conflict"]).toContain("targetRetention");
  expect(cases.meaning).toContain("mia-keyword-meaning"); expect(cases["management-advanced"]).toContain('aria-pressed="true"');
  await render("auto-question", { revealed: false }, ({ view }) => { view.plugin.studyUi.updateAppearance({ autoQuestionSeconds: 10 }); view.render(); });
  await render("auto-answer", {}, ({ view }) => { view.plugin.studyUi.updateAppearance({ autoAnswerSeconds: 5, answerTimer: false }); view.render(); });
  await render("leech-rows", { route: "questions" }, ({ view }) => {
    for (const review of Object.values(view.plugin.store.reviews)) review.card.lapses = 8;
    view.render();
  });
  expect(cases["auto-question"]).toContain("자동 10");
  expect(cases["auto-answer"]).toContain("자동 5");
  expect(cases["leech-rows"]).toContain("mia-leech");
  const names = ["평균", "중앙값", "최빈값", "범위", "사분위수", "백분위수", "누적 도수", "상대 도수"];
  for (const count of [1, 3, 8]) {
    const keywords = keywordReferencesFromInput(names.slice(0, count).join(", "), "키워드");
    const record = { ...question, subject: "통계이론", coreKeywords: keywords.slice(0, 3), subKeywords: keywords.slice(3) };
    const meanings = new Map(keywords.map(({ target, label }) => [target, `${label}의 의미\n둘째 줄\n\n마지막 문단`]));
    const modal = new ManagedQuestionModal(app, ["통계이론"], "키워드", record, meanings, async () => {});
    modal.open();
    const fields = modal.contentEl.querySelectorAll(".mia-keyword-meanings textarea");
    expect(fields).toHaveLength(count);
    expect(fields[0].value).toBe("평균의 의미\n둘째 줄\n\n마지막 문단");
    capture(`question-editor-${count}`, modal.containerEl);
    modal.close();
  }
  if (process.env.MIA_GENERATE_LAYOUT_HARNESS === "1") {
    await mkdir(".claude/slim", { recursive: true });
    // Reuse the exact host defaults; only replace the standalone boot script.
    const base = layoutHarness({ short: cases.hidden }).replace('<link rel="stylesheet"', `<style>
:where(.mia-keyboard-modal-container) { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
:where(.mia-keyboard-modal) { position: relative; max-width: 100%; }
:where(.mia-keyboard-modal .modal-header) { padding: 18px 20px 8px; }
:where(.mia-keyboard-modal .modal-content) { padding: 8px 20px 20px; }
:where(.mia-keyboard-modal .setting-item) { padding-block: 14px; }
:where(.mia-keyboard-modal .setting-item-control) { display: flex; }
</style>
<link rel="stylesheet"`);
    const html = base.slice(0, base.indexOf('<script id="mia-cases"')) + `<script id="mia-extra-cases" type="application/json">${JSON.stringify(cases).replaceAll("<", "\\u003c")}</script>
<script>
const params = new URLSearchParams(location.search), cases = JSON.parse(document.getElementById('mia-extra-cases').textContent);
const route = params.get('route'), device = params.get('device');
document.body.classList.add(device === 'desktop' ? 'is-desktop' : 'is-mobile');
if (device === 'phone') document.body.classList.add('is-phone');
document.querySelector('.view-content').innerHTML = cases[route];
const root = document.querySelector('.mia-view, .modal-container, .vertical-tab-content');
root.dataset.device = device;
const pane = document.querySelector('.workspace-leaf');
Object.assign(pane.style, {left:'0',top:'0',width:innerWidth+'px',height:innerHeight+'px'});
for (const [key,value] of Object.entries({width:innerWidth,height:innerHeight,left:0,top:0,'right-gap':0,'bottom-gap':0})) root.style.setProperty('--mia-pane-'+key,value+'px');
for (const edge of ['Left','Right','Top','Bottom']) root.style.setProperty('--safe-area-inset-'+edge.toLowerCase(),(Number(params.get('safe'+edge))||0)+'px');
root.dataset.viewportHeight = innerHeight < 440 ? 'short' : innerHeight < 600 ? 'compact' : 'regular';
window.miaLayoutReport = () => {
  const surface = root.querySelector('.mia-recovery-modal, .mia-confirm-modal, .mia-editor-modal-long');
  const content = surface?.querySelector('.modal-content');
  return {
    route, device, paneWidth: innerWidth, innerWidth, contentWidth: root.getBoundingClientRect().width,
    contentSafePaneRatio: 1, grids: {}, elements: document.querySelectorAll('.view-content *').length,
    horizontalOverflow: surface && [surface, content, ...surface.querySelectorAll(".mia-keyword-meanings, .setting-item-control, textarea")].some(el => el.scrollWidth > el.clientWidth + 1),
    paneHorizontalOverflow: surface && (Math.min(surface.getBoundingClientRect().left, content.getBoundingClientRect().left) < -1
      || Math.max(surface.getBoundingClientRect().right, content.getBoundingClientRect().right) > innerWidth + 1),
  };
};
</script></body></html>`;
    await writeFile(".claude/slim/layout-extra.html", html);
    await writeFile(".claude/slim/layout-extra-cases.json", JSON.stringify(Object.keys(cases)));
  }
});

async function timedStudy(appearance) {
  const { view, root } = await renderLayoutCase({ revealed: false });
  view.plugin.modalOpenGuard = { open: (_key, create) => create().open() };
  view.plugin.studyUi.updateAppearance(appearance);
  view.startReview(["q", "related"]);
  const saveReview = vi.fn(async (id, state) => { view.plugin.store.reviews[id] = state; });
  view.plugin.store.setReview = saveReview;
  const saveAppearance = changes => {
    root.querySelector(".mia-appearance-button").click();
    const modal = document.querySelector(".mia-appearance-modal");
    for (const [label, value] of changes) {
      const name = [...modal.querySelectorAll(".setting-item-name")].find(el => el.textContent === label);
      const control = name.closest(".setting-item").querySelector("select, input");
      if (control.type === "checkbox") control.checked = value;
      else control.value = value;
      control.dispatchEvent(new window.Event("change"));
    }
    [...modal.querySelectorAll("button")].find(el => el.textContent === "보기 설정 저장").click();
    expect(modal.isConnected).toBe(false);
  };
  return { view, root, saveReview, saveAppearance };
}

it.each([["question", "skip"], ["answer", "skip"], ["answer", "again"]])(
  "stops automatic progress immediately on the %s phase with %s action", async (phase, action) => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const { view, root, saveReview, saveAppearance } = await timedStudy({
      autoQuestionSeconds: 5, autoAnswerSeconds: 3, autoAnswerAction: action,
    });
    const revealed = phase === "answer";
    if (revealed) root.querySelector(".mia-reveal").click();
    const card = root.querySelector(".mia-study-card");
    const history = structuredClone(view.plugin.store.reviews);
    const [lateTick] = intervals.mock.calls.at(-1);
    await vi.advanceTimersByTimeAsync(2000);
    root.scrollTop = 57;
    saveAppearance([[revealed ? "정답 시간" : "질문 시간", "0"]]);
    expect(root.querySelector(".mia-auto-advance")).toBeNull();
    expect(root.querySelector(".mia-study-card")).toBe(card);
    expect(root.scrollTop).toBe(57);
    lateTick();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(view.queueIndex).toBe(0);
    expect(view.answerVisible).toBe(revealed);
    expect(view.plugin.store.reviews).toEqual(history);
    expect(saveReview).not.toHaveBeenCalled();
    await view.onClose();
    expect(view.answerTimer).toBeNull();
  },
);

it("applies a new limit and timer visibility to the current card without resetting recall time or leaking intervals", async () => {
  const active = new Set();
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation((fn, ms) => {
    const id = set(fn, ms);
    if (ms === 1000) active.add(id);
    return id;
  });
  vi.spyOn(globalThis, "clearInterval").mockImplementation(id => { active.delete(id); clear(id); });
  const { view, root, saveAppearance, saveReview } = await timedStudy({ autoQuestionSeconds: 15, answerTimer: true });
  const clock = view.answerClock;
  await vi.advanceTimersByTimeAsync(4000);
  saveAppearance([["질문 시간", "10"], ["답변 타이머", false]]);
  expect(root.querySelector(".mia-auto-advance").textContent).toBe("자동 6");
  expect(root.querySelector(".mia-answer-timer")).toBeNull();
  expect(active.size).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  saveAppearance([["답변 타이머", true]]);
  expect(root.querySelector(".mia-answer-timer").textContent).toBe("0:05");
  expect(view.answerClock).toBe(clock);
  expect(active.size).toBe(1);
  await vi.advanceTimersByTimeAsync(4000);
  expect(view.answerVisible).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(view.answerVisible).toBe(true);
  root.querySelector(".mia-ratings button[data-grade='4']").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(saveReview.mock.calls[0][1].history[0].answer_ms).toBe(10_000);
  await view.onClose();
  expect(active.size).toBe(0);
});

it.each([["skip", "again"], ["again", "skip"]])(
  "restarts an overdue shortened countdown safely and changes the action from %s to %s", async (before, after) => {
    const { view, root, saveAppearance, saveReview } = await timedStudy({
      autoAnswerSeconds: 15, autoAnswerAction: before,
    });
    root.querySelector(".mia-reveal").click();
    await vi.advanceTimersByTimeAsync(6000);
    saveAppearance([["정답 시간", "3"], ["정답 후 동작", after]]);
    expect(root.querySelector(".mia-auto-advance").textContent).toBe("자동 3");
    await vi.advanceTimersByTimeAsync(2000);
    expect(view.queueIndex).toBe(0);
    expect(saveReview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.queueIndex).toBe(1);
    if (after === "again") expect(saveReview.mock.calls[0][1].lastRating).toBe(1);
    else expect(saveReview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveReview).toHaveBeenCalledTimes(after === "again" ? 1 : 0);
    await view.onClose();
  },
);
