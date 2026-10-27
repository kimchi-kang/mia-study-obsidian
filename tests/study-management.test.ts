import { describe, expect, it } from "vitest";
import { default_w, Rating, State } from "ts-fsrs";
import { DEFAULT_SETTINGS, DEFAULT_STUDY_MANAGEMENT, type QuestionRecord } from "../src/core/models";
import { dailyStudyCounts, parseSteps, parseStudyManagement, studyDayStart, validParameters } from "../src/core/study-management";
import { FsrsService } from "../src/core/fsrs-service";
import { buildReviewQueue } from "../src/core/recommendation-engine";
import { DataStoreInternals, MiaDataStore } from "../src/services/data-store";

const now = new Date(2026, 9, 25, 12);
const fsrs = new FsrsService(DEFAULT_SETTINGS);
const question = (id: string): QuestionRecord => ({
  id, filePath: `${id}.md`, heading: id, headingLevel: 3, questionMarkdown: id, answerMarkdown: "answer",
  subject: "test", deck: "test", questionType: "정의형", coreKeywords: [], subKeywords: [], followUpIds: [],
  location: { headingLine: 0, questionStartLine: 1, questionEndLine: 2, answerHeadingLine: 3, answerEndLine: 4, metadataStartLine: null, metadataEndLine: null, anchorLine: 2 },
});
const old = fsrs.rate(undefined, Rating.Easy, new Date(2026, 8, 1, 12));
const manage = (patch: Partial<typeof DEFAULT_STUDY_MANAGEMENT> = {}) => ({ ...structuredClone(DEFAULT_STUDY_MANAGEMENT), ...patch });

