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
    "subject-editor": () => new SubjectEditorModal(app, "전자공학", async () => {}),
    "question-editor": () => new ManagedQuestionModal(app, ["전자공학", "통계이론"], "", question, new Map(), async () => {}, plugin.index.registered),
    "question-create": () => new ManagedQuestionModal(app, ["전자공학", "통계이론"], "", null, new Map(), async () => {}, plugin.index.registered),
    "keyword-editor": () => new KeywordEditorModal(app, { name: "재료 보존", meaning: "전체 재료량은 일정하다." }, async () => {}),
    metadata: () => new QuestionMetadataModal(app, question, "", async () => {}, id => plugin.index.questionById(id)),
    "follow-up": () => new FollowUpModal(app, question, plugin.index.registered, async () => {}),
    export: () => new SubjectExportModal(app, [{ name: "전자공학", count: 2 }, { name: "통계이론", count: 0 }], async () => {}),
    appearance: () => new StudyAppearanceModal(app, plugin.studyUi, noop),
    controls: () => new StudyControlsModal(app),
    management: () => new StudyManagementModal(app, plugin, noop),
    result: () => new StudyResultModal(app, { total: 8, again: 1, hard: 1, good: 4, easy: 1, skipped: 1, durationSeconds: 120, averageAnswerMs: 1234 }, noop, noop, noop),
    detail: () => new QuestionDetailModal(app, question, review, [], new Map(), {}),
    preview: () => new QuestionPreviewModal(app, question, noop, noop, plugin.studyUi.appearance),
    meaning: () => new KeywordMeaningModal(app, "재료 보존", "재료 보존", "bank.md", ""),
    "settings-conflict": () => new SettingsConflictModal(app, DEFAULT_SETTINGS, [{ id: "alternative", settings: DEFAULT_SETTINGS }], async () => {}),
    "review-conflict": () => new ReviewConflictModal(app, { q: [review] }, () => question.heading),
  };
  for (const [name, factory] of Object.entries(modals)) {
    const modal = factory();
    await modal.onOpen();
    if (["management", "subject-editor", "question-editor", "question-create", "keyword-editor", "metadata", "follow-up"].includes(name)) { modal.containerEl.addClass("mia-keyboard-modal-container"); modal.modalEl.addClass("mia-keyboard-modal", "mia-setting-controls"); }
    await Promise.resolve();
    capture(name, modal.containerEl);
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
  expect(Object.keys(cases)).toHaveLength(42);
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
  if (process.env.MIA_GENERATE_LAYOUT_HARNESS === "1") {
    await mkdir(".claude/slim", { recursive: true });
    // Reuse the exact host defaults; only replace the standalone boot script.
    const base = layoutHarness({ short: cases.hidden });
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
window.miaLayoutReport = () => ({route,device,paneWidth:innerWidth,innerWidth,contentWidth:root.getBoundingClientRect().width,contentSafePaneRatio:1,grids:{},elements:document.querySelectorAll('.view-content *').length});
</script></body></html>`;
    await writeFile(".claude/slim/layout-extra.html", html);
    await writeFile(".claude/slim/layout-extra-cases.json", JSON.stringify(Object.keys(cases)));
  }
});
