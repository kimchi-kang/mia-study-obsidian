import { describe, expect, it, vi } from "vitest";
const followUpWindows = vi.hoisted(() => []);
const notices = vi.hoisted(() => []);
vi.mock("../src/ui/follow-up-modal", () => ({ FollowUpModal: class {
  constructor(app, base, questions, submit) { followUpWindows.push({ base, questions, submit }); }
  open() {}
} }));
vi.mock("obsidian",()=>({
  Plugin:class {},Modal:class {},ItemView:class {},PluginSettingTab:class {},MarkdownView:class {},
  TFile:class {},TFolder:class {},Component:class {},Setting:class {},Notice:class { constructor(message) { notices.push(message); } },Platform:{isMobile:true},normalizePath:path=>path,
}));
import { TFile,TFolder } from "obsidian";
import MiaStudyPlugin from "../src/main";
import { QuestionIndex } from "../src/services/question-index";
import { appendManagedQuestion,createSubjectBank } from "../src/core/managed-question";
import { readKeywordMeaning } from "../src/core/keyword-note";
import { MAX_FOLLOW_UPS, questionBlockLink } from "../src/core/follow-up";
import { parseQuestionFile } from "../src/core/question-parser";
import { renderSubjectNote } from "../src/core/subject-note";

const oldPath="MIA/수학/문제은행.md",nextPath="MIA/물리/문제은행.md";
const input={questionMarkdown:"원래 질문",answerMarkdown:"원래 정답",questionType:"정의형",coreKeywords:[],subKeywords:[]};
async function environment({sourceFailure,rollbackFailure=false,afterInsert}={}){
  const root=Object.assign(new TFolder(),{path:"",name:"",children:[]});
  const files=new Map([["",root]]),contents=new Map();
  const add=(path,entry)=>{
    const parts=path.split("/"),name=parts.pop(),parent=files.get(parts.join("/"));
    Object.assign(entry,{path,name,...(entry instanceof TFolder?{children:[]}:{extension:"md"})});
    parent.children.push(entry);files.set(path,entry);return entry;
  };
  for(const path of ["MIA","MIA/수학","MIA/물리"])add(path,new TFolder());
  for(const path of [oldPath,nextPath])add(path,new TFile());
  const source=appendManagedQuestion(createSubjectBank("수학"),input,"mia-q-one").replace("> 보조:","> 보조:\n> 사용자 메모: 이동해도 보존\n> <!-- 이동 보존 주석 -->");
  contents.set(oldPath,source);contents.set(nextPath,createSubjectBank("물리"));
  let destinationWrites=0;
  const vault={
    getRoot:()=>root,getAbstractFileByPath:path=>files.get(path),getMarkdownFiles:()=>[...files.values()].filter(f=>f instanceof TFile),
    cachedRead:vi.fn(async file=>contents.get(file.path)),read:vi.fn(async file=>contents.get(file.path)),
    createFolder:vi.fn(async path=>add(path,new TFolder())),
    create:vi.fn(async(path,text)=>{contents.set(path,text);return add(path,new TFile());}),
    process:vi.fn(async(file,update)=>{
      if(file.path===nextPath && ++destinationWrites>1 && rollbackFailure)throw Error("rollback blocked");
      const text=update(contents.get(file.path));
      if(file.path===oldPath && sourceFailure==="before")throw Error("source write failed");
      contents.set(file.path,text);
      if(file.path===nextPath && destinationWrites===1)afterInsert?.(contents);
      if(file.path===oldPath && sourceFailure==="after")throw Error("source error after persistence");
    }),
  };
  const plugin=new MiaStudyPlugin();plugin.app={vault,metadataCache:{getFirstLinkpathDest:()=>null}};plugin.store={settings:{sourceRoots:["MIA"],keywordFolder:"MIA/키워드"},reviews:{}};
  plugin.index=new QuestionIndex(plugin.app,()=>["MIA"]);await plugin.index.rebuild();
  const question=plugin.index.questionById("mia-q-one");
  const draft={...input,subject:"물리",keywordMeanings:[]};
  const count=path=>parseQuestionFile(path,contents.get(path)).questions.filter(q=>q.id==="mia-q-one").length;
  const trashFile=vi.fn(async file=>{for(const path of [...files.keys()])if(path===file.path||path.startsWith(file.path+"/")){files.delete(path);contents.delete(path);}});
  const renameFile=vi.fn(async(file,next)=>{
    const old=file.path;
    for(const [path,entry] of [...files])if(path===old||path.startsWith(old+"/")){
      const renamed=next+path.slice(old.length);files.delete(path);files.set(renamed,entry);entry.path=renamed;entry.name=renamed.split("/").at(-1);
      if(contents.has(path)){contents.set(renamed,contents.get(path));contents.delete(path);}
    }
  });
  plugin.app.fileManager={trashFile,renameFile};
  return{plugin,vault,contents,question,draft,count,source,files,add,trashFile,renameFile};
}

describe("question move failure boundaries",()=>{
  it("moves unknown metadata with the stable ID and retains one copy",async()=>{
    const env=await environment();await env.plugin.moveManagedQuestion(env.question,env.draft);
    expect(env.count(oldPath)).toBe(0);expect(env.count(nextPath)).toBe(1);
    expect(env.contents.get(nextPath)).toContain("> 사용자 메모: 이동해도 보존");
    expect(env.contents.get(nextPath)).toContain("> <!-- 이동 보존 주석 -->");
  });
  it("rolls back just the inserted destination question when the source write failed before persistence",async()=>{
    const env=await environment({sourceFailure:"before"});
    await expect(env.plugin.moveManagedQuestion(env.question,env.draft)).rejects.toThrow("source write failed");
    expect(env.contents.get(oldPath)).toBe(env.source);expect(env.count(nextPath)).toBe(0);
  });
  it("does not delete the only remaining question after a source write persisted and then rejected",async()=>{
    const env=await environment({sourceFailure:"after"});
    await expect(env.plugin.moveManagedQuestion(env.question,env.draft)).resolves.toBeUndefined();
    expect(env.count(oldPath)).toBe(0);expect(env.count(nextPath)).toBe(1);
  });
  it("refuses a stale source before mutating the destination",async()=>{
    const env=await environment();env.contents.set(oldPath,env.source.replace("원래 정답","다른 기기의 정답"));
    await expect(env.plugin.moveManagedQuestion(env.question,env.draft)).rejects.toThrow(/변경/);
    expect(env.count(nextPath)).toBe(0);expect(env.vault.process).not.toHaveBeenCalled();
  });
  it("preserves both sides and reports incomplete recovery if compensation cannot be written",async()=>{
    const env=await environment({sourceFailure:"before",rollbackFailure:true});
    await expect(env.plugin.moveManagedQuestion(env.question,env.draft)).rejects.toThrow(/되돌리|복구/);
    expect(env.count(oldPath)).toBe(1);expect(env.count(nextPath)).toBe(1);
  });
  it("preserves an externally edited destination when the source write fails",async()=>{
    const env=await environment({sourceFailure:"before",afterInsert:contents=>contents.set(nextPath,contents.get(nextPath).replace("원래 정답","대상에서 추가 수정한 정답"))});
    await expect(env.plugin.moveManagedQuestion(env.question,env.draft)).rejects.toThrow(/되돌리|복구/);
    expect(env.count(oldPath)).toBe(1);expect(env.contents.get(nextPath)).toContain("대상에서 추가 수정한 정답");
  });
  it("preserves newly added unknown metadata in the destination during failed compensation",async()=>{
    const env=await environment({sourceFailure:"before",afterInsert:contents=>contents.set(nextPath,contents.get(nextPath).replace("> 보조:","> 보조:\n> 외부 메모: 반드시 보존"))});
    await expect(env.plugin.moveManagedQuestion(env.question,env.draft)).rejects.toThrow(/복구/);
    expect(env.count(oldPath)).toBe(1);expect(env.contents.get(nextPath)).toContain("외부 메모: 반드시 보존");
  });
  it("retains source metadata added between destination insertion and source deletion",async()=>{
    const env=await environment({afterInsert:contents=>contents.set(oldPath,contents.get(oldPath).replace("> 보조:","> 보조:\n> 외부 메모: 원본 보존"))});
    await expect(env.plugin.moveManagedQuestion(env.question,env.draft)).rejects.toThrow(/변경/);
    expect(env.contents.get(oldPath)).toContain("외부 메모: 원본 보존");expect(env.count(nextPath)).toBe(0);
  });
  it("does not guess whether to delete the destination when the failed source cannot be read back",async()=>{
    const env=await environment({sourceFailure:"before"});
    env.vault.read.mockResolvedValueOnce(env.source).mockRejectedValueOnce(Error("readback unavailable"));
    await expect(env.plugin.moveManagedQuestion(env.question,env.draft)).rejects.toThrow(/확인|복구/);
    expect(env.count(oldPath)).toBe(1);expect(env.count(nextPath)).toBe(1);
  });
});

