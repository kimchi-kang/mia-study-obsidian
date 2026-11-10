import { describe, expect, it, vi } from "vitest";
const modalCapture = vi.hoisted(() => ({ args: null }));
vi.mock("../src/ui/manage-modals", async importOriginal => ({
  ...await importOriginal(),
  ManagedQuestionModal: class { constructor(...args) { modalCapture.args = args; } open() {} },
}));
vi.mock("obsidian", () => ({
  Plugin: class {}, Modal: class {}, ItemView: class {}, PluginSettingTab: class {}, MarkdownView: class {},
  TFile: class {}, TFolder: class {}, Component: class {}, Setting: class {}, Notice: class {}, Platform: { isMobile: true }, normalizePath: path => path,
}));
import { TFile, TFolder } from "obsidian";
import MiaStudyPlugin from "../src/main";
import { QuestionIndex } from "../src/services/question-index";
import { appendManagedQuestion, createSubjectBank } from "../src/core/managed-question";
import { renderSubjectNote } from "../src/core/subject-note";

// Imported questions sit beside the bank (MIA-AGENT.md: save under a new file name).
const bankPath = "MIA/수학/문제은행.md", importPath = "MIA/수학/가져온문제.md", notePath = "MIA/수학/수학 노트.md";
const physicsBank = "MIA/물리/문제은행.md", physicsNote = "MIA/물리/물리 노트.md";
const question = (text) => ({ questionMarkdown: text, answerMarkdown: `${text} 정답`, questionType: "정의형", coreKeywords: [], subKeywords: [] });

async function environment() {
  const root = Object.assign(new TFolder(), { path: "", name: "", children: [] });
  const files = new Map([["", root]]), contents = new Map();
  const add = (path, entry) => {
    const parts = path.split("/"), name = parts.pop(), parent = files.get(parts.join("/"));
    Object.assign(entry, { path, name, ...(entry instanceof TFolder ? { children: [] } : { extension: "md" }) });
    parent.children.push(entry); files.set(path, entry); return entry;
  };
  for (const path of ["MIA", "MIA/수학", "MIA/물리"]) add(path, new TFolder());
  const write = (path, text) => { contents.set(path, text); add(path, new TFile()); };
  write(bankPath, appendManagedQuestion(createSubjectBank("수학"), question("은행 질문"), "mia-q-bank"));
  write(importPath, appendManagedQuestion(appendManagedQuestion("# 가져온 문제\n", question("가져온 질문 하나"), "mia-q-import-one"), question("가져온 질문 둘"), "mia-q-import-two"));
  write(notePath, renderSubjectNote("수학", []));
  write(physicsBank, createSubjectBank("물리"));
  write(physicsNote, renderSubjectNote("물리", []));
  const vault = {
    getRoot: () => root, getAbstractFileByPath: path => files.get(path), getMarkdownFiles: () => [...files.values()].filter(f => f instanceof TFile),
    cachedRead: vi.fn(async file => contents.get(file.path)), read: vi.fn(async file => contents.get(file.path)),
    createFolder: vi.fn(async path => add(path, new TFolder())),
    create: vi.fn(async (path, text) => { contents.set(path, text); return add(path, new TFile()); }),
    process: vi.fn(async (file, update) => { const text = update(contents.get(file.path)); contents.set(file.path, text); return text; }),
  };
  const plugin = new MiaStudyPlugin();
  plugin.app = { vault, fileManager: {} };
  plugin.store = { settings: { sourceRoots: ["MIA"], keywordFolder: "MIA/키워드" }, reviews: {}, getReview: () => undefined, removeReview: vi.fn(async () => {}) };
  plugin.index = new QuestionIndex(plugin.app, () => ["MIA"]);
  await plugin.index.rebuild();
  plugin.followUps.refreshIncoming = vi.fn(async () => {});
  return { plugin, contents };
}

const draftFor = (record, overrides = {}) => ({
  subject: record.subject, questionMarkdown: record.questionMarkdown, answerMarkdown: record.answerMarkdown,
  questionType: record.questionType, coreKeywords: [], subKeywords: [], keywordMeanings: [], ...overrides,
});

