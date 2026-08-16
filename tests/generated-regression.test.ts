import { describe, expect, it } from "vitest";
import { renderManagedQuestion } from "../src/core/managed-question";
import { QUESTION_TYPES } from "../src/core/models";
import { parseQuestionFile } from "../src/core/question-parser";

const cases = Array.from({ length: 300 }, (_, index) => index);

describe("300 generated managed-question regressions", () => {
  it.each(cases)("round-trips Korean question variant %i", (index) => {
    const type = QUESTION_TYPES[index % QUESTION_TYPES.length]!;
    const id = `mia-q-generated-${index}`;
    const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
    const updatedAt = new Date(Date.UTC(2026, 0, 2) + index * 60_000).toISOString();
    const core = { target: `키워드/핵심-${index % 31}`, label: `핵심 ${index % 31}`, raw: `[[키워드/핵심-${index % 31}|핵심 ${index % 31}]]` };
    const sub = { target: `키워드/보조-${index % 17}`, label: `보조 ${index % 17}`, raw: `[[키워드/보조-${index % 17}|보조 ${index % 17}]]` };
    const followUpId = `mia-q-related-${index}`;
    const content = renderManagedQuestion({
      questionMarkdown: `한글 면접 질문 ${index}은 무엇인가?`,
      answerMarkdown: `면접 정답 ${index}\n\n두 번째 설명 문단`,
      questionType: type,
      coreKeywords: [core],
      subKeywords: [sub],
      followUpLinks: [`[[전공면접대비/과목/문제은행#^${followUpId}|관련 ${index}]]`],
      createdAt,
      updatedAt,
    }, id);
    const parsed = parseQuestionFile("전공면접대비/과목/문제은행.md", content, { subject: "과목" }).questions[0];
    expect(parsed).toMatchObject({
      id,
      subject: "과목",
      questionMarkdown: `한글 면접 질문 ${index}은 무엇인가?`,
      answerMarkdown: `면접 정답 ${index}\n\n두 번째 설명 문단`,
      questionType: type,
      followUpIds: [followUpId],
      createdAt,
      updatedAt,
    });
    expect(parsed?.coreKeywords).toEqual([core]);
    expect(parsed?.subKeywords).toEqual([sub]);
  });
});
