import { describe, expect, it, vi } from "vitest";
import { VerifiedPluginStorage } from "../src/services/verified-plugin-storage";
import { MiaDataStore } from "../src/services/data-store";
import { DEFAULT_PLUGIN_DATA } from "../src/core/models";
import { FsrsService } from "../src/core/fsrs-service";
import { Rating } from "ts-fsrs";

const fsrs = new FsrsService({targetRetention:.9,maximumIntervalDays:36500});
function environment(text = null) {
  let disk = text;
  const adapter = {
    exists: vi.fn(async () => disk !== null),
    read: vi.fn(async () => { if(disk===null) throw Error("missing");return disk; }),
  };
  const native = {
    loadData:vi.fn(async()=>{if(disk===null)return null;try{return JSON.parse(disk);}catch{return undefined;}}),
    saveData:vi.fn(async value=>{disk=JSON.stringify(value);}),
  };
  const path=".custom/plugins/mia-study/data.json";
  const storage=new VerifiedPluginStorage(native,adapter,path);
  return {native,adapter,storage,path,disk:()=>disk,replace:value=>{disk=value;}};
}

describe("verified Obsidian JSON storage",()=>{
  it("accepts a genuine first installation without a data file",async()=>{
    const env=environment();await expect(env.storage.loadData()).resolves.toBeNull();
    expect(env.adapter.exists).toHaveBeenCalledWith(env.path);
  });
  it.each(["{broken","null",""])("refuses an existing unreadable data file %j instead of treating it as a new install",async text=>{
    const env=environment(text);await expect(env.storage.loadData()).rejects.toThrow();
    expect(env.disk()).toBe(text);expect(env.native.saveData).not.toHaveBeenCalled();
  });
  it("does not classify an adapter permission failure as a missing file",async()=>{
    const env=environment();env.adapter.exists.mockRejectedValueOnce(Error("permission denied"));
    await expect(env.storage.loadData()).rejects.toThrow("permission denied");
  });
  it("passes valid native data through without bypassing the native change tracking",async()=>{
    const env=environment(JSON.stringify(DEFAULT_PLUGIN_DATA));
    await expect(env.storage.loadData()).resolves.toEqual(DEFAULT_PLUGIN_DATA);
    expect(env.native.loadData).toHaveBeenCalledOnce();
  });
  it("rejects a native write that resolves after swallowing an actual storage error",async()=>{
    const env=environment(JSON.stringify(DEFAULT_PLUGIN_DATA));env.native.saveData.mockResolvedValueOnce(undefined);
    await expect(env.storage.saveData({...DEFAULT_PLUGIN_DATA,settings:{...DEFAULT_PLUGIN_DATA.settings,targetRetention:.8}})).rejects.toThrow();
    expect(JSON.parse(env.disk()).settings.targetRetention).toBe(.9);
  });
  it("verifies successful writes from the actual file and honors a custom plugin directory",async()=>{
    const env=environment();const value={...DEFAULT_PLUGIN_DATA,settings:{...DEFAULT_PLUGIN_DATA.settings,targetRetention:.8}};
    await expect(env.storage.saveData(value)).resolves.toBeUndefined();
    expect(env.native.saveData).toHaveBeenCalledOnce();expect(env.adapter.read).toHaveBeenCalledWith(env.path);
    expect(JSON.parse(env.disk())).toEqual(value);
  });
  it("does not apply an unsaved grade to memory or recovery when the host swallowed a write error",async()=>{
    const env=environment(JSON.stringify(DEFAULT_PLUGIN_DATA)),write=vi.fn();
    const store=new MiaDataStore(env.storage,{read:()=>null,write});await store.load();
    env.native.saveData.mockResolvedValueOnce(undefined);
    await expect(store.setReview("q",fsrs.rate(undefined,Rating.Good,new Date("2026-10-20"),"q"))).rejects.toThrow();
    expect(store.getReview("q")).toBeUndefined();expect(write).not.toHaveBeenCalled();
  });
  it("uses a valid recovery copy for a damaged native file while refusing to overwrite the damaged bytes",async()=>{
    const env=environment("{broken"),saved=structuredClone(DEFAULT_PLUGIN_DATA);
    saved.reviews.q=fsrs.rate(undefined,Rating.Good,new Date("2026-10-20"),"q");
    const store=new MiaDataStore(env.storage,{read:()=>saved,write:vi.fn()});await store.load();
    expect(store.getReview("q")).toEqual(saved.reviews.q);
    await expect(store.updateSettings({targetRetention:.8})).rejects.toThrow();
    expect(env.disk()).toBe("{broken");expect(env.native.saveData).not.toHaveBeenCalled();
  });
});

describe("verified JSON formatting compatibility",()=>{
  const value={...DEFAULT_PLUGIN_DATA,extra:{text:"한글\n줄바꿈 \"따옴표\"",list:[1,null,true]}};
  it.each([undefined,2,4,"\t"])("verifies the complete persisted value with indentation %j",async indent=>{
    const env=environment();env.native.saveData.mockImplementationOnce(async data=>env.replace(JSON.stringify(data,null,indent)));
    await expect(env.storage.saveData(value)).resolves.toBeUndefined();expect(JSON.parse(env.disk())).toEqual(value);
  });
  it("accepts extra outer whitespace through the existing parsed comparison",async()=>{
    const env=environment();env.native.saveData.mockImplementationOnce(async data=>env.replace(" \n"+JSON.stringify(data)+"\n "));
    await expect(env.storage.saveData(value)).resolves.toBeUndefined();
  });
  it.each([undefined,2])("rejects changed nested history content in format %j",async indent=>{
    const env=environment();env.native.saveData.mockImplementationOnce(async data=>env.replace(JSON.stringify({...data,extra:{...data.extra,text:"changed"}},null,indent)));
    await expect(env.storage.saveData(value)).rejects.toThrow(/같은 내용/);
  });
  it("rejects corrupt persisted JSON even after native save resolved",async()=>{
    const env=environment();env.native.saveData.mockImplementationOnce(async()=>env.replace('{\n  "broken":'));
    await expect(env.storage.saveData(value)).rejects.toThrow(/형식/);
  });
});
