import {describe,it,expect,vi} from 'vitest';
import {MiaDataStore} from '../src/services/data-store';
import {DEFAULT_PLUGIN_DATA} from '../src/core/models';
import {FsrsService} from '../src/core/fsrs-service';
const fsrs=new FsrsService({targetRetention:.9,maximumIntervalDays:36500});
const grade=rating=>fsrs.rate(undefined,rating,new Date('2026-10-21'),'q');
function environment(){
 let disk=structuredClone(DEFAULT_PLUGIN_DATA);disk.reviews={one:grade(3),two:grade(1),other:grade(4)};
 for(const id of Object.keys(disk.reviews))disk.reviewVersions[id]='2026-10-21T00:00:00.000Z:seed';
 const storage={loadData:async()=>structuredClone(disk),saveData:vi.fn(async data=>{disk=structuredClone(data);})};
 const recovery={read:()=>null,write:vi.fn()};
 return {store:new MiaDataStore(storage,recovery),storage,recovery,read:()=>structuredClone(disk)};
}
describe('bulk review removal boundaries',()=>{
 it('rejects a stale later question without marking an earlier question deleted in memory',async()=>{
  const h=environment();await h.store.load();const before=h.read();
  await expect(h.store.removeReviews(['one','two'],{state:before.reviews.one})).rejects.toThrow('다른 기기');
  expect(h.store.reviews).toEqual(before.reviews);expect(h.read()).toEqual(before);
  expect(h.store.getReviewVersion('one')).toBe(before.reviewVersions.one);
  expect(h.storage.saveData).not.toHaveBeenCalled();expect(h.recovery.write).not.toHaveBeenCalled();
  await h.store.synchronize();expect(h.read().reviews).toEqual(before.reviews);
 });
 it('removes duplicate targets together while retaining unrelated history and advancing all deletion markers',async()=>{
  const h=environment();await h.store.load();const before=h.read();
  await h.store.removeReviews(['one','two','one']);const result=h.read();
  expect(result.reviews).toEqual({other:before.reviews.other});
  for(const id of ['one','two'])expect(result.reviewVersions[id]>before.reviewVersions[id]).toBe(true);
  expect(result.reviewVersions.other).toBe(before.reviewVersions.other);
  expect(h.storage.saveData).toHaveBeenCalledOnce();expect(h.recovery.write.mock.calls[0][0]).toEqual(result);
 });
 it('does not publish a partial bulk deletion after a failed save and permits retry',async()=>{
  const h=environment();await h.store.load();const before=h.read();
  h.storage.saveData.mockRejectedValueOnce(Error('disk full'));
  await expect(h.store.removeReviews(['one','two'])).rejects.toThrow('disk full');
  expect(h.store.reviews).toEqual(before.reviews);expect(h.read()).toEqual(before);expect(h.recovery.write).not.toHaveBeenCalled();
  await h.store.removeReviews(['one','two']);expect(h.read().reviews).toEqual({other:before.reviews.other});
 });
});
