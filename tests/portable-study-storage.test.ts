import { describe, expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
import { DEFAULT_PLUGIN_DATA } from "../src/core/models";
import { FsrsService } from "../src/core/fsrs-service";
import { MiaDataStore } from "../src/services/data-store";
import { PortableStudyStorage, PORTABLE_DATA_PATH, PORTABLE_RESUME_PATH, PORTABLE_STUDY_FOLDER, PORTABLE_SYNC_INCOMPLETE_WARNING, portableSyncPartiallyArrived, preparePortableStudyStorage, selectPortableStudyStorage } from "../src/services/portable-study-storage";
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

const MODE_FILE = `${PORTABLE_STUDY_FOLDER}/sync-mode.md`;
const FENCE_HEAD = "<!-- mia-study-sync:mode:v1 -->\n\n이 파일은 MIA Study가 관리합니다. 직접 편집하지 마세요.\n\n```json\n";

describe("tolerant reading of portable files", () => {
  async function prepared() {
    const ui = setup(); const store = new MiaDataStore(ui.legacy); await store.load();
    await store.setReview("a", scheduler.rate(undefined, Rating.Good, new Date("2026-10-27T00:00:00Z"), "a"));
    await prepare(ui);
    return ui;
  }
  const variants: Array<[string, (text: string) => string]> = [
    ["CRLF line endings", text => text.replaceAll("\n", "\r\n")],
    ["lone CR line endings", text => text.replaceAll("\n", "\r")],
    ["a UTF-8 BOM", text => `\uFEFF${text}`],
    ["a missing final newline", text => text.slice(0, -1)],
    ["extra trailing blank lines", text => `${text}\n\n\n`],
    ["trailing spaces after the fence", text => `${text.slice(0, -1)}  \n`],
    ["BOM + CRLF + no final newline", text => `\uFEFF${text.replaceAll("\n", "\r\n").slice(0, -2)}`],
  ];
  it.each(variants)("reads all three files with %s the same as the original", async (_name, change) => {
    const ui = await prepared();
    const records = await new PortableStudyStorage(ui.adapter).loadData();
    const resume = await new PortableStudyStorage(ui.adapter).resumeAdapter.read(PORTABLE_RESUME_PATH);
    for (const path of [...ui.files.keys()]) ui.files.set(path, change(ui.files.get(path)!));
    const portable = await selectPortableStudyStorage(ui.adapter, true);
    expect(portable).not.toBeNull();
    expect(await portable!.loadData()).toEqual(records);
    expect(await portable!.resumeAdapter.read(PORTABLE_RESUME_PATH)).toBe(resume);
  });

  const rejected: Array<[string, (text: string) => string]> = [
    ["truncated JSON", text => text.slice(0, Math.floor(text.length * 0.6))],
    ["truncated just before the closing fence", text => text.slice(0, text.lastIndexOf("\n```"))],
    ["an altered marker comment", text => text.replace("mia-study-sync:", "mia-study-sync-x:")],
    ["a different marker kind", text => text.replace(":records:", ":resume:")],
    ["an altered notice line", text => text.replace("직접 편집하지 마세요.", "자유롭게 편집하세요.")],
    ["a missing closing fence", text => text.slice(0, text.lastIndexOf("```"))],
    ["a missing opening fence", text => text.replace("```json\n", "")],
    ["text after the closing fence", text => `${text}남은 글자\n`],
    ["two merged copies", text => text + text],
    ["an empty file", () => ""],
  ];
  it.each(rejected)("still rejects %s", async (_name, change) => {
    const ui = await prepared();
    const before = ui.files.get(PORTABLE_DATA_PATH)!;
    ui.files.set(PORTABLE_DATA_PATH, change(before));
    await expect(new PortableStudyStorage(ui.adapter).loadData()).rejects.toThrow();
  });
  it.each([
    ["an altered marker comment", (text: string) => text.replace("mia-study-sync:", "mia-study-sync-x:")],
    ["a missing closing fence", (text: string) => text.slice(0, text.lastIndexOf("```"))],
  ])("still reports the format error and never rewrites a file with %s", async (_name, change) => {
    const ui = await prepared();
    ui.files.set(PORTABLE_DATA_PATH, change(ui.files.get(PORTABLE_DATA_PATH)!));
    const before = new Map(ui.files); ui.adapter.write.mockClear();
    await expect(new PortableStudyStorage(ui.adapter).loadData()).rejects.toThrow("범용 동기화 파일 형식을 확인하세요. 원본을 덮어쓰지 않았습니다.");
    await expect(prepare(ui)).rejects.toThrow();
    expect(ui.files).toEqual(before); expect(ui.adapter.write).not.toHaveBeenCalled();
  });

  it("writes the same bytes as before (pins existing behaviour)", async () => {
    const ui = setup(); await prepare(ui);
    expect(ui.files.get(MODE_FILE)).toBe(`${FENCE_HEAD}{\n  "version": 1\n}\n\`\`\`\n`);
    expect(ui.files.get(PORTABLE_RESUME_PATH)).toBe(`<!-- mia-study-sync:resume:v1 -->\n\n이 파일은 MIA Study가 관리합니다. 직접 편집하지 마세요.\n\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n`);
    const records = ui.files.get(PORTABLE_DATA_PATH)!;
    expect(records.startsWith("<!-- mia-study-sync:records:v1 -->\n\n이 파일은 MIA Study가 관리합니다. 직접 편집하지 마세요.\n\n```json\n{\n  \"version\": 1,")).toBe(true);
    expect(records.endsWith("\n}\n```\n")).toBe(true); expect(records).not.toContain("\r");
  });
  it("rewrites a CRLF file with the original LF bytes on the next save (round trip)", async () => {
    const ui = await prepared();
    const original = ui.files.get(PORTABLE_DATA_PATH)!;
    ui.files.set(PORTABLE_DATA_PATH, `\uFEFF${original.replaceAll("\n", "\r\n")}`);
    const portable = new PortableStudyStorage(ui.adapter);
    await portable.saveData(await portable.loadData());
    expect(ui.files.get(PORTABLE_DATA_PATH)).toBe(original);
  });

  it("does not report a failed save when the file system hands the text back with CRLF", async () => {
    const ui = await prepared(); const read = ui.adapter.read;
    ui.adapter.read = async path => (await read(path)).replaceAll("\n", "\r\n");
    const portable = new PortableStudyStorage(ui.adapter);
    await portable.saveData(await portable.loadData());
    await portable.resumeAdapter.write(PORTABLE_RESUME_PATH, JSON.stringify(snapshot));
  });
  it("still treats a different persisted body as a failed save even if only line endings also differ", async () => {
    const ui = await prepared(); const portable = new PortableStudyStorage(ui.adapter);
    ui.adapter.write.mockImplementationOnce(async (path, text) => { ui.files.set(path, `${text.replaceAll("\n", "\r\n")}changed`); });
    await expect(portable.saveData(DEFAULT_PLUGIN_DATA)).rejects.toThrow("저장 결과");
  });
  it("does not call a line-ending-only difference between two reads a change by another device", async () => {
    const ui = await prepared(); const read = ui.adapter.read; let reads = 0;
    ui.adapter.read = async path => { const text = await read(path); return path === PORTABLE_DATA_PATH && ++reads === 2 ? text.replaceAll("\n", "\r\n") : text; };
    await prepare(ui);
  });
  it("still aborts preparation when a real change appears between two reads, even combined with CRLF", async () => {
    const ui = await prepared(); const read = ui.adapter.read; let reads = 0;
    ui.adapter.read = async path => { const text = await read(path); return path === PORTABLE_DATA_PATH && ++reads === 2 ? `${text.replaceAll("\n", "\r\n")}external` : text; };
    ui.adapter.write.mockClear();
    await expect(prepare(ui)).rejects.toThrow("다른 기기"); expect(ui.adapter.write).not.toHaveBeenCalled();
  });
});

describe("detecting a sync folder that has not fully arrived", () => {
  const adapterWith = (...present: string[]) => ({ exists: async (path: string) => present.includes(path) });
  it.each([
    ["only the folder", [PORTABLE_STUDY_FOLDER]],
    ["only the data file", [PORTABLE_DATA_PATH]],
    ["only the resume file", [PORTABLE_RESUME_PATH]],
    ["data and resume without the mode file", [PORTABLE_STUDY_FOLDER, PORTABLE_DATA_PATH, PORTABLE_RESUME_PATH]],
  ])("reports %s as partially arrived", async (_name, present) => {
    expect(await portableSyncPartiallyArrived(adapterWith(...present))).toBe(true);
  });
  it("reports nothing for a vault without the folder or once the mode file is present", async () => {
    expect(await portableSyncPartiallyArrived(adapterWith())).toBe(false);
    expect(await portableSyncPartiallyArrived(adapterWith(MODE_FILE, PORTABLE_STUDY_FOLDER, PORTABLE_DATA_PATH))).toBe(false);
  });
  it("treats a failing existence check as no evidence instead of breaking startup", async () => {
    expect(await portableSyncPartiallyArrived({ exists: async () => { throw new Error("adapter unavailable"); } })).toBe(false);
  });
  it("does not change which storage is selected (pinning existing behaviour)", async () => {
    const ui = setup();
    ui.files.set(PORTABLE_DATA_PATH, "x");
    expect(await selectPortableStudyStorage(ui.adapter, false)).toBeNull();
  });
  it("warns in Korean that ratings stay on this device", () => {
    expect(PORTABLE_SYNC_INCOMPLETE_WARNING).toBe("동기화 폴더(MIA Study Sync)를 찾았지만 아직 모두 도착하지 않았습니다. 지금 남기는 평가는 이 기기에만 저장됩니다. 보관함 동기화를 마친 뒤 Obsidian을 다시 시작하세요.");
  });
});
