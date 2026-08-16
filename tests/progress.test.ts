import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { QuestionRecord } from "../src/core/models";
import { calculateProgress } from "../src/core/progress";

const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });

function question(id: string, subject: string): QuestionRecord & { id: string } {
  return {
    id,
    filePath: `${subject}/문제은행.md`,
    heading: id,
    headingLevel: 3,
    questionMarkdown: id,
    answerMarkdown: `${id} 답`,
    subject,
    deck: subject,
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
  };
}

describe("study progress", () => {
  it("counts new, due, studied, ratings, and subjects", () => {
    const now = new Date("2026-08-16T00:00:00.000Z");
    let hard = fsrs.rate(undefined, Rating.Hard, new Date("2026-08-01T00:00:00.000Z"));
    hard = { ...hard, card: { ...hard.card, due: "2026-08-10T00:00:00.000Z" } };
    const ratedGood = fsrs.rate(undefined, Rating.Good, new Date("2026-08-15T00:00:00.000Z"));
    const good = { ...ratedGood, card: { ...ratedGood.card, due: "2026-08-20T00:00:00.000Z" } };
    const result = calculateProgress(
      [question("new", "회로"), question("hard", "회로"), question("good", "전자기학")],
      { hard, good },
      fsrs,
      now,
    );
    expect(result).toMatchObject({ total: 3, new: 1, studied: 2, due: 1, hard: 1, good: 1 });
    expect(result.bySubject).toEqual([
      { subject: "전자기학", counts: expect.objectContaining({ total: 1, studied: 1, good: 1 }) },
      { subject: "회로", counts: expect.objectContaining({ total: 2, new: 1, due: 1, hard: 1 }) },
    ]);
  });
});
