import { afterEach, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => {
  const { obsidianLayoutBoundary } = await import("./fixtures/study-layout-obsidian");
  const boundary = obsidianLayoutBoundary();
  return { ...boundary, Modal: class {
    constructor(app) { this.app = app; this.modalEl = document.createElement("div"); this.contentEl = this.modalEl.createDiv(); this.titleEl = this.modalEl.createEl("h2"); }
    setTitle(text) { this.titleEl.textContent = text; }
  } };
});
import { MarkdownRenderer, Component } from "obsidian";
import { createLayoutDom } from "./fixtures/study-layout-render";
import { QuestionDetailModal } from "../src/ui/question-detail-modal";
import { QuestionPreviewModal } from "../src/ui/question-preview-modal";
let dom;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(["detail", "preview"])("observes a %s renderer rejection while preserving close cleanup", async kind => {
  dom = createLayoutDom(); vi.stubGlobal("document", dom.window.document);
  const failure = new Error("markdown renderer failed");
  vi.spyOn(MarkdownRenderer, "render").mockRejectedValue(failure);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const unload = vi.spyOn(Component.prototype, "unload");
  const question = { id: "one", heading: "질문", questionMarkdown: "질문", answerMarkdown: "답", subject: "과목", questionType: "정의형", coreKeywords: [], subKeywords: [], filePath: "bank.md" };
  const restore = vi.fn();
  const modal = kind === "detail" ? new QuestionDetailModal({}, question, undefined, [], new Map(), {}) : new QuestionPreviewModal({}, question, () => {}, restore, { size: "medium" });
  await expect(modal.onOpen()).resolves.toBeUndefined();
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  modal.onClose();
  expect(unload).toHaveBeenCalledOnce(); expect(modal.contentEl.children).toHaveLength(0);
  if (kind === "preview") expect(restore).toHaveBeenCalledOnce();
});
