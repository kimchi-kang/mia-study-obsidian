import { describe, expect, it } from "vitest";
import { withoutSourceAttribution } from "../src/core/source-attribution";

describe("study answer source attribution", () => {
  it.each(["원문: [[과목/원본]]", "**원문:** [[과목/원본|링크]]", "원문： [원본](source.md)"])("hides standalone source link %s", line => {
    expect(withoutSourceAttribution(`답안입니다.\n\n${line}`)).toBe("답안입니다.");
  });
  it("removes the source footer separators while preserving other answer separators", () => {
    expect(withoutSourceAttribution("첫 부분\n\n---\n\n둘째 부분\n\n---\n\n원문: [[출처]]\n\n***")).toBe("첫 부분\n\n---\n\n둘째 부분");
  });
  it("preserves code, prose, links in the answer, equations and table structure", () => {
    const answer = "설명에서 원문: [[예제]]라는 표현을 쓴다.\n\n```md\n원문: [[코드 예제]]\n```\n\n$$E=mc^2$$\n\n|값|의미|\n|---|---|\n|1|[[참고]]|";
    expect(withoutSourceAttribution(answer)).toBe(answer);
  });
});
