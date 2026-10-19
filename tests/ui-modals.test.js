import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class Element {
    children = []; handlers = new Map(); text = ""; disabled = false; dataset = {};
    constructor(options = {}) { this.text = options.text ?? ""; }
    createEl(tag, options = {}) { const child = new Element(options); child.tag = tag; this.children.push(child); return child; }
    createDiv(options) { return this.createEl("div", options); }
    createSpan(options) { return this.createEl("span", options); }
    empty() { this.children = []; }
    addClass() {} removeClass() {} setAttribute() {} setText(text) { this.text = text; }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    find(text) { return this.children.flatMap(child => [child, child.find(text)]).find(child => child && child.text === text); }
    click() { if (!this.disabled) this.handlers.get("click")?.(); }
  }
  class Setting {
    constructor(parent) { this.parent = parent; }
    setName() { return this; } setDesc() { return this; }
    addDropdown(callback) {
      const select = this.parent.createEl("select");
      callback({ addOption() { return this; }, setValue(value) { select.value = value; return this; }, onChange(handler) { select.handlers.set("change", handler); return this; } }); return this;
    }
    addToggle(callback) {
      const toggle = this.parent.createEl("input");
      callback({ setValue(value) { toggle.value = value; return this; }, onChange(handler) { toggle.handlers.set("change", handler); return this; } }); return this;
    }
    addText(callback) {
      const input = this.parent.createEl("input");
      callback({ setPlaceholder() { return this; }, setValue(value) { input.value = value; return this; }, onChange() { return this; } });
      return this;
    }
    addButton(callback) {
      const button = this.parent.createEl("button");
      callback({ setButtonText(text) { button.text = text; return this; }, setCta() { return this; }, setDisabled(value) { button.disabled = value; return this; }, onClick(handler) { button.addEventListener("click", handler); return this; } });
      return this;
    }
  }
  return {
    Modal: class {
      contentEl = new Element(); modalEl = new Element(); containerEl = new Element(); titleEl = new Element();
      close = vi.fn(); constructor(app) { this.app = app; } setTitle() {}
    },
    Setting, Component: class { load() {} unload() {} }, Notice: class {},
    MarkdownRenderer: { render: async (_app, text, element) => { element.text = text; } },
  };
});
import { MarkdownRenderer } from "obsidian";
import { QuestionPreviewModal } from "../src/ui/question-preview-modal";
import { StudyAppearanceModal } from "../src/ui/study-appearance-modal";
import { StudyUiStore } from "../src/services/study-ui-store";
import { QuestionDetailModal } from "../src/ui/question-detail-modal";
import { QuestionMetadataModal } from "../src/ui/metadata-modal";

const question = { id: "base", heading: "질문", questionMarkdown: "문제", answerMarkdown: "정답", subject: "과목", questionType: "정의형", filePath: "과목A/문제은행.md", coreKeywords: [{ target: "키워드", raw: "키워드", label: "키워드" }], subKeywords: [], followUpIds: ["other"] };

