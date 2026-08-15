import { describe, expect, it } from "vitest";
import { isManagedSubjectNote, renderSubjectNote, subjectNoteFileName } from "../src/core/subject-note";

describe("generated subject notes", () => {
  it("renders each question and answer as one compact line", () => {
    const content = renderSubjectNote("전자기학", [{
      questionMarkdown: "가우스 법칙은?\n\n수식으로 설명하라.",
      answerMarkdown: "$\\nabla \\cdot \\mathbf D = \\rho_v$\n입니다.",
    }, {
      questionMarkdown: "쿨롱 법칙은?",
      answerMarkdown: "두 전하 사이의 힘이다.",
    }]);
    expect(content).toContain("질문: 가우스 법칙은? 수식으로 설명하라.");
    expect(content).toContain("대답: $\\nabla \\cdot \\mathbf D = \\rho_v$ 입니다.");
    expect(content.match(/^질문:/gm)).toHaveLength(2);
    expect(content.match(/^대답:/gm)).toHaveLength(2);
    expect(isManagedSubjectNote(content)).toBe(true);
  });

  it("uses the requested subject note filename", () => {
    expect(subjectNoteFileName("전자기학")).toBe("전자기학 노트.md");
    expect(isManagedSubjectNote("# 사용자가 만든 노트")).toBe(false);
  });
});
