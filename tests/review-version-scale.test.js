import {describe,it,expect,vi} from 'vitest';
import {nextReviewVersion} from '../src/core/review-sync';
import {MiaDataStore} from '../src/services/data-store';
import {DEFAULT_PLUGIN_DATA} from '../src/core/models';
import {FsrsService} from '../src/core/fsrs-service';
const stamp='2099-01-01T00:00:00.000Z';
describe('review version generation at scale',()=>{
 it('advances past 200000 revision markers without an argument-count limit',()=>{
  const versions=Object.fromEntries(Array.from({length:200000},(_,i)=>['q'+i,stamp+':seed']));
  const original=versions.q199999;
  expect(nextReviewVersion(versions)).toMatch(/^2099-01-01T00:00:00\.001Z:.+/);
  expect(versions.q199999).toBe(original);expect(Object.keys(versions)).toHaveLength(200000);
 });
 it('preserves the finite-date, epoch-floor and own-property rules',()=>{
  const now=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-21T00:00:00Z'));
  try{
   const versions=Object.assign(Object.create({inherited:stamp+':inherited'}),{invalid:'not-a-date',past:'1960-01-01T00:00:00.000Z:old'});
   expect(nextReviewVersion(versions)).toMatch(/^2026-10-21T00:00:00\.000Z:.+/);
   expect(nextReviewVersion({})).toMatch(/^2026-10-21T00:00:00\.000Z:.+/);
  }finally{now.mockRestore();}
 });
 it('commits and reloads a grade when old deleted questions left 200000 markers',async()=>{
  let disk=structuredClone(DEFAULT_PLUGIN_DATA),recovery=null;
  disk.reviewVersions=Object.fromEntries(Array.from({length:200000},(_,i)=>['deleted-'+i,stamp+':seed']));
  const storage={loadData:async()=>structuredClone(disk),saveData:async data=>{disk=structuredClone(data);}};
  const cache={read:()=>recovery,write:data=>{recovery=structuredClone(data);}};
  const store=new MiaDataStore(storage,cache);await store.load();
  const fsrs=new FsrsService(store.settings),review=fsrs.rate(undefined,3,new Date('2026-10-21'),'new');
  await store.setReview('new',review,{state:undefined});
  expect(store.getReviewVersion('new')).toMatch(/^2099-01-01T00:00:00\.001Z:.+/);
  const restarted=new MiaDataStore(storage,cache);await restarted.load();
  expect(restarted.getReview('new')).toEqual(review);expect(Object.keys(restarted.reviews)).toEqual(['new']);
  expect(restarted.getReview('deleted-199999')).toBeUndefined();expect(restarted.getReviewVersion('deleted-199999')).toBe(stamp+':seed');
  expect(Object.keys(disk.reviewVersions)).toHaveLength(200001);expect(recovery).toEqual(disk);
 },30000);
});
