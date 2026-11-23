import { createRequire } from "node:module";
import { FsrsService } from "../../src/core/fsrs-service";
import { DEFAULT_SETTINGS } from "../../src/core/models";
import { StudyUiStore } from "../../src/services/study-ui-store";
import { MiaStudyView } from "../../src/ui/study-view";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

export function createLayoutDom() {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const proto = dom.window.HTMLElement.prototype;
  proto.createEl = function(tag, options = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.text !== undefined) element.textContent = options.text;
    if (options.cls) element.className = options.cls;
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
    this.append(element);
    return element;
  };
  proto.createDiv = function(options) { return this.createEl("div", options); };
  proto.createSpan = function(options) { return this.createEl("span", options); };
  proto.empty = function() { this.replaceChildren(); };
  proto.setText = function(text) { this.textContent = text; };
  proto.setAttr = function(name, value) { this.setAttribute(name, value); };
  proto.addClass = function(...names) { this.classList.add(...names); };
  proto.removeClass = function(...names) { this.classList.remove(...names); };
  proto.toggleClass = function(name, on) { this.classList.toggle(name, on); };
  return dom;
}

export async function renderLayoutCase({ long = false, related = true, revealed = true, route = "study", targets = false, history = "default" } = {}) {
  const question = {
    id: "q", heading: "재료 보존이란?", questionMarkdown: "재료 보존이란?",
    answerMarkdown: Array.from({ length: long ? 40 : 3 }, (_, i) => `${i + 1}. 전체 재료량은 일정하다.`).join("\n"),
    subject: "생명과학", questionType: "정의형", filePath: "bank.md",
    coreKeywords: [{ target: "재료 보존", label: "재료 보존" }], subKeywords: [], followUpIds: related ? ["related"] : [],
  };
  let questions = related ? [question, { ...question, id: "related", heading: "재료 보존의 예는?" }] : [question];
  const subjects = ["생명과학", "통계이론", "지리학", "현대미술사", "경제원론", "음악이론"];
  if (route !== "study") questions = Array.from({ length: 48 }, (_, i) => ({
    ...question, id: i === 0 ? "q" : `q-${i}`, subject: subjects[i % subjects.length],
    heading: `${subjects[i % subjects.length]} 개념 ${i + 1}의 원리와 적용은?`,
    coreKeywords: [{ target: `개념 ${i % 12 + 1}`, label: `개념 ${i % 12 + 1}` }],
    subKeywords: [], followUpIds: [],
  }));
  const files = new Map();
  const local = new Map();
  const studyApp = { loadLocalStorage: key => local.get(key), saveLocalStorage: (key, value) => { local.set(key, value); }, vault: { adapter: { exists: async path => files.has(path), read: async path => files.get(path), write: async (path, data) => { files.set(path, data); } } } };
  const plugin = {
    manifest: { version: "1.4.23" }, studyUi: new StudyUiStore(studyApp, "layout-harness.json"),
    fsrs: new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 }),
    index: { diagnostics: [], candidates: [], isReady: true, registered: questions, questionById: id => questions.find(q => q.id === id) },
    listSubjects: () => subjects, listKeywordNotes: () => [],
    questionDetailSource: async question => ({ question, review: plugin.store.getReview(question.id), recommendations: [], meanings: new Map(), actions: {} }),
    store: { settings: structuredClone(DEFAULT_SETTINGS), reviews: {}, getReview: id => plugin.store.reviews[id], getReviewVersion: () => null },
  };
  if (targets) plugin.store.settings.targetDates = [
    { id: "second", label: "연습 시험", date: "2026-12-03", subjects: ["통계이론"] },
    { id: "first", label: "첫 면접", date: "2026-11-28" },
    { id: "past", label: "지난 시험", date: "2026-11-12" },
  ];
  if (route !== "study") {
    for (const [i, item] of questions.entries()) {
      if (i % 3 === 0) continue;
      plugin.store.reviews[item.id] = plugin.fsrs.rate(undefined, i % 4 + 1, new Date("2026-11-14T00:00:00Z"), item.id);
    }
    const reviews = Object.values(plugin.store.reviews);
    if (history === "varied") {
      for (const [day, count] of [[8, 24], [10, 16], [16, 8]]) {
        const review = new Date(2026, 10, day, 5).toISOString();
        for (const state of reviews.slice(0, count)) {
          const log = { ...state.history[0], review, answer_ms: 30_000 };
          if (day === 16) state.history.push(log);
          else state.history.unshift(log);
        }
      }
    }
    if (history === "empty") for (const state of reviews) state.history = [];
    await plugin.studyUi.saveResume({ queue: ["q", "q-1", "q-2"], seed: ["q", "q-1", "q-2"], skipped: [], queueIndex: 1, answerVisible: false, sessionMode: "recall", updatedAt: "2026-11-16T00:00:00Z" });
  }
  // Standard density, focus off, medium reading size: include the full reported chrome.
  plugin.studyUi.updateAppearance({ focus: false, density: "detailed", size: "medium" });
  let view;
  const leaf = { app: { workspace: { requestSaveLayout() {} } }, setViewState: async ({ state }) => view.setState(state, {}) };
  view = new MiaStudyView(leaf, plugin);
  document.body.append(view.contentEl);
  if (route === "questions") view.questionList.selectedId = "q";
  if (route === "study") view.startReview(["q"]);
  else await view.setState({ route }, {});
  if (route === "study" && revealed) [...view.contentEl.querySelectorAll("button")].find(b => b.textContent === "정답 보기").click();
  await Promise.all(view.readingRenders);
  if (route === "questions") {
    await new Promise(resolve => {
      const complete = () => view.contentEl.querySelector(".mia-detail-actions, .mia-detail-panel .mia-warning");
      if (complete()) { resolve(); return; }
      const observer = new window.MutationObserver(() => {
        if (complete()) { observer.disconnect(); resolve(); }
      });
      observer.observe(view.contentEl, { childList: true, subtree: true });
    });
  }
  await Promise.resolve();
  return { view, root: view.contentEl };
}
