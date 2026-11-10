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
    expect(keywordReferencesFromInput("[[개념/전속#정의|전기 선속]]", "MIA/키워드")).toEqual([{
      target: "개념/전속#정의",
      label: "전기 선속",
      raw: "[[개념/전속#정의|전기 선속]]",
    }]);
  });

  it.each(["f[x]", "C]D", "x#y", "x|y", "x^y"])("rejects wiki-link special characters in a plain keyword: %s", (name) => {
    expect(() => keywordReferencesFromInput(name, "MIA/키워드")).toThrow(/키워드 이름에 링크 특수문자/);
  });

  it.each(["[[ |별칭]], 정상", "[[   ]]", "[[|별칭]]", "[[]]"])("rejects a keyword wiki link with an empty target: %s", (value) => {
    expect(() => keywordReferencesFromInput(value, "MIA/키워드")).toThrow(/키워드 링크의 대상.*입력/);
  });

  it("creates legacy root-link meanings in the configured folder", () => {
    expect(keywordNotePath("가우스 법칙", "가우스 법칙", "MIA/키워드"))
      .toBe("MIA/키워드/가우스 법칙.md");
    expect(keywordNotePath("개념/가우스 법칙", "가우스", "MIA/키워드"))
      .toBe("개념/가우스 법칙.md");
  });

  it("keeps commas inside wiki links when re-reading pre-filled keyword fields", () => {
    const existing = [
      { target: "MIA/키워드/RC, RL 회로", label: "RC, RL 회로", raw: "[[MIA/키워드/RC, RL 회로|RC, RL 회로]]" },
      { target: "MIA/키워드/옴의 법칙", label: "옴의 법칙", raw: "[[MIA/키워드/옴의 법칙|옴의 법칙]]" },
    ];
    // The editors pre-fill the field this way and parse it again on save.
    expect(keywordReferencesFromInput(existing.map(item => item.raw).join(", "), "MIA/키워드")).toEqual(existing);
    expect(keywordReferencesFromInput("가우스 법칙, [[개념/전속|전기, 선속]], 대칭성", "MIA/키워드").map(item => item.label))
      .toEqual(["가우스 법칙", "전기, 선속", "대칭성"]);
  });

  it("saves an aliased keyword's meaning at the note its link target resolves to", () => {
    expect(keywordNotePath("가우스 법칙", "가우스", "MIA/키워드")).toBe("MIA/키워드/가우스 법칙.md");
    expect(keywordNotePath("가우스 법칙#정의", "가우스", "MIA/키워드")).toBe("MIA/키워드/가우스 법칙.md");
  });

  it("rejects traversal and Obsidian configuration paths", () => {
    expect(() => keywordNotePath("../밖", "밖", "MIA/키워드")).toThrow();
    expect(() => keywordNotePath(".obsidian/plugins/침범", "침범", "MIA/키워드")).toThrow();
  });
});
