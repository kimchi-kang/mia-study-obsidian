import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readKeywordMeaning } from "../src/core/keyword-note";
import { parseQuestionFile } from "../src/core/question-parser";
import { renderSubjectNote } from "../src/core/subject-note";

const guide = readFileSync(new URL("../MIA-AGENT.md", import.meta.url), "utf8");

function example(name: string): string {
  const start = `<!-- mia-agent:${name}-example:start -->`;
  const end = `<!-- mia-agent:${name}-example:end -->`;
  const section = guide.split(start)[1]?.split(end)[0];
  const markdown = section?.match(/```markdown\n([\s\S]*?)\n```/u)?.[1];
  if (!markdown) throw new Error(`Missing documented ${name} example`);
  return markdown;
}

describe("user agent guide examples", () => {
  it("imports the documented bank with valid answers, metadata and resolvable links", () => {
    const parsed = parseQuestionFile("MIA/수학/문제은행.md", example("bank"), { subject: "수학" });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.questions).toHaveLength(2);
    expect(new Set(parsed.questions.map((question) => question.id)).size).toBe(2);
    const ids = new Set(parsed.questions.map((question) => question.id));
    const keywordMeaning = readKeywordMeaning(example("keyword"));
    expect(keywordMeaning).not.toBe("");
    for (const question of parsed.questions) {
      expect(question.id).toMatch(/^mia-q-[A-Za-z0-9-]+$/u);
      expect(question.questionMarkdown).not.toBe("");
      expect(question.answerMarkdown).not.toBe("");
      expect(question.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(question.updatedAt).toBe(question.createdAt);
      expect(question.coreKeywords.map((keyword) => keyword.target)).toEqual(["MIA/키워드/덧셈"]);
      for (const target of question.followUpIds) expect(ids.has(target)).toBe(true);
    }
    expect(parsed.questions.map((question) => question.questionType)).toEqual(["계산형", "정의형"]);
    expect(parsed.questions[0]?.followUpIds).toEqual(["mia-q-example-reason"]);
    const note = renderSubjectNote("수학", parsed.questions);
    expect(note).toContain("질문: 사과 2개에 3개를 더하면 몇 개인가?");
    expect(note).toContain("대답: 5개다. 2 + 3 = 5.");
  });
});
