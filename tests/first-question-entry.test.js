import { it, expect, vi } from "vitest";
const dialogs = vi.hoisted(() => ({ questions: [], subjects: [] }));
vi.mock("../src/ui/manage-modals", () => ({
  ManagedQuestionModal: class { constructor(...args) { dialogs.questions.push(args); } open() {} },
  SubjectEditorModal: class { constructor(...args) { dialogs.subjects.push(args); } open() {} },
  ConfirmDeleteModal: class {}, KeywordEditorModal: class {},
}));
vi.mock("obsidian", () => ({
  Plugin: class {}, Modal: class {}, ItemView: class {}, PluginSettingTab: class {}, MarkdownView: class {},
  TFile: class {}, TFolder: class {}, Component: class {}, Setting: class {}, Notice: class {}, Platform: { isMobile: false }, normalizePath: path => path,
}));
import MiaStudyPlugin from "../src/main";
it("opens the question editor directly with no subjects and submits the new subject in the same draft", async () => {
  const plugin = new MiaStudyPlugin();
  plugin.app = {};
  plugin.store = { settings: { keywordFolder: "MIA/키워드" } };
  plugin.index = { registered: [] };
  plugin.listSubjects = () => [];
  plugin.createManagedQuestion = vi.fn().mockResolvedValue(undefined);
  await plugin.openManagedQuestionEditor();
  expect(dialogs.subjects).toHaveLength(0);
  expect(dialogs.questions).toHaveLength(1);
  const args = dialogs.questions[0];
  expect(args[1]).toEqual([]);
  const draft = { subject: "첫 과목", questionMarkdown: "질문", answerMarkdown: "정답", coreKeywords: [], subKeywords: [], keywordMeanings: [] };
  await args[5](draft);
  expect(plugin.createManagedQuestion).toHaveBeenCalledExactlyOnceWith(draft);
});
