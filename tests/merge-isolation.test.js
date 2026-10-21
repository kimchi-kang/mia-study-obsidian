import {describe,it,expect} from 'vitest';
import {mergeReviewData,mergeIntoOwnedIncoming} from '../src/core/review-sync';
import {DEFAULT_PLUGIN_DATA} from '../src/core/models';
import {FsrsService} from '../src/core/fsrs-service';
import {Rating} from 'ts-fsrs';
const service=new FsrsService({targetRetention:.9,maximumIntervalDays:36500});
describe('merged data ownership',()=>{
 it.each(['local','incoming'])('does not share winner or conflict history references with %s input',winner=>{
  const left=structuredClone(DEFAULT_PLUGIN_DATA),right=structuredClone(DEFAULT_PLUGIN_DATA);
  left.reviews.q=service.rate(undefined,Rating.Good,new Date('2026-10-20'),'q');right.reviews.q=service.rate(undefined,Rating.Again,new Date('2026-10-20'),'q');
  left.reviewVersions.q=(winner==='local'?'2026-10-21':'2026-10-20')+'T00:00:00.000Z:a';right.reviewVersions.q=(winner==='incoming'?'2026-10-21':'2026-10-20')+'T00:00:00.000Z:b';
  const saved=JSON.stringify([left,right]),merged=mergeReviewData(left,right);merged.reviews.q.history[0].rating=99;merged.reviewConflicts.q[0].history[0].rating=88;merged.settings.sourceRoots.push('new');expect(JSON.stringify([left,right])).toBe(saved);
 });
 it('retains a legacy new card without an edit marker',()=>{
  const local=structuredClone(DEFAULT_PLUGIN_DATA);local.reviews.q=service.createState(new Date('2026-10-20'));const merged=mergeReviewData(local,structuredClone(DEFAULT_PLUGIN_DATA));expect(merged.reviews.q).toEqual(local.reviews.q);
 });
});


describe('delayed grades after an explicit deletion',()=>{
 for(const merge of [mergeReviewData,mergeIntoOwnedIncoming])for(const deletionSide of ['local','incoming']){
  it(`${merge.name} retains the delivered grade with deletion on ${deletionSide}`,()=>{
   const deletion=structuredClone(DEFAULT_PLUGIN_DATA),delivered=structuredClone(DEFAULT_PLUGIN_DATA);
   deletion.reviewVersions.q='2026-10-21T01:00:00.000Z:undo';
   delivered.reviews.q=service.rate(undefined,Rating.Again,new Date('2026-10-20'),'q');
   delivered.reviewVersions.q='2026-10-21T00:00:00.000Z:offline';
   const local=deletionSide==='local'?deletion:delivered;
   const incoming=structuredClone(deletionSide==='local'?delivered:deletion);
   const before=JSON.stringify(local),grade=structuredClone(delivered.reviews.q);
   const merged=merge(local,incoming);
   expect(merged.reviews.q).toBeUndefined();expect(merged.reviewVersions.q).toBe(deletion.reviewVersions.q);
   expect(merged.reviewConflicts.q).toEqual([grade]);expect(JSON.stringify(local)).toBe(before);
   const repeated=mergeReviewData(merged,delivered);
   expect(repeated).toEqual(merged);repeated.reviewConflicts.q[0].history[0].rating=99;
   expect(delivered.reviews.q).toEqual(grade);expect(merged.reviewConflicts.q).toEqual([grade]);
  });
 }
 it('does not archive an empty first-install snapshot or lose a newer grade',()=>{
  const empty=structuredClone(DEFAULT_PLUGIN_DATA),deletion=structuredClone(DEFAULT_PLUGIN_DATA),newer=structuredClone(DEFAULT_PLUGIN_DATA);
  deletion.reviewVersions.q='2026-10-21T00:00:00.000Z:undo';
  expect(mergeReviewData(deletion,empty).reviewConflicts.q).toBeUndefined();
  newer.reviews.q=service.rate(undefined,Rating.Good,new Date('2026-10-21'),'q');newer.reviewVersions.q='2026-10-21T01:00:00.000Z:new';
  expect(mergeReviewData(deletion,newer).reviews.q).toEqual(newer.reviews.q);
 });
});
