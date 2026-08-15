export function createKeywordNote(name: string, meaning: string): string {
  return `# ${name}\n\n## 의미\n\n${meaning.trim()}\n\n## 연결\n`;
}

export function validateKeywordName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("키워드 이름을 입력하세요.");
  if (name === "." || name === ".." || /[\\/:*?"<>|#\[\]^]/u.test(name)) {
    throw new Error("키워드 이름에 경로 또는 링크 특수문자를 사용할 수 없습니다.");
  }
  return name;
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
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+의미\s*$/.test(line.trim()));
  if (start < 0) {
    const base = content.replaceAll("\r\n", "\n").trimEnd();
    return `${base}${base ? "\n\n" : `# ${name}\n\n`}## 의미\n\n${meaning.trim()}\n`.replaceAll("\n", newline);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s+/.test(lines[index]?.trim() ?? "")) {
      end = index;
      break;
    }
  }
  lines.splice(start + 1, end - start - 1, "", meaning.trim(), "");
  return lines.join(newline);
}
