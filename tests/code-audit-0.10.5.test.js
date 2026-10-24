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
import { MiaDataStore } from "../src/services/data-store";
import { FsrsService } from "../src/core/fsrs-service";
import { DEFAULT_PLUGIN_DATA } from "../src/core/models";
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


describe("0.10.5 independent code audit", () => {
  it("deleting the first-root subject must not remove reviews for an identically named second-root subject", async () => {
    const env = await environment();
    env.add("Archive", new TFolder()); env.add("Archive/수학", new TFolder());
    const otherPath = "Archive/수학/문제은행.md";
    env.add(otherPath, new TFile());
    env.contents.set(otherPath, appendManagedQuestion(createSubjectBank("수학"), input, "mia-q-other-root"));
    let disk = structuredClone(DEFAULT_PLUGIN_DATA);
    disk.settings.sourceRoots = ["MIA", "Archive"];
    const fsrs = new FsrsService(disk.settings);
    for (const id of ["mia-q-one", "mia-q-other-root"]) disk.reviews[id] = fsrs.rate(undefined, 4, new Date("2026-10-20T00:00:00Z"), id);
    env.plugin.store = new MiaDataStore({loadData:async()=>structuredClone(disk),saveData:async data=>{disk=structuredClone(data);}});
    await env.plugin.store.load();
    env.plugin.index = new QuestionIndex(env.plugin.app, () => env.plugin.store.settings.sourceRoots);
    await env.plugin.index.rebuild();
    const protectedReview = structuredClone(disk.reviews["mia-q-other-root"]);
    await env.plugin.deleteSubject("수학");
    expect(env.files.has(otherPath)).toBe(true);
    expect(disk.reviews["mia-q-one"]).toBeUndefined();
    expect(disk.reviews["mia-q-other-root"]).toEqual(protectedReview);
  });

  it.each([false, true])("editing a nested keyword must update the selected file (same-name root note exists: %s)", async rootExists => {
    const env = await environment();
    env.add("MIA/키워드", new TFolder()); env.add("MIA/키워드/회로", new TFolder());
    const path = "MIA/키워드/회로/전압.md"; env.add(path, new TFile());
    env.contents.set(path, "# 전압\n\n## 의미\n\n원래 의미\n\n## 연결\n");
    if(rootExists) { env.add("MIA/키워드/전압.md",new TFile()); env.contents.set("MIA/키워드/전압.md","# 전압\n\n## 의미\n\n별도 루트 키워드\n\n## 연결\n"); }
    await env.plugin.saveKeyword({name:"전압", target:path.slice(0,-3), filePath:path}, "전압", "새 의미");
    expect.soft(env.contents.get(path)).toContain("새 의미");
    if(rootExists) expect.soft(env.contents.get("MIA/키워드/전압.md")).toContain("별도 루트 키워드");
    else expect.soft(env.files.has("MIA/키워드/전압.md")).toBe(false);
  });

  it("must recheck the managed-note marker inside the atomic update", async () => {
    const env = await environment();
    const path = "MIA/수학/수학 노트.md";
    env.add(path, new TFile());
    env.contents.set(path, "<!-- mia-study-subject-note:v1 -->\n# 자동 노트\n");
    const process = env.vault.process.getMockImplementation();
    env.vault.process.mockImplementation(async (file, update) => {
      if(file.path === path) env.contents.set(path, "# 사용자 노트\n동기화가 도착한 보존할 내용\n");
      return process(file, update);
    });
    await expect(env.plugin.syncSubjectNote("수학", [env.question])).rejects.toThrow(/사용자 노트/);
    expect(env.contents.get(path)).toContain("동기화가 도착한 보존할 내용");
  });

  it("moving a question must keep relative Markdown links aimed at the original attachment", async () => {
    const env = await environment();
    const withLink = {...input, answerMarkdown:"![회로](./회로.png)"};
    env.contents.set(oldPath, appendManagedQuestion(createSubjectBank("수학"), withLink, "mia-q-one"));
    await env.plugin.index.rebuild();
    const question = env.plugin.index.questionById("mia-q-one");
    await env.plugin.moveManagedQuestion(question, {...env.draft, answerMarkdown:withLink.answerMarkdown});
    const moved = parseQuestionFile(nextPath, env.contents.get(nextPath)).questions.find(q=>q.id==="mia-q-one");
    const destination = new URL(moved.answerMarkdown.match(/\]\(([^)]+)\)/)[1], "https://vault.invalid/" + nextPath).pathname;
    expect(destination).toBe("/MIA/%EC%88%98%ED%95%99/%ED%9A%8C%EB%A1%9C.png");
  });
});
