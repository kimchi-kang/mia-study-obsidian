import { describe, expect, it } from "vitest";
import {
  appendManagedQuestion,
  createSubjectBank,
  deleteCurrentManagedQuestion,
  replaceCurrentManagedQuestion,
} from "../src/core/managed-question";
import { parseQuestionFile } from "../src/core/question-parser";
import { renderSubjectNote } from "../src/core/subject-note";

const path = "전공면접대비/전자기학/문제은행.md";
const base = {
  questionMarkdown: "맥스웰 방정식이란?",
  answerMarkdown: "전자기 현상을 기술하는 방정식이다.",
  questionType: "정의형" as const,
  coreKeywords: [{
    target: "전공면접대비/MIA/키워드/맥스웰 방정식",
    label: "맥스웰 방정식",
    raw: "[[전공면접대비/MIA/키워드/맥스웰 방정식|맥스웰 방정식]]",
  }],
  subKeywords: [],
};

describe("managed bank and compact-note synchronization", () => {
  it("projects create, edit, and delete results from the same latest bank", () => {
    let bank = appendManagedQuestion(createSubjectBank("전자기학"), base, "mia-q-one");
    let questions = parseQuestionFile(path, bank, { subject: "전자기학" }).questions;
    expect(renderSubjectNote("전자기학", questions)).toContain("질문: 맥스웰 방정식이란?");

    const original = questions[0];
    expect(original).toBeDefined();
    if (!original) return;
    bank = replaceCurrentManagedQuestion(
      bank,
      original,
      (content) => parseQuestionFile(path, content, { subject: "전자기학" }).questions,
      { ...base, questionMarkdown: "수정된 질문", answerMarkdown: "수정된 대답" },
    );
    questions = parseQuestionFile(path, bank, { subject: "전자기학" }).questions;
    const editedNote = renderSubjectNote("전자기학", questions);
    expect(editedNote).toContain("질문: 수정된 질문");
    expect(editedNote).toContain("대답: 수정된 대답");
    expect(editedNote).not.toContain("맥스웰 방정식이란?");

    const edited = questions[0];
    expect(edited).toBeDefined();
    if (!edited) return;
    bank = deleteCurrentManagedQuestion(
      bank,
      edited,
      (content) => parseQuestionFile(path, content, { subject: "전자기학" }).questions,
    );
    questions = parseQuestionFile(path, bank, { subject: "전자기학" }).questions;
    expect(questions).toEqual([]);
    expect(renderSubjectNote("전자기학", questions)).not.toContain("질문:");
  });
});
