import {describe,it,expect} from 'vitest';
import {mergeReviewData} from '../src/core/review-sync';
import {FsrsService} from '../src/core/fsrs-service';
import {DEFAULT_PLUGIN_DATA} from '../src/core/models';
const service=new FsrsService({targetRetention:.9,maximumIntervalDays:36500});
const reverse=value=>Object.fromEntries(Object.entries(value).reverse());
function snapshots(){const left=structuredClone(DEFAULT_PLUGIN_DATA);left.reviews.q=service.rate(undefined,3,new Date('2026-10-22T00:00:00Z'),'q');left.reviewVersions.q='2026-10-22T00:00:00.000Z:same';return [left,structuredClone(left)];}
describe('review equality retains serialization tie and conflict semantics',()=>{
 it.each(['root','card','log','changed-log'])('preserves both delivered states and the original winner: %s',variant=>{
  const [local,incoming]=snapshots();const state=incoming.reviews.q;
  if(variant==='root')incoming.reviews.q=reverse(state);
  if(variant==='card')state.card=reverse(state.card);
  if(variant==='log')state.history[0]=reverse(state.history[0]);
  if(variant==='changed-log')state.history[0].difficulty+=1;
  const before=structuredClone([local,incoming]);const localWins=JSON.stringify(local.reviews.q)>JSON.stringify(incoming.reviews.q);
  const result=mergeReviewData(local,incoming);
  expect(JSON.stringify(result.reviews.q)).toBe(JSON.stringify((localWins?local:incoming).reviews.q));
  expect(result.reviewConflicts.q).toHaveLength(1);
  expect(JSON.stringify(result.reviewConflicts.q[0])).toBe(JSON.stringify((localWins?incoming:local).reviews.q));
  expect([local,incoming]).toEqual(before);
 });
 it('detects an externally edited history after an equal merge instead of trusting a cached key',()=>{
  const [local,incoming]=snapshots();expect(mergeReviewData(local,incoming).reviewConflicts.q).toBeUndefined();
  local.reviews.q.history[0].difficulty+=1;
  expect(mergeReviewData(local,incoming).reviewConflicts.q).toHaveLength(1);
 });
});