describe("subject notes for questions outside the managed folder", () => {
  it.each(["edit", "delete", "move"])("does not create a subject folder for an external question on %s", async (action) => {
    const env = await environment();
    const externalPath = "통계이론/1장.md";
    const bank = appendManagedQuestion(createSubjectBank("통계이론"), input, "mia-q-external");
    env.add("통계이론", new TFolder());
    env.add(externalPath, new TFile());
    env.contents.set(externalPath, bank);
    env.plugin.store.settings.sourceRoots = ["MIA", "통계이론"];
    env.plugin.index = new QuestionIndex(env.plugin.app, () => env.plugin.store.settings.sourceRoots);
    await env.plugin.index.rebuild();
    const question = env.plugin.index.questionById("mia-q-external");
    expect(question.subject).toBe("미분류");
    env.plugin.store.getReview = () => undefined;
    env.plugin.store.removeReview = vi.fn();
    if (action === "delete") await env.plugin.deleteManagedQuestion(question);
    else await env.plugin.updateManagedQuestion(question, {
      ...env.draft, subject: action === "move" ? "물리" : question.subject, answerMarkdown: "새 정답",
    });

    expect(env.files.has("MIA/미분류")).toBe(false);
    expect(env.contents.has("MIA/미분류/미분류 노트.md")).toBe(false);
    if (action === "move") expect(env.contents.get("MIA/물리/물리 노트.md")).toContain("새 정답");
    const externalQuestions = parseQuestionFile(externalPath, env.contents.get(externalPath)).questions;
    if (action === "edit") expect(externalQuestions[0]?.answerMarkdown).toBe("새 정답");
    else expect(externalQuestions).toEqual([]);
  });

  it("keeps the managed subject after indexing a new question with empty source roots", async () => {
    const env = await environment();
    env.plugin.store.settings.sourceRoots = [];
    env.plugin.index = new QuestionIndex(env.plugin.app, () => [], () => env.plugin.managedRoot);
    const externalPath = "통계이론/1장.md";
    env.add("통계이론", new TFolder());
    env.add(externalPath, new TFile());
    env.contents.set(externalPath, appendManagedQuestion("", input, "mia-q-external"));
    const persisted = vi.fn();
    await env.plugin.createManagedQuestion(env.draft, persisted);
    await env.plugin.index.rebuild();
    const saved = env.plugin.index.questionById(persisted.mock.calls[0][0].id);
    expect(saved.subject).toBe("물리");
    expect(env.plugin.index.questionById("mia-q-external").subject).toBe("통계이론");
    await env.plugin.updateManagedQuestion(saved, { ...env.draft, subject: saved.subject, answerMarkdown: "새 정답" });
    expect(env.contents.get("MIA/물리/물리 노트.md")).toContain("새 정답");
    expect(env.files.has("MIA/MIA")).toBe(false);
    expect(env.contents.has("MIA/MIA/MIA 노트.md")).toBe(false);
  });
});


const keywordPath="MIA/키워드/기존.md",newKeywordPath="MIA/키워드/새이름.md";
const keywordEntry={name:"기존",target:"MIA/키워드/기존",filePath:keywordPath};

describe("keyword cards without a note", () => {
  const name = "표본 분포";
  const target = "자료/표본 분포.md#정의";
  const entry = { name, target };
  const ref = (target) => ({ target, label: name, raw: `[[${target}|${name}]]` });
  const sameNamePath = "MIA/개념/통계이론/표본 분포.md";
  const renamedPath = "MIA/개념/통계이론/표집 분포.md";
  async function referenceEnvironment() {
    const env = await environment();
    env.plugin.store.settings.keywordFolder = "MIA/개념/통계이론";
    env.contents.set(oldPath, appendManagedQuestion("", {
      ...input, coreKeywords: [ref(target)], subKeywords: [ref("자료/표본 분포#예시")],
    }, "mia-q-one"));
    env.contents.set(nextPath, appendManagedQuestion("", {
      ...input, coreKeywords: [ref("다른 폴더/표본 분포"), ref("MIA/개념/통계이론/표집 분포")],
    }, "mia-q-other"));
    await env.plugin.index.rebuild();
    return env;
  }

  it("creates a short-link note through the configured keyword folder without changing question files", async () => {
    const env = await referenceEnvironment();
    const before = new Map(env.contents);
    const short = { name, target: name };
    expect(env.plugin.keywords.withExistingNote(short)).toEqual(short);
    await env.plugin.saveKeyword(short, name, "표본에서 계산한 통계량의 분포");
    expect(readKeywordMeaning(env.contents.get(sameNamePath))).toBe("표본에서 계산한 통계량의 분포");
    expect(env.vault.createFolder.mock.calls).toEqual([["MIA/개념"], ["MIA/개념/통계이론"]]);
    expect(env.vault.process).not.toHaveBeenCalled();
    expect(env.contents.get(oldPath)).toBe(before.get(oldPath));
    expect(env.contents.get(nextPath)).toBe(before.get(nextPath));
  });

  it("creates the note where an explicit-folder link points, so the question link resolves to it", async () => {
    const env = await referenceEnvironment();
    const before = new Map(env.contents);
    await env.plugin.saveKeyword(entry, name, "표본에서 계산한 통계량의 분포");
    // `[[자료/표본 분포.md#정의|표본 분포]]` resolves to 자료/표본 분포.md; the heading is not part of the filename.
    expect(readKeywordMeaning(env.contents.get("자료/표본 분포.md"))).toBe("표본에서 계산한 통계량의 분포");
    expect(env.contents.has(sameNamePath)).toBe(false);
    expect(env.vault.createFolder.mock.calls).toEqual([["자료"]]);
    expect(env.contents.get(oldPath)).toBe(before.get(oldPath));
    expect(env.contents.get(nextPath)).toBe(before.get(nextPath));
  });

  it("applies the same portable path checks as creating a keyword", async () => {
    const env = await referenceEnvironment();
    env.add("MIA/개념", new TFolder());
    env.add("MIA/개념/Statistics", new TFolder());
    env.plugin.store.settings.keywordFolder = "MIA/개념/statistics";
    await expect(env.plugin.saveKeyword({ name, target: name }, name, "의미")).rejects.toThrow(/대소문자/);
    expect(env.vault.create).not.toHaveBeenCalled();
  });

  it("finds an existing note by its explicit path without treating the heading as part of the filename", async () => {
    const env = await referenceEnvironment();
    env.add("자료", new TFolder());
    const path = "자료/표본 분포.md";
    env.add(path, new TFile());
    env.contents.set(path, "# 표본 분포\n\n## 의미\n\n기존 의미\n");
    const existing = env.plugin.keywords.withExistingNote(entry);
    expect(existing.filePath).toBe(path);
    await env.plugin.saveKeyword(existing, name, "갱신한 의미");
    expect(readKeywordMeaning(env.contents.get(path))).toBe("갱신한 의미");
    expect(env.vault.create).not.toHaveBeenCalled();
  });

  it.each(["rename", "delete"])("updates only the matching question references on %s", async action => {
    const env = await referenceEnvironment();
    const other = env.contents.get(nextPath);
    if (action === "rename") await env.plugin.saveKeyword(entry, "표집 분포", "새 의미");
    else await env.plugin.deleteKeyword(entry);
    const question = env.plugin.index.questionById("mia-q-one");
    expect(question.coreKeywords.map(keyword => keyword.target)).toEqual(
      action === "rename" ? [renamedPath.slice(0, -3)] : [],
    );
    expect(question.subKeywords).toEqual([]);
    expect(env.contents.get(nextPath)).toBe(other);
    expect(env.trashFile).not.toHaveBeenCalled();
    expect(env.renameFile).not.toHaveBeenCalled();
    if (action === "rename") expect(readKeywordMeaning(env.contents.get(renamedPath))).toBe("새 의미");
    else expect(env.vault.create).not.toHaveBeenCalled();
  });

  it("restores question references when creating the renamed note fails", async () => {
    const env = await referenceEnvironment();
    const before = new Map(env.contents);
    env.vault.create.mockRejectedValueOnce(Error("disk full"));
    await expect(env.plugin.saveKeyword(entry, "표집 분포", "새 의미")).rejects.toThrow("disk full");
    expect(env.contents).toEqual(before);
  });
});
async function connectedEnvironment(){
  const env=await environment();env.add("MIA/키워드",new TFolder());env.add(keywordPath,new TFile());
  env.contents.set(keywordPath,"# 기존\n\n## 의미\n\n원래 의미\n\n## 연결\n");
  const reference={raw:"[[MIA/키워드/기존|기존]]",target:"MIA/키워드/기존",label:"기존"};
  for(const [path,id] of [[oldPath,"mia-q-one"],[nextPath,"mia-q-two"]]){
    env.contents.set(path,appendManagedQuestion(createSubjectBank(path===oldPath?"수학":"물리"),{...input,coreKeywords:[reference]},id));
  }
  await env.plugin.index.rebuild();return env;
}
function failSecondBank(env,mode="before",afterFailure){
  const process=env.vault.process;
  env.vault.process=vi.fn(async(file,update)=>{
    if(file.path===nextPath){
      if(mode==="after")await process(file,update);
      afterFailure?.();throw Error("second bank failed");
    }
    return process(file,update);
  });
}

