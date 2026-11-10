import { describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";
import { Rating } from "ts-fsrs";
import { FsrsService, type StudyGrade } from "../src/core/fsrs-service";
import { MiaDataStore } from "../src/services/data-store";
import { DEFAULT_PLUGIN_DATA, MiaPluginData, type QuestionReviewState } from "../src/core/models";
import { mergeReviewData } from "../src/core/review-sync";

const fsrs = new FsrsService({ targetRetention: .9, maximumIntervalDays: 36500 });
function environment() {
  let disk: MiaPluginData = structuredClone(DEFAULT_PLUGIN_DATA);
  const device = () => {
    let recovery: MiaPluginData | null = null;
    const plugin = { loadData: async () => structuredClone(disk), saveData: async (value: MiaPluginData) => { disk = structuredClone(value); } };
    const cache = { read: () => recovery, write: (value: MiaPluginData) => { recovery = structuredClone(value); } };
    return { store: new MiaDataStore(plugin as Plugin, cache), restart: () => new MiaDataStore(plugin as Plugin, cache), plugin };
  };
  return { device, read: () => structuredClone(disk), overwrite: (data: MiaPluginData) => { disk = structuredClone(data); } };
}

describe("cross-device review protection", () => {
  it("preserves different questions saved from two stale devices", async () => {
    const env = environment(), phone = env.device(), pad = env.device();
    await phone.store.load(); await pad.store.load();
    await phone.store.setReview("one", fsrs.rate(undefined, Rating.Good));
    await pad.store.setReview("two", fsrs.rate(undefined, Rating.Hard));
    await phone.store.synchronize();
    expect(Object.keys(phone.store.reviews).sort()).toEqual(["one", "two"]);
    expect(Object.keys(env.read().reviews).sort()).toEqual(["one", "two"]);
  });
  it("recovers a local successful rating after a delayed cloud snapshot overwrites the file, including restart", async () => {
    const env = environment(), phone = env.device(); await phone.store.load();
    const delayed = env.read();
    await phone.store.setReview("one", fsrs.rate(undefined, Rating.Good));
    env.overwrite(delayed);
    const restarted = phone.restart(); await restarted.load();
    expect(restarted.getReview("one")?.lastRating).toBe(Rating.Good);
    await restarted.synchronize(); expect(env.read().reviews.one?.lastRating).toBe(Rating.Good);
  });
  it("keeps the deletion marker so a delayed pre-undo snapshot cannot resurrect a rating", async () => {
    const env = environment(), phone = env.device(); await phone.store.load();
    await phone.store.setReview("one", fsrs.rate(undefined, Rating.Good)); const stale = env.read();
    await phone.store.removeReview("one"); env.overwrite(stale);
    const restarted = phone.restart(); await restarted.load(); await restarted.synchronize();
    expect(restarted.getReview("one")).toBeUndefined(); expect(env.read().reviews.one).toBeUndefined();
    expect(env.read().reviewVersions.one).toBeDefined();
  });
  it("retains both divergent offline grades without inventing combined FSRS history", async () => {
    const env = environment(), phone = env.device(), pad = env.device(); await phone.store.load(); await pad.store.load();
    await phone.store.setReview("one", fsrs.rate(undefined, Rating.Good)); const phoneSnapshot = env.read();
    env.overwrite(structuredClone(DEFAULT_PLUGIN_DATA));
    await pad.store.setReview("one", fsrs.rate(undefined, Rating.Again));
    env.overwrite(phoneSnapshot); await pad.store.synchronize();
    expect(pad.store.getReview("one")?.history).toHaveLength(1);
    const grades = [pad.store.getReview("one")?.lastRating, ...pad.store.conflicts.one!.map(review => review.lastRating)];
    expect(grades.sort()).toEqual([Rating.Again, Rating.Good].sort());
    await pad.store.synchronize(); expect(pad.store.conflicts.one).toHaveLength(1);
  });
  it("rejects a stale grade or undo and refreshes the in-memory record", async () => {
    const env = environment(), phone = env.device(), pad = env.device(); await phone.store.load(); await pad.store.load();
    const first = fsrs.rate(undefined, Rating.Good); await phone.store.setReview("one", first);
    await pad.store.synchronize(); const updated = fsrs.rate(first, Rating.Hard, new Date(Date.now()+60000));
    await pad.store.setReview("one", updated);
    await expect(phone.store.removeReview("one", { state: first })).rejects.toThrow("다른 기기");
    expect(phone.store.getReview("one")).toEqual(updated);
    await expect(phone.store.setReview("one", first, { state: undefined })).rejects.toThrow("다른 기기");
    expect(env.read().reviews.one).toEqual(updated);
  });
  it("does not put failed writes in the device recovery cache", async () => {
    const env = environment(), phone = env.device(); await phone.store.load();
    phone.plugin.saveData = async () => { throw Error("disk full"); };
    await expect(phone.store.setReview("one", fsrs.rate(undefined, Rating.Good))).rejects.toThrow("disk full");
    const restarted = phone.restart(); await restarted.load(); expect(restarted.getReview("one")).toBeUndefined();
  });
});


describe("concurrent file delivery", () => {
  it("converges after simultaneous writes and does not resurrect an undone rating", async () => {
    const env = environment(), phone = env.device(), pad = env.device(); await phone.store.load(); await pad.store.load();
    await Promise.all([phone.store.setReview("one",fsrs.rate(undefined,Rating.Good)),pad.store.setReview("two",fsrs.rate(undefined,Rating.Again))]);
    await phone.store.synchronize(); await pad.store.synchronize();
    expect(Object.keys(phone.store.reviews).sort()).toEqual(["one","two"]);
    expect(pad.store.reviews).toEqual(phone.store.reviews);
    const stale = env.read(); await phone.store.removeReview("one"); const deletion=env.read();
    env.overwrite(stale); await phone.store.synchronize(); await pad.store.synchronize();
    expect(pad.store.getReview("one")).toBeUndefined();
    expect(env.read().reviewVersions.one).toBe(deletion.reviewVersions.one);
  });
});

function reviewAt(previous: QuestionReviewState | undefined, day: number, grade: StudyGrade = Rating.Good): QuestionReviewState {
  return fsrs.rate(previous, grade, new Date(Date.UTC(2026, 9, day, 9)), "q");
}

function reviewSnapshot(state: QuestionReviewState | undefined, version: string): MiaPluginData {
  const data = structuredClone(DEFAULT_PLUGIN_DATA);
  if (state) data.reviews.q = structuredClone(state);
  data.reviewVersions.q = version;
  return data;
}

describe("archiving the losing review after a cross-device undo", () => {
  const h1 = reviewAt(undefined, 1);
  const h2 = reviewAt(h1, 2);
  const h3 = reviewAt(h2, 10);
  const h4 = reviewAt(h3, 15);

  it("keeps the day-16 undo active and archives the day-15 device's four grades", () => {
    const undo = reviewSnapshot(h2, "2026-10-16T09:00:00.000Z:undo");
    const offline = reviewSnapshot(h4, "2026-10-15T09:00:00.000Z:offline");
    const merged = mergeReviewData(undo, offline);
    expect(merged.reviews.q).toEqual(h2);
    expect(merged.reviews.q?.history).toHaveLength(2);
    expect(merged.reviewVersions.q).toBe(undo.reviewVersions.q);
    expect(merged.reviewConflicts.q).toEqual([h4]);
    expect(merged.reviewConflicts.q?.[0]?.history).toHaveLength(4);
  });

  it("does not archive a losing state whose grades are a strict prefix of the winning progression", () => {
    const earlier = reviewSnapshot(h2, "2026-10-02T09:00:00.000Z:earlier");
    const later = reviewSnapshot(h4, "2026-10-15T09:00:00.000Z:later");
    const merged = mergeReviewData(earlier, later);
    expect(merged.reviews.q).toEqual(h4);
    expect(merged.reviewConflicts.q).toBeUndefined();
  });

  it("merges 512 seeded pairs symmetrically and idempotently without duplicate archives or lost grades", () => {
    const fork = reviewAt(h2, 10, Rating.Again);
    const states = [undefined, h1, h2, h3, h4, fork, reviewAt(fork, 15, Rating.Hard)];
    let seed = 20261016;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor(seed / 0x100000000 * max);
    };
    const snapshot = (device: string) => {
      const data = reviewSnapshot(states[random(states.length)], `2026-10-${16 + random(4)}T09:00:00.000Z:${device}`);
      if (random(3) === 0) {
        const archived = states[1 + random(states.length - 1)]!;
        data.reviewConflicts.q = [structuredClone(archived)];
      }
      return data;
    };
    const logs = (data: MiaPluginData) => new Set([data.reviews.q, ...(data.reviewConflicts.q ?? [])]
      .flatMap(state => state?.history.map(log => JSON.stringify(log)) ?? []));
    for (let index = 0; index < 512; index++) {
      const left = snapshot("left"), right = snapshot("right");
      const merged = mergeReviewData(left, right);
      expect(mergeReviewData(right, left), `pair ${index}`).toEqual(merged);
      for (const original of [left, right, merged]) expect(mergeReviewData(merged, original), `pair ${index}`).toEqual(merged);
      const archived = (merged.reviewConflicts.q ?? []).map(review => JSON.stringify(review));
      expect(new Set(archived).size, `pair ${index}`).toBe(archived.length);
      expect(logs(merged), `pair ${index}`).toEqual(new Set([...logs(left), ...logs(right)]));
    }
  });

  it("archives one previously shared grade when the second device has not added a grade", async () => {
    const env = environment(), phone = env.device(), pad = env.device();
    await phone.store.load();
    await phone.store.setReview("q", h2);
    await phone.store.setReview("q", h3, { state: h2 });
    await pad.store.load();
    expect(pad.store.getReview("q")).toEqual(h3);
    await phone.store.setReview("q", h2, { state: h3 });
    await pad.store.synchronize();
    await phone.store.synchronize();
    expect(env.read().reviews.q).toEqual(h2);
    expect(env.read().reviewConflicts).toEqual({ q: [h3] });
    expect(h3.history.slice(h2.history.length)).toHaveLength(1);
  });

  it.each([false, true])("archives nothing for a single-device grade and undo (previous state=%s)", async (existing) => {
    const env = environment(), phone = env.device();
    await phone.store.load();
    const previous = existing ? h2 : undefined;
    const rated = reviewAt(previous, 10);
    if (previous) await phone.store.setReview("q", previous);
    await phone.store.setReview("q", rated, { state: previous });
    if (previous) await phone.store.setReview("q", previous, { state: rated });
    else await phone.store.removeReview("q", { state: rated });
    const restarted = phone.restart();
    await restarted.load();
    await restarted.synchronize();
    expect(restarted.getReview("q")).toEqual(previous);
    expect(restarted.conflicts).toEqual({});
    expect(env.read().reviewConflicts).toEqual({});
  });
});
