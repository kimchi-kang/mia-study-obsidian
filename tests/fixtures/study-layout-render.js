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

export async function renderLayoutCase({ long = false, related = true, revealed = true } = {}) {
  const question = {
    id: "q", heading: "재료 보존이란?", questionMarkdown: "재료 보존이란?",
    answerMarkdown: Array.from({ length: long ? 40 : 3 }, (_, i) => `${i + 1}. 전체 재료량은 일정하다.`).join("\n"),
    subject: "전자공학", questionType: "정의형", filePath: "bank.md",
    coreKeywords: [{ target: "재료 보존", label: "재료 보존" }], subKeywords: [], followUpIds: related ? ["related"] : [],
  };
  const questions = related ? [question, { ...question, id: "related", heading: "재료 보존의 예는?" }] : [question];
  const files = new Map();
  const studyApp = { loadLocalStorage: () => null, saveLocalStorage() {}, vault: { adapter: { exists: async path => files.has(path), read: async path => files.get(path), write: async (path, data) => { files.set(path, data); } } } };
  const plugin = {
    manifest: { version: "1.4.22" }, studyUi: new StudyUiStore(studyApp, "layout-harness.json"),
    fsrs: new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 }),
    index: { diagnostics: [], candidates: [], isReady: true, registered: questions, questionById: id => questions.find(q => q.id === id) },
    store: { settings: structuredClone(DEFAULT_SETTINGS), reviews: {}, getReview: () => undefined, getReviewVersion: () => null },
  };
  // Standard density, focus off, medium reading size: include the full reported chrome.
  plugin.studyUi.updateAppearance({ focus: false, density: "detailed", size: "medium" });
  let view;
  const leaf = { app: { workspace: { requestSaveLayout() {} } }, setViewState: async ({ state }) => view.setState(state, {}) };
  view = new MiaStudyView(leaf, plugin);
  document.body.append(view.contentEl);
  view.startReview(["q"]);
  if (revealed) [...view.contentEl.querySelectorAll("button")].find(b => b.textContent === "정답 보기").click();
  await Promise.all(view.readingRenders);
  await Promise.resolve();
  return { view, root: view.contentEl };
}
