import { describe, expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import type { Plugin } from "obsidian";
import { DataStoreInternals, MiaDataStore } from "../src/services/data-store";

describe("settings validation", () => {
  it("starts new installs under MIA and preserves existing user locations", () => {
    expect(DataStoreInternals.parseSettings(undefined)).toMatchObject({
      sourceRoots: ["MIA"], keywordFolder: "MIA/키워드",
    });
    expect(DataStoreInternals.parseSettings({ sourceRoots: ["내 학습"], keywordFolder: "내 학습/개념" })).toMatchObject({
      sourceRoots: ["내 학습"], keywordFolder: "내 학습/개념",
    });
  });
  it("clamps invalid values and normalizes roots", () => {
    const settings = DataStoreInternals.parseSettings({
      sourceRoots: [" 전자기학 ", 42, ""],
      targetRetention: 2,
      maximumIntervalDays: -4,
      newCardsPerDay: 12,
      reviewsPerDay: 0,
      keywordFolder: "",
    });
    expect(settings.sourceRoots).toEqual(["전자기학"]);
    expect(settings.targetRetention).toBe(0.99);
    expect(settings.maximumIntervalDays).toBe(36500);
    expect(settings).not.toHaveProperty("newCardsPerDay");
    expect(settings).not.toHaveProperty("reviewsPerDay");
    expect(settings.keywordFolder).toBe("MIA/키워드");
  });

  it("normalizes duplicate paths and rejects traversal or internal keyword folders", () => {
    const settings = DataStoreInternals.parseSettings({
      sourceRoots: ["/전자기학/", "전자기학", "../밖"],
      keywordFolder: ".obsidian/plugins",
    });
    expect(settings.sourceRoots).toEqual(["전자기학"]);
    expect(settings.keywordFolder).toBe("MIA/키워드");
  });
});

describe("review data validation", () => {
  it("accepts complete FSRS data and derives the last rating from its history", () => {
    const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
    const review = fsrs.rate(undefined, Rating.Good, new Date("2026-08-16T00:00:00.000Z"));
    const parsed = DataStoreInternals.parseReviews({ "mia-q-valid": { ...review, lastRating: 99 } });
    expect(parsed.reviews["mia-q-valid"]?.lastRating).toBe(Rating.Good);
    expect(parsed.quarantined).toEqual({});
  });

  it("quarantines malformed records without discarding their original value", () => {
    const corrupt = { card: { due: "not-a-date" }, history: [], lastRating: null };
    const parsed = DataStoreInternals.parseReviews({ "mia-q-corrupt": corrupt });
    expect(parsed.reviews).toEqual({});
    expect(parsed.quarantined["mia-q-corrupt"]).toEqual(corrupt);
  });

  it("preserves an existing quarantine while recovering newly valid records", () => {
    const parsed = DataStoreInternals.parseReviews({}, { "mia-q-old": { raw: true } });
    expect(parsed.quarantined).toEqual({ "mia-q-old": { raw: true } });
  });
});

describe("review deletion", () => {
  it("removes several question records in one persisted update", async () => {
    const writes: unknown[] = [];
    const plugin = {
      loadData: async () => ({}),
      saveData: async (value: unknown) => { writes.push(value); },
    } as unknown as Plugin;
    const store = new MiaDataStore(plugin);
    await store.load();
    const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
    const review = fsrs.rate(undefined, Rating.Good, new Date("2026-08-16T00:00:00.000Z"));
    await store.setReview("one", review);
    await store.setReview("two", review);
    const before = writes.length;
    await store.removeReviews(["one", "two", "one"]);
    expect(store.reviews).toEqual({});
    expect(writes).toHaveLength(before + 1);
  });
});

describe("overlapping saves", () => {
  it("does not carry a failed review into a queued successful settings save", async () => {
    let rejectSave!: (error: Error) => void;
    const writes: unknown[] = [];
    const plugin = {
      loadData: async () => ({}),
      saveData: async (value: unknown) => {
        writes.push(structuredClone(value));
        if (writes.length === 1) await new Promise<void>((_resolve, reject) => { rejectSave = reject; });
      },
    } as unknown as Plugin;
    const store = new MiaDataStore(plugin); await store.load();
    const review = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 }).rate(undefined, Rating.Good);
    const first = store.setReview("one", review);
    const failed = expect(first).rejects.toThrow("disk full");
    const second = store.updateSettings({ targetRetention: 0.85 });
    await new Promise(resolve => setTimeout(resolve, 0));
    rejectSave(Error("disk full"));
    await failed; await second;
    expect(store.getReview("one")).toBeUndefined();
    expect(writes.at(-1)).toHaveProperty("reviews", {});
    expect(writes.at(-1)).toMatchObject({ settings: { targetRetention: 0.85 } });
  });

  it("commits queued review changes in order even when the first save fails", async () => {
    const writes: unknown[] = [];
    const store = new MiaDataStore({
      loadData: async () => ({}),
      saveData: async (value: unknown) => { writes.push(structuredClone(value)); if (writes.length === 1) throw Error("disk full"); },
    } as unknown as Plugin);
    await store.load();
    const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
    const old = fsrs.rate(undefined, Rating.Again), latest = fsrs.rate(undefined, Rating.Good);
    const first = store.setReview("one", old);
    const failed = expect(first).rejects.toThrow("disk full");
    const second = store.setReview("one", latest);
    await failed; await second;
    expect(store.getReview("one")).toEqual(latest);
    expect(writes.at(-1)).toMatchObject({ reviews: { one: latest } });
  });
});

