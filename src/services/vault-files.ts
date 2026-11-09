import { TFile, TFolder, normalizePath } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import { assertPortablePathSegment, portableNameKey } from "../core/note-name";

/** Rejects names that would collide on case- or normalization-insensitive file systems. */
export function assertPortablePath(app: App, path: string): void {
  const parts = normalizePath(path).split("/");
  let parent: TFolder | undefined = app.vault.getRoot();
  for (const part of parts) {
    assertPortablePathSegment(part, "저장 경로");
    const matches: TAbstractFile[] = parent?.children.filter((child) => portableNameKey(child.name) === portableNameKey(part)) ?? [];
    if (matches.some((child) => child.name !== part)) {
      throw new Error("대소문자나 한글 표기만 다른 이름이 이미 있습니다. 기존 이름의 표기를 사용하세요.");
    }
    const child = matches[0];
    parent = child instanceof TFolder ? child : undefined;
  }
}

export async function ensureFolder(app: App, path: string): Promise<void> {
  const normalized = normalizePath(path);
  assertPortablePath(app, normalized);
  const parts = normalized.split("/").filter(Boolean);
  for (let index = 1; index <= parts.length; index += 1) {
    const current = parts.slice(0, index).join("/");
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFile) throw new Error(`${current} 파일 때문에 폴더를 만들 수 없습니다.`);
    if (!existing) await app.vault.createFolder(current);
  }
}

/** Moves to Obsidian's trash and confirms the entry is actually gone. */
export async function trashFileVerified(app: App, file: TFile | TFolder): Promise<void> {
  const path = file.path;
  try {
    await app.fileManager.trashFile(file);
  } catch (error) {
    if (app.vault.getAbstractFileByPath(path)) throw error;
    // A rejected trash operation can already have moved the entry successfully.
  }
  if (app.vault.getAbstractFileByPath(path)) throw new Error(`${path}: 휴지통 이동을 확인하지 못했습니다.`);
}
