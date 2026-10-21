import { describe,expect,it,vi } from "vitest";
import { applyFileChanges } from "../src/services/file-change-batch";
function environment({at=2,mode="before",rollbackBlocked=false,afterFailure,readBlocked=false}={}){
 const files=[{path:"a.md"},{path:"b.md"},{path:"c.md"}],disk=new Map(files.map(f=>[f.path,"original "+f.path]));let writes=0;
 const vault={
  read:vi.fn(async file=>{if(readBlocked)throw Error("read blocked");return disk.get(file.path);}),
  process:vi.fn(async(file,update)=>{
   writes++;if(rollbackBlocked && writes>at)throw Error("rollback blocked");
   const next=update(disk.get(file.path));
   if(writes===at && mode==="before"){afterFailure?.(disk);throw Error("write blocked");}
   disk.set(file.path,next);
   if(writes===at && mode==="after"){afterFailure?.(disk);throw Error("write persisted then rejected");}
   return next;
  }),
 };
 return{files,disk,vault,changes:files.map(file=>({file,update:content=>content+" updated"}))};
}
describe("guarded batch file changes",()=>{
 it("writes a successful batch once per file",async()=>{
  const env=environment({at:99});await applyFileChanges(env.vault,env.changes);expect([...env.disk.values()]).toEqual(["original a.md updated","original b.md updated","original c.md updated"]);
 });
 it.each([1,2,3])("restores originals after write %s fails before persistence",async at=>{
  const env=environment({at}),before=new Map(env.disk);await expect(applyFileChanges(env.vault,env.changes)).rejects.toThrow("write blocked");expect(env.disk).toEqual(before);
 });
 it.each([1,2,3])("restores originals after write %s persists and then rejects",async at=>{
  const env=environment({at,mode:"after"}),before=new Map(env.disk);await expect(applyFileChanges(env.vault,env.changes)).rejects.toThrow();expect(env.disk).toEqual(before);
 });
 it("restores all writes if the final action fails",async()=>{
  const env=environment({at:99}),before=new Map(env.disk);await expect(applyFileChanges(env.vault,env.changes,async()=>{throw Error("final action failed");})).rejects.toThrow("final action failed");expect(env.disk).toEqual(before);
 });
 it("preserves external changes and reports the affected paths",async()=>{
  const env=environment({afterFailure:disk=>disk.set("a.md","external change")});await expect(applyFileChanges(env.vault,env.changes)).rejects.toThrow(/복구.*a.md/);expect(env.disk.get("a.md")).toBe("external change");expect(env.disk.get("b.md")).toBe("original b.md");
 });
 it("does not guess recovery when a file cannot be read",async()=>{
  const env=environment({readBlocked:true});await expect(applyFileChanges(env.vault,env.changes)).rejects.toThrow(/복구/);expect(env.disk.get("a.md")).toBe("original a.md updated");
 });
 it("reports rollback failure without hiding it behind the initial write error",async()=>{
  const env=environment({rollbackBlocked:true});await expect(applyFileChanges(env.vault,env.changes)).rejects.toThrow(/복구/);expect(env.disk.get("a.md")).toBe("original a.md updated");
 });
 it("does not roll back no-op files",async()=>{
  const env=environment();env.changes[0].update=content=>content;await expect(applyFileChanges(env.vault,env.changes)).rejects.toThrow();expect(env.vault.process).toHaveBeenCalledTimes(2);
 });
});


describe("batch storage acknowledgements",()=>{
 it("does not run the final deletion after a write silently failed",async()=>{
  const env=environment({at:99}),finish=vi.fn();env.vault.process.mockImplementationOnce(async(file,update)=>update(env.disk.get(file.path)));
  await expect(applyFileChanges(env.vault,env.changes,finish)).rejects.toThrow(/저장/);expect(finish).not.toHaveBeenCalled();expect(env.disk.get("a.md")).toBe("original a.md");
 });
 it("recognizes a completed rollback even if its write promise rejects",async()=>{
  const env=environment({at:99});let calls=0;
  env.vault.process.mockImplementation(async(file,update)=>{env.disk.set(file.path,update(env.disk.get(file.path)));if(++calls>3)throw Error("rollback persisted then rejected");});
  await expect(applyFileChanges(env.vault,env.changes,async()=>{throw Error("finish failed");})).rejects.toThrow("finish failed");
  expect([...env.disk.values()]).toEqual(["original a.md","original b.md","original c.md"]);
 });
});
