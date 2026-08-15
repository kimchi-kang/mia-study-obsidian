import { describe, expect, it } from "vitest";
import { createKeywordNote, readKeywordMeaning, updateKeywordMeaning, validateKeywordName } from "../src/core/keyword-note";

describe("keyword meaning notes", () => {
  it("creates, reads, and updates only the meaning section", () => {
    const created = createKeywordNote("레시피 원칙", "폐곡면의 선속과 재료를 연결한다.");
    expect(readKeywordMeaning(created)).toBe("폐곡면의 선속과 재료를 연결한다.");
    const withConnection = `${created}\n- [[문제은행]]\n`;
    const updated = updateKeywordMeaning(withConnection, "레시피 원칙", "수정된 의미");
    expect(readKeywordMeaning(updated)).toBe("수정된 의미");
    expect(updated).toContain("- [[문제은행]]");
  });

  it("rejects names that could escape the managed keyword folder", () => {
    expect(validateKeywordName(" 레시피 원칙 ")).toBe("레시피 원칙");
    expect(() => validateKeywordName("../밖")).toThrow();
    expect(() => validateKeywordName("폴더/키워드")).toThrow();
  });
});
