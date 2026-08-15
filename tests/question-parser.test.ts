import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseQuestionFile, QuestionParserInternals } from "../src/core/question-parser";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures/vault/전자기학/04 정전기학/가우스 법칙.md");

describe("parseQuestionFile", () => {
  it("parses registered and candidate questions without splitting secondary solution headings", () => {
    const content = readFileSync(fixturePath, "utf8");
    const parsed = parseQuestionFile("전자기학/04 정전기학/가우스 법칙.md", content);

    expect(parsed.questions).toHaveLength(2);
    const first = parsed.questions[0];
    expect(first?.id).toBe("mia-q-gauss-line");
    expect(first?.subject).toBe("전자기학");
    expect(first?.deck).toBe("가우스 법칙");
    expect(first?.questionType).toBe("계산형");
    expect(first?.questionMarkdown).toContain("gaussian-cylinder.png");
    expect(first?.questionMarkdown).not.toContain("학습 정보");
    expect(first?.answerMarkdown).toContain("풀이 2: 결과");
    expect(first?.coreKeywords.map((item) => item.label)).toEqual(["가우스 법칙", "전속밀도"]);
    expect(first?.followUpIds).toEqual(["mia-q-coulomb"]);

    expect(parsed.questions[1]?.id).toBeNull();
    expect(parsed.diagnostics).toEqual([]);
  });

  it("reports a missing answer without dropping the question", () => {
    const parsed = parseQuestionFile("전자기학/미완성.md", "### 질문\n\n> [!question] 문제\n> 답이 아직 없다.");
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.diagnostics[0]?.code).toBe("missing-answer");
  });

  it("reports invalid learning metadata instead of silently accepting it", () => {
    const parsed = parseQuestionFile("전자기학/오류.md", `### 질문

> [!question] 문제
> 설명하시오.

^mia-q-invalid

> [!mia]- 학습 정보
> 유형: 암산형
> 이어보기: [[일반 노트]]

#### 풀이

정답`);
    expect(parsed.questions[0]?.questionType).toBe("정의형");
    expect(parsed.diagnostics.filter((item) => item.code === "invalid-metadata")).toHaveLength(2);
  });
});

describe("metadata parsing", () => {
  it("keeps plain keywords as a supported fallback", () => {
    expect(QuestionParserInternals.parseKeywordReferences("가우스 법칙, 전속 밀도")).toEqual([
      { target: "가우스 법칙", label: "가우스 법칙", raw: "가우스 법칙" },
      { target: "전속 밀도", label: "전속 밀도", raw: "전속 밀도" },
    ]);
  });
});