describe("Anki study management", () => {
  it("migrates old data and rejects malformed persisted settings without sharing default arrays", () => {
    const parsed = DataStoreInternals.parseSettings({ targetRetention: .85 });
    expect(parsed.studyManagement).toEqual(DEFAULT_STUDY_MANAGEMENT);
    parsed.studyManagement.learningSteps.push("2h");
    expect(DEFAULT_STUDY_MANAGEMENT.learningSteps).toEqual(["1m", "10m"]);
    expect(parseStudyManagement({ newCardsPerDay: -1, reviewsPerDay: Infinity, dayStartsAt: 24, learningSteps: ["oops"], newReviewOrder: "invalid", fsrsParameters: [1] })).toEqual(DEFAULT_STUDY_MANAGEMENT);
    expect(parseStudyManagement({ newCardsPerDay: 0, reviewsPerDay: 0 }).newCardsPerDay).toBe(0);
  });
  it("validates explicit steps and FSRS-6 weights", () => {
    expect(parseSteps("1m 10m 2h 1d")).toEqual(["1m", "10m", "2h", "1d"]);
    expect(parseSteps(" ")).toEqual([]);
    for (const bad of ["0m", "-1h", "10", "1x", "Infinitym", "1m,,10m", "0.1m", "1.5m", "0.001h", "36501d"]) expect(parseSteps(bad)).toBeNull();
    expect(validParameters([...default_w])).toBe(true);
    expect(validParameters(Array(21).fill(NaN))).toBe(false);
    expect(validParameters(Array(19).fill(1))).toBe(false);
  });
  it("preserves fractional hours and days exactly rather than truncating their amount", () => {
    expect(parseSteps("1.5h 0.5d")).toEqual(["90m", "720m"]);
    expect(parseStudyManagement({ learningSteps: ["1.5h"] }).learningSteps).toEqual(["90m"]);
    const scheduler = new FsrsService({ ...DEFAULT_SETTINGS, studyManagement: manage({ learningSteps: parseSteps("1.5h")! }) });
    const preview = scheduler.preview(undefined, now, "fraction").find(item => item.grade === Rating.Again)!;
    expect(preview.due.getTime() - now.getTime()).toBe(90 * 60_000);
    expect(scheduler.rate(undefined, Rating.Again, now, "fraction").card.due).toBe(preview.due.toISOString());
  });
  it("uses a local 04:00 day boundary with no carryover", () => {
    expect(studyDayStart(new Date(2026, 9, 25, 3, 59), 4)).toEqual(new Date(2026, 9, 24, 4));
    expect(studyDayStart(new Date(2026, 9, 25, 4), 4)).toEqual(new Date(2026, 9, 25, 4));
    const first = fsrs.rate(undefined, Rating.Again, now);
    const second = fsrs.rate(first, Rating.Good, new Date(now.getTime() + 60_000));
    expect(dailyStudyCounts({ q: second }, manage(), new Date(now.getTime() + 60_000))).toEqual({ fresh: 1, review: 0 });
    expect(dailyStudyCounts({ q: second }, manage(), new Date(2026, 9, 26, 4))).toEqual({ fresh: 0, review: 0 });
  });
  it("counts reviews globally across subjects and excludes intraday repeats", () => {
    const reviewed = fsrs.rate(old, Rating.Again, now);
    const repeat = fsrs.rate(reviewed, Rating.Good, new Date(now.getTime() + 600_000));
    expect(dailyStudyCounts({ q: repeat }, manage(), new Date(now.getTime() + 600_000))).toEqual({ fresh: 0, review: 1 });
    const queue = buildReviewQueue([question("new")], { unrelated: repeat }, fsrs, { now: new Date(now.getTime() + 600_000), management: manage({ reviewsPerDay: 1 }) });
    expect(queue).toEqual([]);
  });
  it("applies limits while leaving due intraday learning available at zero", () => {
    const learning = fsrs.rate(undefined, Rating.Again, new Date(now.getTime() - 60_000));
    const questions = ["a", "b", "review", "learning"].map(question);
    const reviews = { review: old, learning };
    expect(buildReviewQueue(questions, reviews, fsrs, { now, management: manage({ newCardsPerDay: 0, reviewsPerDay: 0 }) }).map(q => q.id)).toEqual(["learning"]);
    expect(buildReviewQueue([question("a"), question("b"), question("review")], { review: old }, fsrs,
      { now, management: manage({ newCardsPerDay: 1, reviewsPerDay: 1 }) }).map(q => q.id)).toEqual(["review"]);
    expect(buildReviewQueue([question("a"), question("b"), question("review")], { review: old }, fsrs,
      { now, management: manage({ newCardsPerDay: 1, reviewsPerDay: 1, newCardsIgnoreReviewLimit: true }) }).map(q => q.id)).toEqual(["review", "a"]);
  });
  it("does not allow a second session to reuse the new-card review budget", () => {
    const introduced = fsrs.rate(undefined, Rating.Easy, now);
    expect(buildReviewQueue([question("a")], { outside: introduced }, fsrs,
      { now, management: manage({ reviewsPerDay: 1 }) })).toEqual([]);
  });
  it("counts interday learning against the review limit", () => {
    const learning = fsrs.rate(undefined, Rating.Again, new Date(2026, 9, 24, 12));
    const reviewed = fsrs.rate(learning, Rating.Good, now);
    expect(dailyStudyCounts({ q: reviewed }, manage(), now).review).toBe(1);
    expect(buildReviewQueue([question("learning")], { learning }, fsrs,
      { now, management: manage({ reviewsPerDay: 0 }) })).toEqual([]);
  });
  it("honors before/after/mix and stable sorting without changing caller data", () => {
    const questions = ["a", "b", "r1", "r2"].map(question);
    const reviews = { r1: old, r2: { ...old, card: { ...old.card, scheduled_days: 2 } } };
    const before = structuredClone([questions, reviews]);
    const run = (newReviewOrder: "before" | "after" | "mix") => buildReviewQueue(questions, reviews, fsrs,
      { now, management: manage({ newReviewOrder, reviewOrder: "interval-ascending" }) }).map(q => q.id);
    expect(run("before")).toEqual(["a", "b", "r2", "r1"]);
    expect(run("after")).toEqual(["r2", "r1", "a", "b"]);
    expect(run("mix")).toEqual(["r2", "a", "r1", "b"]);
    expect([questions, reviews]).toEqual(before);
  });
  it("uses configured steps for previews and ratings and keeps fixed intervals authoritative", () => {
    const settings = { ...DEFAULT_SETTINGS, studyManagement: manage({ learningSteps: ["2m", "20m"], relearningSteps: ["5m"], enableFuzz: false }) };
    const custom = new FsrsService(settings);
    expect(custom.rate(undefined, Rating.Again, now).card.due).toBe(new Date(now.getTime() + 120_000).toISOString());
    expect(custom.rate(old, Rating.Again, now).card.due).toBe(new Date(now.getTime() + 300_000).toISOString());
    for (const preview of custom.preview(undefined, now, "q")) expect(custom.rate(undefined, preview.grade, now, "q").card.due).toBe(preview.due.toISOString());
    const fixed = new FsrsService({ ...settings, gradeIntervalsMinutes: { 1: 7 } });
    expect(fixed.rate(undefined, Rating.Again, now).card.due).toBe(new Date(now.getTime() + 420_000).toISOString());
    const auto = new FsrsService({ ...settings, studyManagement: manage({ learningSteps: [], relearningSteps: [] }) });
    expect(auto.rate(undefined, Rating.Good, now).card.reps).toBe(1);
  });
  it("persists settings across restart without modifying existing review state", async () => {
    let disk: unknown = undefined;
    const storage = { loadData: async () => disk, saveData: async (data: unknown) => { disk = structuredClone(data); } };
    const store = new MiaDataStore(storage);
    await store.load(); await store.setReview("q", old);
    const before = structuredClone(store.reviews);
    const settings = manage({ learningSteps: ["3m"], newCardsPerDay: 7, fsrsParameters: [...default_w] });
    await store.updateSettings({ studyManagement: settings });
    const restarted = new MiaDataStore(storage); await restarted.load();
    expect(restarted.settings.studyManagement).toEqual(settings);
    expect(restarted.reviews).toEqual(before);
    expect(restarted.getReview("q")?.card.state).toBe(State.Review);
  });
});


