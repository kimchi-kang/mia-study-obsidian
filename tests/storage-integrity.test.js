import { afterEach, describe, expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
import { MiaDataStore } from "../src/services/data-store";
import { FsrsService } from "../src/core/fsrs-service";
import { mergeReviewData } from "../src/core/review-sync";
import { DEFAULT_PLUGIN_DATA } from "../src/core/models";

const fsrs = new FsrsService({ targetRetention: .9, maximumIntervalDays: 36500 });
const at = new Date("2026-10-20T00:00:00Z");
const grade = rating => fsrs.rate(undefined, rating, at, "q");
function data(reviews = {}, versions = {}) {
  return { ...structuredClone(DEFAULT_PLUGIN_DATA), reviews: structuredClone(reviews), reviewVersions: { ...versions } };
}
function environment(initial = data(), recovered = null) {
  let disk = structuredClone(initial), cache = structuredClone(recovered);
  const plugin = { loadData: vi.fn(async () => structuredClone(disk)), saveData: vi.fn(async next => { disk = structuredClone(next); }) };
  const recovery = { read: vi.fn(() => structuredClone(cache)), write: vi.fn(next => { cache = structuredClone(next); }), onWarning: vi.fn() };
  const store = new MiaDataStore(plugin, recovery);
  return { store, plugin, recovery, disk: () => disk, cache: () => cache, overwrite: value => { disk = structuredClone(value); } };
}
afterEach(() => vi.restoreAllMocks());

describe("storage envelope and recovery safety", () => {
  it("refuses a future schema even when an older recovery copy exists", async () => {
    const future = { ...data({q: grade(Rating.Good)}), version: 2, futureHistory: ["keep"] };
    const env = environment(future, data({q: grade(Rating.Again)}));
    await expect(env.store.load()).rejects.toThrow(/버전/);
    expect(env.disk()).toEqual(future); expect(env.plugin.saveData).not.toHaveBeenCalled();
    expect(env.recovery.write).not.toHaveBeenCalled();
  });
  it.each(["commit", "synchronize"])("does not downgrade a newer file delivered before %s", async action => {
    const env = environment(); await env.store.load();
    const future = { ...data(), version: 2, futureHistory: ["keep"] }; env.overwrite(future);
    await expect(action === "commit" ? env.store.setReview("q", grade(Rating.Good)) : env.store.synchronize()).rejects.toThrow(/버전/);
    expect(env.disk()).toEqual(future); expect(env.store.getReview("q")).toBeUndefined();
    expect(env.plugin.saveData).not.toHaveBeenCalled(); expect(env.recovery.write).not.toHaveBeenCalled();
  });
  it.each(["invalid-root", false, [], {reviews: []}, {reviewVersions: []}, {settings: []}, {reviewConflicts: []}])("does not reinterpret malformed top-level data as an empty installation: %j", async raw => {
    const env = environment(raw);
    await expect(env.store.load()).rejects.toThrow();
    expect(env.plugin.saveData).not.toHaveBeenCalled(); expect(env.recovery.write).not.toHaveBeenCalled();
    expect(env.disk()).toEqual(raw);
  });
  it("uses a valid recovery copy after a primary read failure, without overwriting the broken file", async () => {
    const saved = data({q: grade(Rating.Good)}); saved.settings.sourceRoots = ["내 학습"];
    const env = environment("broken", saved);
    env.plugin.loadData.mockRejectedValueOnce(new SyntaxError("invalid JSON"));
    await expect(env.store.load()).resolves.toBeUndefined();
    expect(env.store.getReview("q")).toEqual(saved.reviews.q); expect(env.store.settings.sourceRoots).toEqual(saved.settings.sourceRoots);
    expect(env.store.loadWarnings.join(" ")).toMatch(/복구/);
    await expect(env.store.setReview("other", grade(Rating.Hard))).rejects.toThrow();
    expect(env.disk()).toBe("broken"); expect(env.plugin.saveData).not.toHaveBeenCalled();
    env.overwrite(saved); await env.store.setReview("other", grade(Rating.Hard));
    expect(env.disk().reviews.q).toEqual(saved.reviews.q);
  });
  it("restores recovery settings when the primary file is absent", async () => {
    const saved = data({q: grade(Rating.Good)}); saved.settings.sourceRoots = ["My Study"];
    const env = environment(null, saved); await env.store.load();
    expect(env.store.settings.sourceRoots).toEqual(["My Study"]);
    expect(env.store.getReview("q")).toEqual(saved.reviews.q);
  });
  it("keeps an unreadable recovery original instead of replacing it during a later successful primary save", async () => {
    const env = environment(data({q: grade(Rating.Good)}), { version: 2, future: "keep" });
    await env.store.load(); await env.store.updateSettings({targetRetention: .8});
    expect(env.store.loadWarnings.join(" ")).toMatch(/복구/);
    expect(env.cache()).toEqual({version: 2, future: "keep"}); expect(env.recovery.write).not.toHaveBeenCalled();
    expect(env.disk().settings.targetRetention).toBe(.8);
  });
  it("does not discard malformed alternatives from a conflict history", async () => {
    const broken = data(); broken.reviewConflicts.q = [{card: "corrupt"}];
    const env = environment(broken); await expect(env.store.load()).rejects.toThrow();
    expect(env.disk()).toEqual(broken); expect(env.plugin.saveData).not.toHaveBeenCalled();
  });
  it("refuses malformed edit markers instead of silently dropping a deletion marker", async () => {
    const broken=data(); broken.reviewVersions.q="not-a-version";
    const env=environment(broken);await expect(env.store.load()).rejects.toThrow();
    expect(env.disk()).toEqual(broken);expect(env.plugin.saveData).not.toHaveBeenCalled();
  });
  it("keeps both originals untouched when two corrupt values claim the same quarantine slot", async () => {
    const old=data();old.quarantinedReviews.q={original:"first"};
    const incoming=data();incoming.quarantinedReviews.q={original:"second"};
    const env=environment(old,old);await env.store.load();env.overwrite(incoming);
    await expect(env.store.synchronize()).rejects.toThrow(/격리/);
    expect(env.disk()).toEqual(incoming);expect(env.cache()).toEqual(old);
    expect(env.plugin.saveData).not.toHaveBeenCalled();expect(env.recovery.write).not.toHaveBeenCalled();
  });
  it("refuses to overwrite an existing quarantined original with a different malformed record", async () => {
    const broken=data({q:{card:"new corrupt"}});broken.quarantinedReviews.q={card:"old corrupt"};
    const env=environment(broken);await expect(env.store.load()).rejects.toThrow(/격리/);
    expect(env.disk()).toEqual(broken);expect(env.plugin.saveData).not.toHaveBeenCalled();
  });
});

describe("quarantine and conflict preservation", () => {
  it("keeps the last valid card and corrupt incoming original through save and restart", async () => {
    const valid = grade(Rating.Good), broken = { card: {due: "broken"}, history: [] };
    const env = environment(data({q:valid}, {q:"2026-10-20T00:00:00.000Z:a"})); await env.store.load();
    env.overwrite(data({q:broken}, {q:"2026-10-20T00:01:00.000Z:b"}));
    await env.store.synchronize();
    expect(env.store.getReview("q")).toEqual(valid); expect(env.disk().quarantinedReviews.q).toEqual(broken);
    await env.store.updateSettings({targetRetention:.85});
    const restarted = new MiaDataStore(env.plugin, env.recovery); await restarted.load();
    expect(restarted.getReview("q")).toEqual(valid);
    await restarted.synchronize(); expect(env.disk().quarantinedReviews.q).toEqual(broken);
    await restarted.setReview("q",fsrs.rate(valid,Rating.Hard,new Date("2026-10-20T00:10:00Z"),"q"));
    expect(env.disk().quarantinedReviews.q).toEqual(broken);
  });
  it("retains local-only alternatives even when the current card and version are absent", () => {
    const local = data(); local.reviewConflicts.q = [grade(Rating.Again)];
    expect(mergeReviewData(local, data()).reviewConflicts.q).toEqual(local.reviewConflicts.q);
  });
  it("converges deterministically when two different histories carry the same edit version", () => {
    const a = data({q:grade(Rating.Good)}, {q:"2026-10-20T00:00:00.000Z:same"});
    const b = data({q:grade(Rating.Again)}, {q:a.reviewVersions.q});
    const ab = mergeReviewData(a,b), ba = mergeReviewData(b,a);
    expect(ab.reviews.q).toEqual(ba.reviews.q);
    expect([ab.reviews.q,...ab.reviewConflicts.q].map(r=>r.lastRating).sort()).toEqual([Rating.Again,Rating.Good].sort());
    expect(mergeReviewData(ab,ba)).toEqual(mergeReviewData(ba,ab));
  });
  it("retains both different card states when their histories are identical", () => {
    const one = grade(Rating.Good), two = structuredClone(one); two.card.due = "2026-10-21T00:00:00.000Z";
    const result = mergeReviewData(data({q:one}),data({q:two}));
    expect([result.reviews.q,...(result.reviewConflicts.q??[])]).toHaveLength(2);
  });
  it("preserves an explicit deletion on equal versions rather than resurrecting the card", () => {
    const alive = data({q:grade(Rating.Good)}, {q:"2026-10-20T00:00:00.000Z:same"});
    const deleted = data({}, alive.reviewVersions);
    expect(mergeReviewData(alive,deleted).reviews.q).toBeUndefined();
    expect(mergeReviewData(deleted,alive).reviews.q).toBeUndefined();
  });
});

describe("ambiguous primary save completion", () => {
  it("confirms a synchronized write before reporting success when the write rejects after persistence", async () => {
    const saved=data({q:grade(Rating.Good)},{q:"2026-10-20T00:00:00.000Z:local"});
    const env=environment(data(),saved);await env.store.load();const notify=vi.fn();env.store.subscribe(notify);
    const incoming=data({other:grade(Rating.Hard)},{other:"2026-10-20T00:00:01.000Z:other"});env.overwrite(incoming);
    env.plugin.saveData.mockImplementationOnce(async next=>{env.overwrite(next);throw Error("after write");});
    await expect(env.store.synchronize()).resolves.toBeUndefined();
    expect(Object.keys(env.disk().reviews).sort()).toEqual(["other","q"]);
    expect(env.store.reviews).toEqual(env.disk().reviews);expect(notify).toHaveBeenCalledOnce();
  });
  it("keeps confirmed state when a malformed file arrives during an active session", async () => {
    const saved=data({q:grade(Rating.Good)}),env=environment(saved,saved);await env.store.load();
    const broken={reviews:[]};env.overwrite(broken);
    await expect(env.store.synchronize()).rejects.toThrow();
    expect(env.store.getReview("q")).toEqual(saved.reviews.q);expect(env.disk()).toEqual(broken);
    expect(env.cache()).toEqual(saved);expect(env.plugin.saveData).not.toHaveBeenCalled();
  });
  it("reports success once if the write rejected after persisting exactly the requested state", async () => {
    const env = environment(); await env.store.load(); const notify=vi.fn(); env.store.subscribe(notify);
    env.plugin.saveData.mockImplementationOnce(async next => { env.overwrite(next); throw Error("error after write"); });
    await expect(env.store.setReview("q",grade(Rating.Good))).resolves.toBeUndefined();
    expect(env.store.getReview("q")).toEqual(env.disk().reviews.q);
    expect(env.store.getReview("q").history).toHaveLength(1); expect(notify).toHaveBeenCalledOnce();
    expect(env.recovery.write).toHaveBeenCalledOnce(); expect(env.plugin.saveData).toHaveBeenCalledOnce();
  });
  it("keeps failure when readback does not prove the requested write persisted", async () => {
    const env=environment();await env.store.load();env.plugin.saveData.mockRejectedValueOnce(Error("disk full"));
    await expect(env.store.setReview("q",grade(Rating.Good))).rejects.toThrow("disk full");
    expect(env.store.getReview("q")).toBeUndefined();expect(env.recovery.write).not.toHaveBeenCalled();
  });
  it("keeps failure and confirmed memory when the verification read also fails", async () => {
    const env=environment();await env.store.load();
    env.plugin.saveData.mockRejectedValueOnce(Error("write uncertain"));
    env.plugin.loadData.mockResolvedValueOnce(env.disk()).mockRejectedValueOnce(Error("read unavailable"));
    await expect(env.store.setReview("q",grade(Rating.Good))).rejects.toThrow("write uncertain");
    expect(env.store.getReview("q")).toBeUndefined();expect(env.recovery.write).not.toHaveBeenCalled();
  });
});

describe("delivery order and restart convergence", () => {
  it("preserves both simultaneous different-question saves after both devices restart", async () => {
    let disk=data(), phoneRecovery=null, tabletRecovery=null;
    const boundary={loadData:async()=>structuredClone(disk),saveData:async value=>{disk=structuredClone(value);}};
    const phoneCache={read:()=>phoneRecovery,write:value=>{phoneRecovery=structuredClone(value);}};
    const tabletCache={read:()=>tabletRecovery,write:value=>{tabletRecovery=structuredClone(value);}};
    const phone=new MiaDataStore(boundary,phoneCache),tablet=new MiaDataStore(boundary,tabletCache);
    await phone.load();await tablet.load();
    await Promise.all([phone.setReview("one",grade(Rating.Good)),tablet.setReview("two",grade(Rating.Hard))]);
    const restartedPhone=new MiaDataStore(boundary,phoneCache),restartedTablet=new MiaDataStore(boundary,tabletCache);
    await restartedPhone.load();await restartedTablet.load();
    await restartedTablet.synchronize();await restartedPhone.synchronize();await restartedTablet.synchronize();
    expect(Object.keys(disk.reviews).sort()).toEqual(["one","two"]);
    expect(restartedPhone.reviews).toEqual(restartedTablet.reviews);
  });
  it("converges across 200 same-question delivery cases without concatenating divergent FSRS history", () => {
    for(let i=0;i<200;i++){
      const a=data({q:grade(1+i%4)},{q:`2026-10-20T00:00:00.000Z:${i%2 ? "same":"a"}`});
      const b=data({q:grade(1+(i+1)%4)},{q:`2026-10-20T00:00:00.000Z:${i%2 ? "same":"b"}`});
      const ab=mergeReviewData(a,b),ba=mergeReviewData(b,a);
      expect(ab.reviews).toEqual(ba.reviews);expect(ab.reviewConflicts).toEqual(ba.reviewConflicts);
      expect(ab.reviews.q.history).toHaveLength(1);
      const merged=mergeReviewData(ab,ba);expect(mergeReviewData(merged,ab)).toEqual(merged);
      expect(new Set([merged.reviews.q,...merged.reviewConflicts.q].map(x=>x.lastRating)).size).toBe(2);
    }
  });
});