describe("multi-file links and keyword failure boundaries",()=>{
  it("does not merge or trash a keyword-list entry containing a question bank", async () => {
    const env = await connectedEnvironment();
    env.files.get(keywordPath).basename = "기존";
    const bank = appendManagedQuestion("# 기존\n\n## 의미\n", input, "mia-q-keyword-bank");
    env.contents.set(keywordPath, bank);
    env.add(newKeywordPath, new TFile()).basename = "새이름";
    env.contents.set(newKeywordPath, "# 새이름\n\n## 의미\n\n대상 뜻\n");
    await env.plugin.index.rebuild();
    const selected = env.plugin.keywords.list().find(entry => entry.filePath === keywordPath);
    expect(selected).toEqual(keywordEntry);

    const before = new Map(env.contents);
    await expect(env.plugin.saveKeyword(selected, "새이름", "")).rejects.toThrow(/문제은행.*병합/);
    expect(env.contents).toEqual(before);
    expect(env.vault.process).not.toHaveBeenCalled();
    expect(env.trashFile).not.toHaveBeenCalled();
  });

  it.each([["rename", "bank"], ["rename", "subject note"], ["delete", "bank"], ["delete", "subject note"]])(
    "rejects keyword %s before touching a protected source %s", async (action, kind) => {
      const env = await connectedEnvironment();
      const source = kind === "bank" ? appendManagedQuestion("# 기존\n\n## 의미\n", input, "mia-q-protected")
        : renderSubjectNote("수학", [input]);
      env.contents.set(keywordPath, source);
      const before = new Map(env.contents);
      const mutation = action === "rename" ? env.plugin.saveKeyword(keywordEntry, "새이름", "뜻")
        : env.plugin.deleteKeyword(keywordEntry);
      await expect(mutation).rejects.toThrow(kind === "bank" ? /문제은행/ : /자동 생성 과목 노트/);
      expect(env.contents).toEqual(before);
      expect(env.renameFile).not.toHaveBeenCalled();
      expect(env.vault.process).not.toHaveBeenCalled();
      expect(env.trashFile).not.toHaveBeenCalled();
    },
  );

  it("rolls back link changes if the keyword source becomes a question bank before trash", async () => {
    const env = await connectedEnvironment();
    const bank = appendManagedQuestion("# 기존\n\n## 의미\n", input, "mia-q-late-protected");
    const expected = new Map(env.contents);
    expected.set(keywordPath, bank);
    const process = env.vault.process;
    let changed = false;
    env.vault.process = vi.fn(async (file, update) => {
      await process(file, update);
      if (file.path === nextPath && !changed) {
        env.contents.set(keywordPath, bank);
        changed = true;
      }
    });
    await expect(env.plugin.deleteKeyword(keywordEntry)).rejects.toThrow(/문제은행.*키워드 삭제/);
    expect(env.contents).toEqual(expected);
    expect(env.trashFile).not.toHaveBeenCalled();
  });

  it.each(["before","after"])("restores both follow-up files when the second write fails %s persistence",async mode=>{
    const env=await connectedEnvironment(),before=new Map(env.contents);failSecondBank(env,mode);
    await expect(env.plugin.applyFollowUpChanges(new Map([["mia-q-one",["mia-q-two"]],["mia-q-two",["mia-q-one"]]]))).rejects.toThrow();
    expect(env.contents.get(oldPath)).toBe(before.get(oldPath));expect(env.contents.get(nextPath)).toBe(before.get(nextPath));
  });
  it("retains an external edit during failed follow-up compensation and reports recovery",async()=>{
    const env=await connectedEnvironment();failSecondBank(env,"before",()=>env.contents.set(oldPath,env.contents.get(oldPath)+"\n外部 메모\n"));
    await expect(env.plugin.applyFollowUpChanges(new Map([["mia-q-one",["mia-q-two"]],["mia-q-two",["mia-q-one"]]]))).rejects.toThrow(/복구/);
    expect(env.contents.get(oldPath)).toContain("外部 메모");
  });
  it("keeps all keyword references and its note when a later reference write fails",async()=>{
    const env=await connectedEnvironment(),before=new Map(env.contents);failSecondBank(env);
    await expect(env.plugin.deleteKeyword(keywordEntry)).rejects.toThrow();
    expect(env.contents.get(oldPath)).toBe(before.get(oldPath));expect(env.contents.get(nextPath)).toBe(before.get(nextPath));
    expect(env.contents.get(keywordPath)).toBe(before.get(keywordPath));expect(env.trashFile).not.toHaveBeenCalled();
  });
  it("restores keyword references when trash fails before moving the note",async()=>{
    const env=await connectedEnvironment(),before=new Map(env.contents);env.trashFile.mockRejectedValueOnce(Error("trash blocked"));
    await expect(env.plugin.deleteKeyword(keywordEntry)).rejects.toThrow();
    expect(env.contents).toEqual(before);
  });
  it("finishes a verified deletion if trash persisted before rejecting",async()=>{
    const env=await connectedEnvironment(),trash=env.trashFile.getMockImplementation();
    env.trashFile.mockImplementationOnce(async file=>{await trash(file);throw Error("trash completed then failed");});
    await env.plugin.deleteKeyword(keywordEntry);expect(env.files.has(keywordPath)).toBe(false);
    expect(env.contents.get(oldPath)).not.toContain("[[MIA/키워드/기존|기존]]");
    expect(env.contents.get(nextPath)).not.toContain("[[MIA/키워드/기존|기존]]");
  });
  it("does not remove links if the keyword note has already vanished",async()=>{
    const env=await connectedEnvironment(),before=env.contents.get(oldPath);env.files.delete(keywordPath);
    await expect(env.plugin.deleteKeyword(keywordEntry)).rejects.toThrow();expect(env.contents.get(oldPath)).toBe(before);
  });
  it("restores a renamed keyword path, meaning and both references after a later write fails",async()=>{
    const env=await connectedEnvironment(),before=new Map(env.contents);failSecondBank(env);
    await expect(env.plugin.saveKeyword(keywordEntry,"새이름","새 의미")).rejects.toThrow();
    expect(env.files.has(keywordPath)).toBe(true);expect(env.files.has(newKeywordPath)).toBe(false);expect(env.contents).toEqual(before);
  });
  it("retains source note and restores destination meaning when merging references fails",async()=>{
    const env=await connectedEnvironment();env.add(newKeywordPath,new TFile());env.contents.set(newKeywordPath,"# 새이름\n\n## 의미\n\n대상 의미\n\n## 연결\n");
    const before=new Map(env.contents);failSecondBank(env);
    await expect(env.plugin.saveKeyword(keywordEntry,"새이름","새 의미")).rejects.toThrow();
    expect(env.contents).toEqual(before);expect(env.trashFile).not.toHaveBeenCalled();
  });
  it("refuses a merge that would discard additional user content",async()=>{
    const env=await connectedEnvironment();env.add(newKeywordPath,new TFile());env.contents.set(newKeywordPath,"# 새이름\n\n## 의미\n대상 의미\n");
    env.contents.set(keywordPath,env.contents.get(keywordPath)+"\n## 사용자 기록\n보존할 원문\n");const before=new Map(env.contents);
    await expect(env.plugin.saveKeyword(keywordEntry,"새이름","새 의미")).rejects.toThrow(/사용자|병합/);
    expect(env.contents).toEqual(before);expect(env.trashFile).not.toHaveBeenCalled();
  });
  it("completes a successful merge without duplicating the stored meanings",async()=>{
    const env=await connectedEnvironment();env.add(newKeywordPath,new TFile());env.contents.set(newKeywordPath,"# 새이름\n\n## 의미\n\n대상 의미\n\n## 연결\n");
    await env.plugin.saveKeyword(keywordEntry,"새이름","원래 의미");expect(env.files.has(keywordPath)).toBe(false);
    expect(env.contents.get(newKeywordPath).match(/원래 의미/g)).toHaveLength(1);expect(env.contents.get(newKeywordPath)).toContain("대상 의미");
    expect(env.contents.get(oldPath)).toContain("[[MIA/키워드/새이름|새이름]]");
  });
});

