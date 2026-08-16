import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { MAX_FOLLOW_UPS, normalizeFollowUpIds, planFollowUpChanges } from "../src/core/follow-up";
import { renameKeywordReferences } from "../src/core/keyword-reference";
import { renderManagedQuestion } from "../src/core/managed-question";
import { QuestionRecord } from "../src/core/models";
import { parseQuestionFile } from "../src/core/question-parser";
import { queryQuestions, weaknessUrgency } from "../src/core/question-query";
import { recommendQuestions } from "../src/core/recommendation-engine";

const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });

function question(id: string, overrides: Partial<Omit<QuestionRecord, "id">> = {}): QuestionRecord & { id: string } {
  return {
    id,
    filePath: `전공면접대비/전자기학/${id}.md`,
    heading: `${id} 질문`,
    headingLevel: 3,
    questionMarkdown: `${id} 질문 본문`,
    answerMarkdown: `${id} 정답`,
    subject: "전자기학",
    deck: "전자기학",
    questionType: "정의형",
    coreKeywords: [],
    subKeywords: [],
    followUpIds: [],
    location: {
      headingLine: 0, questionStartLine: 1, questionEndLine: 2, answerHeadingLine: 3,
      answerEndLine: 4, metadataStartLine: null, metadataEndLine: null, anchorLine: 2,
    },
    ...overrides,
  };
}

describe("feature completeness", () => {
  it("round-trips created and updated timestamps through managed markdown", () => {
    const createdAt = "2026-08-15T01:02:03.000Z";
    const updatedAt = "2026-08-16T04:05:06.000Z";
    const content = renderManagedQuestion({
      questionMarkdown: "전속 밀도란?", answerMarkdown: "단위 면적당 전속이다.", questionType: "정의형",
      coreKeywords: [{ target: "전속 밀도", label: "전속 밀도", raw: "[[전속 밀도]]" }], subKeywords: [],
      createdAt, updatedAt,
    }, "mia-q-time");
    const parsed = parseQuestionFile("전공면접대비/전자기학/문제은행.md", content).questions[0];
    expect(parsed).toMatchObject({ createdAt, updatedAt });
  });

  it("plans directional and bidirectional follow-up updates and enforces the 50 item limit", () => {
    const base = question("base", { followUpIds: ["old"] });
    const old = question("old", { followUpIds: ["base"] });
    const next = question("next");
    const changes = planFollowUpChanges(base, ["next"], [base, old, next], true);
    expect(changes.get("base")).toEqual(["next"]);
    expect(changes.get("old")).toEqual([]);
    expect(changes.get("next")).toEqual(["base"]);
    expect(normalizeFollowUpIds("base", Array.from({ length: 80 }, (_, index) => `q-${index}`))).toHaveLength(MAX_FOLLOW_UPS);
  });

  it("deduplicates keyword references when a rename merges two keywords", () => {
    const old = { target: "키워드/옛이름", label: "옛이름", raw: "[[키워드/옛이름|옛이름]]" };
    const existing = { target: "키워드/새이름", label: "새이름", raw: "[[키워드/새이름|새이름]]" };
    expect(renameKeywordReferences([old, existing], [old.target, existing.target], existing.target, existing.label)).toEqual([existing]);
  });

  it("supports weak, today, created, and updated question queries", () => {
    const now = new Date("2026-08-16T12:00:00.000Z");
    const older = question("older", { createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" });
    const newer = question("newer", { createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T01:00:00.000Z" });
    let weak = fsrs.rate(undefined, Rating.Again, now);
    weak = { ...weak, card: { ...weak.card, due: "2026-08-10T00:00:00.000Z" } };
    const base = { text: "", subject: "all", questionType: "all" as const, keyword: "", now };
    expect(queryQuestions([older, newer], { newer: weak }, fsrs, { ...base, review: "weak", sort: "weak" }).map((item) => item.id)).toEqual(["newer"]);
    expect(queryQuestions([older, newer], { newer: weak }, fsrs, { ...base, review: "today", sort: "updated" }).map((item) => item.id)).toEqual(["newer"]);
    expect(queryQuestions([older, newer], {}, fsrs, { ...base, review: "all", sort: "created" }).map((item) => item.id)).toEqual(["newer", "older"]);
    expect(weaknessUrgency(weak, now)).toBeGreaterThan(100);
  });

  it("rejects automatic recommendations below the five point threshold", () => {
    const keyword = { target: "희귀", label: "희귀", raw: "[[희귀]]" };
    const base = question("base", { subKeywords: [keyword], subject: "A" });
    const lowScore = question("low", { subKeywords: [keyword], subject: "B" });
    expect(recommendQuestions(base, [base, lowScore], {}, fsrs)).toEqual([]);
  });
});
