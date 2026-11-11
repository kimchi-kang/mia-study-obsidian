import { describe,expect,it } from "vitest";
import { QuestionIndex } from "../src/services/question-index";
const bank=(id,title="질문")=>`### ${title}\n\n> [!question] 문제\n> 질문\n^${id}\n\n#### 정답\n답\n`;
function environment(){
 const files=new Map(),contents=new Map();let roots=[];
 const app={vault:{getMarkdownFiles:()=>[...files.values()],cachedRead:async file=>{const text=contents.get(file.path);if(text instanceof Error)throw text;return text;}}};
 const index=new QuestionIndex(app,()=>roots);
 const add=(path,text)=>{const file={path,extension:"md"};files.set(path,file);contents.set(path,text);return file;};
 return{index,files,contents,add,setRoots:value=>{roots=value;}};
}
describe("index lookup cache invalidation",()=>{
 it("publishes fresh records to listeners after an individual refresh",async()=>{
  const env=environment(),file=env.add("a.md",bank("mia-q-one","옛 제목"));await env.index.rebuild();expect(env.index.questionById("mia-q-one").heading).toBe("옛 제목");
  let seen;env.index.subscribe(()=>{seen=env.index.questionById("mia-q-one").heading;});env.contents.set(file.path,bank("mia-q-one","새 제목"));await env.index.refreshFile(file);expect(seen).toBe("새 제목");
 });
 it("excludes newly duplicated IDs from lookups and diagnostics includes both",async()=>{
  const env=environment();env.add("a.md",bank("mia-q-one"));await env.index.rebuild();expect(env.index.questionById("mia-q-one")).toBeDefined();
  await env.index.refreshFile(env.add("b.md",bank("mia-q-one")));expect(env.index.questionById("mia-q-one")).toBeUndefined();expect(env.index.registered).toHaveLength(0);expect(env.index.diagnostics.filter(d=>d.code==="duplicate-id")).toHaveLength(2);
 });
 it("makes a formerly duplicated ID usable after removal without notification",async()=>{
  const env=environment();env.add("a.md",bank("mia-q-one"));env.add("b.md",bank("mia-q-one"));await env.index.rebuild();expect(env.index.questionById("mia-q-one")).toBeUndefined();
  env.index.remove("b.md",false);expect(env.index.questionById("mia-q-one").filePath).toBe("a.md");expect(env.index.diagnostics).toEqual([]);
 });
 it("does not expose mutable cached result arrays to callers",async()=>{
  const env=environment();env.add("a.md",bank("mia-q-one"));env.add("b.md",bank("mia-q-two").replace("^mia-q-two",""));await env.index.rebuild();
  env.index.registered.splice(0);env.index.candidates.splice(0);env.index.diagnostics.push({code:"fake"});expect(env.index.registered).toHaveLength(1);expect(env.index.candidates).toHaveLength(1);expect(env.index.diagnostics.some(d=>d.code==="fake")).toBe(false);
 });
 it("invalidates all derived lists on source-root changes",async()=>{
  const env=environment();env.add("A/a.md",bank("mia-q-one"));env.add("B/b.md",bank("mia-q-two"));await env.index.rebuild();expect(env.index.registered).toHaveLength(2);
  env.setRoots(["B"]);await env.index.rebuild();expect(env.index.questionById("mia-q-one")).toBeUndefined();expect(env.index.registered.map(q=>q.id)).toEqual(["mia-q-two"]);
 });
 it("removes stale lookups on read failure and restores them after recovery",async()=>{
  const env=environment(),file=env.add("a.md",bank("mia-q-one"));await env.index.rebuild();env.index.questionById("mia-q-one");env.contents.set(file.path,Error("unreadable"));await env.index.refreshFile(file);
  expect(env.index.questionById("mia-q-one")).toBeUndefined();expect(env.index.diagnostics[0].code).toBe("read-error");env.contents.set(file.path,bank("mia-q-one"));await env.index.refreshFile(file);expect(env.index.questionById("mia-q-one")).toBeDefined();expect(env.index.diagnostics).toEqual([]);
 });
});

describe("cross-file duplicate summary",()=>{
 const two=bank("mia-q-one","첫째")+"\n"+bank("mia-q-two","둘째");
 it("groups a sync conflict copy with its original and counts the hidden questions",async()=>{
  const env=environment();env.add("문제/은행.md",two);env.add("문제/은행 (1).md",two);env.add("문제/다른.md",bank("mia-q-other"));await env.index.rebuild();
  expect(env.index.registered.map(q=>q.id)).toEqual(["mia-q-other"]);
  expect(env.index.crossFileDuplicates).toEqual({hiddenQuestions:2,files:[
   {filePath:"문제/은행 (1).md",hiddenQuestions:2,sharesWith:["문제/은행.md"]},
   {filePath:"문제/은행.md",hiddenQuestions:2,sharesWith:["문제/은행 (1).md"]},
  ]});
 });
 it("names the other files in each cross-file diagnostic and caps a long list",async()=>{
  const env=environment();env.add("a.md",bank("mia-q-one"));for(const n of [1,2,3,4,5])env.add(`a (${n}).md`,bank("mia-q-one"));await env.index.rebuild();
  const message=env.index.diagnostics.find(d=>d.filePath==="a.md"&&d.code==="duplicate-id").message;
  expect(message).toBe("여러 파일에서 중복된 문제 ID: mia-q-one · 같은 ID가 있는 다른 파일: a (1).md, a (2).md, a (3).md 외 2개");
  expect(env.index.diagnostics.find(d=>d.filePath==="a (1).md"&&d.code==="duplicate-id").message).toContain("a (2).md, a (3).md, a (4).md 외 2개");
  expect(env.index.crossFileDuplicates.hiddenQuestions).toBe(1);
 });
 it("keeps the dropping rule and the old diagnostic for duplicates inside one file",async()=>{
  const env=environment();env.add("a.md",bank("mia-q-one","첫째")+"\n"+bank("mia-q-one","둘째"));await env.index.rebuild();
  expect(env.index.registered).toHaveLength(0);expect(env.index.crossFileDuplicates).toEqual({hiddenQuestions:0,files:[]});
  expect(env.index.diagnostics.filter(d=>d.code==="duplicate-id").map(d=>d.message)).toContain("여러 파일에서 중복된 문제 ID: mia-q-one");
  expect(env.index.diagnostics.filter(d=>d.message.includes("다른 파일"))).toEqual([]);
 });
 it("empties the summary once the copy is removed and returns a copy of the data",async()=>{
  const env=environment();env.add("a.md",bank("mia-q-one"));env.add("a (1).md",bank("mia-q-one"));await env.index.rebuild();
  env.index.crossFileDuplicates.files.splice(0);env.index.crossFileDuplicates.files[0]?.sharesWith.splice(0);expect(env.index.crossFileDuplicates.files).toHaveLength(2);expect(env.index.crossFileDuplicates.files[0].sharesWith).toHaveLength(1);
  env.index.remove("a (1).md",false);expect(env.index.crossFileDuplicates).toEqual({hiddenQuestions:0,files:[]});expect(env.index.questionById("mia-q-one")).toBeDefined();
 });
});
