import { fencedCodeLines } from "./markdown-structure";

/** Recognize generated standalone source links, not prose mentioning a source. */
export function isSourceAttributionLine(line: string): boolean {
  // Markdown renders escaped chapter brackets like literal ones. Normalize only
  // this comparison so the saved Markdown and unrelated answer text stay intact.
  const sourceLine = line.replace(/&(?:lt|#0*60|#x0*3c);/giu, "<").replace(/&(?:gt|#0*62|#x0*3e);/giu, ">");
  return /^\s*(?:\*\*)?원문(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(?:\[\[[^\n]+\]\]|\[[^\]]+\]\([^)]+\))(?:\s*(?:[·•|—–-]\s*)?[<〈《][^\n<>〈〉《》]+[>〉》])?\s*$/u.test(sourceLine);
}

/** Presentation only: retain the stored answer and source note for editing. */
export function withoutSourceAttribution(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const fenced = fencedCodeLines(lines);
  const hidden = new Set<number>();
  lines.forEach((line, index) => {
    if (fenced[index] || !isSourceAttributionLine(line)) return;
    hidden.add(index);
    // Remove only separators touching the generated attribution block.
    for (const direction of [-1, 1]) {
      let adjacent = index + direction;
      while (adjacent >= 0 && adjacent < lines.length && !lines[adjacent]?.trim()) adjacent += direction;
      if (!fenced[adjacent] && /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(lines[adjacent] ?? "")) hidden.add(adjacent);
    }
  });
  return lines.filter((_, index) => !hidden.has(index)).join("\n").trim();
}
