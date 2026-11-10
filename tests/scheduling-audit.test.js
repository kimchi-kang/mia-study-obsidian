import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { FsrsService } from '../src/core/fsrs-service';
import { DEFAULT_SETTINGS } from '../src/core/models';
import { Rating } from 'ts-fsrs';

const calendarCode=buildSync({stdin:{contents:`
import {studyDayStart,dailyStudyCounts,orderManagedQueue} from './src/core/study-management';
import {DEFAULT_STUDY_MANAGEMENT} from './src/core/models';
const [instant,logAt,hour=2]=JSON.parse(process.argv[1]);
const now=new Date(instant),settings={...DEFAULT_STUDY_MANAGEMENT,dayStartsAt:hour};
const record={card:{state:1,last_review:logAt,due:instant},history:[{review:logAt,due:logAt,state:0}]};
const queue=orderManagedQueue([{id:'q'}],[],{q:record},{...settings,newCardsPerDay:0,reviewsPerDay:0},now,()=>0,()=>0);
console.log(JSON.stringify({start:studyDayStart(now,hour).toISOString(),counts:dailyStudyCounts({q:record},settings,now),queue:queue.map(q=>q.id)}));
`,resolveDir:process.cwd()},bundle:true,packages:'external',platform:'node',format:'esm',write:false}).outputFiles[0].text;

describe('independent study-day and duration bounds',()=>{
 it.each([
  ['America/New_York','2026-03-08T06:30:00Z','2026-03-07T07:30:00Z','2026-03-07T07:00:00.000Z'],
  ['Europe/Berlin','2026-03-29T00:30:00Z','2026-03-28T01:30:00Z','2026-03-28T01:00:00.000Z'],
  ['Pacific/Apia','2011-12-30T11:00:00Z','2011-12-29T12:30:00Z','2011-12-29T12:00:00.000Z'],
  ['Australia/Lord_Howe','2026-10-03T15:00:00Z','2026-10-02T15:45:00Z','2026-10-02T15:30:00.000Z'],
 ])('uses yesterday\'s configured hour before a skipped 02:00 in %s',(zone,now,logAt,expected)=>{
  const actual=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',calendarCode,JSON.stringify([now,logAt])],{cwd:process.cwd(),env:{...process.env,TZ:zone},encoding:'utf8'}));
  expect(actual.start).toBe(expected);
  expect(actual.counts).toEqual({fresh:1,review:0});
  expect(actual.queue).toEqual(['q']);
 });
 it.each([[1,'1584m'],[2,'3000m']])('never exceeds a configured %s-day maximum with %s learning step',(maximumIntervalDays,step)=>{
  const at=new Date('2026-11-06T00:00:00.123Z');
  const scheduler=new FsrsService({...structuredClone(DEFAULT_SETTINGS),maximumIntervalDays,studyManagement:{...DEFAULT_SETTINGS.studyManagement,learningSteps:[step],enableFuzz:false}});
  const expected=new Date(at.getTime()+maximumIntervalDays*86400000).toISOString();
  const preview=scheduler.preview(undefined,at,'duration-bound').find(p=>p.grade===Rating.Again);
  expect(preview.due.toISOString()).toBe(expected);
  expect(scheduler.rate(undefined,Rating.Again,at,'duration-bound').card.due).toBe(expected);
 });
});

// Independent oracle: locked upstream scheduler, not Mia preview/rate as each other's expectation.
import { createEmptyCard, fsrs, GenSeedStrategyWithCardId, StrategyMode, State, default_w } from 'ts-fsrs';
import { buildReviewQueue } from '../src/core/recommendation-engine';
import { planLearningQueue } from '../src/core/learning-queue';
import { DEFAULT_STUDY_MANAGEMENT } from '../src/core/models';
import { parsePluginData } from '../src/services/data-store';

const fixedDayCode = buildSync({
  stdin: { resolveDir: process.cwd(), contents: `
    import { FsrsService } from "./src/core/fsrs-service";
    import { DEFAULT_SETTINGS } from "./src/core/models";
    const [grade, days, hour, minute, simulate] = JSON.parse(process.argv[1]);
    const scheduler = new FsrsService({ ...DEFAULT_SETTINGS, gradeIntervalsMinutes: { [grade]: days * 1440 } });
    const session = day => new Date(2026, 9, 20 + day, hour, minute);
    const rate = (previous, day) => scheduler.rate(previous, grade, new Date(+session(day) + 5 * 60000), "fixed");
    let review = rate(undefined, 0);
    if (!simulate) {
      const stored = JSON.parse(JSON.stringify(review));
      const baseline = new FsrsService(DEFAULT_SETTINGS).rate(undefined, grade, new Date(+session(0) + 5 * 60000), "fixed");
      const unchanged = { ...baseline, card: { ...baseline.card, due: stored.card.due, scheduled_days: days } };
      const next = scheduler.nextReviewAt(stored);
      console.log(JSON.stringify({
        stored, unchanged, next, dueAtStudyTime: scheduler.isDue(stored, session(days)),
        beforeDay: scheduler.isDue(stored, new Date(2026, 9, 20 + days, 3, 59, 59, 999)),
      }));
    } else {
      let late = 0, early = 0, visits = 0, expectedDay = days;
      for (let day = 1; day <= 64; day++) {
        if (!scheduler.isDue(review, session(day))) continue;
        late += Number(day > expectedDay);
        early += Number(day < expectedDay);
        visits++;
        review = rate(review, day);
        expectedDay = day + days;
      }
      console.log(JSON.stringify({ late, early, visits }));
    }
  ` },
  bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false,
}).outputFiles[0].text;