describe("subject operation failure boundaries",()=>{
  it("restores a renamed folder when the problem bank write fails",async()=>{
    const env=await connectedEnvironment(),before=new Map(env.contents),process=env.vault.process;
    env.vault.process=vi.fn(async(file,update)=>{if(file.path==="MIA/화학/문제은행.md")throw Error("bank blocked");return process(file,update);});
    await expect(env.plugin.renameSubject("수학","화학")).rejects.toThrow();
    expect(env.files.has("MIA/수학")).toBe(true);expect(env.files.has("MIA/화학")).toBe(false);expect(env.contents).toEqual(before);
  });
  it("reverses a folder rename that persisted before rejecting",async()=>{
    const env=await connectedEnvironment(),rename=env.renameFile.getMockImplementation();
    env.renameFile.mockImplementationOnce(async(file,next)=>{await rename(file,next);throw Error("rename after persistence");});
    await expect(env.plugin.renameSubject("수학","화학")).rejects.toThrow();
    expect(env.files.has("MIA/수학/문제은행.md")).toBe(true);expect(env.files.has("MIA/화학")).toBe(false);
  });
  it("reports a blocked folder restoration and keeps the moved files",async()=>{
    const env=await connectedEnvironment(),rename=env.renameFile.getMockImplementation(),process=env.vault.process;
    env.renameFile.mockImplementation(async(file,next)=>{if(next==="MIA/수학")throw Error("restore blocked");return rename(file,next);});
    env.vault.process=vi.fn(async(file,update)=>{if(file.path==="MIA/화학/문제은행.md")throw Error("bank blocked");return process(file,update);});
    await expect(env.plugin.renameSubject("수학","화학")).rejects.toThrow(/복구/);expect(env.files.has("MIA/화학/문제은행.md")).toBe(true);
  });
  it("does not remove reviews if the subject cannot be trashed",async()=>{
    const env=await connectedEnvironment();env.plugin.store.removeReviews=vi.fn();env.trashFile.mockRejectedValueOnce(Error("trash blocked"));
    await expect(env.plugin.deleteSubject("수학")).rejects.toThrow();expect(env.plugin.store.removeReviews).not.toHaveBeenCalled();expect(env.files.has(oldPath)).toBe(true);
  });
  it("reports the trash location and refreshes the index if review cleanup fails",async()=>{
    const env=await connectedEnvironment();env.plugin.store.removeReviews=vi.fn().mockRejectedValueOnce(Error("review save blocked"));
    await expect(env.plugin.deleteSubject("수학")).rejects.toThrow(/휴지통.*완료되지/);expect(env.plugin.index.questionById("mia-q-one")).toBeUndefined();expect(env.plugin.index.questionById("mia-q-two")).toBeDefined();
  });
});

describe("question deletion and review commit boundaries",()=>{
  it("restores the problem and incoming links when review deletion fails",async()=>{
    const env=await connectedEnvironment();
    await env.plugin.applyFollowUpChanges(new Map([["mia-q-two",["mia-q-one"]]]));const before=new Map(env.contents);
    env.plugin.store.getReview=()=>undefined;env.plugin.store.removeReview=vi.fn().mockRejectedValueOnce(Error("review blocked"));
    await expect(env.plugin.deleteManagedQuestion(env.plugin.index.questionById("mia-q-one"))).rejects.toThrow();
    expect(env.contents).toEqual(before);
  });
  it("does not delete review state if an incoming link update fails",async()=>{
    const env=await connectedEnvironment();await env.plugin.applyFollowUpChanges(new Map([["mia-q-two",["mia-q-one"]]]));const before=new Map(env.contents);
    env.plugin.store.getReview=()=>undefined;env.plugin.store.removeReview=vi.fn();failSecondBank(env);
    await expect(env.plugin.deleteManagedQuestion(env.plugin.index.questionById("mia-q-one"))).rejects.toThrow();
    expect(env.contents).toEqual(before);expect(env.plugin.store.removeReview).not.toHaveBeenCalled();
  });
});

describe("subject generated note and rename completion",()=>{
  async function withNote(){
    const env=await connectedEnvironment();
    const {renderSubjectNote,subjectNoteFileName}=await import("../src/core/subject-note");
    const path="MIA/수학/"+subjectNoteFileName("수학");env.add(path,new TFile());env.contents.set(path,renderSubjectNote("수학",[env.plugin.index.questionById("mia-q-one")]));return{...env,notePath:path,subjectNoteFileName};
  }
  it("restores the folder and generated note name if the note rename fails",async()=>{
    const env=await withNote(),before=new Map(env.contents),rename=env.renameFile.getMockImplementation();
    env.renameFile.mockImplementation(async(file,next)=>{if(file instanceof TFile)throw Error("note rename blocked");return rename(file,next);});
    await expect(env.plugin.renameSubject("수학","화학")).rejects.toThrow();expect(env.contents).toEqual(before);
  });
  it("restores both generated note and bank contents if incoming link refresh fails",async()=>{
    const env=await withNote();await env.plugin.applyFollowUpChanges(new Map([["mia-q-two",["mia-q-one"]]]));const before=new Map(env.contents);failSecondBank(env);
    await expect(env.plugin.renameSubject("수학","화학")).rejects.toThrow();expect(env.contents).toEqual(before);expect(env.files.has(env.notePath)).toBe(true);
  });
  it("changes a subject and its generated note while keeping stable question IDs",async()=>{
    const env=await withNote();await env.plugin.renameSubject("수학","화학");
    expect(env.files.has("MIA/수학")).toBe(false);expect(env.files.has("MIA/화학/"+env.subjectNoteFileName("화학"))).toBe(true);
    expect(env.plugin.index.questionById("mia-q-one").subject).toBe("화학");expect(env.contents.get("MIA/화학/문제은행.md")).toContain("# 화학 문제은행");
  });
});


describe("subject trash and reference cleanup ordering",()=>{
  it("keeps review history when incoming reference cleanup fails after trash",async()=>{
    const env=await connectedEnvironment();await env.plugin.applyFollowUpChanges(new Map([["mia-q-two",["mia-q-one"]]]));
    const before=env.contents.get(nextPath);env.plugin.store.removeReviews=vi.fn();failSecondBank(env);
    await expect(env.plugin.deleteSubject("수학")).rejects.toThrow(/휴지통/);
    expect(env.plugin.store.removeReviews).not.toHaveBeenCalled();expect(env.contents.get(nextPath)).toBe(before);
    expect(env.plugin.index.questionById("mia-q-one")).toBeUndefined();
  });
});

describe("newly generated subject note recovery",()=>{
  it("removes only the newly generated note when later link refresh fails",async()=>{
    const env=await connectedEnvironment();await env.plugin.applyFollowUpChanges(new Map([["mia-q-two",["mia-q-one"]]]));const before=new Map(env.contents);failSecondBank(env);
    await expect(env.plugin.renameSubject("수학","화학")).rejects.toThrow();expect(env.contents).toEqual(before);
  });
});


