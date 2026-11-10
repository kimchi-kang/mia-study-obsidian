import { KeywordReference } from "./models";
import { assertSingleLine } from "./markdown-structure";
import { assertPortablePathSegment } from "./note-name";

function normalizeFolder(folder: string): string {
  return folder.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").trim();
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^\/+/, "");
}

/** Split on commas between keywords, never inside a `[[target|label]]` link. */
function splitKeywordInput(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith("[[", index)) { depth += 1; index += 1; }
    else if (depth > 0 && value.startsWith("]]", index)) { depth -= 1; index += 1; }
    else if (depth === 0 && value[index] === ",") { items.push(value.slice(start, index)); start = index + 1; }
  }
  items.push(value.slice(start));
  return items;
}

export function keywordReferencesFromInput(value: string, keywordFolder = ""): KeywordReference[] {
  const folder = normalizeFolder(keywordFolder);
  return splitKeywordInput(value).map((item) => item.trim()).filter(Boolean).map((item) => {
    assertSingleLine(item, "키워드");
    const match = item.match(/^\[\[([^\]|]*)(?:\|([^\]]+))?\]\]$/);
    if (match) {
      const target = match[1]?.trim();
      if (!target) throw new Error("키워드 링크의 대상이 비어 있습니다. 연결할 노트 이름이나 경로를 입력하세요.");
      const label = match[2]?.trim() || target.split("#").at(-1) || target;
      return { target, label, raw: item };
    }
    if (/[#\[\]^|]/u.test(item)) {
      throw new Error("키워드 이름에 링크 특수문자([, ], #, |, ^)를 사용할 수 없습니다. 특수문자를 빼고 다시 입력해 주세요.");
    }
    const target = folder ? `${folder}/${item}` : item;
    return { target, label: item, raw: folder ? `[[${target}|${item}]]` : `[[${item}]]` };
  });
}

export function keywordLinkPath(target: string): string {
  return target.split("#")[0]?.trim() ?? "";
}

export function keywordNotePath(target: string, label: string, keywordFolder: string): string {
  assertSingleLine(target, "키워드 경로");
  assertSingleLine(label, "키워드 이름");
  const targetPath = keywordLinkPath(target) || label.trim();
  const explicitPath = targetPath.includes("/") || targetPath.includes("\\") || targetPath.endsWith(".md");
  const folder = normalizeFolder(keywordFolder);
  // Use the link target, not its display label, so `[[가우스 법칙|가우스]]` saves
  // the meaning to the same note the link (and the meaning reader) resolves.
  const base = explicitPath || !folder ? targetPath : `${folder}/${targetPath}`;
  const markdownPath = base.endsWith(".md") ? base : `${base}.md`;
  const path = normalizePath(markdownPath);
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || segments[0]?.toLocaleLowerCase("en") === ".obsidian") {
    throw new Error("키워드 노트 경로는 보관함 내부의 일반 폴더여야 합니다.");
  }
  for (const segment of segments) assertPortablePathSegment(segment, "키워드 노트 경로");
  return path;
}