function fixedDayInSeoul(args) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', fixedDayCode, JSON.stringify(args)], {
    cwd: process.cwd(), env: { ...process.env, TZ: 'Asia/Seoul' }, encoding: 'utf8',
  }));
}

it('makes the fixed three-day Good card due on its Seoul study day without changing the saved state', () => {
  const { stored, unchanged, next, dueAtStudyTime, beforeDay } = fixedDayInSeoul([Rating.Good, 3, 9, 0, false]);
  expect(stored.card).toMatchObject({ state: State.Learning, scheduled_days: 3, due: '2026-10-23T00:05:00.000Z' });
  expect(stored).toEqual(unchanged);
  expect({ dueAtStudyTime, beforeDay, next }).toEqual({
    dueAtStudyTime: true, beforeDay: false, next: '2026-10-22T19:00:00.000Z',
  });
});

it.each([
  [Rating.Good, 3, 9, 0], [Rating.Good, 3, 23, 30], [Rating.Good, 3, 3, 30],
  [Rating.Hard, 1, 9, 0], [Rating.Hard, 1, 23, 30], [Rating.Hard, 1, 3, 30],
])('has no late fixed reviews over 64 days in Seoul (grade %s, %s days, %s:%s)', (grade, days, hour, minute) => {
  expect(fixedDayInSeoul([grade, days, hour, minute, true])).toEqual({
    late: 0, early: 0, visits: Math.floor(64 / days),
  });
});

it('keeps an exact due timestamp for a fixed 23-hour learning interval', () => {
  const scheduler = new FsrsService({ ...DEFAULT_SETTINGS, gradeIntervalsMinutes: { 3: 1380 } });
  const review = scheduler.rate(undefined, Rating.Good, new Date(2026, 9, 20, 9, 5), 'sub-day');
  const due = new Date(review.card.due);
  expect(review.card).toMatchObject({ state: State.Learning, scheduled_days: 0 });
  expect(scheduler.nextReviewAt(review)).toEqual(due);
  expect(scheduler.isDue(review, new Date(+due - 1))).toBe(false);
  expect(scheduler.isDue(review, due)).toBe(true);
});

it.each([
  ['default', DEFAULT_STUDY_MANAGEMENT],
  ...[['30m', '12h'], ['23h'], ['1d', '2d']].map(steps =>
    [steps.join(' '), { ...DEFAULT_STUDY_MANAGEMENT, learningSteps: steps, relearningSteps: steps }]),
])('never saves a day-long Learning or Relearning state without fixed intervals (%s)', (_label, studyManagement) => {
  const scheduler = new FsrsService({ ...DEFAULT_SETTINGS, studyManagement });
  const grades = [Rating.Again, Rating.Hard, Rating.Good, Rating.Good, Rating.Easy, Rating.Again, Rating.Good, Rating.Easy];
  const counts = { total: 0, interdayLearning: 0 };
  for (let card = 0; card < 24; card++) {
    let review;
    let at = new Date(2026, 9, 20, card);
    for (let turn = 0; turn < 240; turn++) {
      review = scheduler.rate(review, grades[(card + turn) % grades.length], at, `ordinary-${card}`);
      const { state, scheduled_days } = review.card;
      if ((state === State.Learning || state === State.Relearning) && scheduled_days >= 1) counts.interdayLearning++;
      counts.total++;
      at = new Date(Math.max(Date.parse(review.card.due), +at + 60000));
    }
  }
  expect(counts).toEqual({ total: 5760, interdayLearning: 0 });
});

