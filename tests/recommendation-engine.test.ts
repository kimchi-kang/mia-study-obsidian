import { describe, expect, it } from "vitest";
import { Rating, State } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { DEFAULT_STUDY_MANAGEMENT, QuestionRecord } from "../src/core/models";
import { buildReviewQueue, planSelectedReview, recommendQuestions } from "../src/core/recommendation-engine";
import { queryQuestions } from "../src/core/question-query";
import { studyDayStart } from "../src/core/study-management";

const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });

function question(id: string, overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id,
    filePath: `지리학/${id}.md`,
    heading: id,
    headingLevel: 3,
    questionMarkdown: id,
    answerMarkdown: `${id} 답`,
    subject: "지리학",
    deck: "지형학",
    questionType: "정의형",
    coreKeywords: [],
    subKeywords: [],
    followUpIds: [],
    location: {
      headingLine: 0,
      questionStartLine: 1,
      questionEndLine: 2,
      answerHeadingLine: 3,
      answerEndLine: 4,
      metadataStartLine: null,
      metadataEndLine: null,
      anchorLine: 2,
    },
    ...overrides,
  };
}

const recipe = { target: "레시피 원칙", label: "레시피 원칙", raw: "[[레시피 원칙]]" };

describe("recommendQuestions", () => {
  it("combines keyword, subject, type, direct-link, and due urgency", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const base = question("base", { coreKeywords: [recipe], followUpIds: ["direct"] });
    const related = question("related", { coreKeywords: [recipe], questionType: "원리형" });
    const direct = question("direct", { subject: "통계이론" });
    let dueReview = fsrs.rate(undefined, Rating.Good, new Date("2026-07-01T00:00:00.000Z"));
    dueReview = { ...dueReview, card: { ...dueReview.card, due: "2026-08-01T00:00:00.000Z" } };

    const result = recommendQuestions(base, [base, related, direct], { related: dueReview }, fsrs, { now });
    expect(result[0]?.question.id).toBe("direct");
    expect(result[1]?.question.id).toBe("related");
    expect(result[1]?.reasons).toContain("복습 기한 경과");
  });

  it("matches legacy root links with keyword-folder links by their note name", () => {
    const base = question("base", { coreKeywords: [{ ...recipe, target: "레시피 원칙" }] });
    const related = question("related", { coreKeywords: [{ ...recipe, target: "MIA/키워드/레시피 원칙" }] });
    expect(recommendQuestions(base, [base, related], {}, fsrs)[0]?.question.id).toBe("related");
  });

  it("does not recommend from a common keyword alone", () => {
    const common = { target: "MIA/키워드/개념", label: "개념", raw: "[[MIA/키워드/개념|개념]]" };
    const base = question("base", { coreKeywords: [common] });
    const unrelated = question("unrelated", { coreKeywords: [common] });
    expect(recommendQuestions(base, [base, unrelated], {}, fsrs)).toEqual([]);
  });
});

describe("buildReviewQueue", () => {
  it("shuffles due and new groups independently without mutation, duplicates or future reviews", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    const questions = ["new-a", "due-a", "future", "due-b", "new-b", "due-c"].map(id => question(id));
    const due = fsrs.rate(undefined, Rating.Easy, new Date("2026-09-01T00:00:00Z"));
    const reviews = { "due-a": due, "due-b": due, "due-c": due, future: fsrs.rate(undefined, Rating.Easy, now) };
    const original = structuredClone(questions); const beforeReviews = structuredClone(reviews);
    const first = buildReviewQueue(questions, reviews, fsrs, { now, random: () => 0 }).map(q => q.id);
    const second = buildReviewQueue(questions, reviews, fsrs, { now, random: () => 0.999999 }).map(q => q.id);
    expect(first).toEqual(["due-b", "due-c", "due-a", "new-b", "new-a"]);
    expect(second).toEqual(["due-a", "due-b", "due-c", "new-a", "new-b"]);
    expect(new Set(first).size).toBe(first.length); expect(questions).toEqual(original); expect(reviews).toEqual(beforeReviews);
  });

  it("prioritizes due learning steps, then recall risk, consistently with the question list", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    const mature = fsrs.rate(undefined, Rating.Easy, new Date("2026-09-01T00:00:00Z"));
    const weak = { ...mature, card: { ...mature.card, stability: 1, due: "2026-10-16T00:00:00Z", last_review: "2026-10-15T00:00:00Z" } };
    const strong = { ...mature, card: { ...mature.card, stability: 100, due: "2026-10-07T00:00:00Z", last_review: "2026-09-27T00:00:00Z" } };
    const learning = fsrs.rate(undefined, Rating.Again, new Date(now.getTime() - 120_000));
    const future = fsrs.rate(undefined, Rating.Easy, now);
    const reviews = { weak, strong, learning, future };
    const questions = ["new", "strong", "weak", "future", "learning"].map(id => question(id));
    expect(fsrs.retrievability(weak, now)).toBeLessThan(fsrs.retrievability(strong, now)!);
    expect(buildReviewQueue(questions, reviews, fsrs, { now }).map(q => q.id)).toEqual(["learning", "weak", "strong", "new"]);
    const listed = queryQuestions(questions.filter((q): q is QuestionRecord & { id: string } => q.id !== null), reviews, fsrs, {
      text: "", subject: "all", questionType: "all", review: "all", keyword: "", sort: "review", now,
    });
    expect(listed.map(q => q.id)).toEqual(["learning", "weak", "strong", "new", "future"]);
  });

  it("puts every due card before every new card without a study cap", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const dueQuestion = question("due");
    const newQuestion = question("new");
    const anotherNewQuestion = question("new-2");
    let dueReview = fsrs.rate(undefined, Rating.Good, new Date("2026-07-01T00:00:00.000Z"));
    dueReview = { ...dueReview, card: { ...dueReview.card, due: "2026-08-01T00:00:00.000Z" } };

    expect(buildReviewQueue([newQuestion, anotherNewQuestion, dueQuestion], { due: dueReview }, fsrs, { now })
      .map((item) => item.id)).toEqual(["due", "new", "new-2"]);
  });
});

