import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MiaDataStore } from "../src/services/data-store";
import { DEFAULT_PLUGIN_DATA } from "../src/core/models";
import { FsrsService } from "../src/core/fsrs-service";
const clone = <T>(x:T):T => structuredClone(x);
function device(initial=clone(DEFAULT_PLUGIN_DATA)) {
 let disk=clone(initial), cache:unknown=null;
 const storage={loadData:async()=>clone(disk),saveData:async (x:unknown)=>{disk=clone(x as typeof initial);}};
 const recovery={read:()=>cache,write:(x:unknown)=>{cache=clone(x);}};
 return {store:new MiaDataStore(storage,recovery),storage,recovery,disk:()=>clone(disk),deliver:(x:typeof initial)=>{disk=clone(x);}};
}
function trace(name:string, value:unknown) {
 const directory=process.env.MIA_MULTI_DEVICE_TRACE_DIR;
 if(directory){mkdirSync(directory,{recursive:true});writeFileSync(join(directory,`${name}.json`),JSON.stringify(value,null,2));}
}
const fsrs=new FsrsService(DEFAULT_PLUGIN_DATA.settings);
const review=()=>fsrs.rate(undefined,3,new Date('2026-10-27T00:00:00Z'),'q');
describe('multi-device loss boundaries',()=>{
 it('retains offline settings siblings and both FSRS objects after reverse delivery and restart',async()=>{
  const a=device(),b=device();await a.store.load();await b.store.load();
  await a.store.updateSettings({targetRetention:.8});await b.store.updateSettings({maximumIntervalDays:100});
  const branchA=a.disk(),branchB=b.disk();a.deliver(branchB);await a.store.setReview('q',review());
  const all=[a.disk().settings,...(a.disk().settingsSync?.conflicts??[]).map(x=>x.settings)];
  expect(all).toContainEqual(branchA.settings);expect(all).toContainEqual(branchB.settings);
  trace("offline-settings-disjoint",{branchA,branchB,final:a.disk()});
  const again=new MiaDataStore(a.storage,a.recovery);await again.load();await again.synchronize();
  expect(again.getReview('q')).toEqual(review());
  expect([again.settings,...again.settingsConflicts.map(x=>x.settings)]).toEqual(expect.arrayContaining(all));
 });
 it('preserves same-field competing settings rather than silently discarding one',async()=>{
  const a=device(),b=device();await a.store.load();await b.store.load();await a.store.updateSettings({targetRetention:.8});await b.store.updateSettings({targetRetention:.95});
  const one=a.disk(),two=b.disk();a.deliver(two);await a.store.synchronize();
  expect([a.store.settings,...a.store.settingsConflicts.map(x=>x.settings)]).toEqual(expect.arrayContaining([one.settings,two.settings]));
 });
 it('keeps ordinary descendant setting delivery free of conflicts and repeated events idempotent',async()=>{
  const a=device();await a.store.load();const b=device(a.disk());await b.store.load();await b.store.updateSettings({targetRetention:.8});a.deliver(b.disk());
  await a.store.synchronize();await a.store.synchronize();expect(a.store.settings.targetRetention).toBe(.8);expect(a.store.settingsConflicts).toEqual([]);
 });
});

