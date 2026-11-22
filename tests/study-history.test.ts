import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTotalAnswerDuration } from "../src/core/answer-time";
import { FsrsService } from "../src/core/fsrs-service";
import type { SerializedReviewLog } from "../src/core/models";
import { summarizeStudyHistory } from "../src/core/study-history";

const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });

function local(day: number, hour = 12, minute = 0): Date {
  return new Date(2026, 10, day, hour, minute);
}

function log(day: number | Date, extra: Partial<SerializedReviewLog> = {}): SerializedReviewLog {
  const at = typeof day === "number" ? local(day) : day;
  return { ...fsrs.rate(undefined, 3, at).history[0]!, ...extra };
}

function summary(history: SerializedReviewLog[], now = local(18), weeks?: number) {
  return summarizeStudyHistory({ q: { ...fsrs.createState(now), history } }, 4, now, weeks);
}

afterEach(() => vi.unstubAllEnvs());

describe("study history", () => {
  it("buckets 03:59 on the previous day and 04:00 on the current day", () => {
    const history = [log(local(18, 3, 59)), log(local(18, 4))];
    const before = summary(history, local(18, 3, 59));
    expect(before.today.count).toBe(1);
    expect(before.days.find(day => day.date === "2026-11-18")).toMatchObject({ count: 0, future: true });
    const at = summary(history, local(18, 4));
    expect(at.days.find(day => day.date === "2026-11-17")?.count).toBe(1);
    expect(at.today.count).toBe(1);
    expect(at.streak).toBe(2);
  });

  it("counts ratings 1 through 4 across cards and ignores manual, invalid and future logs", () => {
    const now = local(18);
    const card = fsrs.createState(now);
    const result = summarizeStudyHistory({
      first: { ...card, history: [log(18, { rating: 1 }), log(18, { rating: 2 }), log(18, { rating: 0 }), log(18, { rating: 5 })] },
      second: { ...card, history: [log(18, { rating: 3 }), log(18, { rating: 4 }), log(18, { review: "invalid" }), log(local(18, 12, 1))] },
    }, 4, now);
    expect(result.today.count).toBe(4);
    expect(result.total).toBe(4);
  });

  it.each([
    [[15, 16, 17], 3],
    [[15, 16, 17, 18], 4],
    [[14, 16, 17, 18], 3],
    [[15, 16], 0],
  ] as const)("counts a streak for dates %j", (dates, expected) => {
    expect(summary(dates.map(day => log(day))).streak).toBe(expected);
  });

  it("remembers the longest streak even after it ended", () => {
    const history = [1, 2, 3, 4, 8, 9, 17, 18].map(day => log(day));
    const result = summary(history);
    expect(result.streak).toBe(2);
    expect(result.longestStreak).toBe(4);
    expect(summary([log(17), log(18)]).longestStreak).toBe(2);
    expect(summary([]).longestStreak).toBe(0);
  });

  it("counts a streak that starts before the grid", () => {
    const result = summary(Array.from({ length: 100 }, (_, i) => log(18 - i)));
    expect(result.streak).toBe(100);
    expect(result.activeDays).toBe(80);
    expect(result.total).toBe(80);
  });

  it("returns 12 Monday-first columns and preserves the space for future dates", () => {
    const { days } = summary([]);
    expect(days).toHaveLength(84);
    expect(days[0]?.date).toBe("2026-08-31");
    expect(days.slice(-7).map(day => day.date)).toEqual([
      "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22",
    ]);
    expect(days.slice(-7, -4).every(day => !day.future)).toBe(true);
    expect(days.slice(-4).every(day => day.future && day.count === 0 && day.answerMs === 0 && day.level === 0)).toBe(true);
  });

  it("scales levels to the grid maximum and totals the most recent seven study days", () => {
    const result = summary([
      ...Array.from({ length: 10 }, () => log(10)),
      log(11), log(12, { answer_ms: 100_000 }), log(15, { answer_ms: 5000 }),
      log(16, { answer_ms: 1200 }), log(16, { answer_ms: -1 }),
      log(17), log(17), log(17),
      log(18), log(18, { answer_ms: 5400 }), log(18, { answer_ms: NaN }), log(18, { answer_ms: 3600 }),
    ], local(18), 1);
    expect(result.days.map(day => day.level)).toEqual([2, 3, 4, 0, 0, 0, 0]);
    expect(result.today).toEqual({ count: 4, answerMs: 9000 });
    expect(result.week).toEqual({ count: 11, answerMs: 75_200 });
    expect(result.total).toBe(9);
    expect(result.activeDays).toBe(3);
    expect(summary([log(18)], local(18), 1).days[2]?.level).toBe(4);
    expect(summary([1, 2, 3, 4].flatMap(count => Array.from({ length: count }, () => log(14 + count))))
      .days.filter(day => day.count).map(day => day.level)).toEqual([1, 2, 3, 4]);
  });

  it.each(["UTC", "America/New_York", "Asia/Seoul", "Pacific/Auckland"])("keeps dates and streaks across a DST weekend in %s", tz => {
    vi.stubEnv("TZ", tz);
    const result = summary([log(local(1, 3, 59)), log(local(1, 4)), log(local(2, 4))], local(2, 4));
    expect(result.streak).toBe(3);
    expect(result.days.filter(day => day.count).map(day => day.date)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(result.days.at(-7)?.date).toBe("2026-11-02");
  });

  it("keeps the grid aligned when a time zone skips a whole civil date", () => {
    vi.stubEnv("TZ", "Pacific/Apia");
    const dates = [25, 26, 27, 28, 29, 31].map(day => new Date(2011, 11, day, 12));
    const now = new Date(2012, 0, 1, 12);
    const result = summary([...dates, now].map(date => log(date)), now);
    expect(result.streak).toBe(7);
    expect(result.week.count).toBe(7);
    expect(result.days.at(-3)).toMatchObject({ date: "2011-12-30", count: 0, future: false });
  });

  it("formats aggregate recall time in seconds, minutes and hours", () => {
    expect(formatTotalAnswerDuration(24_000)).toBe("24초");
    expect(formatTotalAnswerDuration(240_000)).toBe("4분");
    expect(formatTotalAnswerDuration(3_600_000)).toBe("1시간");
    expect(formatTotalAnswerDuration(3_840_000)).toBe("1시간 4분");
  });
});
