import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { QuestionRecord } from "../src/core/models";
import { buildReviewQueue, recommendQuestions } from "../src/core/recommendation-engine";

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
    const common = { target: "MIA/키워드/기압", label: "기압", raw: "[[MIA/키워드/기압|기압]]" };
    const base = question("base", { coreKeywords: [common] });
    const unrelated = question("unrelated", { coreKeywords: [common] });
    expect(recommendQuestions(base, [base, unrelated], {}, fsrs)).toEqual([]);
  });
});

describe("buildReviewQueue", () => {
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