describe('known edit bases and recovery',()=>{
 it('rebases disjoint fields only against the editor captured base',async()=>{
  const a=device();await a.store.load();const base=clone(a.store.settings);
  const b=device();await b.store.load();await b.store.updateSettings({maximumIntervalDays:100});a.deliver(b.disk());
  await a.store.updateSettings({targetRetention:.8},base);
  expect(a.store.settings.targetRetention).toBe(.8);expect(a.store.settings.maximumIntervalDays).toBe(100);expect(a.store.settingsConflicts).toEqual([]);
 });
 it('archives conflicting same-field input, keeps remote active, and explicitly restores without changing cards',async()=>{
  const a=device();await a.store.load();const base=clone(a.store.settings);await a.store.setReview('q',review());
  const b=device(a.disk());await b.store.load();await b.store.updateSettings({targetRetention:.95});a.deliver(b.disk());
  await expect(a.store.updateSettings({targetRetention:.8},base)).rejects.toThrow(/보관/);
  expect(a.store.settings.targetRetention).toBe(.95);expect(a.store.settingsConflicts).toHaveLength(1);
  const before=clone(a.store.reviews);const restarted=new MiaDataStore(a.storage,a.recovery);await restarted.load();
  await restarted.restoreSettingsConflict(restarted.settingsConflicts[0]!.id);
  expect(restarted.settings.targetRetention).toBe(.8);expect(restarted.reviews).toEqual(before);expect(restarted.settingsConflicts.map(x=>x.settings.targetRetention)).toContain(.95);
 });
 it('keeps a failed operation in a device-local pending copy through restart and retries without evaluating twice',async()=>{
  const a=device();let pending:unknown=null;
  const recovery={...a.recovery,readPending:()=>pending,writePending:(x:unknown)=>{pending=clone(x);}};
  const store=new MiaDataStore(a.storage,recovery);await store.load();
  const save=a.storage.saveData;a.storage.saveData=async()=>{throw Error('offline write failure');};
  await expect(store.setReview('q',review())).rejects.toThrow(/failure/);expect(store.getReview('q')).toBeUndefined();expect(pending).not.toBeNull();
  const restart=new MiaDataStore(a.storage,recovery);await restart.load();expect(restart.pendingRecovery!.reviews.q!.history).toHaveLength(1);
  await expect(restart.updateSettings({targetRetention:.8})).rejects.toThrow(/미완료/);
  a.storage.saveData=save;await restart.retryPending();await restart.retryPending();
  expect(restart.getReview('q')).toEqual(review());expect(a.disk().reviews.q!.card.due).toBe('2026-10-27T00:10:00.000Z');expect(pending).toBeNull();trace('failed-write-retry',{final:a.disk(),pendingAfterRetry:pending});
 });
 it('does not attempt a host write when staging the local recovery intent fails',async()=>{
  const a=device();const store=new MiaDataStore(a.storage,{...a.recovery,writePending:()=>{throw Error('local full');}});await store.load();
  await expect(store.setReview('q',review())).rejects.toThrow('local full');expect(a.disk().reviews).toEqual({});
 });
 it('retains known local evaluations when a service replaces the file before the app reads it',async()=>{
  const a=device(),b=device();await a.store.load();await b.store.load();await a.store.setReview('a',review());await b.store.setReview('b',review());
  const oldA=a.disk();a.deliver(b.disk());const restarted=new MiaDataStore(a.storage,a.recovery);await restarted.load();await restarted.synchronize();
  expect(Object.keys(a.disk().reviews).sort()).toEqual(['a','b']);expect(a.disk().reviews.a).toEqual(oldA.reviews.a);expect(a.disk().reviews.b).toEqual(b.disk().reviews.b);
 });
 it('reproduces the unobservable gap: a host save overwrites an unread peer file, recoverable only from the peer',async()=>{
  const a=device(),b=device();await a.store.load();await b.store.load();await b.store.setReview('b',review());const peer=b.disk();
  const save=a.storage.saveData;a.storage.saveData=async next=>{a.deliver(peer);await save(next);};
  await a.store.setReview('a',review());expect(a.disk().reviews.b).toBeUndefined();trace("unobservable-overwrite",{unreadPeer:peer,afterHostOverwrite:a.disk()});
  // No event or read delivered B to A, so A cannot reconstruct it. B's retained
  // independent state is the recovery source, not a guessed synthesized log.
  b.deliver(a.disk());await b.store.synchronize();expect(Object.keys(b.disk().reviews).sort()).toEqual(['a','b']);trace('peer-recovery-after-unobservable-overwrite',{peerRecovered:b.disk()});
 });
 it('preserves distinct same-time ratings as complete branches, never concatenates histories',async()=>{
  const a=device(),b=device();await a.store.load();await b.store.load();
  const good=review(),again=fsrs.rate(undefined,1,new Date('2026-10-27T00:00:00Z'),'q');
  await a.store.setReview('q',good);await b.store.setReview('q',again);a.deliver(b.disk());await a.store.synchronize();await a.store.synchronize();
  const branches=[a.store.getReview('q')!,...(a.store.conflicts.q??[])];expect(branches).toHaveLength(2);
  expect(branches.map(x=>x.card.due).sort()).toEqual(['2026-10-27T00:01:00.000Z','2026-10-27T00:10:00.000Z']);
  expect(branches.map(x=>x.history[0]!.rating).sort()).toEqual([1,3]);expect(branches.every(x=>x.card.state===1&&x.card.reps===1&&x.history.length===1)).toBe(true);trace('same-time-ratings',{originalGood:good,originalAgain:again,final:a.disk()});
 });
 it('rejects a stale same-question evaluation after reading a newer complete state',async()=>{
  const a=device(),b=device();await a.store.load();await b.store.load();await b.store.setReview('q',review());a.deliver(b.disk());
  await expect(a.store.setReview('q',fsrs.rate(undefined,1,new Date('2026-10-27T00:00:00Z'),'q'),{state:undefined})).rejects.toThrow(/変更|변경/);expect(a.store.getReview('q')).toEqual(review());
 });
});