describe("stale follow-up editors and concurrent metadata",()=>{
  async function opened(){const env=await connectedEnvironment();env.plugin.openFollowUpEditor(env.plugin.index.questionById("mia-q-one"));return{...env,editor:followUpWindows.at(-1)};}
  it("rejects old selection after the base links were changed and indexed",async()=>{
    const env=await opened();await env.plugin.applyFollowUpChanges(new Map([["mia-q-one",["mia-q-two"]]]));const before=new Map(env.contents);
    await expect(env.editor.submit([],false)).rejects.toThrow(/변경/);expect(env.contents).toEqual(before);
  });
  it("does not silently skip a selected question deleted while the editor was open",async()=>{
    const env=await opened();env.files.delete(nextPath);env.contents.delete(nextPath);await env.plugin.index.rebuild();const before=new Map(env.contents);
    await expect(env.editor.submit(["mia-q-two"],false)).rejects.toThrow();expect(env.contents).toEqual(before);
  });
  it("retains a target's newer reverse links rather than replacing them from an old bidirectional editor",async()=>{
    const env=await opened();await env.plugin.applyFollowUpChanges(new Map([["mia-q-two",["mia-q-one"]]]));const before=new Map(env.contents);
    await expect(env.editor.submit(["mia-q-two"],true)).rejects.toThrow(/변경/);expect(env.contents).toEqual(before);
  });
  it("detects link changes on disk before the index receives them",async()=>{
    const env=await connectedEnvironment(),writes=env.plugin.followUps.fileChanges(new Map([["mia-q-one",[]]]));
    const {updateQuestionMetadata}=await import("../src/core/question-writer");
    const q=env.plugin.index.questionById("mia-q-one");env.contents.set(oldPath,updateQuestionMetadata(env.contents.get(oldPath),q,{...q,followUpLinks:["[[MIA/물리/문제은행#^mia-q-two|둘]]"]}));const before=new Map(env.contents);
    const {applyFileChanges}=await import("../src/services/file-change-batch");
    await expect(applyFileChanges(env.vault,writes)).rejects.toThrow(/변경/);expect(env.contents).toEqual(before);
  });
  it("keeps unrelated metadata edits while applying a still-current link selection",async()=>{
    const env=await opened();env.contents.set(oldPath,env.contents.get(oldPath).replace("> 유형: 정의형","> 유형: 비교형").replace("> 보조:","> 보조:\n> 사용자 메모: 외부 기록"));
    await env.editor.submit(["mia-q-two"],false);
    expect(env.contents.get(oldPath)).toContain("> 유형: 비교형");expect(env.contents.get(oldPath)).toContain("사용자 메모: 외부 기록");
    expect(parseQuestionFile(oldPath,env.contents.get(oldPath)).questions[0].followUpIds).toEqual(["mia-q-two"]);
  });
  it("refuses an old metadata form rather than overwriting newer keywords",async()=>{
    const env=await connectedEnvironment(),old=env.plugin.index.questionById("mia-q-one");env.contents.set(oldPath,env.contents.get(oldPath).replace("> 핵심: [[MIA/키워드/기존|기존]]","> 핵심: [[새 키워드]]"));const before=env.contents.get(oldPath);
    await expect(env.plugin.writeMetadata(old,{...old})).rejects.toThrow(/변경/);expect(env.contents.get(oldPath)).toBe(before);
  });
  it("preserves a concurrent follow-up alias edit even when the link IDs have not changed", async () => {
    const env = await environment();
    const raw = "> **이어볼 질문**:  [[지리학/기후, 지형.md#^mia-q-missing|이전 별칭]]  ";
    env.contents.set(oldPath, env.contents.get(oldPath).replace("> 보조:", `> 보조:\n${raw}`));
    await env.plugin.index.rebuild();
    const original = env.plugin.index.questionById("mia-q-one");
    const newer = raw.replace("이전 별칭", "새 별칭");
    const before = env.contents.get(oldPath).replace(raw, newer);
    env.contents.set(oldPath, before);
    await expect(env.plugin.writeMetadata(original, { ...input, followUpLinks: [] })).rejects.toThrow(/이어볼 문제 링크.*변경/);
    expect(env.contents.get(oldPath)).toBe(before);
    await env.plugin.writeMetadata(original, { ...input, questionType: "비교형" });
    expect(env.contents.get(oldPath).split("\n")).toContain(newer);
  });
  it("still allows a fresh bidirectional selection",async()=>{
    const env=await opened();await env.editor.submit(["mia-q-two"],true);
    expect(env.plugin.index.questionById("mia-q-one").followUpIds).toEqual(["mia-q-two"]);
    expect(env.plugin.index.questionById("mia-q-two").followUpIds).toEqual(["mia-q-one"]);
  });

  it.each([1, 2])("saves forward links and reports %i full reverse lists without modifying them", async fullCount => {
    const env = await connectedEnvironment();
    const fullIds = Array.from({ length: fullCount }, (_, index) => `mia-q-full-${index}`);
    const links = Array.from({ length: MAX_FOLLOW_UPS }, (_, index) => `[[지리학/보관#^mia-q-related-${index}]]`);
    const fullQuestions = fullIds.reduce((bank, id, index) => appendManagedQuestion(bank, {
      ...input, questionMarkdown: `지리학 ${index + 1}`, followUpLinks: links,
    }, id), createSubjectBank("지리학"));
    env.contents.set(nextPath, fullQuestions);
    await env.plugin.index.rebuild();
    expect(env.plugin.index.questionById(fullIds[0]).followUpIds).toHaveLength(MAX_FOLLOW_UPS);
    env.plugin.openFollowUpEditor(env.plugin.index.questionById("mia-q-one"));
    const before = notices.length;
    await followUpWindows.at(-1).submit(fullIds, true);
    expect(env.plugin.index.questionById("mia-q-one").followUpIds).toEqual(fullIds);
    expect(env.contents.get(nextPath)).toBe(fullQuestions);
    const label = fullCount === 1 ? `${env.plugin.index.questionById(fullIds[0]).heading} 문제는` : "2개 문제는";
    expect(notices.slice(before)).toEqual([
      "1개 질문의 연결을 갱신했습니다.",
      `${label} 꼬리질문이 이미 50개라 반대 방향 연결을 추가하지 못했습니다.`,
    ]);
  });
});

describe("late reverse-link conflicts",()=>{
  it("rolls back the first file and retains a reverse link changed just before the second write",async()=>{
    const env=await connectedEnvironment();env.plugin.openFollowUpEditor(env.plugin.index.questionById("mia-q-one"));const editor=followUpWindows.at(-1);
    const original=env.contents.get(oldPath),process=env.vault.process;
    const {updateQuestionMetadata}=await import("../src/core/question-writer");let external;
    env.vault.process=vi.fn(async(file,update)=>{
      if(file.path===nextPath && external===undefined){
        const q=env.plugin.index.questionById("mia-q-two");external=updateQuestionMetadata(env.contents.get(nextPath),q,{...q,followUpLinks:["[[MIA/수학/문제은행#^mia-q-one|외부에서 연결]]"]});env.contents.set(nextPath,external);
      }
      return process(file,update);
    });
    await expect(editor.submit(["mia-q-two"],true)).rejects.toThrow(/변경/);
    expect(env.contents.get(oldPath)).toBe(original);expect(env.contents.get(nextPath)).toBe(external);
  });
  it("preserves an unresolved link while refreshing a valid target", async () => {
    const { plugin, contents } = await connectedEnvironment();
    const unresolved = "[[missing#^mia-q-missing|누락, 원문]]";
    const oldLink = "[[bank#^mia-q-two|둘]]";
    contents.set(oldPath, contents.get(oldPath).replace("> 보조:", `> 보조:\n> 이어볼 질문: ${oldLink} ,  ${unresolved}`));
    await plugin.index.rebuild();
    const before = contents.get(oldPath);
    await plugin.followUps.refreshIncoming(["mia-q-two"]);
    const newLink = questionBlockLink(plugin.index.questionById("mia-q-two"));
    expect(contents.get(oldPath)).toContain(`> 이어볼 질문: ${newLink} ,  ${unresolved}`);
    expect(before).toContain(oldLink);
  });
});

describe("automatic cleanup with dangling follow-ups", () => {
  const sourceSubject = "지리학", incomingSubject = "통계이론", nextSubject = "레시피";
  const bankPath = subject => `MIA/${subject}/문제은행.md`;
  const sourcePath = bankPath(sourceSubject), incomingPath = bankPath(incomingSubject);
  const sourceId = "mia-q-region", incomingId = "mia-q-statistics";
  const dangling = "[[기록/이전 문제은행.md#^mia-q-missing|  누락, 원본 별칭  ]]";
  const untouched = "[[기록/이전 문제은행.md#^mia-q-two|수정 대상 밖의 링크]]";
  const affected = "[[이전 파일#^mia-q-region|이전 이름]]";
  const outgoing = "[[기록/다른 파일#^mia-q-also-missing|누락된 다른 질문]]";

  async function setup() {
    const env = await connectedEnvironment();
    for (const subject of [sourceSubject, incomingSubject]) {
      env.add(`MIA/${subject}`, new TFolder());
      env.add(bankPath(subject), new TFile());
    }
    env.contents.set(sourcePath, appendManagedQuestion(createSubjectBank(sourceSubject),
      { ...input, questionMarkdown: "유역이란 무엇인가요?", followUpLinks: [outgoing] }, sourceId));
    env.contents.set(incomingPath, appendManagedQuestion(createSubjectBank(incomingSubject),
      { ...input, questionMarkdown: "중앙값이란 무엇인가요?", followUpLinks: [dangling, affected, untouched] }, incomingId));
    env.plugin.store.removeReview = vi.fn(async () => {});
    env.plugin.store.removeReviews = vi.fn(async () => {});
    env.plugin.store.getReview = () => undefined;
    await env.plugin.index.rebuild();
    return { ...env, sourceQuestion: env.plugin.index.questionById(sourceId) };
  }

  it.each(["edit-question", "move-question", "rename-subject", "delete-question", "delete-subject"])(
    "preserves unresolved Markdown bytes and completes %s", async operation => {
      const { plugin, contents, files, sourceQuestion } = await setup();
      const draft = { ...input, subject: sourceSubject, questionMarkdown: "유역의 범위는 무엇인가요?", keywordMeanings: [] };
      if (operation === "edit-question") await plugin.updateManagedQuestion(sourceQuestion, draft);
      if (operation === "move-question") await plugin.moveManagedQuestion(sourceQuestion, { ...draft, subject: nextSubject });
      if (operation === "rename-subject") await plugin.renameSubject(sourceSubject, nextSubject);
      if (operation === "delete-question") await plugin.deleteManagedQuestion(sourceQuestion);
      if (operation === "delete-subject") await plugin.deleteSubject(sourceSubject);

      const text = contents.get(incomingPath);
      const updated = plugin.index.questionById(sourceId);
      const links = parseQuestionFile(incomingPath, text).questions[0].followUpIds;
      if (operation.startsWith("delete")) {
        expect(updated).toBeUndefined();
        expect(links).toEqual(["mia-q-missing", "mia-q-two"]);
        expect(text).toContain(`> 이어보기: ${dangling}, ${untouched}`);
        if (operation === "delete-question") expect(plugin.store.removeReview).toHaveBeenCalledWith(sourceId, expect.anything());
        else {
          expect(plugin.store.removeReviews).toHaveBeenCalledWith([sourceId]);
          expect(files.has(sourcePath)).toBe(false);
        }
      } else {
        expect(updated.subject).toBe(operation === "edit-question" ? sourceSubject : nextSubject);
        expect(contents.get(updated.filePath)).toContain(outgoing);
        expect(links).toEqual(["mia-q-missing", sourceId, "mia-q-two"]);
        expect(text).toContain(`> 이어보기: ${dangling}, ${questionBlockLink(updated)}, ${untouched}`);
      }
    },
  );

  it.each(["delete", "rename", "move"])("validates incoming files before a subject or question %s", async operation => {
    const { plugin, contents, sourceQuestion, trashFile, renameFile, vault } = await setup();
    contents.set(incomingPath, contents.get(incomingPath).replace(affected, outgoing));
    const before = new Map(contents);
    const operationPromise = operation === "delete" ? plugin.deleteSubject(sourceSubject)
      : operation === "rename" ? plugin.renameSubject(sourceSubject, nextSubject)
        : plugin.moveManagedQuestion(sourceQuestion, { ...input, subject: nextSubject, keywordMeanings: [] });
    await expect(operationPromise).rejects.toThrow(/연결이 다른 작업에서 변경/);
    expect(trashFile).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
    expect(vault.process).not.toHaveBeenCalled();
    expect(contents).toEqual(before);
    expect(plugin.store.removeReviews).not.toHaveBeenCalled();
  });

  it("rejects a vanished follow-up selected while creating a question before writing", async () => {
    const { plugin, contents, files, vault, sourceQuestion } = await setup();
    const selected = questionBlockLink(sourceQuestion);
    files.delete(sourcePath);
    contents.delete(sourcePath);
    const before = new Map(contents);
    await expect(plugin.createManagedQuestion({
      ...input, subject: nextSubject, followUpLinks: [selected], keywordMeanings: [],
    })).rejects.toThrow(/연결할 질문이 변경 또는 삭제/);
    expect(contents).toEqual(before);
    expect(vault.createFolder).not.toHaveBeenCalled();
  });
});

