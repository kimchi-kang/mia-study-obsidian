import { describe, expect, it } from "vitest";
import { keywordNotePath, keywordReferencesFromInput } from "../src/core/keyword-path";

describe("keyword paths", () => {
  it("places plain keywords in the configured folder and keeps their display label", () => {
    expect(keywordReferencesFromInput("레시피 원칙", "MIA/키워드")).toEqual([{
      target: "MIA/키워드/레시피 원칙",
      label: "레시피 원칙",
      raw: "[[MIA/키워드/레시피 원칙|레시피 원칙]]",
    }]);
  });

  it("preserves explicit wiki-link targets", () => {
    expect(keywordReferencesFromInput("[[개념/물량|인구 분석]]", "MIA/키워드")[0]).toEqual({
      target: "개념/물량",
      label: "인구 분석",
      raw: "[[개념/물량|인구 분석]]",
    });
  });

  it("creates legacy root-link meanings in the configured folder", () => {
    expect(keywordNotePath("레시피 원칙", "레시피 원칙", "MIA/키워드"))
      .toBe("MIA/키워드/레시피 원칙.md");
    expect(keywordNotePath("개념/레시피 원칙", "레시피", "MIA/키워드"))
      .toBe("개념/레시피 원칙.md");
  });

  it("keeps commas inside wiki links when re-reading pre-filled keyword fields", () => {
    const existing = [
      { target: "MIA/키워드/시차, 환율 계산", label: "시차, 환율 계산", raw: "[[MIA/키워드/시차, 환율 계산|시차, 환율 계산]]" },
      { target: "MIA/키워드/비율의 원칙", label: "비율의 원칙", raw: "[[MIA/키워드/비율의 원칙|비율의 원칙]]" },
    ];
    // The editors pre-fill the field this way and parse it again on save.
    expect(keywordReferencesFromInput(existing.map(item => item.raw).join(", "), "MIA/키워드")).toEqual(existing);
    expect(keywordReferencesFromInput("레시피 원칙, [[개념/물량|전기, 선속]], 대칭성", "MIA/키워드").map(item => item.label))
      .toEqual(["레시피 원칙", "전기, 선속", "대칭성"]);
  });

  it("saves an aliased keyword's meaning at the note its link target resolves to", () => {
    expect(keywordNotePath("레시피 원칙", "레시피", "MIA/키워드")).toBe("MIA/키워드/레시피 원칙.md");
    expect(keywordNotePath("레시피 원칙#정의", "레시피", "MIA/키워드")).toBe("MIA/키워드/레시피 원칙.md");
  });

  it("rejects traversal and Obsidian configuration paths", () => {
    expect(() => keywordNotePath("../밖", "밖", "MIA/키워드")).toThrow();
    expect(() => keywordNotePath(".obsidian/plugins/침범", "침범", "MIA/키워드")).toThrow();
  });
});