describe("subject notes cover every question file in the subject folder", () => {
  it("keeps bank questions in the note after deleting an imported question", async () => {
    const { plugin, contents } = await environment();
    await plugin.deleteManagedQuestion(plugin.index.questionById("mia-q-import-one"));
    const note = contents.get(notePath);
    expect(note).toContain("질문: 은행 질문");
    expect(note).toContain("질문: 가져온 질문 둘");
    expect(note).not.toContain("가져온 질문 하나");
  });

  it("keeps imported questions in the note after editing a bank question", async () => {
    const { plugin, contents } = await environment();
    const bank = plugin.index.questionById("mia-q-bank");
    await plugin.updateManagedQuestion(bank, draftFor(bank, { answerMarkdown: "고친 정답" }));
    const note = contents.get(notePath);
    expect(note).toContain("대답: 고친 정답");
    expect(note).toContain("질문: 가져온 질문 하나");
    expect(note).toContain("질문: 가져온 질문 둘");
  });

  it("lists the bank first and includes imported files when re-syncing all notes", async () => {
    const { plugin, contents } = await environment();
    await plugin.syncAllSubjectNotes(false);
    const note = contents.get(notePath);
    expect(note.indexOf("은행 질문")).toBeGreaterThan(-1);
    expect(note.indexOf("은행 질문")).toBeLessThan(note.indexOf("가져온 질문 하나"));
    expect(note).toContain("가져온 질문 둘");
  });

  it("updates both subjects completely when moving an imported question", async () => {
    const { plugin, contents } = await environment();
    const moved = plugin.index.questionById("mia-q-import-one");
    await plugin.updateManagedQuestion(moved, draftFor(moved, { subject: "물리" }));
    expect(contents.get(notePath)).toContain("질문: 은행 질문");
    expect(contents.get(notePath)).toContain("질문: 가져온 질문 둘");
    expect(contents.get(notePath)).not.toContain("가져온 질문 하나");
    expect(contents.get(physicsNote)).toContain("질문: 가져온 질문 하나");
  });

  it("keeps imported questions in the old subject note when retrying it after a failed move", async () => {
    const { plugin, contents } = await environment();
    const moved = plugin.index.questionById("mia-q-import-one");
    await plugin.openManagedQuestionEditor(moved);
    const save = modalCapture.args[5];
    const realSync = plugin.subjectNotes.sync.bind(plugin.subjectNotes);
    let failures = 1;
    plugin.subjectNotes.sync = async (...args) => { if (failures-- > 0) throw new Error("note write failed"); return realSync(...args); };
    await expect(save(draftFor(moved, { subject: "물리" }))).rejects.toThrow("note write failed");
    await save(draftFor(moved, { subject: "물리" }));
    expect(contents.get(notePath)).toContain("질문: 은행 질문");
    expect(contents.get(notePath)).toContain("질문: 가져온 질문 둘");
    expect(contents.get(notePath)).not.toContain("가져온 질문 하나");
    expect(contents.get(physicsNote)).toContain("질문: 가져온 질문 하나");
  });

  it("does not rewrite subject notes that are already up to date", async () => {
    const { plugin, contents } = await environment();
    await plugin.syncAllSubjectNotes(false);
    const before = new Map(contents);
    plugin.app.vault.process.mockClear(); plugin.app.vault.create.mockClear();
    await plugin.syncAllSubjectNotes(false);
    expect(plugin.app.vault.process).not.toHaveBeenCalled();
    expect(plugin.app.vault.create).not.toHaveBeenCalled();
    expect(contents).toEqual(before);
  });

  it("still refuses to overwrite a note that is no longer a managed subject note", async () => {
    const { plugin, contents } = await environment();
    contents.set(notePath, "# 내 노트\n사용자 내용");
    await expect(plugin.subjectNotes.sync("수학", [])).rejects.toThrow("자동 생성 노트가 아닙니다");
    expect(contents.get(notePath)).toBe("# 내 노트\n사용자 내용");
  });
});

describe("scheduler rebuilds", () => {
  it("keeps the same FsrsService until a scheduling setting changes", async () => {
    const { plugin } = await environment();
    Object.assign(plugin.store.settings, { targetRetention: 0.9, maximumIntervalDays: 36500, gradeIntervalsMinutes: {}, studyManagement: { dayStartsAt: 4, learningSteps: ["1m", "10m"], relearningSteps: ["10m"], fsrsParameters: [], enableFuzz: true } });
    plugin.refreshFsrs();
    const first = plugin.fsrs;
    plugin.store.settings.sourceRoots = ["MIA", "다른"]; // unrelated setting
    plugin.refreshFsrs();
    expect(plugin.fsrs).toBe(first);
    plugin.store.settings.targetRetention = 0.85;
    plugin.refreshFsrs();
    expect(plugin.fsrs).not.toBe(first);
    const second = plugin.fsrs;
    plugin.store.settings.studyManagement = { ...plugin.store.settings.studyManagement, dayStartsAt: 5 };
    plugin.refreshFsrs();
    expect(plugin.fsrs).not.toBe(second);
  });
});
