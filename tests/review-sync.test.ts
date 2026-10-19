import { describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { MiaDataStore } from "../src/services/data-store";
import { DEFAULT_PLUGIN_DATA, MiaPluginData } from "../src/core/models";

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
