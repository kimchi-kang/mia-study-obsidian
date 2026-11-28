import { expect, it, vi } from "vitest";
import { Rating, State } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { DEFAULT_PLUGIN_DATA, DEFAULT_SETTINGS, type QuestionReviewState, type TargetDate } from "../src/core/models";
import { forecastReviews, summarizeTargetDates } from "../src/core/target-dates";
import { settingsConflictKey } from "../src/core/conflict-dismissals";
import { settingsSnapshot } from "../src/core/settings-sync";
import { MiaDataStore, parsePluginData, parseSettings } from "../src/services/data-store";
import { PORTABLE_DATA_PATH, PortableStudyStorage } from "../src/services/portable-study-storage";

const local = (day: number, hour = 4, minute = 0) => new Date(2026, 10, day, hour, minute);
const target: TargetDate = { id: "first", label: "첫 면접", date: "2026-11-20" };
const alternate = { ...target, label: "연습 시험" };
const fsrs = new FsrsService(DEFAULT_SETTINGS);
const snapshot = (targetDates?: TargetDate[]) => ({
  ...structuredClone(DEFAULT_PLUGIN_DATA), settings: { ...DEFAULT_SETTINGS, ...(targetDates ? { targetDates } : {}) },
});

it("keeps the first 20 valid unique targets, normalizes names and subjects, and omits the all-subjects scope", () => {
  const parsed = parseSettings({ targetDates: [
    null, { ...target, date: "2026-02-29" }, { ...target, date: "2026-11-31" },
    { ...target, date: "2026-11-2" }, { ...target, date: "0000-11-02" },
    { ...target, label: "가".repeat(41) }, { ...target, label: " " }, { ...target, id: "" },
    { ...target, subjects: "지리학" }, { ...target, subjects: ["지리학", 3] },
    { ...target, label: " 첫 면접  ", subjects: [" 지리학 ", "지리학", "통계이론"] }, alternate,
    { id: "leap", label: "가".repeat(40), date: "2028-02-29", subjects: [] },
    ...Array.from({ length: 22 }, (_, i) => ({ ...target, id: String(i) })),
  ] });
  expect(parsed.targetDates).toHaveLength(20);
  expect(parsed.targetDates?.slice(0, 2)).toEqual([
    { ...target, subjects: ["지리학", "통계이론"] },
    { id: "leap", label: "가".repeat(40), date: "2028-02-29" },
  ]);
  expect(parsed.targetDates?.at(-1)?.id).toBe("17");
  expect(parseSettings({ targetDates: {} })).not.toHaveProperty("targetDates");
});

it("saves identical legacy data.json bytes for an unused or empty list and omits the field after deletion", async () => {
  let disk = JSON.stringify(parsePluginData(snapshot()), null, 2);
  const baseline = disk;
  const store = new MiaDataStore({
    loadData: async () => JSON.parse(disk),
    saveData: async data => { disk = JSON.stringify(data, null, 2); },
  });
  await store.load();
  await store.updateSettings({ targetDates: [] });
  expect(disk).toBe(baseline);
  await store.updateSettings({ targetDates: [target] });
  expect(JSON.parse(disk).settings.targetDates).toEqual([target]);
  await store.updateSettings({ targetDates: [] });
  expect(disk).not.toContain('"targetDates":');
  expect(JSON.stringify(parsePluginData(snapshot([])), null, 2)).toBe(baseline);
});

it("syncs target edits and divergent archives through Markdown, and honors legacy dismissal fingerprints", async () => {
  const files = new Map<string, string>();
  const portable = new PortableStudyStorage({
    exists: async path => files.has(path),
    read: async path => files.get(path)!,
    write: async (path, content) => { files.set(path, content); },
    mkdir: async () => {},
  });
  const old = snapshot([target]);
  await portable.saveData(old);
  const localStore = new MiaDataStore(portable);
  await localStore.load();
  await localStore.updateSettings({ maximumIntervalDays: 180 });
  expect(localStore.settings.targetDates).toEqual([target]);
  await localStore.updateSettings({ targetDates: [alternate] });
  const edited = parsePluginData(await portable.loadData());
  expect(edited.settings.targetDates).toEqual([alternate]);
  expect(files.get(PORTABLE_DATA_PATH)).toContain("연습 시험");

  const divergent = snapshot([{ ...target, date: "2026-11-23" }]);
  const divergentId = settingsSnapshot(divergent).id;
  expect(settingsConflictKey(divergentId)).not.toBe(settingsConflictKey(settingsSnapshot(old).id));
  await portable.saveData(divergent);
  await localStore.synchronize();
  const merged = parsePluginData(await portable.loadData());
  const archive = merged.settingsSync?.conflicts[0];
  expect(archive).toBeDefined();
  const branches = [merged.settings, archive!.settings];
  expect(branches.map(settings => settings.targetDates)).toEqual(expect.arrayContaining([
    edited.settings.targetDates, divergent.settings.targetDates,
  ]));
  // The identified edit stays active; the legacy divergent copy (no edit identity) is the archived branch.
  expect(merged.settings.targetDates).toEqual(edited.settings.targetDates);
  expect(archive!.id).toBe(divergentId);
  expect(localStore.settings.targetDates).toEqual([alternate]);
  const unwanted = localStore.settingsConflicts.find(item => item.settings.targetDates?.[0]?.date === "2026-11-23")!;
  await localStore.dismissSettingsConflict(unwanted);
  const clean = parsePluginData(await portable.loadData());
  expect(unwanted.id).toBe(divergentId);
  expect(clean.conflictDismissals?.[settingsConflictKey(divergentId)]).toBeDefined();
  // A copy with the dismissed legacy identity cannot reappear.
  await portable.saveData(merged);
  await localStore.synchronize();
  expect(localStore.settings.targetDates).toEqual([alternate]);
  expect(localStore.settingsConflicts.some(item => item.id === unwanted.id)).toBe(false);
});

