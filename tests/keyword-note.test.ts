import { describe, expect, it } from "vitest";
import {
  createKeywordNote,
  readKeywordMeaning,
  updateKeywordMeaning,
  validateKeywordMeaning,
  validateKeywordName,
} from "../src/core/keyword-note";

describe("keyword meaning notes", () => {
  it("creates, reads, and updates only the meaning section", () => {
    const created = createKeywordNote("가우스 법칙", "폐곡면의 선속과 전하를 연결한다.");
    expect(readKeywordMeaning(created)).toBe("폐곡면의 선속과 전하를 연결한다.");
    const withConnection = `${created}\n- [[문제은행]]\n`;
    const updated = updateKeywordMeaning(withConnection, "가우스 법칙", "수정된 의미");
    expect(readKeywordMeaning(updated)).toBe("수정된 의미");
    expect(updated).toContain("- [[문제은행]]");
  });

  it("rejects names that could escape the managed keyword folder", () => {
    expect(validateKeywordName(" 가우스 법칙 ")).toBe("가우스 법칙");
    expect(() => validateKeywordName("../밖")).toThrow();
    expect(() => validateKeywordName("폴더/키워드")).toThrow();
  });

  it("rejects headings that could split the managed meaning section", () => {
    expect(() => validateKeywordMeaning("설명\n\n## 연결\n주입")).toThrow();
    expect(validateKeywordMeaning("설명\n\n### 세부 내용")).toBe("설명\n\n### 세부 내용");
    expect(validateKeywordMeaning("```markdown\n## 코드 예시\n```")).toContain("## 코드 예시");
  });
});

describe("keyword Markdown section boundaries",()=>{
  const meaning="설명\n\n```markdown\n## 코드 안의 제목\n## 의미\n예시 본문\n```\n\n마지막 의미 문단";
  it("round-trips valid fenced headings without truncating the stored meaning",()=>{
    expect(readKeywordMeaning(createKeywordNote("검증",meaning))).toBe(meaning);
  });
  it("replaces the entire old meaning without leaving code fragments or touching connections",()=>{
    const note=createKeywordNote("검증",meaning)+"\n- [[보존할 연결]]\n";
    const updated=updateKeywordMeaning(note,"검증","새 의미");
    expect(updated).not.toContain("코드 안의 제목");expect(updated).not.toContain("예시 본문");
    expect(updated).toContain("- [[보존할 연결]]");expect(readKeywordMeaning(updated)).toBe("새 의미");
  });
  it("does not mistake an indented code example for the next managed section",()=>{
    const text="설명\n\n    ## 코드 제목\n\n마지막 문단";
    expect(readKeywordMeaning(createKeywordNote("검증",text))).toBe(text);
  });
  it("rejects a real Markdown section with up to three leading spaces",()=>{
    expect(()=>validateKeywordMeaning("설명\n\n  ## 연결\n다른 구역")).toThrow();
  });
});

it.each(["```markdown\n## 코드", "~~~\n코드"])("rejects an unclosed fence instead of absorbing the following connection section: %s",text=>{
  expect(()=>createKeywordNote("검증",text)).toThrow(/코드 블록/);
});
