import { describe, expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
import { DEFAULT_PLUGIN_DATA } from "../src/core/models";
import { FsrsService } from "../src/core/fsrs-service";
import { MiaDataStore } from "../src/services/data-store";
import { PortableStudyStorage, PORTABLE_DATA_PATH, PORTABLE_RESUME_PATH, preparePortableStudyStorage, selectPortableStudyStorage } from "../src/services/portable-study-storage";
import { StudyUiStore } from "../src/services/study-ui-store";

const snapshot = { version: 1, resume: { queue: ["a", "b"], seed: ["a", "b"], skipped: [], queueIndex: 1, answerVisible: true, sessionMode: "recall", updatedAt: "2026-10-26T00:00:00.000Z" }, updatedAt: "2026-10-26T00:00:00.000Z" };
const scheduler = new FsrsService(DEFAULT_PLUGIN_DATA.settings);
function setup() {
  const files = new Map<string, string>();const directories=new Set<string>();
  const adapter = {
    exists: async (path: string) => files.has(path) || directories.has(path),
    read: async (path: string) => { const value=files.get(path); if(value===undefined)throw Error("missing file");return value; },
    write: vi.fn(async (path: string, text: string) => { files.set(path,text); }),
    mkdir: async (path: string) => { directories.add(path); },
  };
  let disk: unknown = structuredClone(DEFAULT_PLUGIN_DATA);
  const legacy={loadData:vi.fn(async()=>structuredClone(disk)),saveData:async(value:unknown)=>{disk=structuredClone(value);}};
  return {files,adapter,legacy,legacyValue:()=>structuredClone(disk)};
}
const prepare = (ui: ReturnType<typeof setup>, resume: unknown = snapshot) => preparePortableStudyStorage(ui.adapter,ui.legacy,resume);

describe("portable study storage using ordinary note files",()=>{
  it("leaves the working legacy mode unchanged until explicitly enabled",async()=>{
    const ui=setup();expect(await selectPortableStudyStorage(ui.adapter,false)).toBeNull();
    expect(ui.adapter.write).not.toHaveBeenCalled();expect(ui.legacy.loadData).not.toHaveBeenCalled();
  });
  it("copies grades, settings and resume without modifying the legacy source",async()=>{
    const ui=setup();const store=new MiaDataStore(ui.legacy);await store.load();
    await store.setReview("a",scheduler.rate(undefined,Rating.Good,new Date(),"a"));
    await store.updateSettings({studyManagement:{...store.settings.studyManagement,newCardsPerDay:7}});
    const original=ui.legacyValue();await prepare(ui);
    const portable=await selectPortableStudyStorage(ui.adapter,false);expect(portable).not.toBeNull();
    const loaded=new MiaDataStore(portable!);await loaded.load();
    expect(loaded.reviews).toEqual(store.reviews);expect(loaded.settings.studyManagement.newCardsPerDay).toBe(7);
    expect(JSON.parse(await portable!.resumeAdapter.read(PORTABLE_RESUME_PATH))).toEqual(snapshot);
    expect(ui.legacyValue()).toEqual(original);
    expect([...ui.files.keys()]).toHaveLength(3);expect([...ui.files.keys()].every(path=>path.endsWith(".md")&&!path.startsWith("."))).toBe(true);
  });
  it("round trips between two devices that transfer only ordinary Markdown files",async()=>{
    const pc=setup();await prepare(pc);const desktop=new MiaDataStore((await selectPortableStudyStorage(pc.adapter,false))!);await desktop.load();
    await desktop.setReview("a",scheduler.rate(undefined,Rating.Easy,new Date(),"a"));
    const phone=setup();for(const[path,text]of pc.files)phone.files.set(path,text);
    const mobile=new MiaDataStore((await selectPortableStudyStorage(phone.adapter,false))!);await mobile.load();expect(mobile.reviews).toEqual(desktop.reviews);
    await mobile.setReview("b",scheduler.rate(undefined,Rating.Hard,new Date(),"b"));
    for(const[path,text]of phone.files)pc.files.set(path,text);await desktop.synchronize();expect(desktop.reviews).toEqual(mobile.reviews);
    await mobile.removeReview("a");for(const[path,text]of phone.files)pc.files.set(path,text);
    await desktop.synchronize();expect(desktop.getReview("a")).toBeUndefined();expect(desktop.getReview("b")).toEqual(mobile.getReview("b"));
    expect(phone.legacy.loadData).not.toHaveBeenCalled();
  });
  it("merges another device's shared grades and keeps its newer resume",async()=>{
    const ui=setup();await prepare(ui);const portable=(await selectPortableStudyStorage(ui.adapter,false))!;
    const remote=new MiaDataStore(portable);await remote.load();await remote.setReview("b",scheduler.rate(undefined,Rating.Easy,new Date(),"b"));
    const newer={...snapshot,resume:{...snapshot.resume,queueIndex:0,updatedAt:"2026-10-27T00:00:00.000Z"},updatedAt:"2026-10-27T00:00:00.000Z"};
    await portable.resumeAdapter.write(PORTABLE_RESUME_PATH,JSON.stringify(newer));
    const local=new MiaDataStore(ui.legacy);await local.load();await local.setReview("a",scheduler.rate(undefined,Rating.Good,new Date(),"a"));
    await prepare(ui);await remote.synchronize();expect(Object.keys(remote.reviews).sort()).toEqual(["a","b"]);
    expect(JSON.parse(await portable.resumeAdapter.read(PORTABLE_RESUME_PATH))).toEqual(newer);
  });
  it("retains device appearance and suspension checkpoints when the resume path changes",async()=>{
    const ui=setup();await prepare(ui);const portable=(await selectPortableStudyStorage(ui.adapter,false))!;
    const local=new Map<string,unknown>();const app={vault:{adapter:ui.adapter},loadLocalStorage:(key:string)=>local.get(key),saveLocalStorage:(key:string,value:unknown)=>{local.set(key,value);}};
    // The mock is the Obsidian host boundary only; both stores and files are real.
    const original=new StudyUiStore(app,"legacy/ui-state.json");original.updateAppearance({size:"large",focus:true});
    await original.saveResume({...snapshot.resume,sessionMode:"recall",queueIndex:0,updatedAt:"2026-10-28T00:00:00.000Z"});
    const moved=new StudyUiStore(app,PORTABLE_RESUME_PATH,{localStatePath:"legacy/ui-state.json",adapter:portable.resumeAdapter});await moved.load();
    expect(moved.appearance).toMatchObject({size:"large",focus:true});expect(moved.resume?.queueIndex).toBe(0);
    await moved.saveResume({...moved.resume!,answerVisible:false});await moved.load();expect(moved.resume?.answerVisible).toBe(false);
  });
  it.each([PORTABLE_DATA_PATH,PORTABLE_RESUME_PATH])("rejects damaged shared data without rewriting %s",async path=>{
    const ui=setup();await prepare(ui);ui.files.set(path,"broken");const before=new Map(ui.files);ui.adapter.write.mockClear();
    await expect(prepare(ui)).rejects.toThrow();expect(ui.files).toEqual(before);expect(ui.adapter.write).not.toHaveBeenCalled();
  });
  it("does not publish a mode after a failed initial resume copy and can retry",async()=>{
    const ui=setup();const write=ui.adapter.write.getMockImplementation()!;
    ui.adapter.write.mockImplementation(async(path,text)=>{if(path===PORTABLE_RESUME_PATH)throw Error("disk full");await write(path,text);});
    await expect(prepare(ui)).rejects.toThrow("disk full");expect(await selectPortableStudyStorage(ui.adapter,false)).toBeNull();
    ui.adapter.write.mockImplementation(write);await prepare(ui);expect(await selectPortableStudyStorage(ui.adapter,false)).not.toBeNull();
  });
  it("reports missing transferred files rather than silently loading a stale legacy copy",async()=>{
    const ui=setup();await prepare(ui);ui.files.delete(PORTABLE_DATA_PATH);
    await expect(selectPortableStudyStorage(ui.adapter,false)).rejects.toThrow("도착");
    ui.files.clear();await expect(selectPortableStudyStorage(ui.adapter,true)).rejects.toThrow("도착");
  });
  it("does not overwrite a future sync format",async()=>{
    const ui=setup();await prepare(ui);const marker=[...ui.files.keys()].find(path=>path.endsWith("sync-mode.md"))!;
    ui.files.set(marker,ui.files.get(marker)!.replace('"version": 1','"version": 2'));const before=new Map(ui.files);ui.adapter.write.mockClear();
    await expect(prepare(ui)).rejects.toThrow("버전");expect(ui.files).toEqual(before);expect(ui.adapter.write).not.toHaveBeenCalled();
  });
  it("detects a write acknowledgement with different persisted contents",async()=>{
    const ui=setup();await prepare(ui);const portable=new PortableStudyStorage(ui.adapter);
    ui.adapter.write.mockImplementationOnce(async(path,text)=>{ui.files.set(path,text+"changed");});
    await expect(portable.saveData(DEFAULT_PLUGIN_DATA)).rejects.toThrow("저장 결과");
  });
  it("aborts preparation when another device changes a file after it was read",async()=>{
    const ui=setup();await prepare(ui);const read=ui.adapter.read;
    let reads=0;ui.adapter.read=async path=>{const text=await read(path);if(path===PORTABLE_DATA_PATH&&++reads===1)ui.files.set(path,text+"external");return text;};
    ui.adapter.write.mockClear();await expect(prepare(ui)).rejects.toThrow("다른 기기");expect(ui.adapter.write).not.toHaveBeenCalled();
  });
  it("preserves a newer mode file arriving while preparation is in progress",async()=>{
    const ui=setup();await prepare(ui);const marker=[...ui.files.keys()].find(path=>path.endsWith("sync-mode.md"))!;
    const future=ui.files.get(marker)!.replace('"version": 1','"version": 2');const write=ui.adapter.write.getMockImplementation()!;
    const local=new MiaDataStore(ui.legacy);await local.load();await local.setReview("a",scheduler.rate(undefined,Rating.Good,new Date(),"a"));
    ui.adapter.write.mockImplementation(async(path,text)=>{await write(path,text);if(path===PORTABLE_DATA_PATH)ui.files.set(marker,future);});
    await expect(prepare(ui)).rejects.toThrow("다른 기기");expect(ui.files.get(marker)).toBe(future);
  });
  it("keeps clear-session timestamps so an older remote resume cannot resurrect them",async()=>{
    const ui=setup();await prepare(ui);const cleared={version:1,resume:null,updatedAt:"2026-10-28T00:00:00.000Z"};await prepare(ui,cleared);
    const portable=(await selectPortableStudyStorage(ui.adapter,false))!;
    expect(JSON.parse(await portable.resumeAdapter.read(PORTABLE_RESUME_PATH))).toEqual(cleared);
    await prepare(ui,snapshot);expect(JSON.parse(await portable.resumeAdapter.read(PORTABLE_RESUME_PATH))).toEqual(cleared);
  });

  it("rejects future review data rather than loading an older recovery snapshot",async()=>{
    const ui=setup();await prepare(ui);ui.files.set(PORTABLE_DATA_PATH,ui.files.get(PORTABLE_DATA_PATH)!.replace('"version": 1','"version": 2'));
    const store=new MiaDataStore(new PortableStudyStorage(ui.adapter),{read:()=>DEFAULT_PLUGIN_DATA,write:vi.fn()});
    await expect(store.load()).rejects.toThrow("지원하지 않는 복습 기록");
  });

});