describe("planSelectedReview", () => {
  it("explains each omitted selection using the same study day and daily limits as the queue", () => {
    const now = new Date(2026, 9, 17, 9);
    const futureAt = new Date(2026, 9, 18, 15);
    const old = fsrs.rate(undefined, Rating.Easy, new Date(2026, 8, 15, 9));
    const reviews = {
      future: { ...old, card: { ...old.card, state: State.Review, scheduled_days: 1, due: futureAt.toISOString() } },
      due: old,
      introduced: fsrs.rate(undefined, Rating.Easy, new Date(2026, 9, 17, 8)),
    };
    const management = { ...DEFAULT_STUDY_MANAGEMENT, newCardsPerDay: 1, reviewsPerDay: 1 };
    const options = { management, now };
    const questions = [question("future"), question("due"), question("fresh")];
    const result = planSelectedReview(questions, ["future", "due", "fresh", "missing", "missing"], reviews, fsrs, options);
    expect(result.queue).toEqual(buildReviewQueue(questions, reviews, fsrs, options));
    expect(result.queue).toEqual([]);
    expect(result.exclusions).toEqual(expect.arrayContaining([
      { id: "future", reason: "not-due", nextDue: studyDayStart(futureAt, management.dayStartsAt) },
      { id: "due", reason: "review-limit" },
      { id: "fresh", reason: "new-limit" },
      { id: "missing", reason: "missing" },
    ]));
    expect(result.exclusions).toHaveLength(4);
  });

  it("reports the review cap for a new card blocked only by the shared review budget", () => {
    const now = new Date(2026, 9, 17, 9);
    const learning = fsrs.rate(undefined, Rating.Again, new Date(now.getTime() - 120_000));
    const management = { ...DEFAULT_STUDY_MANAGEMENT, reviewsPerDay: 0, newCardsPerDay: 3 };
    const questions = [question("fresh"), question("learning")];
    const result = planSelectedReview(questions, ["fresh", "learning"], { learning }, fsrs, { now, management });
    expect(result.queue.map(item => item.id)).toEqual(["learning"]);
    expect(result.exclusions).toEqual([{ id: "fresh", reason: "review-limit" }]);
  });
});

it("counts core-to-sub matches symmetrically and only scores each keyword at its highest match", () => {
  const shared = { target: "지형 분류", label: "지형 분류", raw: "[[지형 분류]]" };
  const common = { target: "개념", label: "개념", raw: "[[개념]]" };
  const base = question("base", { coreKeywords: [shared, common], subKeywords: [shared, recipe, common] });
  const candidate = question("related", { subject: "통계이론", coreKeywords: [shared, recipe, common], subKeywords: [shared, recipe, common] });
  for (const [left, right] of [[base, candidate], [candidate, base]] as const) {
    expect(recommendQuestions(left, [left, right], {}, fsrs)[0]).toMatchObject({
      score: 7, reasons: ["핵심 키워드 1개 일치", "보조 키워드 1개 일치"],
    });
  }
  const onlyCore = question("core-only", { coreKeywords: [recipe, shared] });
  const onlySub = question("sub-only", { subKeywords: [recipe, shared] });
  for (const [left, right] of [[onlySub, onlyCore], [onlyCore, onlySub]] as const) {
    expect(recommendQuestions(left, [left, right], {}, fsrs)[0]).toMatchObject({
      score: 6, reasons: ["보조 키워드 2개 일치", "같은 과목"],
    });
  }
});