describe('pre-1.4 archived settings migration',()=>{
 it('loads and preserves older conflict snapshots without writing or discarding their identities',async()=>{
  const {DEFAULT_SETTINGS}=await import('../src/core/models');
  const old=structuredClone(DEFAULT_SETTINGS);delete (old.studyManagement as Partial<typeof old.studyManagement>).interdayLearningOrder;
  const data={version:1,settings:structuredClone(old),reviews:{},settingsSync:{id:'current',ancestors:[],conflicts:[{id:'old-peer',ancestors:['older'],settings:structuredClone(old)}]}};
  let writes=0;const store=new MiaDataStore({loadData:async()=>structuredClone(data),saveData:async()=>{writes++;}});
  await store.load();expect(writes).toBe(0);expect(store.settings.studyManagement.interdayLearningOrder).toBe('mix');expect(store.settingsConflicts).toHaveLength(1);
  expect(store.settingsConflicts[0]).toMatchObject({id:'old-peer',ancestors:['older'],settings:{studyManagement:{interdayLearningOrder:'mix'}}});
  const expected=structuredClone(old);Object.assign(expected.studyManagement,{interdayLearningOrder:'mix'});expect(store.settingsConflicts[0]!.settings).toEqual(expected);
 });
 it('continues to reject explicitly corrupt new placement values in archived originals',async()=>{
  const {DEFAULT_SETTINGS}=await import('../src/core/models');const corrupt={...structuredClone(DEFAULT_SETTINGS),studyManagement:{...DEFAULT_SETTINGS.studyManagement,interdayLearningOrder:'invalid'}};
  const store=new MiaDataStore({loadData:async()=>({version:1,settings:DEFAULT_SETTINGS,reviews:{},settingsSync:{id:'current',ancestors:[],conflicts:[{id:'old-peer',ancestors:[],settings:corrupt}]}}),saveData:async()=>{throw Error('must not write');}});
  await expect(store.load()).rejects.toThrow('보관된 설정');
 });
});

