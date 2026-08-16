import { KeywordReference } from "./models";
import { assertSingleLine } from "./markdown-structure";

function normalizeFolder(folder: string): string {
  return folder.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").trim();
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^\/+/, "");
}

export function keywordReferencesFromInput(value: string, keywordFolder = ""): KeywordReference[] {
  const folder = normalizeFolder(keywordFolder);
  return value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    assertSingleLine(item, "키워드");
    const match = item.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
    if (match) {
      const target = match[1]?.trim() || item;
      const label = match[2]?.trim() || target.split("#").at(-1) || target;
      return { target, label, raw: item };
    }
    const target = folder ? `${folder}/${item}` : item;
    return { target, label: item, raw: folder ? `[[${target}|${item}]]` : `[[${item}]]` };
  });
}

export function keywordNotePath(target: string, label: string, keywordFolder: string): string {
  assertSingleLine(target, "키워드 경로");
  assertSingleLine(label, "키워드 이름");
  const targetPath = target.split("#")[0]?.trim() || label.trim();
  const explicitPath = targetPath.includes("/") || targetPath.includes("\\") || targetPath.endsWith(".md");
  const folder = normalizeFolder(keywordFolder);
  const base = explicitPath || !folder ? targetPath : `${folder}/${label.trim()}`;
  const markdownPath = base.endsWith(".md") ? base : `${base}.md`;
  const path = normalizePath(markdownPath);
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || segments[0]?.toLocaleLowerCase("en") === ".obsidian") {
    throw new Error("키워드 노트 경로는 보관함 내부의 일반 폴더여야 합니다.");
  }
  return path;
}