const instant=new Date('2026-11-06T12:00:00.123Z');
const params={request_retention:.85,maximum_interval:36500,learning_steps:['1m','10m'],relearning_steps:['5m'],w:[...default_w]};
const upstream=fuzz=>fsrs({...params,enable_fuzz:fuzz}).useStrategy(StrategyMode.SEED,GenSeedStrategyWithCardId('questionSeed'));
const serialize=card=>{const {questionSeed,...data}=card;return {...data,due:card.due.toISOString(),...(card.last_review?{last_review:card.last_review.toISOString()}:{} )};};
const q=id=>({id,heading:id,subject:'subject',questionMarkdown:id,answerMarkdown:'answer',coreKeywords:[],subKeywords:[],followUpIds:[]});
const rawNew=createEmptyCard(instant);
const rawLearning=upstream(false).next(createEmptyCard(new Date(instant.getTime()-60000)),new Date(instant.getTime()-60000),Rating.Again).card;
const rawReview=upstream(false).next(createEmptyCard(new Date(instant.getTime()-30*86400000)),new Date(instant.getTime()-30*86400000),Rating.Easy).card;
const rawRelearning=upstream(false).next(rawReview,new Date(instant.getTime()-300000),Rating.Again).card;
const rawStates={new:rawNew,learning:rawLearning,review:rawReview,relearning:rawRelearning};

describe.each([false,true])('locked ts-fsrs 5.4.1 oracle, fuzz=%s',fuzz=>{
 for(const [name,card] of Object.entries(rawStates))it.each([1,2,3,4])(`matches upstream for ${name}, rating %s`,grade=>{
  const settings={...structuredClone(DEFAULT_SETTINGS),targetRetention:.85,studyManagement:{...DEFAULT_STUDY_MANAGEMENT,learningSteps:['1m','10m'],relearningSteps:['5m'],enableFuzz:fuzz,fsrsParameters:[...default_w]}};
  const mia=new FsrsService(settings),id=`oracle-${name}`,input={card:serialize(card),history:[],lastRating:null};
  const expected=upstream(fuzz).next({...card,questionSeed:`${id}:`},instant,grade);
  const actual=mia.rate(input,grade,instant,id),preview=mia.preview(input,instant,id).find(p=>p.grade===grade);
  expect(actual.card).toEqual(serialize(expected.card));
  expect(preview.due.toISOString()).toBe(expected.card.due.toISOString());
  expect(actual.history).toHaveLength(1);expect(input.history).toEqual([]);
 });
});

const settings={...structuredClone(DEFAULT_SETTINGS),studyManagement:{...DEFAULT_STUDY_MANAGEMENT,enableFuzz:false}};
const service=new FsrsService(settings);
const state=(kind,due,reviewAt=instant)=>({card:{...serialize(createEmptyCard(reviewAt)),state:kind,due:due.toISOString(),last_review:reviewAt.toISOString(),stability:10,difficulty:5,reps:1},history:[],lastRating:3});