describe("modal interaction regressions", () => {
  it("does not rebuild a closed detail modal after a slow markdown render", async () => {
    let finish;
    const render = vi.spyOn(MarkdownRenderer, "render").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      const modal = new QuestionDetailModal({}, question, undefined, [], new Map(), {});
      const opening = modal.onOpen(); modal.onClose(); finish(); await opening;
      expect(modal.contentEl.children).toHaveLength(0);
    } finally { render.mockRestore(); }
  });
  it("blocks editing, deleting and starting study while a detail rating is saving", async () => {
    let finish;
    const edit = vi.fn(), remove = vi.fn(), study = vi.fn();
    const rate = () => new Promise(resolve => { finish = resolve; });
    const modal = new QuestionDetailModal({}, question, undefined, [], new Map(), { rate, edit, remove, study });
    await modal.onOpen(); modal.contentEl.find("암기").click();
    modal.contentEl.find("질문 수정").click(); modal.contentEl.find("삭제").click(); modal.contentEl.find("학습").click();
    expect(edit).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(study).not.toHaveBeenCalled();
    finish(); await new Promise(resolve => setTimeout(resolve, 0));
  });
  it("previews just the question and answer, restores the reading position callback and offers a separate details action", async () => {
    const details = vi.fn(), restore = vi.fn();
    const modal = new QuestionPreviewModal({}, question, details, restore, { size: "large" });
    await modal.onOpen();
    expect(modal.modalEl.dataset.readingSize).toBe("large");
    expect(modal.contentEl.find("정답")).toBeDefined();
    for (const text of ["못 암기", "학습", "질문 수정", "삭제"]) expect(modal.contentEl.find(text)).toBeUndefined();
    modal.contentEl.find("전체 상세").click(); expect(modal.close).toHaveBeenCalledOnce(); expect(details).toHaveBeenCalledOnce();
    modal.onClose(); expect(restore).toHaveBeenCalledOnce(); expect(modal.contentEl.children).toHaveLength(0);
  });
  it("applies device appearance settings through the controls without closing the modal", () => {
    const saved = new Map(), change = vi.fn();
    const store = new StudyUiStore({ loadLocalStorage: key => saved.get(key), saveLocalStorage: (key, value) => saved.set(key, value) }, "ui.json");
    const modal = new StudyAppearanceModal({}, store, change); modal.onOpen();
    const selects = modal.contentEl.children.filter(item => item.tag === "select");
    const toggles = modal.contentEl.children.filter(item => item.tag === "input");
    selects[0].handlers.get("change")("large"); selects[1].handlers.get("change")("compact");
    toggles[0].handlers.get("change")(true); selects[2].handlers.get("change")("split");
    toggles[1].handlers.get("change")(false); selects[3].handlers.get("change")("firm");
    expect(store.appearance).toEqual({ size: "large", density: "compact", focus: true, answerLayout: "split", swipeEnabled: false, swipeSensitivity: "firm" });
    expect(change).toHaveBeenCalledTimes(6); expect(modal.close).not.toHaveBeenCalled();
  });
  it("preserves another subject's follow-up path when metadata is saved without edits", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const modal = new QuestionMetadataModal({}, question, "키워드", save, id => id === "other" ? { ...question, id, filePath: "과목B/문제은행.md" } : undefined);
    modal.onOpen();
    const field = modal.contentEl.children.filter(child => child.tag === "input").at(-1);
    expect(field.value).toBe("[[과목B/문제은행.md#^other]]");
    await modal.contentEl.find("저장").handlers.get("click")();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ followUpLinks: ["[[과목B/문제은행.md#^other]]"] }));
  });

  it.each([false, true])("serializes different rating/reset buttons and recovers from save failure=%s", async fail => {
    let finish;
    const rate = vi.fn(() => new Promise((resolve, reject) => { finish = () => fail ? reject(Error("disk full")) : resolve(); }));
    const resetReview = vi.fn();
    const modal = new QuestionDetailModal({}, question, undefined, [], new Map(), { rate, resetReview });
    await modal.onOpen();
    const again = modal.contentEl.find("못 암기");
    const good = modal.contentEl.find("암기");
    const reset = modal.contentEl.find("학습 전으로 초기화");
    again.click(); good.click(); reset.click();
    expect(rate).toHaveBeenCalledTimes(1);
    expect(resetReview).not.toHaveBeenCalled();
    expect(good.disabled).toBe(true);
    finish(); await new Promise(resolve => setTimeout(resolve, 0));
    if (fail) {
      expect(again.disabled).toBe(false);
      expect(good.disabled).toBe(false);
      expect(reset.disabled).toBe(true);
      expect(modal.close).not.toHaveBeenCalled();
    } else expect(modal.close).toHaveBeenCalledTimes(1);
  });
});

it("allows undo directly from the final-question completion dialog", async () => {
  const { StudyResultModal } = await import('../src/ui/study-result-modal');
  const undo=vi.fn();
  const modal=new StudyResultModal({}, {total:1,again:0,hard:0,good:1,easy:0,skipped:0,durationSeconds:3},vi.fn(),vi.fn(),undo);
  modal.onOpen();modal.contentEl.find('직전 평가 취소').click();
  expect(modal.close).toHaveBeenCalledOnce();expect(undo).toHaveBeenCalledOnce();
});


describe("subject export chooser", () => {
  it("exports the clicked subject once while busy and shows the saved file", async () => {
    const { SubjectExportModal } = await import("../src/ui/subject-export-modal");
    let finish;
    const save = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const modal = new SubjectExportModal({}, [{ name: "수학", count: 2 }, { name: "역사", count: 1 }], save);
    modal.onOpen();
    const math = modal.contentEl.find("수학 · 2문제");
    const history = modal.contentEl.find("역사 · 1문제");
    const pending = math.handlers.get("click")();
    history.click();
    expect(save).toHaveBeenCalledExactlyOnceWith("수학");
    expect(history.disabled).toBe(true);
    finish({ path: "MIA 출력/수학.docx", count: 2, warnings: [] });
    await pending;
    expect(modal.contentEl.find("2문제 저장 완료: MIA 출력/수학.docx")).toBeDefined();
    expect(modal.contentEl.find("파일 열기")).toBeDefined();
    expect(history.disabled).toBe(false);
  });
  it("recovers from export failure and does not rebuild a dismissed dialog", async () => {
    const { SubjectExportModal } = await import("../src/ui/subject-export-modal");
    const save = vi.fn().mockRejectedValueOnce(Error("disk full"));
    const modal = new SubjectExportModal({}, [{ name: "수학", count: 2 }, { name: "빈 과목", count: 0 }], save);
    modal.onOpen();
    const button = modal.contentEl.find("수학 · 2문제");
    await button.handlers.get("click")();
    expect(button.disabled).toBe(false);
    expect(modal.contentEl.find("빈 과목 · 0문제").disabled).toBe(true);
    expect(modal.contentEl.find("저장하지 못했습니다. 다시 시도해 주세요.")).toBeDefined();
    let finish;
    save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = button.handlers.get("click")();
    modal.onClose();
    finish({ path: "MIA 출력/수학.docx", count: 2, warnings: [] });
    await pending;
    expect(modal.contentEl.children).toHaveLength(0);
  });
  it("explains how to start when there are no registered questions", async () => {
    const { SubjectExportModal } = await import("../src/ui/subject-export-modal");
    const modal = new SubjectExportModal({}, [], vi.fn());
    modal.onOpen();
    expect(modal.contentEl.find("등록된 질문이 없습니다. 먼저 과목과 질문을 추가해 주세요.")).toBeDefined();
  });
});
