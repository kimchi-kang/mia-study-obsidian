import { describe, expect, it } from "vitest";
import {
  keywordReferenceMatches,
  removeKeywordReferences,
  renameKeywordReferences,
} from "../src/core/keyword-reference";

const original = {
  target: "전공면접대비/MIA/키워드/레시피 원칙",
  label: "레시피",
  raw: "[[전공면접대비/MIA/키워드/레시피 원칙|레시피]]",
};

describe("keyword references", () => {
  it("matches normalized markdown targets", () => {
    expect(keywordReferenceMatches(original, ["전공면접대비\\MIA\\키워드\\레시피 원칙.md"])).toBe(true);
  });

  it("renames the target and visible label together", () => {
    expect(renameKeywordReferences([original], [original.target], "전공면접대비/MIA/키워드/인구 분석", "인구 분석"))
      .toEqual([{ target: "전공면접대비/MIA/키워드/인구 분석", label: "인구 분석", raw: "[[전공면접대비/MIA/키워드/인구 분석|인구 분석]]" }]);
  });

  it("removes only the selected reference", () => {
    const other = { target: "대칭성", label: "대칭성", raw: "[[대칭성]]" };
    expect(removeKeywordReferences([original, other], [original.target])).toEqual([other]);
  });
});
