import { hasHeadingAtOrAbove } from "./markdown-structure";
import { validateNoteName } from "./note-name";

export function validateKeywordMeaning(value: string): string {
  const meaning = value.trim();
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

export function readKeywordMeaning(content: string): string {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+의미\s*$/.test(line.trim()));
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s+/.test(lines[index]?.trim() ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

export function updateKeywordMeaning(content: string, name: string, meaning: string): string {
  const safeMeaning = validateKeywordMeaning(meaning);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+의미\s*$/.test(line.trim()));
  if (start < 0) {
    const base = content.replaceAll("\r\n", "\n").trimEnd();
    return `${base}${base ? "\n\n" : `# ${name}\n\n`}## 의미\n\n${safeMeaning}\n`.replaceAll("\n", newline);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s+/.test(lines[index]?.trim() ?? "")) {
      end = index;
      break;
    }
  }
  lines.splice(start + 1, end - start - 1, "", safeMeaning, "");
  return lines.join(newline);
}

/** Automatic merging can discard unrecognized source sections when trashing the source. */
export function assertMergeableKeywordNote(content: string): void {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const title = lines.findIndex(line => line.trim());
  if (title >= 0 && /^#\s+/.test(lines[title] ?? "")) lines[title] = "";
  const start = lines.findIndex(line => /^##\s+의미\s*$/.test(line.trim()));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^#{1,2}\s+/.test(lines[end]?.trim() ?? "")) end += 1;
    lines.splice(start, end - start);
  }
  if (lines.some(line => line.trim() && !/^##\s+연결\s*$/.test(line.trim()))) {
    throw new Error("기존 키워드에 추가 사용자 내용이 있어 자동 병합을 중단했습니다. 원문을 보존한 뒤 수동으로 병합하세요.");
  }
}
