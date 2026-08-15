import { describe, expect, it } from "vitest";
import { keywordNotePath, keywordReferencesFromInput } from "../src/core/keyword-path";

describe("keyword paths", () => {
  it("places plain keywords in the configured folder and keeps their display label", () => {
    expect(keywordReferencesFromInput("가우스 법칙", "MIA/키워드")).toEqual([{
      target: "MIA/키워드/가우스 법칙",
      label: "가우스 법칙",
      raw: "[[MIA/키워드/가우스 법칙|가우스 법칙]]",
    }]);
  });

  it("preserves explicit wiki-link targets", () => {
    expect(keywordReferencesFromInput("[[개념/전속|전기 선속]]", "MIA/키워드")[0]).toEqual({
      target: "개념/전속",
      label: "전기 선속",
      raw: "[[개념/전속|전기 선속]]",
    });
  });

  it("creates legacy root-link meanings in the configured folder", () => {
    expect(keywordNotePath("가우스 법칙", "가우스 법칙", "MIA/키워드"))
      .toBe("MIA/키워드/가우스 법칙.md");
    expect(keywordNotePath("개념/가우스 법칙", "가우스", "MIA/키워드"))
      .toBe("개념/가우스 법칙.md");
  });

  it("rejects traversal and Obsidian configuration paths", () => {
    expect(() => keywordNotePath("../밖", "밖", "MIA/키워드")).toThrow();
    expect(() => keywordNotePath(".obsidian/plugins/침범", "침범", "MIA/키워드")).toThrow();
  });
});
