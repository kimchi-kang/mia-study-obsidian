import { describe, expect, it } from "vitest";
import { parseQuestionFile } from "../src/core/question-parser";
import { createQuestionId, findCurrentQuestion, registerQuestion, updateQuestionMetadata } from "../src/core/question-writer";

const candidateContent = `# 단원

### 확인문제

> [!question] 문제
> 전속이란 무엇인가?

#### 풀이

전기력선의 흐름을 나타낸다.
`;

describe("question writer", () => {
  it("registers a candidate without changing question or answer content", () => {
    const candidate = parseQuestionFile("전자기학/전속.md", candidateContent).questions[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const updated = registerQuestion(candidateContent, candidate, {
      questionType: "정의형",
      coreKeywords: [{ target: "전속", label: "전속", raw: "[[전속]]" }],
      subKeywords: [],
    }, "mia-q-fixed");
    const parsed = parseQuestionFile("전자기학/전속.md", updated).questions[0];

    expect(parsed?.id).toBe("mia-q-fixed");
    expect(parsed?.questionMarkdown).toBe(candidate.questionMarkdown);
    expect(parsed?.answerMarkdown).toBe(candidate.answerMarkdown);
    expect(parsed?.coreKeywords[0]?.target).toBe("전속");
  });

  it("updates only the existing metadata callout", () => {
    const candidate = parseQuestionFile("전자기학/전속.md", candidateContent).questions[0];
    if (!candidate) return;
    const registered = registerQuestion(candidateContent, candidate, {
      questionType: "정의형",
      coreKeywords: [],
      subKeywords: [],
    }, "mia-q-fixed");
    const registeredQuestion = parseQuestionFile("전자기학/전속.md", registered).questions[0];
    if (!registeredQuestion) return;

    const updated = updateQuestionMetadata(registered, registeredQuestion, {
      questionType: "원리형",
      coreKeywords: [{ target: "전속", label: "전속", raw: "[[전속]]" }],
      subKeywords: [{ target: "전기장", label: "전기장", raw: "[[전기장]]" }],
    });

    expect(updated.match(/\[!mia\]/g)).toHaveLength(1);
    expect(parseQuestionFile("전자기학/전속.md", updated).questions[0]?.questionType).toBe("원리형");
  });

  it("creates deterministic, valid IDs when inputs are injected", () => {
    expect(createQuestionId(123456, 0.5)).toMatch(/^mia-q-2n9c-0[0-9a-z]{6}$/);
  });

  it("relocates an unregistered question after lines are inserted above it", () => {
    const original = parseQuestionFile("전자기학/전속.md", candidateContent).questions[0];
    const shifted = parseQuestionFile("전자기학/전속.md", `서문\n\n${candidateContent}`).questions;
    expect(original).toBeDefined();
    if (!original) return;
    expect(findCurrentQuestion(shifted, original)?.location.questionStartLine)
      .toBe(original.location.questionStartLine + 2);
  });

  it("refuses to guess when multiple unregistered questions have identical content", () => {
    const original = parseQuestionFile("전자기학/전속.md", candidateContent).questions[0];
    const duplicated = parseQuestionFile("전자기학/전속.md", `${candidateContent}\n${candidateContent}`).questions;
    expect(original).toBeDefined();
    if (!original) return;
    expect(findCurrentQuestion(duplicated, { ...original, location: { ...original.location, questionStartLine: 999 } }))
      .toBeUndefined();
  });

  it("refuses to edit an ID that became duplicated", () => {
    const originalCandidate = parseQuestionFile("전자기학/전속.md", candidateContent).questions[0];
    expect(originalCandidate).toBeDefined();
    if (!originalCandidate) return;
    const registered = registerQuestion(candidateContent, originalCandidate, {
      questionType: "정의형",
      coreKeywords: [{ target: "전속", label: "전속", raw: "[[전속]]" }],
      subKeywords: [],
    }, "mia-q-fixed");
    const original = parseQuestionFile("전자기학/전속.md", registered).questions[0];
    const duplicated = parseQuestionFile("전자기학/전속.md", `${registered}\n${registered}`).questions;
    expect(original).toBeDefined();
    if (!original) return;
    expect(findCurrentQuestion(duplicated, original)).toBeUndefined();
  });
});