describe("device-local pending copy failures", () => {
  const scheduler = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
  const rate = (id: string) => scheduler.rate(undefined, Rating.Good, new Date("2026-10-27T00:00:00Z"), id);
  function environment() {
    let disk: unknown = null;
    const local = { pending: null as unknown, recovery: null as unknown };
    const failures = { pendingWrite: false, pendingClear: false, file: false };
    const warnings: string[] = [];
    const storage = {
      loadData: async () => structuredClone(disk),
      saveData: async (value: unknown) => { if (failures.file) throw new Error("file write failed"); disk = structuredClone(value); },
    };
    const recovery = {
      readPending: () => structuredClone(local.pending),
      writePending: (value: unknown) => {
        if (value === null ? failures.pendingClear : failures.pendingWrite) throw new Error("QuotaExceededError");
        local.pending = structuredClone(value);
      },
      read: () => structuredClone(local.recovery),
      write: (value: unknown) => { local.recovery = structuredClone(value); },
      onWarning: (message: string) => { warnings.push(message); },
    };
    return { storage, recovery, local, failures, warnings, disk: () => structuredClone(disk) as any };
  }

  it("saves to the vault file and warns once when the pending copy cannot be written", async () => {
    const env = environment();
    const store = new MiaDataStore(env.storage, env.recovery); await store.load();
    const changes = vi.fn(); store.subscribe(changes);
    env.failures.pendingWrite = true;
    await store.setReview("a", rate("a"));
    await store.setReview("b", rate("b"));
    expect(env.disk().reviews.a).toEqual(rate("a")); expect(env.disk().reviews.b).toEqual(rate("b"));
    expect(store.getReview("a")).toEqual(rate("a")); expect(changes).toHaveBeenCalledTimes(2);
    expect(store.pendingRecovery).toBeNull(); expect(env.local.pending).toBeNull();
    expect(env.warnings).toEqual(["기기 내 임시 저장 사본을 만들지 못했습니다. 기록은 보관함 파일에 직접 저장합니다. 저장 공간과 로컬 저장소 상태를 확인하세요."]);
  });

  it("warns again after the pending copy worked once and failed later", async () => {
    const env = environment();
    const store = new MiaDataStore(env.storage, env.recovery); await store.load();
    env.failures.pendingWrite = true; await store.setReview("a", rate("a"));
    env.failures.pendingWrite = false; await store.setReview("b", rate("b"));
    env.failures.pendingWrite = true; await store.setReview("c", rate("c"));
    expect(env.warnings).toHaveLength(2);
  });

  it("does not hide a failed file write when the pending copy was never stored, and does not block a retry", async () => {
    const env = environment();
    const store = new MiaDataStore(env.storage, env.recovery); await store.load();
    env.failures.pendingWrite = true; env.failures.file = true;
    await expect(store.setReview("a", rate("a"))).rejects.toThrow("file write failed");
    expect(store.getReview("a")).toBeUndefined(); expect(store.pendingRecovery).toBeNull();
    env.failures.file = false;
    await store.setReview("a", rate("a"));
    expect(env.disk().reviews.a).toEqual(rate("a"));
  });

  it("completes the commit when the pending copy cannot be cleared after the file was written", async () => {
    const env = environment();
    const store = new MiaDataStore(env.storage, env.recovery); await store.load();
    const changes = vi.fn(); store.subscribe(changes);
    env.failures.pendingClear = true;
    await store.setReview("a", rate("a"));
    expect(env.disk().reviews.a).toEqual(rate("a")); expect(store.getReview("a")).toEqual(rate("a"));
    expect(changes).toHaveBeenCalledOnce(); expect(env.local.recovery).not.toBeNull();
    expect(store.pendingRecovery).toBeNull();
    await store.setReview("b", rate("b")); // this session is not blocked
    expect(env.disk().reviews.b).toEqual(rate("b"));
    expect(env.warnings).toEqual(["기록은 저장되었지만 기기 내 임시 저장 사본을 정리하지 못했습니다. 다음 실행에서 미완료 저장 확인이 나타나면 재시도를 눌러 정리하세요."]);
  });

  it("resolves a stale pending copy equal to the file through retryPending at the next start", async () => {
    const env = environment();
    const store = new MiaDataStore(env.storage, env.recovery); await store.load();
    env.failures.pendingClear = true;
    await store.setReview("a", rate("a"));
    env.failures.pendingClear = false;
    expect(env.local.pending).not.toBeNull();
    const diskBefore = env.disk();
    const restarted = new MiaDataStore(env.storage, env.recovery); await restarted.load();
    expect(restarted.pendingRecovery).not.toBeNull();
    expect(restarted.loadWarnings.some(message => message.includes("완료를 확인하지 못한 저장 사본"))).toBe(true);
    await expect(restarted.setReview("b", rate("b"))).rejects.toThrow("미완료");
    await restarted.retryPending();
    expect(restarted.pendingRecovery).toBeNull(); expect(env.local.pending).toBeNull();
    expect(restarted.getReview("a")).toEqual(rate("a")); expect(env.disk().reviews).toEqual(diskBefore.reviews);
    await restarted.setReview("b", rate("b")); expect(env.disk().reviews.b).toEqual(rate("b"));
  });

  it("keeps the strict path (pinning existing behaviour): stored pending copy plus failed file write rejects, keeps the copy and blocks new changes", async () => {
    const env = environment();
    const store = new MiaDataStore(env.storage, env.recovery); await store.load();
    env.failures.file = true;
    await expect(store.setReview("a", rate("a"))).rejects.toThrow("file write failed");
    expect(store.getReview("a")).toBeUndefined(); expect(env.local.pending).not.toBeNull(); expect(store.pendingRecovery).not.toBeNull();
    env.failures.file = false;
    await expect(store.setReview("b", rate("b"))).rejects.toThrow("미완료");
    await store.retryPending();
    expect(env.disk().reviews.a).toEqual(rate("a")); expect(store.pendingRecovery).toBeNull();
  });
});
