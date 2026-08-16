import { describe, expect, it } from "vitest";
import { parseQuestionFile } from "../src/core/question-parser";
import {
  appendManagedQuestion,
  createSubjectBank,
  deleteCurrentManagedQuestion,
  renameSubjectBank,
  replaceCurrentManagedQuestion,
  validateSubjectName,
} from "../src/core/managed-question";

const first = {
  questionMarkdown: "가우스 법칙이란 무엇인가?\n\n수식과 함께 설명하라.",
  answerMarkdown: "$\\nabla \\cdot \\mathbf D=\\rho_v$이다.",
  questionType: "정의형" as const,
  coreKeywords: [{ target: "전공면접대비/MIA/키워드/가우스 법칙", label: "가우스 법칙", raw: "[[전공면접대비/MIA/키워드/가우스 법칙|가우스 법칙]]" }],
  subKeywords: [],
};

describe("managed question documents", () => {
  it("appends multiple registered questions to one subject bank", () => {
    const path = "전공면접대비/전자기학/문제은행.md";
    const one = appendManagedQuestion(createSubjectBank("전자기학"), first, "mia-q-one");
    const two = appendManagedQuestion(one, { ...first, questionMarkdown: "쿨롱 법칙은?" }, "mia-q-two");
    const parsed = parseQuestionFile(path, two);
    expect(parsed.questions.map((question) => question.id)).toEqual(["mia-q-one", "mia-q-two"]);
    expect(parsed.questions[0]?.questionMarkdown).toBe(first.questionMarkdown);
    expect(parsed.questions[0]?.answerMarkdown).toBe(first.answerMarkdown);
  });

  it("edits exactly one ID while keeping its FSRS identity and neighbors", () => {
    const path = "전공면접대비/전자기학/문제은행.md";
    const content = appendManagedQuestion(
      appendManagedQuestion(createSubjectBank("전자기학"), first, "mia-q-one"),
      { ...first, questionMarkdown: "쿨롱 법칙은?" },
      "mia-q-two",
    );
    const original = parseQuestionFile(path, content).questions[0];
    expect(original).toBeDefined();
    if (!original) return;
    const updated = replaceCurrentManagedQuestion(
      content,
      original,
      (latest) => parseQuestionFile(path, latest).questions,
      { ...first, questionMarkdown: "수정된 가우스 법칙 질문", answerMarkdown: "수정된 정답" },
    );
    const parsed = parseQuestionFile(path, updated).questions;
    expect(parsed.map((question) => question.id)).toEqual(["mia-q-one", "mia-q-two"]);
    expect(parsed[0]?.questionMarkdown).toBe("수정된 가우스 법칙 질문");
    expect(parsed[0]?.answerMarkdown).toBe("수정된 정답");
    expect(parsed[1]?.questionMarkdown).toBe("쿨롱 법칙은?");
  });

  it("preserves existing follow-up links during a GUI edit", () => {
    const path = "전공면접대비/전자기학/문제은행.md";
    const content = appendManagedQuestion(createSubjectBank("전자기학"), {
      ...first,
      followUpLinks: ["[[다른과목/문제은행#^mia-q-next|후속 질문]]"],
    }, "mia-q-one");
    const original = parseQuestionFile(path, content).questions[0];
    expect(original).toBeDefined();
    if (!original) return;
    const updated = replaceCurrentManagedQuestion(
      content,
      original,
      (latest) => parseQuestionFile(path, latest).questions,
      { ...first, answerMarkdown: "새 정답" },
    );
    expect(updated).toContain("> 이어보기: [[다른과목/문제은행#^mia-q-next|후속 질문]]");
  });

  it("deletes exactly one ID while keeping neighboring questions", () => {
    const path = "전공면접대비/전자기학/문제은행.md";
    const content = appendManagedQuestion(
      appendManagedQuestion(createSubjectBank("전자기학"), first, "mia-q-one"),
      { ...first, questionMarkdown: "쿨롱 법칙은?" },
      "mia-q-two",
    );
    const original = parseQuestionFile(path, content).questions[0];
    expect(original).toBeDefined();
    if (!original) return;
    const updated = deleteCurrentManagedQuestion(
      content,
      original,
      (latest) => parseQuestionFile(path, latest).questions,
    );
    const parsed = parseQuestionFile(path, updated).questions;
    expect(parsed.map((question) => question.id)).toEqual(["mia-q-two"]);
    expect(parsed[0]?.questionMarkdown).toBe("쿨롱 법칙은?");
    expect(updated).not.toContain("가우스 법칙이란 무엇인가?");
  });

  it("keeps an empty subject bank valid after deleting its last question", () => {
    const path = "전공면접대비/전자기학/문제은행.md";
    const content = appendManagedQuestion(createSubjectBank("전자기학"), first, "mia-q-one");
    const original = parseQuestionFile(path, content).questions[0];
    expect(original).toBeDefined();
    if (!original) return;
    const updated = deleteCurrentManagedQuestion(
      content,
      original,
      (latest) => parseQuestionFile(path, latest).questions,
    );
    expect(updated).toBe("# 전자기학 문제은행\n");
    expect(parseQuestionFile(path, updated).questions).toEqual([]);
  });

  it("validates subject folder names", () => {
    expect(validateSubjectName(" 전자기학 ")).toBe("전자기학");
    expect(() => validateSubjectName("회로/이론")).toThrow();
    expect(() => validateSubjectName("..")).toThrow();
  });

  it("renames only the generated subject-bank title", () => {
    expect(renameSubjectBank("# 회로 문제은행\n\n본문\n", "회로", "전자회로"))
      .toBe("# 전자회로 문제은행\n\n본문\n");
    expect(renameSubjectBank("# 사용자 제목\n", "회로", "전자회로")).toBe("# 사용자 제목\n");
  });
});
