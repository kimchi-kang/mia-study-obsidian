import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateKeywordMeaning, validateKeywordName } from "../src/core/keyword-note";
import { keywordNotePath, keywordReferencesFromInput } from "../src/core/keyword-path";
import {
  renderManagedQuestion,
  validateManagedQuestionInput,
  validateSubjectName,
} from "../src/core/managed-question";
import { parseQuestionFile } from "../src/core/question-parser";
import { registerQuestion, updateQuestionMetadata } from "../src/core/question-writer";

const path = "안전성/더미 문제은행.md";

async function fixture(): Promise<string> {
  return readFile(new URL("./fixtures/vault/안전성/더미 문제은행.md", import.meta.url), "utf8");
}

describe("Markdown integrity and injection safety", () => {
  it("indexes all dummy questions while ignoring fake structures inside fenced code", async () => {
    const parsed = parseQuestionFile(path, await fixture(), { subject: "안전성" });
    expect(parsed.questions).toHaveLength(7);
    expect(parsed.questions.filter((question) => question.id)).toHaveLength(6);
    expect(parsed.questions.map((question) => question.id)).not.toContain("mia-q-fake-in-fence");
    expect(parsed.questions[0]?.answerMarkdown).toContain("정답 코드 예시 속 가짜 구역");
    expect(parsed.questions[0]?.answerMarkdown).toContain("보충 설명");
    expect(parsed.diagnostics).toEqual([]);
  });

  it("round-trips dummy registration and metadata updates without changing prompt or answer", async () => {
    const content = await fixture();
    const parsed = parseQuestionFile(path, content, { subject: "안전성" });
    const candidate = parsed.questions.at(-1);
    const registered = parsed.questions[0];
    expect(candidate?.id).toBeNull();
    expect(registered?.id).toBe("mia-q-dummy-ohm");
    if (!candidate || !registered) return;

    const metadata = {
      questionType: "정의형" as const,
      coreKeywords: [{ target: "안전성", label: "안전성", raw: "[[안전성]]" }],
      subKeywords: [],
    };
    const registeredContent = registerQuestion(content, candidate, metadata, "mia-q-dummy-candidate");
    const registeredAgain = parseQuestionFile(path, registeredContent).questions.at(-1);
    expect(registeredAgain?.questionMarkdown).toBe(candidate.questionMarkdown);
    expect(registeredAgain?.answerMarkdown).toBe(candidate.answerMarkdown);

    const updatedContent = updateQuestionMetadata(content, registered, metadata);
    const updated = parseQuestionFile(path, updatedContent).questions[0];
    expect(updated?.questionMarkdown).toBe(registered.questionMarkdown);
    expect(updated?.answerMarkdown).toBe(registered.answerMarkdown);
  });

  it("rejects control-character injection at every metadata and path boundary", async () => {
    const parsed = parseQuestionFile(path, await fixture());
    const registered = parsed.questions[0];
    expect(registered).toBeDefined();
    if (!registered) return;

    expect(() => keywordReferencesFromInput("옴의 법칙\n> 유형: 예외형", "MIA/키워드")).toThrow(/제어 문자/);
    expect(() => keywordNotePath("MIA/키워드/옴\n법칙", "옴의 법칙", "MIA/키워드")).toThrow(/제어 문자/);
    expect(() => validateKeywordName("옴\n법칙")).toThrow();
    expect(() => validateSubjectName("회로\n이론")).toThrow();
    expect(() => validateKeywordMeaning("정상 의미\n\n## 연결\n주입")).toThrow(/### 이하/);
    expect(() => updateQuestionMetadata("", registered, {
      questionType: "정의형",
      coreKeywords: [{ target: "안전", label: "안전", raw: "[[안전]]\n> 유형: 예외형" }],
      subKeywords: [],
    })).toThrow(/제어 문자/);
  });

  it("rejects managed answers that could split or inject a question section", () => {
    const base = {
      questionMarkdown: "안전한 질문",
      answerMarkdown: "안전한 정답",
      questionType: "정의형" as const,
      coreKeywords: [{ target: "안전", label: "안전", raw: "[[안전]]" }],
      subKeywords: [],
    };
    expect(() => renderManagedQuestion({
      ...base,
      answerMarkdown: "정상 설명\n\n### 가짜 질문\n\n> [!question] 문제\n> 삽입 시도",
    }, "mia-q-safe")).toThrow(/#### 이하/);
    expect(() => renderManagedQuestion({
      ...base,
      answerMarkdown: "```markdown\n### 코드 예시\n> [!question] 문제\n```",
    }, "mia-q-safe")).not.toThrow();
    expect(() => validateManagedQuestionInput({
      ...base,
      followUpLinks: ["[[문제은행#^mia-q-next]]\n> 유형: 예외형"],
    })).toThrow(/제어 문자/);
    expect(() => renderManagedQuestion(base, "unsafe\n^mia-q-injected")).toThrow(/문제 ID/);
  });
});
