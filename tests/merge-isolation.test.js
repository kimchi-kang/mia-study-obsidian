import {describe,it,expect} from 'vitest';
import {mergeReviewData} from '../src/core/review-sync';
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