describe("interday learning selection matches daily accounting", () => {
  it.each([Rating.Again, Rating.Good] as const)("charges a scheduled next-day learning step (%s) before selecting it", grade => {
    const settings = { ...DEFAULT_SETTINGS, studyManagement: manage({ learningSteps: ["12h", "13h"], reviewsPerDay: 0 }) };
    const scheduler = new FsrsService(settings);
    const yesterday = new Date(2026, 9, 24, 18);
    const learning = scheduler.rate(undefined, grade, yesterday, "q");
    const due = new Date(learning.card.due);
    expect(learning.card.state).toBe(State.Learning);
    expect(buildReviewQueue([question("q")], {q:learning}, scheduler, {now:due, management:settings.studyManagement})).toEqual([]);
    const allowed = {...settings.studyManagement, reviewsPerDay:1};
    expect(buildReviewQueue([question("q")], {q:learning}, scheduler, {now:due, management:allowed}).map(q=>q.id)).toEqual(["q"]);
    const repeated = scheduler.rate(learning, Rating.Again, due, "q");
    expect(dailyStudyCounts({q:repeated}, allowed, due)).toEqual({fresh:0,review:1});
  });
  it("limits cross-boundary relearning but continues repeats begun in this study day", () => {
    const settings = manage({reviewsPerDay:0});
    const beforeBoundary = new Date(2026,9,25,3,55);
    const lapse = fsrs.rate(old, Rating.Again, beforeBoundary, "q");
    const due = new Date(2026,9,25,4,5);
    expect(buildReviewQueue([question("q")], {q:lapse}, fsrs, {now:due,management:settings})).toEqual([]);
    const today = fsrs.rate(old, Rating.Again, new Date(2026,9,25,4), "q");
    expect(buildReviewQueue([question("q")], {q:today}, fsrs, {now:new Date(2026,9,25,4,10),management:settings}).map(q=>q.id)).toEqual(["q"]);
  });
});
