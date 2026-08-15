import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseQuestionFile } from "../src/core/question-parser";

describe("Obsidian note fixture", () => {
  it("indexes registered questions and leaves the candidate untouched", async () => {
    const path = "전자기학/04 정전기학/가우스 법칙.md";
    const content = await readFile(new URL(`./fixtures/vault/${path}`, import.meta.url), "utf8");
    const parsed = parseQuestionFile(path, content);
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.questions.filter((question) => question.id)).toHaveLength(1);
    expect(parsed.questions.filter((question) => !question.id)).toHaveLength(1);
    expect(parsed.questions[0]?.coreKeywords.map((item) => item.label)).toEqual(["가우스 법칙", "전속밀도"]);
    expect(parsed.diagnostics).toEqual([]);
  });
});
