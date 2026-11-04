import { fencedCodeLines, hasHeadingAtOrAbove } from "./markdown-structure";
import { validateNoteName } from "./note-name";

export function validateKeywordMeaning(value: string): string {
  const meaning = value.trim();
  const lines = meaning.replaceAll("\r\n", "\n").split("\n");
  if (fencedCodeLines([...lines, ""]).at(-1)) {
    throw new Error("키워드 의미의 코드 블록을 닫아 주세요. 연결 구역을 보존하기 위해 저장하지 않았습니다.");
  }
  if (hasHeadingAtOrAbove(meaning, 2)) {
    throw new Error("키워드 의미에서는 ### 이하의 제목만 사용할 수 있습니다. #~## 제목은 관리 구역을 분리합니다.");
  }
  return meaning;
}

export function createKeywordNote(name: string, meaning: string): string {
  return `# ${name}\n\n## 의미\n\n${validateKeywordMeaning(meaning)}\n\n## 연결\n`;
}

export function validateKeywordName(value: string): string {
  return validateNoteName(value, "키워드");
}

function meaningSection(lines: readonly string[]): { start: number; end: number } | null {
  const code = fencedCodeLines(lines);
  const start = lines.findIndex((line, index) => !code[index] && /^ {0,3}##\s+의미\s*$/.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (!code[index] && /^ {0,3}#{1,2}\s+/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return { start, end };
}

export function readKeywordMeaning(content: string): string {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const section = meaningSection(lines);
  return section ? lines.slice(section.start + 1, section.end).join("\n").trim() : "";
}

export function updateKeywordMeaning(content: string, name: string, meaning: string): string {
  const safeMeaning = validateKeywordMeaning(meaning);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const section = meaningSection(lines);
  if (!section) {
    const base = content.replaceAll("\r\n", "\n").trimEnd();
    return `${base}${base ? "\n\n" : `# ${name}\n\n`}## 의미\n\n${safeMeaning}\n`.replaceAll("\n", newline);
  }
  lines.splice(section.start + 1, section.end - section.start - 1, "", safeMeaning, "");
  return lines.join(newline);
}

/** Automatic merging can discard unrecognized source sections when trashing the source. */
export function assertMergeableKeywordNote(content: string): void {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const title = lines.findIndex(line => line.trim());
  if (title >= 0 && /^#\s+/.test(lines[title] ?? "")) lines[title] = "";
  const section = meaningSection(lines);
  if (section) lines.splice(section.start, section.end - section.start);
  if (lines.some(line => line.trim() && !/^##\s+연결\s*$/.test(line.trim()))) {
    throw new Error("기존 키워드에 추가 사용자 내용이 있어 자동 병합을 중단했습니다. 원문을 보존한 뒤 수동으로 병합하세요.");
  }
}
