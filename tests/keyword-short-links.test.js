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
function environment({link,resolve={}}){
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
  note("MIA/키워드/B.md",createKeywordNote("B","B 의미"));
  note("MIA/다른/A2.md","# 다른 노트\n");
  const keyword={target:link.target,label:"A",raw:`[[${link.target}|A]]`};
  note(bankPath,appendManagedQuestion(createSubjectBank("수학"),{questionMarkdown:"질문",answerMarkdown:"정답",questionType:"정의형",coreKeywords:[keyword],subKeywords:[]},"mia-q-one"));
  const vault={
    getRoot:()=>root,getAbstractFileByPath:path=>files.get(path),getMarkdownFiles:()=>[...files.values()].filter(f=>f instanceof TFile),
    cachedRead:async file=>contents.get(file.path),read:async file=>contents.get(file.path),
    createFolder:async path=>add(path,new TFolder()),
    create:async(path,text)=>{contents.set(path,text);return add(path,new TFile());},
    process:async(file,update)=>{const text=update(contents.get(file.path));contents.set(file.path,text);return text;},
  };
  // Resolves like Obsidian: an exact path first, then a unique basename, unless the test pins a target.
  const getFirstLinkpathDest=(linkpath)=>{
    if(resolve[linkpath])return files.get(resolve[linkpath])??null;
    if(files.get(`${linkpath}.md`) instanceof TFile)return files.get(`${linkpath}.md`);
    const matches=[...files.values()].filter(f=>f instanceof TFile&&f.basename===linkpath);
    return matches.length===1?matches[0]:null;
  };
  const trashFile=vi.fn(async file=>{files.delete(file.path);contents.delete(file.path);});
  const plugin=new MiaStudyPlugin();
  plugin.app={vault,metadataCache:{getFirstLinkpathDest},fileManager:{trashFile,renameFile:vi.fn()}};
  plugin.store={settings:{sourceRoots:["MIA"],keywordFolder:"MIA/키워드"},reviews:{}};
  plugin.index=new QuestionIndex(plugin.app,()=>["MIA"]);
  const keywords=()=>parseQuestionFile(bankPath,contents.get(bankPath)).questions[0].coreKeywords.map(k=>k.target);
  return{plugin,contents,files,keywords,trashFile};
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
});
