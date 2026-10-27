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

it("keeps the committed ID snapshot for retry when a derived note fails and returns only on close",async()=>{
  const plugin=new MiaStudyPlugin();plugin.app={};plugin.store={settings:{keywordFolder:"MIA/키워드"}};
  const original={id:"mia-q-current",subject:"과목",questionMarkdown:"질문",answerMarkdown:"정답"};
  const committed={...original,answerMarkdown:"수정 정답"};
  plugin.index={registered:[original],questionById:id=>id===original.id?original:undefined};
  plugin.listSubjects=()=>["과목"];plugin.loadKeywordMeanings=async()=>new Map();
  plugin.updateManagedQuestion=vi.fn().mockImplementationOnce(async(_question,_draft,persisted)=>{persisted(committed);throw Error("derived note failed");}).mockResolvedValue(undefined);
  const closed=vi.fn(),saved=vi.fn();await plugin.openManagedQuestionEditor(original,closed,saved);
  const args=dialogs.questions.at(-1),draft={answerMarkdown:"수정 정답"};
  await expect(args[5](draft)).rejects.toThrow("derived note failed");expect(saved).not.toHaveBeenCalled();expect(closed).not.toHaveBeenCalled();
  await args[5](draft);expect(plugin.updateManagedQuestion.mock.calls[1][0]).toEqual(committed);expect(saved).toHaveBeenCalledOnce();
  args[7]();expect(closed).toHaveBeenCalledOnce();
});

it("does not open an editor whose session was cancelled during keyword loading",async()=>{
  const plugin=new MiaStudyPlugin();plugin.app={};plugin.store={settings:{keywordFolder:"MIA/키워드"}};
  const question={id:"mia-q-a",subject:"과목"};plugin.index={registered:[question],questionById:()=>question};plugin.listSubjects=()=>["과목"];
  let resolve;plugin.loadKeywordMeanings=()=>new Promise(r=>{resolve=r;});let active=true;
  const before=dialogs.questions.length,pending=plugin.openManagedQuestionEditor(question,()=>{},()=>{},()=>active);
  active=false;resolve(new Map());await pending;expect(dialogs.questions).toHaveLength(before);
});

it.each(["deleted", "changed"])("rejects a source %s while the editor's keyword read was pending",async(kind)=>{
  const plugin=new MiaStudyPlugin();plugin.app={};plugin.store={settings:{keywordFolder:"MIA/키워드"}};
  const original={id:"mia-q-pending",subject:"과목",answerMarkdown:"원본"};let current=original;
  plugin.index={registered:[original],questionById:()=>current};plugin.listSubjects=()=>["과목"];
  let resolve;plugin.loadKeywordMeanings=()=>new Promise(r=>{resolve=r;});const before=dialogs.questions.length;
  const pending=plugin.openManagedQuestionEditor(original,()=>{},()=>{},()=>true);
  current=kind==="deleted"?undefined:{...original,answerMarkdown:"외부 수정"};resolve(new Map());
  await expect(pending).rejects.toThrow(kind==="deleted"?/찾을/:/변경/);expect(dialogs.questions).toHaveLength(before);
});
