import { describe, expect, it } from "vitest";
import {
  keywordReferenceMatches,
  removeKeywordReferences,
  renameKeywordReferences,
} from "../src/core/keyword-reference";

const original = {
  target: "전공면접대비/MIA/키워드/가우스 법칙",
  label: "가우스",
  raw: "[[전공면접대비/MIA/키워드/가우스 법칙|가우스]]",
};

describe("keyword references", () => {
  it("matches normalized markdown targets", () => {
    expect(keywordReferenceMatches(original, ["전공면접대비\\MIA\\키워드\\가우스 법칙.md"])).toBe(true);
  });

  it("renames the target and visible label together", () => {
    expect(renameKeywordReferences([original], [original.target], "전공면접대비/MIA/키워드/전기 선속", "전기 선속"))
      .toEqual([{ target: "전공면접대비/MIA/키워드/전기 선속", label: "전기 선속", raw: "[[전공면접대비/MIA/키워드/전기 선속|전기 선속]]" }]);
  });

  it("removes only the selected reference", () => {
    const other = { target: "대칭성", label: "대칭성", raw: "[[대칭성]]" };
    expect(removeKeywordReferences([original, other], [original.target])).toEqual([other]);
  });
});
