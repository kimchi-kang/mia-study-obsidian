import { describe, expect, it } from "vitest";
import { renderSubjectNote } from "../src/core/subject-note";

const display = String.raw`$$
\begin{aligned}
F &= q(E + v \times B) \\
\nabla \cdot D &= \rho
\end{aligned}
$$`;

describe("subject note math preservation", () => {
  it("keeps display math delimiters on separate lines in answers", () => {
    const note = renderSubjectNote("Physics", [{ questionMarkdown: "Explain the field.", answerMarkdown: display }]);
    expect(note).toContain(`대답:\n\n${display}`);
    expect(note).not.toContain("대답: $$");
  });
  it("keeps display math in questions as well as answers", () => {
    const note = renderSubjectNote("Physics", [{ questionMarkdown: display, answerMarkdown: "The equations above." }]);
    expect(note).toContain(`질문:\n\n${display}\n대답: The equations above.`);
  });
  it("preserves prose and multiple display equations in one answer", () => {
    const value = `First equation:\n\n$$a=b$$\n\nSecond equation:\n\n${display}`;
    expect(renderSubjectNote("Physics", [{ questionMarkdown: "Explain.", answerMarkdown: value }])).toContain(value);
  });
  it("preserves newline-sensitive TeX comments", () => {
    const value = "$$\na % this comment must end here\n+ b\n$$";
    expect(renderSubjectNote("Physics", [{ questionMarkdown: "Sum?", answerMarkdown: value }])).toContain(value);
  });
  it("keeps compact ordinary answers and inline math", () => {
    const note = renderSubjectNote("Physics", [{ questionMarkdown: "Inline?", answerMarkdown: "$x+y$\nremains inline." }]);
    expect(note).toContain("대답: $x+y$ remains inline.");
  });
  it("does not reinterpret escaped unit brackets as equations", () => {
    const note = renderSubjectNote("Physics", [{ questionMarkdown: "Unit?", answerMarkdown: String.raw`1.6 × 10⁻¹⁹ \[C\]` }]);
    expect(note).toContain(String.raw`대답: 1.6 × 10⁻¹⁹ \[C\]`);
  });
});
