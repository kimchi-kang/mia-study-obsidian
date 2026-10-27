import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rating, State, fsrs, createEmptyCard, type Card, type Grade } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { DEFAULT_SETTINGS } from "../src/core/models";
import { MiaDataStore, DataStoreInternals } from "../src/services/data-store";

const settings = {...structuredClone(DEFAULT_SETTINGS), studyManagement:{...structuredClone(DEFAULT_SETTINGS.studyManagement),enableFuzz:false}};
const start = new Date("2026-10-27T03:00:00Z");
// FSRS-6 5.4.1 published default weights, deliberately not imported from the SUT.
const weights=[.212,1.2931,2.3065,8.2956,6.4133,.8334,3.0194,.001,1.8722,.1666,.796,1.4835,.0614,.2629,1.6483,.6014,1.8729,.5425,.0912,.0658,.1542];
const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,n));
const round=(n:number)=>Number(n.toFixed(8));
// Independent equations from the versioned FSRS-6 model. No scheduler methods used.
function memory(prior: Card, grade: number, at:Date) {
  const w=weights;
  const initialDifficulty=(g:number)=>round(w[4]! - Math.exp((g-1)*w[5]!) + 1);
  if(prior.state===State.New)return {stability:w[grade-1]!,difficulty:clamp(initialDifficulty(grade),1,10)};
  const s=prior.stability,d=prior.difficulty,t=Math.floor((at.getTime()-prior.last_review!.getTime())/86400000);
  const factor=round(Math.exp(-Math.log(.9)/w[20]!)-1);
  const r=round(Math.pow(1+factor*t/s,-w[20]!));
  let stability:number;
  if(t===0){const increase=Math.pow(s,-w[19]!)*Math.exp(w[17]!*(grade-3+w[18]!));stability=round(clamp(s*(grade>=2?Math.max(increase,1):increase),.001,36500));}
  else if(grade===1){const forgotten=round(clamp(w[11]!*Math.pow(d,-w[12]!)*(Math.pow(s+1,w[13]!)-1)*Math.exp((1-r)*w[14]!),.001,36500));stability=clamp(round(s/Math.exp(w[17]!*w[18]!)),.001,forgotten);}
  else stability=round(clamp(s*(1+Math.exp(w[8]!)*(11-d)*Math.pow(s,-w[9]!)*(Math.exp((1-r)*w[10]!)-1)*(grade===2?w[15]!:1)*(grade===4?w[16]!:1)),.001,36500));
  const damped=d+round(-w[6]!*(grade-3)*(10-d)/9);
  return {stability,difficulty:clamp(round(w[7]!*initialDifficulty(4)+(1-w[7]!)*damped),1,10)};
}

