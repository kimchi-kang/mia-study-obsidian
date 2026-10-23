import { describe, expect, it, vi } from "vitest";
import { StudyUiStore, parseStudyAppearance, parseStudyResume } from "../src/services/study-ui-store";

const saved = { queue: ["one", "two", "one"], seed: ["one", "two"], skipped: ["two"], queueIndex: 1, answerVisible: true, sessionMode: "recall", updatedAt: "2026-10-17T00:00:00Z" };
function device(files = new Map()) {
  const local = new Map();
  const adapter = { exists: async path => files.has(path), read: async path => files.get(path), write: vi.fn(async (path, data) => { files.set(path, data); }) };
  const app = { vault: { adapter }, loadLocalStorage: key => local.get(key), saveLocalStorage: (key, value) => { local.set(key, value); } };
  return { files, local, adapter, app, store: new StudyUiStore(app, "plugin/ui-state.json") };
}

describe("resume persistence and device reading preferences", () => {
  it("loads an existing session on another device without sharing device font preferences", async () => {
    const first = device(); first.store.updateAppearance({ size: "large", density: "compact", memorizationOrder: "sequential" });
    await first.store.saveResume(saved);
    const second = device(first.files); await second.store.load();
    expect(second.store.resume).toEqual(saved);
    expect(second.store.appearance).toMatchObject({ size: "medium", density: "detailed" });
    expect(new StudyUiStore(first.app, "plugin/ui-state.json").appearance).toMatchObject({ size: "large", density: "compact", memorizationOrder: "sequential" });
    expect([...first.files.keys()]).toEqual(["plugin/ui-state.json"]);
  });
  it("persists the latest of several quick position changes in order", async () => {
    const ui = device();
    await Promise.all([ui.store.saveResume(saved), ui.store.saveResume({ ...saved, queueIndex: 2 }), ui.store.saveResume({ ...saved, queueIndex: 0 })]);
    await ui.store.load(); expect(ui.store.resume.queueIndex).toBe(0);
    const copy = ui.store.resume; copy.queue.push("mutated"); expect(ui.store.resume.queue).toEqual(saved.queue);
  });
  it("returns to the last successful save after consecutive failures, and permits retry", async () => {
    const ui = device(); await ui.store.saveResume(saved);
    ui.adapter.write.mockRejectedValueOnce(Error("disk full")).mockRejectedValueOnce(Error("disk full"));
    const result = await Promise.allSettled([ui.store.saveResume({ ...saved, queueIndex: 2 }), ui.store.saveResume(null)]);
    expect(result.map(item => item.status)).toEqual(["rejected", "rejected"]);
    expect(ui.store.resume).toEqual(saved);
    await ui.store.saveResume(null); await ui.store.load(); expect(ui.store.resume).toBeNull();
  });
  it("does not let a slow synced-file read overwrite a newer local move", async () => {
    const ui = device(); await ui.store.saveResume(saved);
    let finishRead;
    const old = ui.files.get("plugin/ui-state.json");
    ui.adapter.read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishRead = () => resolve(old); })).mockImplementation(async path => ui.files.get(path));
    const load = ui.store.load();
    await Promise.resolve(); await Promise.resolve();
    await ui.store.saveResume({ ...saved, queueIndex: 2 });
    finishRead(); await load; expect(ui.store.resume.queueIndex).toBe(2);
  });
  it.each(["{broken", '{"version":2,"resume":null}', '{"version":1,"resume":{"queue":["one"]}}'])("reports unreadable resume data without rewriting it", async raw => {
    const ui = device(new Map([["plugin/ui-state.json", raw]]));
    await expect(ui.store.load()).rejects.toThrow();
    expect(ui.adapter.write).not.toHaveBeenCalled(); expect(ui.files.get("plugin/ui-state.json")).toBe(raw);
  });
  it("keeps current preferences when local saving fails", () => {
    const ui = device(); ui.app.saveLocalStorage = () => { throw Error("unavailable"); };
    expect(() => ui.store.updateAppearance({ size: "large" })).toThrow();
    expect(ui.store.appearance.size).toBe("medium");
  });
  it("defaults unknown appearance values and rejects invalid resume positions", () => {
    expect(parseStudyAppearance({ size: "giant", density: null })).toMatchObject({ size: "medium", density: "detailed" });
    expect(parseStudyResume({ ...saved, queueIndex: -1 })).toBeNull();
    expect(parseStudyResume({ ...saved, queueIndex: 4 })).toBeNull();
    expect(parseStudyResume({ ...saved, queue: ["one", 2] })).toBeNull();
    expect(parseStudyResume({ ...saved, queueIndex: 3 })).toMatchObject({ queueIndex: 3 });
  });
});