it("rebases independent edits and archives a simultaneous edit of the target list", async () => {
  let disk = snapshot([target]);
  const host = { loadData: async () => structuredClone(disk), saveData: async (data: typeof disk) => { disk = structuredClone(data); } };
  const one = new MiaDataStore(host), two = new MiaDataStore(host);
  await one.load();
  await two.load();
  const baseline = structuredClone(one.settings);
  await two.updateSettings({ maximumIntervalDays: 180 });
  await one.updateSettings({ targetDates: [alternate] }, baseline);
  expect(one.settings).toMatchObject({ maximumIntervalDays: 180, targetDates: [alternate] });
  await expect(two.updateSettings({ targetDates: [] })).rejects.toThrow("다른 기기");
  expect(parsePluginData(disk).settingsSync?.conflicts[0]?.settings).not.toHaveProperty("targetDates");
  expect(one.settings.targetDates).toEqual([alternate]);
});

it("projects in scope at the configured study-day start, counts fresh questions, and sorts strict risks", () => {
  const settings = { ...DEFAULT_SETTINGS, studyManagement: { ...DEFAULT_SETTINGS.studyManagement, dayStartsAt: 6 } };
  const scheduler = new FsrsService(settings);
  const date = new Date(2026, 10, 20, 6);
  const fresh = scheduler.rate(undefined, Rating.Good, local(18), "new");
  const reviews = {
    weak: { ...fresh, card: { ...fresh.card, stability: 0.2 } },
    lessWeak: { ...fresh, card: { ...fresh.card, stability: 1 } },
    outside: fresh,
  };
  const retention = scheduler.retrievability(reviews.outside, date)!;
  const questions = ["lessWeak", "weak", "new", "equal", "outside"].map(id => ({ id, subject: id === "outside" ? "통계이론" : "지리학" }));
  const allReviews = { ...reviews, equal: fresh };
  const targets = [{ ...target, subjects: ["지리학"] }, { ...target, id: "past", date: "2026-11-18" }];
  const recall = vi.spyOn(scheduler, "retrievability");
  const before = summarizeTargetDates(targets, questions, allReviews, scheduler, 6, retention, new Date(2026, 10, 20, 5, 59));
  const after = summarizeTargetDates(targets, questions, allReviews, scheduler, 6, retention, date);
  expect(before.map(item => item.daysUntil)).toEqual([-1, 1]);
  expect(after.map(item => item.daysUntil)).toEqual([-2, 0]);
  expect(before[1]).toMatchObject({ total: 4, unstudied: 1, risks: [{ id: "weak" }, { id: "lessWeak" }] });
  expect(before[1]?.averageRecall).toBeCloseTo((scheduler.retrievability(reviews.weak, date)! + scheduler.retrievability(reviews.lessWeak, date)! + retention) / 3);
  expect(recall).toHaveBeenCalledWith(reviews.weak, date);
  expect(summarizeTargetDates(targets, questions, allReviews, scheduler, 6, retention, date, true).map(item => item.target.id)).toEqual([target.id]);
});

it("forecasts 30 study days, rolling past due into today without the daily limit", () => {
  const base = fsrs.rate(undefined, Rating.Good, local(16), "base");
  const due = (at: Date, state = State.Review): QuestionReviewState => ({ ...base, card: { ...base.card, state, due: at.toISOString() } });
  const reviews = {
    past: due(local(17)), previous: due(local(20, 3, 59)), today: due(local(20, 4, 1)),
    tomorrow: due(local(21, 4)), future: due(local(50)), unstudied: due(local(20), State.New),
  };
  const questions = [...Object.keys(reviews), "missing"].map(id => ({ id, subject: "지리학" }));
  const forecast = forecastReviews(questions, reviews, fsrs, 4, local(20));
  expect(forecast).toHaveLength(30);
  expect(forecast.slice(0, 2)).toEqual([{ date: "2026-11-20", count: 3 }, { date: "2026-11-21", count: 1 }]);
  expect(forecast.slice(2).every(item => item.count === 0)).toBe(true);
});