describe("reusing keywords while adding a question", () => {
  it.each(["create", "update", "move"])("saves a short keyword link to the note resolved from the %s destination", async (action) => {
    const env = await environment();
    env.add("MIA/키워드", new TFolder());
    const folders = ["MIA/수학", "MIA/물리", "MIA/키워드"];
    for (const folder of folders) {
      const path = `${folder}/물량.md`;
      env.add(path, new TFile());
      env.contents.set(path, `# 물량\n\n## 의미\n\n${folder}의 뜻\n`);
    }
    const resolve = vi.fn((target, sourcePath) => target === "물량"
      ? env.files.get(`${sourcePath.slice(0, sourcePath.lastIndexOf("/"))}/물량.md`) ?? null
      : null);
    env.plugin.app.metadataCache = { getFirstLinkpathDest: resolve };
    const keyword = { target: "물량#정의", label: "물량", raw: "[[물량#정의|물량]]" };
    const draft = { ...env.draft, coreKeywords: [keyword], keywordMeanings: [{ ...keyword, meaning: "새 뜻" }] };
    if (action === "create") await env.plugin.createManagedQuestion(draft);
    else await env.plugin.updateManagedQuestion(env.question, { ...draft, subject: action === "update" ? "수학" : "물리" });

    const bankPath = action === "update" ? oldPath : nextPath;
    const folder = bankPath.slice(0, bankPath.lastIndexOf("/"));
    for (const path of folders) {
      expect(readKeywordMeaning(env.contents.get(`${path}/물량.md`))).toBe(path === folder ? "새 뜻" : `${path}의 뜻`);
    }
    const [saved] = parseQuestionFile(bankPath, env.contents.get(bankPath)).questions;
    expect((await env.plugin.keywords.loadMeanings(saved)).get(keyword.target)).toBe("새 뜻");
    expect(resolve).toHaveBeenCalledWith("물량", bankPath);
  });

  it("keeps the problem bank protected when a short keyword link resolves to it", async () => {
    const env = await environment();
    env.plugin.app.metadataCache = { getFirstLinkpathDest: vi.fn(() => env.files.get(oldPath)) };
    const keyword = { target: "문제은행", label: "문제은행", raw: "[[문제은행]]" };
    await expect(env.plugin.createManagedQuestion({
      ...env.draft, coreKeywords: [keyword], keywordMeanings: [{ ...keyword, meaning: "새 뜻" }],
    })).rejects.toThrow(/문제은행.*키워드 뜻/);
    expect(env.contents.get(oldPath)).toBe(env.source);
    expect(env.contents.has("MIA/키워드/문제은행.md")).toBe(false);
  });

  it("keeps every problem when its bank is the explicit keyword meaning target", async () => {
    const env = await environment();
    const bank = env.source.replace(/^### /m, "## 의미\n\n은행 설명\n\n### ");
    env.contents.set(oldPath, bank);
    const keyword = { target: "MIA/수학/문제은행", label: "은행", raw: "[[MIA/수학/문제은행|은행]]" };
    await expect(env.plugin.createManagedQuestion({
      ...env.draft, subject: "수학", questionMarkdown: "새 질문", coreKeywords: [keyword],
      keywordMeanings: [{ ...keyword, meaning: "뜻" }],
    })).rejects.toThrow(/문제은행.*키워드 뜻/);
    const written = env.contents.get(oldPath);
    expect(written.startsWith(bank)).toBe(true);
    expect(parseQuestionFile(oldPath, written).questions.map(q => q.questionMarkdown)).toEqual(["원래 질문", "새 질문"]);
  });

  it.each(["save", "edit", "merge", "rename"])("protects a generated subject note during keyword %s", async (action) => {
    const env = await environment();
    env.add("MIA/키워드", new TFolder());
    const old = { name: "기존", target: "MIA/키워드/기존", filePath: "MIA/키워드/기존.md" };
    const destination = "MIA/키워드/대상.md";
    const protectedPath = action === "rename" ? old.filePath : destination;
    const generated = renderSubjectNote("수학", [input]);
    if (action === "merge") {
      env.add(old.filePath, new TFile());
      env.contents.set(old.filePath, "# 기존\n\n## 의미\n\n기존 뜻\n");
    }
    env.add(protectedPath, new TFile());
    env.contents.set(protectedPath, generated);
    const before = new Map(env.contents);
    const current = action === "edit" ? { name: "대상", target: "MIA/키워드/대상", filePath: destination } : old;
    const save = action === "save" ? env.plugin.keywords.saveMeaning("대상", "새 뜻")
      : env.plugin.saveKeyword(current, "대상", "새 뜻");
    await expect(save).rejects.toThrow(action === "rename" ? /과목 노트.*키워드 이름 변경/ : /과목 노트.*키워드 뜻/);
    expect(env.contents).toEqual(before);
    expect(env.trashFile).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("preserves the existing meaning when the new question leaves it blank (%j)", async meaning => {
    const env = await environment();
    env.add("MIA/키워드", new TFolder());
    const path = "MIA/키워드/기후 현상.md";
    env.add(path, new TFile());
    const original = "# 기후 현상\r\n\r\n## 의미\r\n\r\n기존 의미를 보존합니다.\r\n\r\n## 연결\r\n\r\n사용자 연결과 메모\r\n";
    env.contents.set(path, original);
    const keyword = { target: "MIA/키워드/기후 현상", label: "기후 현상", raw: "[[MIA/키워드/기후 현상|기후 현상]]" };
    await env.plugin.createManagedQuestion({ ...env.draft, coreKeywords: [keyword], keywordMeanings: [{ ...keyword, meaning }] });
    expect(parseQuestionFile(nextPath, env.contents.get(nextPath)).questions).toHaveLength(1);
    expect(env.contents.get(path)).toBe(original);
  });
  it("leaves keyword notes untouched when the question write fails", async () => {
    const env = await environment();
    const keyword = { target: "MIA/키워드/새키워드", label: "새키워드", raw: "[[MIA/키워드/새키워드|새키워드]]" };
    const process = env.plugin.app.vault.process.getMockImplementation();
    env.plugin.app.vault.process.mockImplementation(async (file, update) => { if (file.path === nextPath) throw Error("bank write failed"); return process(file, update); });
    await expect(env.plugin.createManagedQuestion({ ...env.draft, coreKeywords: [keyword], keywordMeanings: [{ ...keyword, meaning: "새 의미" }] })).rejects.toThrow("bank write failed");
    expect(env.contents.has("MIA/키워드/새키워드.md")).toBe(false);
  });
  it("reports that the question was saved when the keyword meaning write fails afterwards", async () => {
    const env = await environment();
    const keyword = { target: "MIA/키워드/새키워드", label: "새키워드", raw: "[[MIA/키워드/새키워드|새키워드]]" };
    env.plugin.keywords.saveReferenceMeaning = vi.fn().mockRejectedValue(Error("keyword disk full"));
    await expect(env.plugin.createManagedQuestion({ ...env.draft, coreKeywords: [keyword], keywordMeanings: [{ ...keyword, meaning: "새 의미" }] })).rejects.toThrow("질문은 저장됐지만 키워드 뜻은 저장하지 못했습니다");
    expect(parseQuestionFile(nextPath, env.contents.get(nextPath)).questions).toHaveLength(1);
  });
  it("creates a new keyword note with an empty meaning and applies an explicitly supplied meaning to an existing keyword", async () => {
    const env = await environment();
    const keyword = { target: "MIA/키워드/새키워드", label: "새키워드", raw: "[[MIA/키워드/새키워드|새키워드]]" };
    const draft = { ...env.draft, coreKeywords: [keyword], keywordMeanings: [{ ...keyword, meaning: "" }] };
    await env.plugin.createManagedQuestion(draft);
    expect(env.contents.get("MIA/키워드/새키워드.md")).toContain("## 의미");
    await env.plugin.createManagedQuestion({ ...draft, questionMarkdown: "다른 질문", keywordMeanings: [{ ...keyword, meaning: "명시적으로 입력한 의미" }] });
    expect(env.contents.get("MIA/키워드/새키워드.md")).toContain("명시적으로 입력한 의미");
  });
});


describe("editing a saved question from a session", () => {
  async function editEnvironment(options) {
    const env = await environment(options);
    env.plugin.subjectNotes.assertWritable = vi.fn().mockResolvedValue(undefined);
    env.plugin.questions.saveDraftKeywordMeanings = vi.fn().mockResolvedValue(undefined);
    env.plugin.subjectNotes.sync = vi.fn().mockResolvedValue(undefined);
    env.plugin.followUps.refreshIncoming = vi.fn().mockResolvedValue(undefined);
    env.plugin.store.reviews[env.question.id] = { marker: "existing FSRS record" };
    const duplicate = appendManagedQuestion(env.contents.get(oldPath), input, "mia-q-duplicate");
    env.contents.set(oldPath, duplicate);
    await env.plugin.index.refreshFile(env.files.get(oldPath));
    env.question = env.plugin.index.questionById("mia-q-one");
    env.draft = { ...env.draft, subject: "수학", questionMarkdown: "수정 질문", answerMarkdown: "수정 답변" };
    return env;
  }
  it("persists only the requested ID and refreshes the index without replacing review history", async () => {
    const env=await editEnvironment(); const reviews=structuredClone(env.plugin.store.reviews);
    await env.plugin.updateManagedQuestion(env.question,env.draft);
    const persisted=parseQuestionFile(oldPath,env.contents.get(oldPath)).questions;
    expect(persisted.find(q=>q.id==="mia-q-one")).toMatchObject({questionMarkdown:"수정 질문",answerMarkdown:"수정 답변"});
    expect(persisted.find(q=>q.id==="mia-q-duplicate")).toMatchObject(input);
    expect(env.plugin.index.questionById("mia-q-one")).toMatchObject({questionMarkdown:"수정 질문",answerMarkdown:"수정 답변"});
    expect(env.plugin.store.reviews).toEqual(reviews);
    expect(env.contents.get(oldPath)).toContain("사용자 메모: 이동해도 보존");
  });
  it.each(["#", "##"])("keeps a ### answer subheading when saving a %s question", async (heading) => {
    const env = await editEnvironment();
    const bank = env.contents.get(oldPath)
      .replace(/^### /gm, `${heading} `)
      .replace(/^#### 정답$/gm, `${heading}# 정답`);
    env.contents.set(oldPath, bank);
    await env.plugin.index.refreshFile(env.files.get(oldPath));
    const original = env.plugin.index.questionById("mia-q-one");
    expect(original?.headingLevel).toBe(heading.length);

    const answerMarkdown = "part1\n\n### 소제목\n\npart2";
    await env.plugin.updateManagedQuestion(original, { ...env.draft, answerMarkdown });
    const persisted = parseQuestionFile(oldPath, env.contents.get(oldPath)).questions;
    expect(persisted.find(q => q.id === "mia-q-one")?.answerMarkdown).toBe(answerMarkdown);
  });
  it("does not change persisted content or the index on write failure, and permits retry",async()=>{
    const env=await editEnvironment();const before=env.contents.get(oldPath);
    env.vault.process.mockRejectedValueOnce(Error("disk full"));
    await expect(env.plugin.updateManagedQuestion(env.question,env.draft)).rejects.toThrow("disk full");
    expect(env.contents.get(oldPath)).toBe(before);
    expect(env.plugin.index.questionById("mia-q-one").answerMarkdown).toBe("원래 정답");
    await env.plugin.updateManagedQuestion(env.question,env.draft);
    expect(env.plugin.index.questionById("mia-q-one").answerMarkdown).toBe("수정 답변");
  });
  it.each(["question", "answer", "both"])("persists %s edits with Markdown and retains the ID across a new index instance",async(kind)=>{
    const env=await editEnvironment();const beforeReviews=structuredClone(env.plugin.store.reviews);
    const prompt="한글 · & < > \"특수\" $a_1 + b^2$\n둘째 줄\n\n셋째 줄 "+"긴 질문 ".repeat(150);
    const answer="#### 설명\n\n**굵게** · [링크](https://example.org) · $x_1$\n\n```ts\nconst x = '<&>';\n```\n\n| 가 | 나 |\n| --- | --- |\n| 1 | 2 |\n"+"긴 답변 ".repeat(200);
    const draft={...env.draft,questionMarkdown:kind==="answer"?env.question.questionMarkdown:prompt.trim(),answerMarkdown:kind==="question"?env.question.answerMarkdown:answer.trim()};
    await env.plugin.updateManagedQuestion(env.question,draft);
    const restarted=new QuestionIndex(env.plugin.app,()=>["MIA"]);await restarted.rebuild();
    expect(restarted.questionById(env.question.id)).toMatchObject({id:env.question.id,questionMarkdown:draft.questionMarkdown,answerMarkdown:draft.answerMarkdown});
    expect(restarted.questionById("mia-q-duplicate")).toMatchObject(input);expect(env.plugin.store.reviews).toEqual(beforeReviews);
  });
  it("recognizes a completed source write even if the storage callback rejects afterwards",async()=>{
    const env=await editEnvironment({sourceFailure:"after"});let snapshot;
    await expect(env.plugin.updateManagedQuestion(env.question,env.draft,q=>{snapshot=q;})).resolves.toBeUndefined();
    expect(snapshot.answerMarkdown).toBe("수정 답변");expect(env.plugin.index.questionById("mia-q-one").answerMarkdown).toBe("수정 답변");
  });
  it("rechecks external question changes inside the atomic write and preserves them",async()=>{
    const env=await editEnvironment(); const process=env.vault.process;let external;
    env.vault.process=vi.fn(async(file,update)=>{ external=env.contents.get(oldPath).replaceAll("원래 정답","외부에서 바꾼 정답");env.contents.set(oldPath,external);return process(file,update); });
    await expect(env.plugin.updateManagedQuestion(env.question,env.draft)).rejects.toThrow(/변경/);
    expect(env.contents.get(oldPath)).toBe(external);
  });
  it("reports a partial derived-note failure and exposes the committed snapshot for safe retry",async()=>{
    const env=await editEnvironment();let snapshot=env.question;
    env.plugin.subjectNotes.sync.mockRejectedValueOnce(Error("note locked"));
    await expect(env.plugin.updateManagedQuestion(snapshot,env.draft,q=>{snapshot=q;})).rejects.toThrow("원본 문제는 저장됐지만");
    expect(snapshot.answerMarkdown).toBe("수정 답변");
    expect(env.plugin.index.questionById("mia-q-one").answerMarkdown).toBe("수정 답변");
    await expect(env.plugin.updateManagedQuestion(snapshot,env.draft)).resolves.toBeUndefined();
  });
  it("refuses to edit a different duplicate after the source disappears",async()=>{
    const env=await editEnvironment();
    env.contents.set(oldPath,appendManagedQuestion(createSubjectBank("수학"),input,"mia-q-duplicate"));
    const before=env.contents.get(oldPath);
    await expect(env.plugin.updateManagedQuestion(env.question,env.draft)).rejects.toThrow(/찾지/);
    expect(env.contents.get(oldPath)).toBe(before);
  });
});

describe("new question and move commit boundaries",()=>{
  it("leaves a bank with an open code fence unchanged after repeated failed adds", async () => {
    const env = await environment();
    const bank = "# 물리 문제은행\n\n```\n열린 펜스\n";
    env.contents.set(nextPath, bank);
    const attempts = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const save = env.plugin.createManagedQuestion(env.draft);
      await expect(save).rejects.toThrow(/추가한 원본 문제/);
      attempts.push(save);
    }
    expect(env.contents.get(nextPath)).toBe(bank);
    for (const save of attempts) await expect(save).rejects.toThrow(/닫히지 않은 코드 블록/);
  });

  it.each(["create", "move"])("rejects %s before appending a question that overlaps an existing answer", async (action) => {
    const env = await environment();
    const bank = env.source.replace(/^### /m, "## ").replace(/^#### 정답$/m, "### 정답")
      .replace("mia-q-one", "mia-q-destination");
    env.contents.set(nextPath, bank);
    const before = new Map(env.contents);
    const save = action === "create"
      ? env.plugin.createManagedQuestion(env.draft)
      : env.plugin.moveManagedQuestion(env.question, env.draft);
    await expect(save).rejects.toThrow(/제목 수준.*겹/);
    expect(env.contents).toEqual(before);
  });

  it.each(["delete", "edit"])("rejects %s when the affected range contains another question", async (action) => {
    const env = await environment();
    const shallow = env.source.replace(/^### /m, "## ").replace(/^#### 정답$/m, "### 정답");
    const bank = appendManagedQuestion(shallow, input, "mia-q-nested");
    env.contents.set(oldPath, bank);
    await env.plugin.index.refreshFile(env.files.get(oldPath));
    const original = env.plugin.index.questionById("mia-q-one");
    expect(env.plugin.index.questionById("mia-q-nested")).toBeDefined();
    env.plugin.store.getReview = () => undefined;
    env.plugin.store.removeReview = vi.fn();
    const save = action === "delete"
      ? env.plugin.deleteManagedQuestion(original)
      : env.plugin.updateManagedQuestion(original, { ...env.draft, subject: "수학", answerMarkdown: "바꾼 정답" });
    await expect(save).rejects.toThrow(/제목 수준.*겹/);
    expect(env.contents.get(oldPath)).toBe(bank);
    expect(env.plugin.store.removeReview).not.toHaveBeenCalled();

    await env.plugin.writeMetadata(original, { ...input, questionType: "계산형" });
    expect(env.plugin.index.questionById("mia-q-one")?.questionType).toBe("계산형");
    expect(env.plugin.index.questionById("mia-q-nested")).toBeDefined();
  });

  it("exposes a created question before a derived-note failure so retry retains its ID",async()=>{
    const env=await environment();let saved;
    env.plugin.subjectNotes.sync=vi.fn().mockRejectedValueOnce(Error("subject note locked"));
    await expect(env.plugin.createManagedQuestion(env.draft,q=>{saved=q;})).rejects.toThrow();
    expect(saved?.id).toBeTruthy();
    const first=parseQuestionFile(nextPath,env.contents.get(nextPath)).questions;
    expect(first).toHaveLength(1);expect(saved?.id).toBe(first[0].id);
    await env.plugin.updateManagedQuestion(saved,env.draft);
    expect(parseQuestionFile(nextPath,env.contents.get(nextPath)).questions.map(q=>q.id)).toEqual([first[0].id]);
  });
  it("exposes the new path after a move even when derived notes fail",async()=>{
    const env=await environment();let saved=env.question;
    env.plugin.subjectNotes.sync=vi.fn().mockRejectedValueOnce(Error("subject note locked"));
    await expect(env.plugin.updateManagedQuestion(saved,env.draft,q=>{saved=q;})).rejects.toThrow();
    expect(env.count(oldPath)).toBe(0);expect(env.count(nextPath)).toBe(1);
    expect(saved).toMatchObject({id:env.question.id,filePath:nextPath,subject:"물리"});
    await env.plugin.updateManagedQuestion(saved,env.draft);
    expect(env.count(nextPath)).toBe(1);
  });
});

describe("answer validation while editing existing questions", () => {
  async function overlappingQuestion() {
    const env = await environment();
    const shallow = env.source.replace(/^### /m, "## ").replace(/^#### 정답$/m, "### 정답");
    const bank = appendManagedQuestion(shallow, { ...input, questionMarkdown: "뒤 질문" }, "mia-q-nested");
    env.contents.set(oldPath, bank);
    await env.plugin.index.refreshFile(env.files.get(oldPath));
    return { env, bank, original: env.plugin.index.questionById("mia-q-one") };
  }

  it("updates the prompt and metadata without rewriting an unchanged overlapping answer", async () => {
    const { env, bank, original } = await overlappingQuestion();
    const coreKeywords = [{ target: "핵심", label: "핵심", raw: "[[핵심]]" }];
    await env.plugin.updateManagedQuestion(original, {
      ...env.draft, subject: "수학", questionMarkdown: "고친 질문", questionType: "계산형",
      coreKeywords, answerMarkdown: original.answerMarkdown,
    });
    const written = env.contents.get(oldPath);
    const answerSection = text => text.slice(text.indexOf("### 정답\n"));
    expect(answerSection(written)).toBe(answerSection(bank));
    const [first, second] = parseQuestionFile(oldPath, written).questions;
    expect(first).toMatchObject({ questionMarkdown: "고친 질문", questionType: "계산형", coreKeywords });
    expect(second).toMatchObject({ id: "mia-q-nested", questionMarkdown: "뒤 질문" });
  });

  it.each(["edit", "move"])("reports overlap before validating a replacement answer during %s", async (action) => {
    const { env, original } = await overlappingQuestion();
    const draft = { ...env.draft, answerMarkdown: "```\n닫히지 않은 코드" };
    const before = new Map(env.contents);
    const save = action === "edit" ? env.plugin.updateManagedQuestion(original, { ...draft, subject: "수학" })
      : env.plugin.moveManagedQuestion(original, draft);
    await expect(save).rejects.toThrow(/제목 수준.*겹/);
    expect(env.contents).toEqual(before);
  });

  it("keeps an unchanged legacy answer with an open fence during an in-place edit", async () => {
    const env = await environment();
    const bank = `${env.source}\n~~~\n닫히지 않은 코드\n`;
    env.contents.set(oldPath, bank);
    await env.plugin.index.refreshFile(env.files.get(oldPath));
    const original = env.plugin.index.questionById("mia-q-one");
    const draft = { ...env.draft, subject: "수학", questionType: "계산형", answerMarkdown: original.answerMarkdown };
    await env.plugin.updateManagedQuestion(original, draft);
    const saved = env.plugin.index.questionById("mia-q-one");
    expect(saved).toMatchObject({ questionType: "계산형", answerMarkdown: original.answerMarkdown });

    const before = new Map(env.contents);
    await expect(env.plugin.moveManagedQuestion(saved, { ...draft, subject: "물리" })).rejects.toThrow(/코드 블록을 닫아/);
    expect(env.contents).toEqual(before);
  });
});

describe("keyword links resolved to non-Markdown files", () => {
  async function linkedAttachment(extension) {
    const env = await environment();
    const target = `자료.${extension}`;
    const path = `MIA/물리/${target}`;
    const file = env.add(path, new TFile());
    file.extension = extension;
    env.contents.set(path, "## 의미\n\n첨부 파일을 텍스트로 읽으면 안 됩니다.\n");
    env.plugin.app.metadataCache.getFirstLinkpathDest = vi.fn(() => file);
    const keyword = { target, label: "자료", raw: `[[${target}|자료]]` };
    const draft = { ...env.draft, coreKeywords: [keyword], keywordMeanings: [{ ...keyword, meaning: "새 뜻" }] };
    return { env, draft, file, keyword };
  }

  it.each([["create", "png"], ["update", "pdf"], ["move", "pdf"]])("rejects a keyword attachment before question %s (%s)", async (action, extension) => {
    const { env, draft } = await linkedAttachment(extension);
    const before = new Map(env.contents);
    const save = action === "create" ? env.plugin.createManagedQuestion(draft)
      : action === "move" ? env.plugin.moveManagedQuestion(env.question, draft)
        : env.plugin.updateManagedQuestion(env.question, { ...draft, subject: "수학" });
    await expect(save).rejects.toThrow(/키워드 뜻.*마크다운/);
    expect(env.contents).toEqual(before);
    expect(env.vault.process).not.toHaveBeenCalled();
  });

  it("returns an empty keyword meaning without reading the linked attachment", async () => {
    const { env, file, keyword } = await linkedAttachment("png");
    const meanings = await env.plugin.keywords.loadMeanings({ ...env.question, coreKeywords: [keyword] });
    expect(meanings.get(keyword.target)).toBe("");
    expect(env.vault.cachedRead).not.toHaveBeenCalledWith(file);
  });

  it("rejects writing a keyword meaning directly to a linked attachment", async () => {
    const { env, keyword } = await linkedAttachment("pdf");
    const before = new Map(env.contents);
    await expect(env.plugin.saveKeywordReferenceMeaning(keyword.target, keyword.label, "새 뜻", oldPath))
      .rejects.toThrow(/키워드 뜻.*마크다운/);
    expect(env.contents).toEqual(before);
    expect(env.vault.process).not.toHaveBeenCalled();
  });
});

it("preserves an existing meaning on an empty new-reference retry but still permits an explicit clear",async()=>{
  const env=await environment();env.add("MIA/키워드",new TFolder());const path="MIA/키워드/기존.md";env.add(path,new TFile());
  const original="# 기존\n\n## 의미\n\n여러 줄\n기존 의미\n\n## 연결\n";env.contents.set(path,original);
  const item={target:"MIA/키워드/기존",label:"기존",meaning:"",preserveExistingWhenEmpty:true};
  await env.plugin.questions.saveDraftKeywordMeanings({...env.draft,keywordMeanings:[item]},nextPath);expect(env.contents.get(path)).toBe(original);
  await env.plugin.questions.saveDraftKeywordMeanings({...env.draft,keywordMeanings:[{...item,preserveExistingWhenEmpty:false}]},nextPath);
  expect(readKeywordMeaning(env.contents.get(path))).toBe("");
});
