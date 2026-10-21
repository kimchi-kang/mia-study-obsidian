import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { buildSync } from "esbuild";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";

const settings={targetRetention:.9,maximumIntervalDays:36500};
const service=new FsrsService(settings);
const instants=["2028-02-28T23:59:59.999Z","2028-02-29T23:59:59.999Z","2026-12-31T23:59:59.999Z","2026-03-08T06:59:59.999Z","2026-11-01T05:59:59.999Z"];
const code=buildSync({stdin:{contents:`
import { FsrsService } from './src/core/fsrs-service';
import { calculateProgress } from './src/core/progress';
import { queryQuestions } from './src/core/question-query';
import { Rating } from 'ts-fsrs';
const service=new FsrsService(${JSON.stringify(settings)});
const times=${JSON.stringify(instants)};
const schedules=times.map(value=>{
 const now=new Date(value),prior=service.rate(undefined,Rating.Easy,new Date(now.getTime()-40*86400000),'q');
 return [1,2,3,4].map(grade=>{
  const preview=service.preview(prior,now,'q').find(p=>p.grade===grade);
  const state=service.rate(prior,grade,now,'q');
  if(state.card.due!==preview.due.toISOString())throw Error('preview mismatch');
  if(state.card.elapsed_days<0 || Date.parse(state.card.due)<=now.getTime())throw Error('invalid schedule');
  return state;
 });
});
const q={id:'q',heading:'문제',questionMarkdown:'문제',answerMarkdown:'답',subject:'과목',questionType:'정의형',coreKeywords:[],subKeywords:[],followUpIds:[]};
const localDates=[[2028,1,29],[2026,2,8],[2026,10,1],[2026,11,31]].map(([year,month,date])=>{
 const now=new Date(year,month,date,23,59,59,999),review=service.rate(undefined,Rating.Good,now,'q');
 const reviews={q:review};
 const at=(time)=>({count:calculateProgress([q],reviews,service,time).today,filtered:queryQuestions([q],reviews,service,{text:'',subject:'all',questionType:'all',review:'today',keyword:'',sort:'title',now:time}).length});
 return [at(now),at(new Date(now.getTime()+1))];
});
console.log(JSON.stringify({schedules,localDates}));
`,resolveDir:process.cwd()},bundle:true,packages:"external",platform:"node",format:"esm",write:false}).outputFiles[0].text;
function run(zone){return JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",code],{cwd:process.cwd(),env:{...process.env,TZ:zone},encoding:"utf8"}));}

describe("FSRS calendar and clock boundaries",()=>{
 const utc=run("UTC");
 it.each(["Asia/Seoul","America/New_York","Europe/Berlin","Australia/Lord_Howe"])("keeps absolute schedules identical and uses local calendar days in %s",zone=>{
  const result=run(zone);expect(result.schedules).toEqual(utc.schedules);
  expect(result.localDates).toEqual(Array(4).fill([{count:1,filtered:1},{count:0,filtered:0}]));
 });
 it.each(instants)("recognizes the exact due millisecond across %s",value=>{
  const state=service.rate(undefined,Rating.Again,new Date(value),"q");const due=Date.parse(state.card.due);
  expect(service.isDue(state,new Date(due-1))).toBe(false);expect(service.isDue(state,new Date(due))).toBe(true);
 });
 it.each([1,60_000,86_400_000])("refuses a clock rollback of %s ms without changing the original history",offset=>{
  const time=new Date("2026-10-20T00:00:00Z"),state=service.rate(undefined,Rating.Easy,time,"q"),saved=structuredClone(state);
  expect(()=>service.rate(state,Rating.Good,new Date(time.getTime()-offset),"q")).toThrow();expect(state).toEqual(saved);
 });
 it("allows another intentional grade at exactly the last review instant",()=>{
  const now=new Date("2026-10-20T00:00:00Z"),state=service.rate(undefined,Rating.Again,now,"q");
  expect(service.rate(state,Rating.Good,now,"q").history).toHaveLength(2);
 });
});
