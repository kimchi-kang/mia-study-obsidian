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

  it("rejects traversal and Obsidian configuration paths", () => {
    expect(() => keywordNotePath("../밖", "밖", "MIA/키워드")).toThrow();
    expect(() => keywordNotePath(".obsidian/plugins/침범", "침범", "MIA/키워드")).toThrow();
  });
});
