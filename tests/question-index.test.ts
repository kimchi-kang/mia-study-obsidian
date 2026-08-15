import { describe, expect, it } from "vitest";
import { QuestionIndexInternals } from "../src/services/question-index";
import type { QuestionRecord } from "../src/core/models";

function question(id: string, filePath: string): QuestionRecord {
  return {
    id,
    filePath,
    heading: filePath,
    headingLevel: 3,
    questionMarkdown: "질문",
    answerMarkdown: "정답",
    subject: "전자기학",
    deck: "더미",
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

describe("source root filtering", () => {
  it("matches exact roots and descendants only", () => {
    expect(QuestionIndexInternals.inSourceRoots("전자기학/a.md", ["전자기학"])).toBe(true);
    expect(QuestionIndexInternals.inSourceRoots("전자기학.md", ["전자기학"])).toBe(false);
    expect(QuestionIndexInternals.inSourceRoots("회로/a.md", ["전자기학"])).toBe(false);
    expect(QuestionIndexInternals.inSourceRoots("anything.md", [])).toBe(true);
  });

  it("uses the first folder below a configured root as the subject", () => {
    expect(QuestionIndexInternals.subjectForPath("전공면접대비/전자기학/문제은행.md", ["전공면접대비"]))
      .toBe("전자기학");
    expect(QuestionIndexInternals.subjectForPath("전공면접대비/직접문제.md", ["전공면접대비"]))
      .toBe("미분류");
    expect(QuestionIndexInternals.subjectForPath("전자기학/문제.md", [])).toBeUndefined();
  });
});

describe("duplicate IDs", () => {
  it("excludes every ambiguous question instead of sharing one review state", () => {
    const unique = question("mia-q-unique", "unique.md");
    const duplicateA = question("mia-q-duplicate", "a.md");
    const duplicateB = question("mia-q-duplicate", "b.md");
    expect(QuestionIndexInternals.uniqueRegisteredQuestions([unique, duplicateA, duplicateB]))
      .toEqual([unique]);
  });
});