describe('eligibility, budget and exclusion reasons',()=>{
 it.each([State.Learning,State.Relearning,State.Review])('includes state %s at the exact due millisecond, never before',kind=>{
  const record=state(kind,instant),questions=[q('due')];
  for(const [offset,expected] of [[-1,[]],[0,['due']],[1,['due']]]){
   expect(buildReviewQueue(questions,{due:record},service,{now:new Date(instant.getTime()+offset)}).map(q=>q.id)).toEqual(expected);
  }
 });
 it('keeps a future review out of the fixed session, then includes it on a normal new start',()=>{
  const future=state(State.Review,new Date(instant.getTime()+60000));
  expect(buildReviewQueue([q('future')],{future},service,{now:instant})).toEqual([]);
  expect(planLearningQueue([],0,[],{future},new Set(),new Date(instant.getTime()+60000)).queue).toEqual([]);
  expect(buildReviewQueue([q('future')],{future},service,{now:new Date(instant.getTime()+60000)}).map(q=>q.id)).toEqual(['future']);
 });
 it.each([0,1,20])('applies review/new caps %s without dropping intraday repeats',limit=>{
  const reviews={review:state(State.Review,instant),learning:state(State.Learning,instant),relearning:state(State.Relearning,instant)};
  const result=buildReviewQueue([q('new'),q('review'),q('learning'),q('relearning')],reviews,service,{now:instant,management:{...DEFAULT_STUDY_MANAGEMENT,newCardsPerDay:limit,reviewsPerDay:limit,newCardsIgnoreReviewLimit:true}}).map(q=>q.id);
  expect(result.slice(0,2)).toEqual(['learning','relearning']);
  expect(result.includes('new')).toBe(limit>0);expect(result.includes('review')).toBe(limit>0);
 });
 it('charges interday learning to the review budget and shares the fresh budget across subjects',()=>{
  const yesterday=new Date('2026-11-05T12:00:00Z');
  const consumed=state(State.Learning,instant);consumed.history=[{state:State.New,review:instant.toISOString(),due:instant.toISOString()}];
  const reviews={orphanFromOtherSubject:consumed,interday:state(State.Learning,instant,yesterday)};
  const result=buildReviewQueue([q('new'),q('interday')],reviews,service,{now:instant,management:{...DEFAULT_STUDY_MANAGEMENT,newCardsPerDay:1,reviewsPerDay:0}});
  expect(result).toEqual([]);
  expect(buildReviewQueue([q('new'),q('interday')],reviews,service,{now:instant,management:{...DEFAULT_STUDY_MANAGEMENT,newCardsPerDay:1,reviewsPerDay:1,newCardsIgnoreReviewLimit:true}}).map(q=>q.id)).toEqual(['interday']);
 });
 it('finds a due question beyond page 50/1000 among 2001 registered questions',()=>{
  const questions=Array.from({length:2001},(_,i)=>q(`q-${i}`));
  const reviews=Object.fromEntries(questions.map((q,i)=>[q.id,state(State.Review,new Date(instant.getTime()+(i===2000?0:86400000)))]));
  expect(buildReviewQueue(questions,reviews,service,{now:instant,management:DEFAULT_STUDY_MANAGEMENT}).map(q=>q.id)).toEqual(['q-2000']);
 });
 it('preserves a corrupt date as quarantined source, and rejects a future data format',()=>{
  const raw={...state(State.Review,instant),card:{...state(State.Review,instant).card,due:'not-a-date'}};
  const parsed=parsePluginData({version:1,reviews:{bad:raw}});
  expect(parsed.reviews.bad).toBeUndefined();expect(parsed.quarantinedReviews.bad).toEqual(raw);
  expect(()=>parsePluginData({version:99,reviews:{}})).toThrow();
 });
 it('keeps exact fixed duration precedence and refuses a backwards rating without mutation',()=>{
  const mia=new FsrsService({...settings,gradeIntervalsMinutes:{1:90}}),record=state(State.Review,instant);
  const before=JSON.stringify(record);
  expect(mia.rate(record,1,instant,'fixed').card.due).toBe(new Date(instant.getTime()+90*60000).toISOString());
  expect(()=>mia.rate(record,3,new Date(instant.getTime()-1),'clock')).toThrow();expect(JSON.stringify(record)).toBe(before);
 });
});


it.each([
 ['Asia/Seoul','2026-12-31T14:59:59.999Z',0,'2026-12-30T15:00:00.000Z'],
 ['Asia/Seoul','2026-12-31T15:00:00.000Z',0,'2026-12-31T15:00:00.000Z'],
 ['Asia/Seoul','2028-02-28T18:59:59.999Z',4,'2028-02-27T19:00:00.000Z'],
 ['Asia/Seoul','2028-02-28T19:00:00.000Z',4,'2028-02-28T19:00:00.000Z'],
 ['America/New_York','2026-11-01T08:59:59.999Z',4,'2026-10-31T08:00:00.000Z'],
 ['America/New_York','2026-11-01T09:00:00.000Z',4,'2026-11-01T09:00:00.000Z'],
 ['Antarctica/Troll','2026-03-29T22:30:00.000Z',1,'2026-03-29T01:00:00.000Z'],
])('uses the exact local study boundary %s %s at hour %s',(zone,now,hour,expected)=>{
 const actual=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',calendarCode,JSON.stringify([now,expected,hour])],{cwd:process.cwd(),env:{...process.env,TZ:zone},encoding:'utf8'}));
 expect(actual.start).toBe(expected);
});

it('counts elapsed days across the local study-day boundary, not UTC midnight',()=>{
 const last=new Date(2026,10,5,12,0,0,0);
 const card={...rawReview,last_review:last};
 const mia=new FsrsService({...settings,studyManagement:{...settings.studyManagement,learningSteps:['1m','10m'],relearningSteps:['5m'],fsrsParameters:[...default_w]},targetRetention:.85});
 // Oracle: upstream on a timeline whose UTC midnight is the local 04:00 study-day start.
 const shift=d=>new Date(d.getTime()-d.getTimezoneOffset()*60000-4*3600000);
 for(const [at,elapsed] of [[new Date(2026,10,6,3,59,59,999),0],[new Date(2026,10,6,4,0,0,0),1]]){
  const expected=upstream(false).next({...card,due:shift(card.due),last_review:shift(last),questionSeed:'sd:'},shift(at),Rating.Good);
  expect(expected.log.elapsed_days).toBe(elapsed);
  const actual=mia.rate({card:serialize(card),history:[],lastRating:3},3,at,'sd');
  expect(actual.card.stability).toBe(expected.card.stability);
  expect(actual.card.elapsed_days).toBe(elapsed);
  expect(actual.card.last_review).toBe(at.toISOString());
 }
});
