import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian",()=>({
  Plugin:class {},Modal:class {},ItemView:class {},PluginSettingTab:class {},MarkdownView:class {},
  TFile:class {},TFolder:class {},Component:class {},Setting:class {},Notice:class {},Platform:{isMobile:true},normalizePath:path=>path,
}));
import { TFile,TFolder } from "obsidian";
import MiaStudyPlugin from "../src/main";
import { QuestionIndex } from "../src/services/question-index";
import { appendManagedQuestion,createSubjectBank } from "../src/core/managed-question";
import { parseQuestionFile } from "../src/core/question-parser";

// The first question folder follows the settings, which another device or the
// settings tab can change while an operation awaits the vault. Each write must
// use the folder as it is when that write happens, as main.ts always did.

const input={questionMarkdown:"원래 질문",answerMarkdown:"원래 정답",questionType:"정의형",coreKeywords:[],subKeywords:[]};

function environment({folders,banks={}}){
  const root=Object.assign(new TFolder(),{path:"",name:"",children:[]});
  const files=new Map([["",root]]),contents=new Map();
  const add=(path,entry)=>{
    const parts=path.split("/"),name=parts.pop(),parent=files.get(parts.join("/"));
    if(!(parent instanceof TFolder))throw Error(`ENOENT: ${path}`);
    Object.assign(entry,{path,name,...(entry instanceof TFolder?{children:[]}:{extension:"md"})});
    parent.children.push(entry);files.set(path,entry);return entry;
  };
  for(const path of folders)add(path,new TFolder());
  for(const [path,text] of Object.entries(banks)){add(path,new TFile());contents.set(path,text);}
  const hooks={afterCreateFolder:()=>{},afterRead:()=>{}};
  const vault={
    getRoot:()=>root,getAbstractFileByPath:path=>files.get(path),getMarkdownFiles:()=>[...files.values()].filter(f=>f instanceof TFile),
    cachedRead:async file=>contents.get(file.path),
    read:async file=>{const text=contents.get(file.path);hooks.afterRead(file.path);return text;},
    createFolder:async path=>{const folder=add(path,new TFolder());hooks.afterCreateFolder(path);return folder;},
    create:async(path,text)=>{const file=add(path,new TFile());contents.set(path,text);return file;},
    process:async(file,update)=>{const text=update(contents.get(file.path));contents.set(file.path,text);return text;},
  };
  const plugin=new MiaStudyPlugin();plugin.app={vault,fileManager:{}};
  plugin.store={settings:{sourceRoots:["A"],keywordFolder:"A/키워드"},reviews:{},getReview:()=>undefined};
  plugin.index=new QuestionIndex(plugin.app,()=>plugin.store.settings.sourceRoots);
  const switchTo=next=>{plugin.store.settings.sourceRoots=[next];};
  return{plugin,contents,files,hooks,switchTo};
}

describe("changing the first question folder during an operation", () => {
  it("adds the subject under the folder in effect after the root is prepared", async () => {
    const env=environment({folders:["B"]});
    env.hooks.afterCreateFolder=path=>{if(path==="A")env.switchTo("B");};
    await env.plugin.createSubject("화학");
    expect(env.contents.get("B/화학/문제은행.md")).toContain("화학");
    expect(env.contents.get("B/화학/화학 노트.md")).toContain("mia-study-subject-note");
    expect(env.files.has("A/화학")).toBe(false);
  });

  it("moves the question under the folder in effect after the source is read", async () => {
    const source=appendManagedQuestion(createSubjectBank("수학"),input,"mia-q-one");
    const env=environment({folders:["A","A/수학","B"],banks:{"A/수학/문제은행.md":source}});
    await env.plugin.index.rebuild();
    const question=env.plugin.index.questionById("mia-q-one");
    let switched=false;
    env.hooks.afterRead=path=>{if(!switched&&path==="A/수학/문제은행.md"){switched=true;env.switchTo("B");}};
    await env.plugin.moveManagedQuestion(question,{...input,subject:"물리",keywordMeanings:[]});
    const ids=path=>env.contents.has(path)?parseQuestionFile(path,env.contents.get(path)).questions.map(q=>q.id):[];
    expect(ids("B/물리/문제은행.md")).toEqual(["mia-q-one"]);
    expect(ids("A/물리/문제은행.md")).toEqual([]);
    expect(ids("A/수학/문제은행.md")).toEqual([]);
    expect(env.contents.get("B/물리/물리 노트.md")).toContain("질문: 원래 질문");
  });
});
