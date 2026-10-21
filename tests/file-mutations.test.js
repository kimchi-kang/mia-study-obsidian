import { describe, expect, it, vi } from "vitest";
const followUpWindows = vi.hoisted(() => []);
vi.mock("../src/ui/follow-up-modal", () => ({ FollowUpModal: class {
  constructor(app, base, questions, submit) { followUpWindows.push({ base, questions, submit }); }
  open() {}
} }));
vi.mock("obsidian",()=>({
  Plugin:class {},Modal:class {},ItemView:class {},PluginSettingTab:class {},MarkdownView:class {},
  TFile:class {},TFolder:class {},Component:class {},Setting:class {},Notice:class {},Platform:{isMobile:true},normalizePath:path=>path,
}));
import { TFile,TFolder } from "obsidian";
import MiaStudyPlugin from "../src/main";
import { QuestionIndex } from "../src/services/question-index";
import { appendManagedQuestion,createSubjectBank } from "../src/core/managed-question";
import { parseQuestionFile } from "../src/core/question-parser";

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
  const plugin=new MiaStudyPlugin();plugin.app={vault};plugin.store={settings:{sourceRoots:["MIA"],keywordFolder:"MIA/키워드"},reviews:{}};
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


const keywordPath="MIA/키워드/기존.md",newKeywordPath="MIA/키워드/새이름.md";
const keywordEntry={name:"기존",target:"MIA/키워드/기존",filePath:keywordPath};
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
    const env=await connectedEnvironment(),writes=env.plugin.followUpFileChanges(new Map([["mia-q-one",[]]]));
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
  it("still allows a fresh bidirectional selection",async()=>{
    const env=await opened();await env.editor.submit(["mia-q-two"],true);
    expect(env.plugin.index.questionById("mia-q-one").followUpIds).toEqual(["mia-q-two"]);
    expect(env.plugin.index.questionById("mia-q-two").followUpIds).toEqual(["mia-q-one"]);
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
  it("does not silently remove another unresolved link while refreshing a valid target",async()=>{
    const env=await connectedEnvironment();const {updateQuestionMetadata}=await import("../src/core/question-writer");
    const q=env.plugin.index.questionById("mia-q-one");env.contents.set(oldPath,updateQuestionMetadata(env.contents.get(oldPath),q,{...q,followUpLinks:["[[bank#^mia-q-two|둘]]","[[missing#^mia-q-missing|누락]]"]}));await env.plugin.index.rebuild();const before=env.contents.get(oldPath);
    await expect(env.plugin.refreshIncomingFollowUpLinks(["mia-q-two"])).rejects.toThrow();expect(env.contents.get(oldPath)).toBe(before);
  });
});