describe("reading position and stale device resume", () => {
  it("restores scroll and expanded concepts on another device", async () => {
    const phone = device(); await phone.store.saveResume({ ...saved, scrollTop: 345, pageScrollTop: 12, conceptsOpen: true });
    const pad = device(phone.files); await pad.store.load();
    expect(pad.store.resume).toMatchObject({ scrollTop: 345, pageScrollTop: 12, conceptsOpen: true, answerVisible: true });
    expect(parseStudyResume({ ...saved, scrollTop: -1, pageScrollTop: Infinity })).not.toHaveProperty("scrollTop");
  });
  it("rejects an older queued position rather than overwriting a newer remote session", async () => {
    const phone = device(); await phone.store.saveResume(saved);
    const pad = device(phone.files); await pad.store.load();
    const newer = { ...saved, queueIndex: 2, updatedAt: "2026-10-18T00:00:00Z" };
    await pad.store.saveResume(newer);
    await expect(phone.store.saveResume(saved)).rejects.toThrow("더 최근");
    expect(phone.store.resume).toEqual(newer); await phone.store.load(); expect(phone.store.resume.queueIndex).toBe(2);
  });
});


it("recovers the device checkpoint if the app stops before the asynchronous position write completes", async () => {
  const ui=device();await ui.store.saveResume(saved);
  let finish;ui.adapter.write.mockImplementationOnce((path,data)=>new Promise(resolve=>{finish=()=>{ui.files.set(path,data);resolve();};}));
  const newer={...saved,scrollTop:900,updatedAt:"2026-10-18T01:00:00Z"};const write=ui.store.saveResume(newer);
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  const restarted=new StudyUiStore(ui.app,"plugin/ui-state.json");await restarted.load();
  expect(restarted.resume).toEqual(newer);
  finish();await write;
});

const flushResumeWrites = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
describe("reload and multiple-instance resume ordering", () => {
  it("does not let an older instance's delayed write replace a completed newer session", async () => {
    const ui = device(); await ui.store.saveResume(saved);
    let finish;
    ui.adapter.write.mockImplementationOnce((path, content) => new Promise(resolve => { finish = () => { ui.files.set(path, content); resolve(); }; }));
    const older = ui.store.saveResume({ ...saved, queueIndex: 0 }); await flushResumeWrites();
    vi.resetModules();
    const { StudyUiStore: ReloadedStore } = await import("../src/services/study-ui-store");
    expect(ReloadedStore).not.toBe(StudyUiStore);
    const restarted = new ReloadedStore(ui.app, "plugin/ui-state.json"); await restarted.load();
    const newer = { ...saved, queueIndex: 2, updatedAt: "2026-10-19T00:00:00Z" };
    const latest = restarted.saveResume(newer); await flushResumeWrites();
    finish(); await Promise.all([older, latest]);
    const fresh = new StudyUiStore(ui.app, "plugin/ui-state.json"); await fresh.load();
    expect(JSON.parse(ui.files.get("plugin/ui-state.json")).resume).toEqual(newer);
    expect(fresh.resume).toEqual(newer);
  });
  it("does not roll back another instance's newer synchronous checkpoint when an old write fails", async () => {
    const ui = device(); await ui.store.saveResume(saved);
    let fail, finish;
    ui.adapter.write.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(Error("disk full")); }))
      .mockImplementationOnce((path, content) => new Promise(resolve => { finish = () => { ui.files.set(path, content); resolve(); }; }));
    const old = ui.store.saveResume({ ...saved, queueIndex: 0 }).catch(error => error); await flushResumeWrites();
    const restarted = new StudyUiStore(ui.app, "plugin/ui-state.json"); await restarted.load();
    const newer = { ...saved, queueIndex: 2, updatedAt: "2026-10-19T00:00:00Z" };
    const pending = restarted.saveResume(newer); await flushResumeWrites(); fail(); await old; await flushResumeWrites();
    const checkpoint = ui.local.get("mia-study:resume-checkpoint:plugin/ui-state.json");
    // Finish the write before asserting, so a failing regression does not leave hanging work.
    finish(); await pending;
    expect(checkpoint.resume).toEqual(newer);
  });
  it("does not serialize writes to independent resume paths", async () => {
    const ui = device(); let finish;
    ui.adapter.write.mockImplementationOnce((path, content) => new Promise(resolve => { finish = () => { ui.files.set(path, content); resolve(); }; }));
    const blocked = ui.store.saveResume(saved); await flushResumeWrites();
    const other = new StudyUiStore(ui.app, "other/ui-state.json"); await other.saveResume(saved);
    expect(JSON.parse(ui.files.get("other/ui-state.json")).resume).toEqual(saved);
    finish(); await blocked;
  });
});

it.each([null, {id:"one"}, {id:"one",version:42}, {id:"",version:null}])("refuses a malformed review checkpoint instead of silently removing its replay guard: %j", reviewCheckpoint => {
  expect(parseStudyResume({...saved,reviewCheckpoint})).toBeNull();
});
