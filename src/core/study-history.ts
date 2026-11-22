import { normalizeAnswerMs } from "./answer-time";
import type { QuestionReviewState } from "./models";
import { calendarDate, studyDayStart } from "./study-management";

const DAY_MS = 86_400_000;

interface Activity {
  count: number;
  answerMs: number;
}

type ActivityLevel = 0 | 1 | 2 | 3 | 4;

export interface StudyHistory {
  days: Array<Activity & { date: string; level: ActivityLevel; future: boolean }>;
  streak: number;
  /** 전체 기록에서 가장 길었던 연속 학습일. */
  longestStreak: number;
  today: Activity;
  week: Activity;
  activeDays: number;
  total: number;
}

function previousStudyDay(start: Date, dayStartsAt: number): Date {
  return studyDayStart(new Date(start.getTime() - 1), dayStartsAt);
}

export function summarizeStudyHistory(
  reviews: Readonly<Record<string, QuestionReviewState>>,
  dayStartsAt: number,
  now: Date,
  weeks = 12,
): StudyHistory {
  const byDay = new Map<string, Activity>();
  const nowMs = now.getTime();
  for (const { history } of Object.values(reviews)) {
    for (const { rating, review, answer_ms } of history) {
      if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4) continue;
      const timestamp = Date.parse(review);
      if (!Number.isFinite(timestamp) || timestamp > nowMs) continue;
      const day = calendarDate(studyDayStart(new Date(timestamp), dayStartsAt));
      const activity = byDay.get(day) ?? { count: 0, answerMs: 0 };
      activity.count += 1;
      activity.answerMs += normalizeAnswerMs(answer_ms) ?? 0;
      byDay.set(day, activity);
    }
  }

  const todayStart = studyDayStart(now, dayStartsAt);
  const todayDate = calendarDate(todayStart);
  const today = byDay.get(todayDate) ?? { count: 0, answerMs: 0 };
  let day = today.count ? todayStart : previousStudyDay(todayStart, dayStartsAt);
  let streak = 0;
  while (byDay.has(calendarDate(day))) {
    streak++;
    day = previousStudyDay(day, dayStartsAt);
  }
  const week = { count: 0, answerMs: 0 };
  day = todayStart;
  for (let i = 0; i < 7; i++, day = previousStudyDay(day, dayStartsAt)) {
    const activity = byDay.get(calendarDate(day));
    if (!activity) continue;
    week.count += activity.count;
    week.answerMs += activity.answerMs;
  }

  // Grid rows represent civil dates, including dates a time zone may have skipped.
  const todayDay = Date.parse(todayDate) / DAY_MS;
  const monday = todayDay - (todayStart.getDay() + 6) % 7;
  const firstDay = monday - (weeks - 1) * 7;
  let activeDays = 0;
  let total = 0;
  let max = 0;
  const grid = Array.from({ length: weeks * 7 }, (_, i) => {
    const ordinal = firstDay + i;
    const date = new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
    const future = ordinal > todayDay;
    const { count = 0, answerMs = 0 } = (future ? undefined : byDay.get(date)) ?? {};
    if (count) activeDays++;
    total += count;
    max = Math.max(max, count);
    return { date, count, answerMs, future };
  });
  const days = grid.map(day => ({
    ...day, level: (day.count ? Math.min(4, Math.max(1, Math.ceil(day.count / max * 4))) : 0) as ActivityLevel,
  }));
  // 날짜 문자열을 UTC 자정 일수로 바꿔 이어진 날을 센다(여름시간과 무관).
  let longestStreak = streak;
  let run = 0;
  let previous = Number.NaN;
  for (const ordinal of [...byDay.keys()].map(date => Date.parse(date) / DAY_MS).sort((a, b) => a - b)) {
    run = ordinal - previous === 1 ? run + 1 : 1;
    previous = ordinal;
    longestStreak = Math.max(longestStreak, run);
  }
  return { days, streak, longestStreak, today, week, activeDays, total };
}
