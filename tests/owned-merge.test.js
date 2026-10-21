import {describe,it,expect} from 'vitest';
import {mergeIntoOwnedIncoming} from '../src/core/review-sync';
import {DEFAULT_PLUGIN_DATA} from '../src/core/models';
import {FsrsService} from '../src/core/fsrs-service';
import {Rating} from 'ts-fsrs';
const fsrs=new FsrsService({targetRetention:.9,maximumIntervalDays:36500});
const fresh=()=>structuredClone(DEFAULT_PLUGIN_DATA);
const review=grade=>fsrs.rate(undefined,grade,new Date('2026-10-20'),'q');
const revision=n=>`2026-10-${n}T00:00:00.000Z:test`;
describe('consumed validated incoming merge',()=>{
 it('uses the owned buffer while keeping local input and winner history independent',()=>{
  const local=fresh(),incoming=fresh();local.reviews.q=review(Rating.Good);local.reviewVersions.q=revision(21);const saved=structuredClone(local);
  const merged=mergeIntoOwnedIncoming(local,incoming);expect(merged).toBe(incoming);expect(merged.reviews.q).toEqual(local.reviews.q);
  merged.reviews.q.history[0].rating=Rating.Easy;expect(local).toEqual(saved);
 });
 it('preserves an incoming winner, other reviews, settings and conflict history',()=>{
  const local=fresh(),incoming=fresh();local.reviews.q=review(Rating.Good);local.reviewVersions.q=revision(20);
  incoming.reviews.q=review(Rating.Again);incoming.reviews.other=review(Rating.Easy);incoming.reviewVersions.q=revision(21);incoming.settings.targetRetention=.8;
  const merged=mergeIntoOwnedIncoming(local,incoming);expect(merged.reviews.q.lastRating).toBe(Rating.Again);expect(merged.reviews.other.lastRating).toBe(Rating.Easy);expect(merged.settings.targetRetention).toBe(.8);expect(merged.reviewConflicts.q[0].lastRating).toBe(Rating.Good);
  merged.reviewConflicts.q[0].card.reps=99;expect(local.reviews.q.card.reps).toBe(1);
 });
 it('keeps the original corrupt-presence winner rule when quarantine is merged',()=>{
  const local=fresh(),incoming=fresh();local.quarantinedReviews.q={raw:'preserve'};local.reviewVersions.q=revision(21);
  const merged=mergeIntoOwnedIncoming(local,incoming);expect(merged.quarantinedReviews.q).toEqual({raw:'preserve'});expect(merged.reviewVersions.q).toBeUndefined();expect(merged.reviews.q).toBeUndefined();
 });
 it('retains a valid local record beside the incoming quarantine original',()=>{
  const local=fresh(),incoming=fresh();local.reviews.q=review(Rating.Good);incoming.quarantinedReviews.q={raw:'broken'};incoming.reviewVersions.q=revision(21);
  const merged=mergeIntoOwnedIncoming(local,incoming);expect(merged.reviews.q).toEqual(local.reviews.q);expect(merged.quarantinedReviews.q).toEqual({raw:'broken'});
 });
 it('rejects incompatible opaque quarantine without changing either input',()=>{
  const local=fresh(),incoming=fresh();local.quarantinedReviews.q={raw:1};incoming.quarantinedReviews.q={raw:2};const saved=structuredClone([local,incoming]);
  expect(()=>mergeIntoOwnedIncoming(local,incoming)).toThrow();expect([local,incoming]).toEqual(saved);
 });
 it('retains a newer deletion marker without resurrecting an older incoming grade',()=>{
  const local=fresh(),incoming=fresh();local.reviewVersions.q=revision(21);incoming.reviews.q=review(Rating.Easy);incoming.reviewVersions.q=revision(20);
  const merged=mergeIntoOwnedIncoming(local,incoming);expect(merged.reviews.q).toBeUndefined();expect(merged.reviewVersions.q).toBe(revision(21));
 });
});

import {MiaDataStore} from '../src/services/data-store';
import {vi} from 'vitest';
describe('owned commit failure isolation',()=>{
 it('does not mutate live memory, host input or recovery before a failed save is confirmed',async()=>{
  const disk=fresh();disk.reviews.q=review(Rating.Good);disk.reviews.other=review(Rating.Easy);const before=structuredClone(disk),write=vi.fn();
  const store=new MiaDataStore({loadData:async()=>disk,saveData:async()=>{throw Error('disk full');}},{read:()=>null,write});await store.load();
  const original=store.getReview('q'),next=fsrs.rate(original,Rating.Hard,new Date('2026-10-21'),'q');
  await expect(store.setReview('q',next,{state:original})).rejects.toThrow('disk full');expect(store.getReview('q')).toEqual(before.reviews.q);expect(store.getReview('other')).toEqual(before.reviews.other);expect(disk).toEqual(before);expect(write).not.toHaveBeenCalled();
 });
 it('keeps prior settings after a rejected settings write using the owned buffer',async()=>{
  const disk=fresh(),before=structuredClone(disk),store=new MiaDataStore({loadData:async()=>disk,saveData:async()=>{throw Error('read only');}});await store.load();
  await expect(store.updateSettings({targetRetention:.8})).rejects.toThrow('read only');expect(store.settings.targetRetention).toBe(.9);expect(disk).toEqual(before);
 });
});

it.each(['local','incoming'])('isolates parsed startup winners and alternatives from both host snapshots: %s',async winner=>{
 const disk=fresh(),cache=fresh();disk.reviews.q=review(Rating.Good);cache.reviews.q=review(Rating.Again);
 disk.reviewVersions.q=revision(winner==='incoming'?21:20);cache.reviewVersions.q=revision(winner==='local'?21:20);
 const before=structuredClone([disk,cache]);const save=vi.fn(),recover=vi.fn();
 const store=new MiaDataStore({loadData:async()=>disk,saveData:save},{read:()=>cache,write:recover});await store.load();
 expect(store.getReview('q').lastRating).toBe(winner==='incoming'?Rating.Good:Rating.Again);
 expect(store.conflicts.q).toHaveLength(1);store.getReview('q').history[0].rating=99;store.conflicts.q[0].history[0].rating=88;
 store.settings.sourceRoots.push('new');expect([disk,cache]).toEqual(before);expect(save).not.toHaveBeenCalled();expect(recover).not.toHaveBeenCalled();
});
