import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian",()=>({
  Plugin:class {},Modal:class {},ItemView:class {},PluginSettingTab:class {},MarkdownView:class {},
  TFile:class {},TFolder:class {},Component:class {},Setting:class {},Notice:class {},Platform:{isMobile:true},normalizePath:path=>path,
}));
import { TFile,TFolder } from "obsidian";
import MiaStudyPlugin from "../src/main";
import { QuestionIndex } from "../src/services/question-index";
import { appendManagedQuestion,createSubjectBank } from "../src/core/managed-question";
import { createKeywordNote } from "../src/core/keyword-note";
import { parseQuestionFile } from "../src/core/question-parser";

// After a note rename, Obsidian rewrites links in its configured format, which
// by default is the shortest unique form: [[A2|A]] rather than the full path.
// Keyword merge and delete must treat such a link as the keyword it resolves to.

const bankPath="MIA/수학/문제은행.md";
function environment({link,links=[link],resolve={},withB=true}){
  const root=Object.assign(new TFolder(),{path:"",name:"",children:[]});
  const files=new Map([["",root]]),contents=new Map();
  const add=(path,entry)=>{
    const parts=path.split("/"),name=parts.pop(),parent=files.get(parts.join("/"));
    Object.assign(entry,{path,name,...(entry instanceof TFolder?{children:[]}:{extension:"md",basename:name.replace(/\.md$/,"")})});
    parent.children.push(entry);files.set(path,entry);return entry;
  };
  for(const path of ["MIA","MIA/수학","MIA/키워드","MIA/다른"])add(path,new TFolder());
  const note=(path,text)=>{add(path,new TFile());contents.set(path,text);};
  note("MIA/키워드/A2.md",createKeywordNote("A2","원래 의미"));
  if(withB)note("MIA/키워드/B.md",createKeywordNote("B","B 의미"));
  note("MIA/다른/A2.md","# 다른 노트\n");
  const coreKeywords=links.map(({target,label="A"})=>({target,label,raw:`[[${target}|${label}]]`}));
  note(bankPath,appendManagedQuestion(createSubjectBank("수학"),{questionMarkdown:"질문",answerMarkdown:"정답",questionType:"정의형",coreKeywords,subKeywords:[]},"mia-q-one"));
  const vault={
    getRoot:()=>root,getAbstractFileByPath:path=>files.get(path),getMarkdownFiles:()=>[...files.values()].filter(f=>f instanceof TFile),
    cachedRead:async file=>contents.get(file.path),read:async file=>contents.get(file.path),
    createFolder:async path=>add(path,new TFolder()),
    create:async(path,text)=>{contents.set(path,text);return add(path,new TFile());},
    process:async(file,update)=>{const text=update(contents.get(file.path));contents.set(file.path,text);return text;},
  };
  // Resolves like Obsidian: an exact path first, then a unique basename, unless the test pins a target.
  const getFirstLinkpathDest=vi.fn((linkpath)=>{
    if(resolve[linkpath])return files.get(resolve[linkpath])??null;
    if(files.get(`${linkpath}.md`) instanceof TFile)return files.get(`${linkpath}.md`);
    const matches=[...files.values()].filter(f=>f instanceof TFile&&f.basename===linkpath);
    return matches.length===1?matches[0]:null;
  });
  const trashFile=vi.fn(async file=>{files.delete(file.path);contents.delete(file.path);});
  // Moves the note only; links stay as the test wrote them, as after Obsidian's own link update.
  const renameFile=vi.fn(async(file,next)=>{files.delete(file.path);const text=contents.get(file.path);contents.delete(file.path);
    const parent=files.get(file.path.split("/").slice(0,-1).join("/"));parent.children=parent.children.filter(c=>c!==file);
    add(next,file);contents.set(next,text);});
  const plugin=new MiaStudyPlugin();
  plugin.app={vault,metadataCache:{getFirstLinkpathDest},fileManager:{trashFile,renameFile}};
  plugin.store={settings:{sourceRoots:["MIA"],keywordFolder:"MIA/키워드"},reviews:{}};
  plugin.index=new QuestionIndex(plugin.app,()=>["MIA"]);
  const keywords=()=>parseQuestionFile(bankPath,contents.get(bankPath)).questions[0].coreKeywords.map(k=>k.target);
  const raws=()=>parseQuestionFile(bankPath,contents.get(bankPath)).questions[0].coreKeywords.map(k=>k.raw);
  return{plugin,contents,files,keywords,raws,trashFile,getFirstLinkpathDest};
}
const a2={name:"A2",target:"MIA/키워드/A2",filePath:"MIA/키워드/A2.md"};

describe("keyword links in Obsidian's short form", () => {
  it("merges a short link into the destination keyword", async () => {
    const env=environment({link:{target:"A2"},resolve:{A2:"MIA/키워드/A2.md"}});
    await env.plugin.index.rebuild();
    expect(env.keywords()).toEqual(["A2"]);
    await env.plugin.saveKeyword(a2,"B","");
    expect(env.files.has("MIA/키워드/A2.md")).toBe(false);
    expect(env.keywords()).toEqual(["MIA/키워드/B"]);
    expect(env.contents.get("MIA/키워드/B.md")).toContain("원래 의미");
  });

  it("removes a short link when its keyword is deleted", async () => {
    const env=environment({link:{target:"A2"},resolve:{A2:"MIA/키워드/A2.md"}});
    await env.plugin.index.rebuild();
    await env.plugin.deleteKeyword(a2);
    expect(env.files.has("MIA/키워드/A2.md")).toBe(false);
    expect(env.keywords()).toEqual([]);
  });

  it("leaves a short link that resolves to another note with the same name", async () => {
    const env=environment({link:{target:"A2"},resolve:{A2:"MIA/다른/A2.md"}});
    await env.plugin.index.rebuild();
    await env.plugin.deleteKeyword(a2);
    expect(env.keywords()).toEqual(["A2"]);
  });

  it("still matches full-path links", async () => {
    const env=environment({link:{target:"MIA/키워드/A2"}});
    await env.plugin.index.rebuild();
    await env.plugin.saveKeyword(a2,"B","");
    expect(env.keywords()).toEqual(["MIA/키워드/B"]);
  });

  it("keeps a link Obsidian already updated when a keyword is renamed, as main does", async () => {
    const env=environment({link:{target:"B#의미",label:"사용자 별칭"},withB:false});
    await env.plugin.index.rebuild();
    await env.plugin.saveKeyword(a2,"B","원래 의미");
    expect(env.files.has("MIA/키워드/B.md")).toBe(true);
    expect(env.raws()).toEqual(["[[B#의미|사용자 별칭]]"]);
  });

  it("looks up only links that carry the removed keyword's file name", async () => {
    const env=environment({links:[{target:"C"},{target:"D#의미"},{target:"MIA/키워드/B"},{target:"A2"}],resolve:{A2:"MIA/키워드/A2.md"}});
    await env.plugin.index.rebuild();
    await env.plugin.deleteKeyword(a2);
    expect(env.keywords()).toEqual(["C","D#의미","MIA/키워드/B"]);
    expect(env.getFirstLinkpathDest.mock.calls.map(([linkpath])=>linkpath).every(linkpath=>linkpath==="A2")).toBe(true);
  });
});
