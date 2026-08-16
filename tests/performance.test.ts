import { describe, expect, it } from "vitest";
import { FsrsService } from "../src/core/fsrs-service";
import { QuestionRecord } from "../src/core/models";
import { queryQuestions } from "../src/core/question-query";
import { recommendQuestions } from "../src/core/recommendation-engine";

const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });

function questions(count: number): Array<QuestionRecord & { id: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: `q-${index}`,
    filePath: `전공면접대비/과목-${index % 10}/문제은행.md`,
    heading: `질문 ${index}`,
    headingLevel: 3,
    questionMarkdown: `검색 가능한 질문 본문 ${index}`,
    answerMarkdown: `정답 ${index}`,
    subject: `과목-${index % 10}`,
    deck: `과목-${index % 10}`,
    questionType: "정의형" as const,
    coreKeywords: [{ target: `키워드/${index % 100}`, label: `키워드 ${index % 100}`, raw: `[[키워드/${index % 100}]]` }],
    subKeywords: [],
    followUpIds: [],
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    updatedAt: new Date(1_700_000_000_000 + index * 2000).toISOString(),
    location: { headingLine: 0, questionStartLine: 1, questionEndLine: 2, answerHeadingLine: 3, answerEndLine: 4, metadataStartLine: null, metadataEndLine: null, anchorLine: 2 },
  }));
}

describe("1,500 question performance", () => {
  it("filters, sorts, and recommends within an interactive-time budget", () => {
    const dataset = questions(1500);
    const started = performance.now();
    const result = queryQuestions(dataset, {}, fsrs, {
      text: "질문 본문", subject: "all", questionType: "all", review: "all", keyword: "키워드 42", sort: "updated",
    });
    const recommendations = recommendQuestions(dataset[42]!, dataset, {}, fsrs);
    const elapsed = performance.now() - started;
    expect(result.length).toBe(15);
    expect(recommendations.length).toBeLessThanOrEqual(5);
    expect(elapsed).toBeLessThan(1000);
  });
});