describe('migration and retry boundaries',()=>{
 it('retains unknown legacy settings as alternatives without guessing their edit order',async()=>{
  const old=clone(DEFAULT_PLUGIN_DATA);old.settings.targetRetention=.8;const remote=clone(DEFAULT_PLUGIN_DATA);remote.settings.targetRetention=.95;
  const a=device(old);await a.store.load();a.deliver(remote);await a.store.synchronize();
  expect([a.store.settings,...a.store.settingsConflicts.map(x=>x.settings)].map(x=>x.targetRetention).sort()).toEqual([.8,.95]);
 });
 it('restores a staged local snapshot after readback detects a peer replacement',async()=>{
  const a=device(),b=device();await b.store.load();await b.store.setReview('b',review());let pending:unknown=null;
  const recovery={...a.recovery,readPending:()=>pending,writePending:(x:unknown)=>{pending=clone(x);}};
  const store=new MiaDataStore(a.storage,recovery);await store.load();const save=a.storage.saveData;
  a.storage.saveData=async next=>{await save(next);a.deliver(b.disk());throw Error('readback mismatch');};
  await expect(store.setReview('a',review())).rejects.toThrow(/mismatch/);
  expect(a.disk().reviews.a).toBeUndefined();expect(a.disk().reviews.b).toEqual(review());
  const restored=new MiaDataStore(a.storage,recovery);await restored.load();a.storage.saveData=save;await restored.retryPending();
  expect(Object.keys(a.disk().reviews).sort()).toEqual(['a','b']);expect(a.disk().reviews.a).toEqual(review());expect(a.disk().reviews.b).toEqual(review());
 });
 it('refuses malformed settings ancestry instead of erasing the original',async()=>{
  const broken={...clone(DEFAULT_PLUGIN_DATA),settingsSync:{id:'same',ancestors:['same'],conflicts:[]}};
  const a=device(broken);await expect(a.store.load()).rejects.toThrow(/設定|설정/);expect(a.disk()).toEqual(broken);
 });
 it('does not multiply archived settings under reverse and duplicate offline deliveries',async()=>{
  const a=device(),b=device();await a.store.load();await b.store.load();await a.store.updateSettings({targetRetention:.8});await b.store.updateSettings({targetRetention:.95});const aa=a.disk(),bb=b.disk();
  a.deliver(bb);await a.store.synchronize();b.deliver(aa);await b.store.synchronize();
  const canonical=a.disk();b.deliver(canonical);await b.store.synchronize();a.deliver(b.disk());await a.store.synchronize();await a.store.synchronize();
  expect(a.disk()).toEqual(b.disk());expect(a.store.settingsConflicts).toHaveLength(1);
 });
});
