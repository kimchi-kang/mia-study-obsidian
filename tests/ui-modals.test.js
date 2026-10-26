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
    constructor(parent) { this.parent = parent; this.controlEl = parent; }
    setName() { return this; } setDesc() { return this; }
    addDropdown(callback) {
      const select = this.parent.createEl("select");
      callback({ addOption() { return this; }, setValue(value) { select.value = value; return this; }, setDisabled(value) { select.disabled = value; return this; }, onChange(handler) { select.handlers.set("change", handler); return this; } }); return this;
    }
    addToggle(callback) {
      const toggle = this.parent.createEl("input");
      callback({ setValue(value) { toggle.value = value; return this; }, onChange(handler) { toggle.handlers.set("change", handler); return this; } }); return this;
    }
    addText(callback) {
      const input = this.parent.createEl("input");
      callback({ setPlaceholder() { return this; }, setValue(value) { input.value = value; return this; }, onChange(handler) { input.handlers.set("change", handler); return this; } });
      return this;
    }
    addTextArea(callback) {
      const input = this.parent.createEl("textarea");
      callback({ inputEl: input, setPlaceholder() { return this; }, setValue(value) { input.value = value; return this; }, onChange(handler) { input.handlers.set("change", handler); return this; } }); return this;
    }
    addSearch(callback) { return this.addText(callback); }
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
  it("applies device appearance settings only after saving", () => {
    const saved = new Map(), change = vi.fn();
    const store = new StudyUiStore({ vault: { adapter: { exists: async()=>false, read: async()=>{throw Error("unexpected file read");}, write: async()=>{throw Error("unexpected file write");} } }, loadLocalStorage: key => saved.get(key), saveLocalStorage: (key, value) => saved.set(key, value) }, "ui.json");
    const modal = new StudyAppearanceModal({}, store, change); modal.onOpen();
    const selects = modal.contentEl.children.filter(item => item.tag === "select");
    const toggles = modal.contentEl.children.filter(item => item.tag === "input");
    selects[0].handlers.get("change")("large"); selects[1].handlers.get("change")("compact");
    toggles[0].handlers.get("change")(true); selects[2].handlers.get("change")("split");
    toggles[1].handlers.get("change")(false); selects[4].handlers.get("change")("firm"); selects[3].handlers.get("change")("sequential");
    expect(change).not.toHaveBeenCalled();
    modal.contentEl.find("보기 설정 저장").click();
    expect(store.appearance).toEqual({ size: "large", density: "compact", focus: true, answerLayout: "split", swipeEnabled: false, swipeSensitivity: "firm", memorizationOrder: "sequential" });
    expect(change).toHaveBeenCalledOnce(); expect(modal.close).toHaveBeenCalledOnce();
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


it("opens desktop exports through the system and offers the saved folder", async () => {
  const { SubjectExportModal } = await import("../src/ui/subject-export-modal");
  const openFile = vi.fn().mockResolvedValue(undefined), revealFile = vi.fn();
  const openLinkText = vi.fn();
  const save = vi.fn().mockResolvedValue({ path: "/example/Downloads/수학.docx", count: 2, warnings: [], openFile, revealFile });
  const modal = new SubjectExportModal({ workspace: { openLinkText } }, [{ name: "수학", count: 2 }], save, "다운로드 폴더");
  modal.onOpen();
  expect(modal.contentEl.children.some(child => child.text.includes("저장 위치: 다운로드 폴더"))).toBe(true);
  await modal.contentEl.find("수학 · 2문제").handlers.get("click")();
  modal.contentEl.find("파일 열기").click();
  modal.contentEl.find("저장 폴더에서 보기").click();
  expect(openFile).toHaveBeenCalledOnce(); expect(revealFile).toHaveBeenCalledOnce();
  expect(openLinkText).not.toHaveBeenCalled();
});


import { ManagedQuestionModal } from "../src/ui/manage-modals";
import { appendManagedQuestion, createSubjectBank } from "../src/core/managed-question";
import { parseQuestionFile } from "../src/core/question-parser";
import { MAX_FOLLOW_UPS } from "../src/core/follow-up";

describe("manual question follow-up selection", () => {
  function editor(questions) {
    const save = vi.fn().mockResolvedValue(undefined);
    const modal = new ManagedQuestionModal({}, ["과목"], "키워드", null, new Map(), save, questions);
    modal.onOpen();
    const inputs = modal.contentEl.children.filter(child => child.tag === "input");
    inputs[1].handlers.get("change")("핵심");
    const areas = modal.contentEl.children.filter(child => child.tag === "textarea");
    areas[0].handlers.get("change")("새 질문"); areas[1].handlers.get("change")("새 정답");
    return { modal, save, search: inputs.at(-1).handlers.get("change"), submit: () => modal.contentEl.find("저장").handlers.get("click")() };
  }
  const other = { ...question, id: "mia-q-other", heading: "연결 질문", subject: "다른 과목", filePath: "다른 과목/문제은행.md" };
  it("searches, selects, deselects and writes cross-subject links into the saved bank", async () => {
    const ui = editor([other, { ...other, id: "mia-q-second", heading: "두 번째" }]);
    ui.search("연결 질문");
    expect(ui.modal.contentEl.find("다른 과목 · 두 번째")).toBeUndefined();
    ui.modal.contentEl.find("다른 과목 · 연결 질문").click();
    ui.search("검색 결과 없음");
    expect(ui.modal.contentEl.find("다른 과목 · 연결 질문 · 선택 해제")).toBeDefined();
    ui.modal.contentEl.find("다른 과목 · 연결 질문 · 선택 해제").click();
    ui.search("연결 질문"); ui.modal.contentEl.find("다른 과목 · 연결 질문").click();
    await ui.submit();
    const draft = ui.save.mock.calls[0][0];
    expect(draft.followUpLinks).toEqual(["[[다른 과목/문제은행#^mia-q-other|연결 질문]]"]);
    const bank = appendManagedQuestion(createSubjectBank("과목"), draft, "mia-q-new");
    expect(parseQuestionFile("과목/문제은행.md", bank).questions[0].followUpIds).toEqual(["mia-q-other"]);
  });
  it("allows saving with no follow-ups and caps selections at the supported limit", async () => {
    const empty = editor([]); await empty.submit();
    expect(empty.save).toHaveBeenCalledWith(expect.objectContaining({ followUpLinks: [] }));
    const ui = editor(Array.from({ length: MAX_FOLLOW_UPS + 1 }, (_, i) => ({ ...other, id: `mia-q-${i}`, heading: `질문 ${i}` })));
    for (let i = 0; i < MAX_FOLLOW_UPS; i++) ui.modal.contentEl.find(`다른 과목 · 질문 ${i}`).click();
    expect(ui.modal.contentEl.find(`다른 과목 · 질문 ${MAX_FOLLOW_UPS}`).disabled).toBe(true);
    await ui.submit(); expect(ui.save.mock.calls[0][0].followUpLinks).toHaveLength(MAX_FOLLOW_UPS);
  });
  it("keeps existing links untouched when editing an existing question", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const modal = new ManagedQuestionModal({}, ["과목"], "키워드", question, new Map(), save, [other]);
    modal.onOpen(); await modal.contentEl.find("저장").handlers.get("click")();
    expect(save.mock.calls[0][0].followUpLinks).toBeUndefined();
  });
});


describe("preview question-only markdown", () => {
  it.each(["$E=mc^2$", "$\\frac{a}{b}$"])("renders the matching title once: %s", async text => {
    const render = vi.spyOn(MarkdownRenderer, "render");
    try {
      const modal = new QuestionPreviewModal({}, { ...question, heading: text, questionMarkdown: text }, vi.fn(), vi.fn(), { size: "large" });
      await modal.onOpen();
      const calls = render.mock.calls.filter(call => call[1] === text);
      expect(calls).toHaveLength(1);
      expect(calls[0][2].tag).toBe("h3");
      expect(calls[0][3]).toBe(question.filePath);
    } finally { render.mockRestore(); }
  });
});

describe("keyword meaning dialog lifetime", () => {
  it.each([false, true])("ignores a read completing after close (failure=%s)", async fail => {
    const { KeywordMeaningModal } = await import("../src/ui/keyword-modal");
    let finish;
    const app = { metadataCache: { getFirstLinkpathDest: () => ({ path: "keyword.md" }) }, vault: {
      cachedRead: () => new Promise((resolve, reject) => { finish = () => fail ? reject(Error("read failed")) : resolve("meaning"); }),
    } };
    const render = vi.spyOn(MarkdownRenderer, "render");
    try {
      const modal = new KeywordMeaningModal(app, "keyword", "키워드", "source.md", "keywords");
      const pending = modal.onOpen(); modal.onClose(); finish(); await pending;
      expect(render).not.toHaveBeenCalled();
      expect(modal.contentEl.children).toHaveLength(0);
    } finally { render.mockRestore(); }
  });
  it("does not append controls after a closed dialog's slow renderer finishes", async () => {
    const { KeywordMeaningModal } = await import("../src/ui/keyword-modal");
    let finish;
    const app = { metadataCache: { getFirstLinkpathDest: () => ({ path: "keyword.md" }) }, vault: { cachedRead: async () => "meaning" } };
    const render = vi.spyOn(MarkdownRenderer, "render").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      const modal = new KeywordMeaningModal(app, "keyword", "키워드", "source.md", "keywords");
      const pending = modal.onOpen(); await Promise.resolve(); modal.onClose(); finish(); await pending;
      expect(modal.contentEl.children).toHaveLength(0);
    } finally { render.mockRestore(); }
  });
  it("still renders a readable note and reports an active read failure", async () => {
    const { KeywordMeaningModal } = await import("../src/ui/keyword-modal");
    const cachedRead = vi.fn().mockResolvedValueOnce("meaning").mockRejectedValueOnce(Error("read failed"));
    const app = { metadataCache: { getFirstLinkpathDest: () => ({ path: "keyword.md" }) }, vault: { cachedRead } };
    const modal = new KeywordMeaningModal(app, "keyword", "키워드", "source.md", "keywords");
    await modal.onOpen(); expect(modal.contentEl.find("키워드 노트 열기")).toBeDefined(); modal.onClose();
    await modal.onOpen(); expect(modal.contentEl.find("키워드 노트를 읽지 못했습니다: read failed")).toBeDefined();
  });
});

it.each([1, 2])("reports invalid keyword input and permits correction without losing the question (field=%s)", async fieldIndex => {
  const { ManagedQuestionModal } = await import("../src/ui/manage-modals");
  const save = vi.fn().mockResolvedValue(undefined);
  const modal = new ManagedQuestionModal({}, ["과목"], "키워드", question, new Map(), save);
  modal.onOpen();
  const inputs = modal.contentEl.children.filter(child => child.tag === "input");
  inputs[fieldIndex].handlers.get("change")("잘못된\u0001키워드");
  const button = modal.contentEl.find("저장");
  await expect(button.handlers.get("click")()).resolves.toBeUndefined();
  expect(save).not.toHaveBeenCalled(); expect(modal.close).not.toHaveBeenCalled(); expect(button.disabled).toBe(false);
  inputs[fieldIndex].handlers.get("change")("정상키워드");
  await button.handlers.get("click")();
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0]).toMatchObject({ questionMarkdown: "문제", answerMarkdown: "정답" });
  expect(modal.close).toHaveBeenCalledOnce();
});
