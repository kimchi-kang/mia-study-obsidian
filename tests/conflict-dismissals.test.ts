import { expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { DEFAULT_PLUGIN_DATA, DEFAULT_SETTINGS, type MiaPluginData } from "../src/core/models";
import { mergeReviewData } from "../src/core/review-sync";
import { MiaDataStore, parsePluginData } from "../src/services/data-store";
import { PORTABLE_DATA_PATH, PortableStudyStorage } from "../src/services/portable-study-storage";

const fsrs = new FsrsService(DEFAULT_SETTINGS);
const archive = fsrs.rate(undefined, Rating.Again, new Date("2026-10-20T00:00:00Z"));
const active = fsrs.rate(undefined, Rating.Good, new Date("2026-10-21T00:00:00Z"));
const alternate = { id: "branch-a", ancestors: [], settings: { ...DEFAULT_SETTINGS, targetRetention: .8 } };
const second = { id: "branch-b", ancestors: [], settings: { ...DEFAULT_SETTINGS, targetRetention: .85 } };

function legacyData(): MiaPluginData {
  return {
    ...structuredClone(DEFAULT_PLUGIN_DATA), reviews: { one: active },
    reviewConflicts: { one: [archive], two: [archive] },
    reviewVersions: { one: "2026-10-21T00:00:00.000Z:active" },
    settingsSync: { id: "branch-z", ancestors: [], conflicts: [alternate, second] },
  };
}

function fixture(initial = legacyData()) {
  let disk = structuredClone(initial);
  const save = vi.fn(async (value: MiaPluginData) => { disk = structuredClone(value); });
  const store = new MiaDataStore({ loadData: async () => structuredClone(disk), saveData: save });
  return { store, disk: () => structuredClone(disk), deliver: (value: MiaPluginData) => { disk = structuredClone(value); }, save };
}

it("dismisses one archive, then all, while preserving active reviews and their versions", async () => {
  const { store, disk } = fixture();
  await store.load();
  await store.dismissReviewConflicts({ one: store.conflicts.one! });
  expect(store.conflicts).toEqual({ two: [archive] });
  await store.dismissReviewConflicts(store.conflicts, true);
  expect(store.conflicts).toEqual({});
  expect(disk().reviews).toEqual(legacyData().reviews);
  expect(disk().reviewVersions).toEqual(legacyData().reviewVersions);
  const revisions = Object.values(disk().conflictDismissals!);
  expect(revisions).toHaveLength(2);
  expect(new Set(revisions).size).toBe(2);
});

it("checks the confirmed data against a concurrent arrival before deleting all", async () => {
  const { store, deliver, save } = fixture();
  await store.load();
  const confirmed = store.conflicts;
  const incoming = legacyData();
  incoming.reviewConflicts.three = [active];
  deliver(incoming);
  await expect(store.dismissReviewConflicts(confirmed, true)).rejects.toThrow("다시 확인");
  expect(save).not.toHaveBeenCalled();
  expect(store.conflicts.three).toEqual([active]);
});

it("keeps all copies when only one of the confirmed histories changed", async () => {
  const { store, deliver, save } = fixture();
  await store.load();
  const confirmed = store.conflicts;
  const incoming = legacyData();
  incoming.reviewConflicts.two = [active];
  deliver(incoming);
  await expect(store.dismissReviewConflicts(confirmed, true)).rejects.toThrow("다시 확인");
  expect(save).not.toHaveBeenCalled();
  expect(store.conflicts).toEqual({ one: [archive], two: expect.arrayContaining([archive, active]) });
});

it("reports a failed write and leaves both memory and disk unchanged", async () => {
  const { store, disk, save } = fixture();
  await store.load();
  const before = disk();
  save.mockRejectedValueOnce(new Error("저장 실패"));
  await expect(store.dismissReviewConflicts(store.conflicts, true)).rejects.toThrow("저장 실패");
  expect(store.conflicts).toEqual(before.reviewConflicts);
  expect(disk()).toEqual(before);
});

it("rejects only dismissed review copies, including stale active branches, in both merge directions", async () => {
  const { store, disk } = fixture();
  await store.load();
  await store.dismissReviewConflicts(store.conflicts, true);
  const clean = disk();
  const stale = legacyData();
  stale.reviews.one = archive;
  stale.reviewVersions.one = "2026-10-20T00:00:00.000Z:old";
  for (const [left, right] of [[clean, stale], [stale, clean]] as const) {
    const merged = mergeReviewData(left, right);
    expect(merged.reviews.one).toEqual(active);
    expect(merged.reviewConflicts).toEqual({});
    expect(merged.conflictDismissals).toEqual(clean.conflictDismissals);
  }
  const reordered = { history: archive.history, lastRating: archive.lastRating, card: archive.card };
  stale.reviews.one = reordered;
  stale.reviewConflicts.one = [reordered];
  expect(mergeReviewData(clean, stale).reviewConflicts).toEqual({});
  const newBranch = fsrs.rate(undefined, Rating.Hard, new Date("2026-10-20T00:00:00Z"));
  stale.reviews.one = newBranch;
  expect(mergeReviewData(clean, stale).reviewConflicts).toEqual({ one: [newBranch] });
});

it("cleans archived and active copies on question deletion but keeps reset recovery", async () => {
  const { store, disk, deliver } = fixture();
  await store.load();
  const stale = disk();
  await store.removeReviews(["one"]);
  expect(store.getReview("one")).toBeUndefined();
  expect(store.conflicts.one).toBeUndefined();
  deliver(stale);
  await store.synchronize();
  expect(store.getReview("one")).toBeUndefined();
  expect(store.conflicts).toEqual({ two: [archive] });

  const reset = fixture();
  await reset.store.load();
  await reset.store.removeReview("one");
  expect(reset.store.conflicts.one).toEqual([archive]);
});

it("keeps one previous-settings safety copy on apply and lets it be dismissed on each cycle", async () => {
  const { store, deliver, disk } = fixture();
  await store.load();
  const stale = disk();
  for (const id of [alternate.id, second.id]) {
    const previous = structuredClone(store.settings);
    await store.restoreSettingsConflict(id);
    const backup = store.settingsConflicts.find(item => item.settings.targetRetention === previous.targetRetention)!;
    expect(backup.settings).toEqual(previous);
    await store.dismissSettingsConflict(backup);
    expect(store.settingsConflicts.some(item => item.id === backup.id)).toBe(false);
    deliver(stale);
    await store.synchronize();
  }
  expect(store.settings.targetRetention).toBe(.85);
  expect(store.settingsConflicts).toEqual([]);
});

it("keeps dismissed divergent settings from winning again after an unrelated edit", async () => {
  const { store, deliver, disk } = fixture();
  await store.load();
  await store.dismissSettingsConflict(alternate);
  const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("00000000-0000-4000-8000-000000000000");
  try { await store.updateSettings({ maximumIntervalDays: 100 }); }
  finally { uuid.mockRestore(); }
  const current = disk();
  const stale = legacyData();
  stale.settings = alternate.settings;
  stale.settingsSync = { ...alternate, conflicts: [] };
  deliver(stale);
  await store.synchronize();
  expect(store.settings).toEqual(current.settings);
  expect(store.settingsConflicts).toEqual([second]);

  stale.settingsSync.id = "later-edit";
  stale.settingsSync.ancestors = [alternate.id];
  stale.settings = { ...alternate.settings, targetRetention: .82 };
  deliver(stale);
  await store.synchronize();
  expect(store.settings.targetRetention).toBe(.82);
});

it("continues to read 1.5.1 payloads and preserves old-reader fields through the Markdown round trip", async () => {
  const legacy = legacyData();
  const { conflictDismissals: missing, ...oldShape } = parsePluginData(legacy);
  expect(missing).toBeUndefined();
  expect(oldShape).toEqual(legacy);
  const files = new Map<string, string>();
  const storage = new PortableStudyStorage({
    exists: async path => files.has(path), read: async path => files.get(path)!,
    write: async (path, value) => { files.set(path, value); }, mkdir: async () => {},
  });
  await storage.saveData(legacy);
  const oldMarkdown = files.get(PORTABLE_DATA_PATH)!;
  const store = new MiaDataStore(storage);
  await store.load();
  await store.dismissReviewConflicts(store.conflicts, true);
  await store.dismissSettingsConflict(alternate);
  const clean = parsePluginData(await storage.loadData());
  // A legacy writer serializes only fields it knows and can send an older copy again.
  const { conflictDismissals: ignored, ...legacyResave } = clean;
  expect(Object.keys(ignored!)).toHaveLength(3);
  expect(parsePluginData(legacyResave)).toEqual(legacyResave);
  expect(legacyResave.reviews).toEqual(legacy.reviews);
  expect(legacyResave.settings).toEqual(legacy.settings);
  files.set(PORTABLE_DATA_PATH, oldMarkdown);
  await store.synchronize();
  expect(store.conflicts).toEqual({});
  expect(store.settingsConflicts).toEqual([second]);
  expect(await storage.loadData()).toEqual(clean);
});