describe("versioned FSRS-6 algorithm audit",()=>{
  it("matches literal initial steps, first memory values and hard rounding",()=>{
    const service=new FsrsService(settings);
    for(const [grade,minutes,state,step] of [[1,1,1,0],[2,6,1,0],[3,10,1,1],[4,8*1440,2,0]]){
      const actual=service.rate(undefined,grade!,start,"q");
      expect(actual.card.state).toBe(state);expect(actual.card.learning_steps).toBe(step);
      expect(Date.parse(actual.card.due)-start.getTime()).toBe(minutes!*60000);
      expect(actual.card.stability).toBe(weights[grade!-1]);
      expect(actual.card.difficulty).toBeCloseTo(clamp(weights[4]!-Math.exp((grade!-1)*weights[5]!)+1,1,10),7);
    }
  });
  it.each(["always-good","always-again","mixed","long-absence","same-day","restart-next-day"])("simulates %s against published equations and unmodified 5.4.1 reference",async scenario=>{
    let disk:unknown; const storage={loadData:async()=>structuredClone(disk),saveData:async(data:unknown)=>{disk=structuredClone(data);}};
    let store=new MiaDataStore(storage);await store.load();await store.updateSettings(settings);
    const reference=fsrs({request_retention:.9,maximum_interval:36500,enable_fuzz:false,learning_steps:["1m","10m"],relearning_steps:["10m"]});
    let expected=createEmptyCard(start);let at=start;
    const trace:unknown[]=[];
    for(let i=0;i<80;i++){
      const grade=(scenario==="always-again"?1:scenario==="mixed"?[1,2,3,4,3,3,1,3][i%8]:scenario==="long-absence"&&i%9===0?1:3) as Grade;
      if(i){at=scenario==="same-day"?new Date(at.getTime()+60000):new Date(expected.due);if(scenario==="long-absence")at=new Date(at.getTime()+180*86400000);if(scenario==="restart-next-day")at=new Date(at.getTime()+86400000);}
      const previous=store.getReview("q"),snapshot=JSON.stringify(previous);
      const service=new FsrsService(store.settings),preview=service.preview(previous,at,"q").find(p=>p.grade===grade)!;
      expect(JSON.stringify(previous)).toBe(snapshot);
      const independent=memory(expected,grade,at);
      const result=reference.next(expected,at,grade);expected=result.card;
      if(expected.scheduled_days>36500)expected={...expected,scheduled_days:36500,due:new Date(at.getTime()+36500*86400000)};
      const actual=service.rate(previous,grade,at,"q");
      expect(actual.card.stability).toBeCloseTo(independent.stability,7);expect(actual.card.difficulty).toBeCloseTo(independent.difficulty,7);
      const expectedCard={...expected,due:expected.due.toISOString(),last_review:expected.last_review?.toISOString()};
      expect(actual.card).toEqual(expectedCard);
      expect(preview.due.toISOString()).toBe(actual.card.due);expect(preview.scheduledDays).toBe(actual.card.scheduled_days);
      expect(actual.history).toHaveLength(i+1);expect(actual.card.reps).toBe(i+1);
      for(const n of [actual.card.stability,actual.card.difficulty,actual.card.scheduled_days,actual.card.elapsed_days])expect(Number.isFinite(n)&&n>=0).toBe(true);
      expect(Date.parse(actual.card.due)).toBeGreaterThan(at.getTime());expect(actual.card.scheduled_days).toBeLessThanOrEqual(36500);
      await store.setReview("q",actual,{state:previous});store=new MiaDataStore(storage);await store.load();expect(store.getReview("q")).toEqual(actual);
      trace.push({step:i+1,at:at.toISOString(),before:previous?.card??"New",grade,expected:expectedCard,actual:actual.card});
    }
    if(process.env.MIA_SCHEDULER_TRACE_DIR){mkdirSync(process.env.MIA_SCHEDULER_TRACE_DIR,{recursive:true});writeFileSync(join(process.env.MIA_SCHEDULER_TRACE_DIR,`${scenario}.json`),JSON.stringify(trace,null,2));}
  });
  it("bounds deterministic fuzz using the published range rather than a preview oracle",()=>{
    const service=new FsrsService({...settings,studyManagement:{...settings.studyManagement,enableFuzz:true}});
    // Easy initial stability 8.2956 -> 8 days; delta=1+.15*(7-2.5)+.1*(8-7)=1.775.
    for(let i=0;i<200;i++){
      const state=service.rate(undefined,Rating.Easy,start,`fuzz-${i}`);
      expect(state.card.scheduled_days).toBeGreaterThanOrEqual(6);expect(state.card.scheduled_days).toBeLessThanOrEqual(10);
      expect(new FsrsService({...settings,studyManagement:{...settings.studyManagement,enableFuzz:true}}).rate(undefined,Rating.Easy,start,`fuzz-${i}`)).toEqual(state);
    }
  });
  it("keeps early and late review consistent with independently calculated elapsed days",()=>{
    const service=new FsrsService(settings),previous=service.rate(undefined,Rating.Easy,start,"q");
    for(const days of [0,1,7,8,9,365,3650])for(const grade of [1,2,3,4]){
      const at=new Date(start.getTime()+days*86400000),result=service.rate(previous,grade,at,"q");
      const expected=memory({...previous.card,due:new Date(previous.card.due),last_review:start} as Card,grade,at);
      expect(result.card.elapsed_days).toBe(days);expect(result.card.stability).toBeCloseTo(expected.stability,7);expect(result.card.difficulty).toBeCloseTo(expected.difficulty,7);
    }
  });
  it("fixed overrides preserve FSRS states and memory while clamping the scheduled time",()=>{
    const service=new FsrsService({...settings,maximumIntervalDays:7,gradeIntervalsMinutes:{1:20000,2:7,3:1440,4:20160}});
    const automatic=new FsrsService({...settings,maximumIntervalDays:7});
    for(const grade of [1,2,3,4]){
      const actual=service.rate(undefined,grade,start,"q"),base=automatic.rate(undefined,grade,start,"q");
      expect(actual.card.state).toBe(base.card.state);expect(actual.card.stability).toBe(base.card.stability);
      expect(Date.parse(actual.card.due)-start.getTime()).toBe(({1:10080,2:7,3:1440,4:10080}[grade as 1|2|3|4])*60000);
    }
  });
  it("quarantines incomplete legacy cards instead of silently inventing learning history",()=>{
    const service=new FsrsService(settings),review=service.rate(undefined,Rating.Good,start,"q");
    const broken=JSON.parse(JSON.stringify(review));delete broken.card.learning_steps;
    const parsed=DataStoreInternals.parseReviews({good:review,broken});expect(parsed.reviews.good).toEqual(review);expect(parsed.reviews.broken).toBeUndefined();expect(parsed.quarantined.broken).toEqual(broken);
  });
});

describe("literal learning and relearning transitions",()=>{
  const service=new FsrsService(settings);
  it.each([1,2,3,4] as const)("grade %s repeats, advances or exits each short-term stage",grade=>{
    const step0=service.rate(undefined,Rating.Again,start,"q");
    const step1=service.rate(step0,Rating.Good,new Date(step0.card.due),"q");
    const mature=service.rate(undefined,Rating.Easy,start,"q");
    const relearn=service.rate(mature,Rating.Again,new Date(mature.card.due),"q");
    for(const [before,minutes,expectedState,expectedStep] of [
      [step0,grade===1?1:grade===2?6:grade===3?10:null,grade===4?2:1,grade===3?1:0],
      [step1,grade===1?1:grade===2?6:null,grade<=2?1:2,grade===2?1:0],
      [relearn,grade===1?10:grade===2?15:null,grade<=2?3:2,0],
    ] as const){
      const at=new Date(before.card.due),after=service.rate(before,grade,at,"q");
      expect(after.card.state).toBe(expectedState);expect(after.card.learning_steps).toBe(expectedStep);
      if(minutes!==null)expect(Date.parse(after.card.due)-at.getTime()).toBe(minutes*60000);
      else expect(after.card.scheduled_days).toBeGreaterThanOrEqual(1);
      expect(after.card.lapses).toBe(before.card.lapses);expect(after.history).toHaveLength(before.history.length+1);
    }
  });
  it("uses the pinned library policy that a configured step of a day enters Review",()=>{
    const service=new FsrsService({...settings,studyManagement:{...settings.studyManagement,learningSteps:["1d","2d"]}});
    const result=service.rate(undefined,Rating.Again,start,"q");
    expect(result.card.state).toBe(State.Review);expect(result.card.scheduled_days).toBe(1);expect(Date.parse(result.card.due)-start.getTime()).toBe(86400000);
  });
});
