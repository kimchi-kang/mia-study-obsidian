import { Platform, TFile } from "obsidian";
import type { App } from "obsidian";
import type { ExportImage } from "../core/subject-export";
import { downloadsDirectory, openExportFile, revealExportFile, writeExportFile, type ExportReceipt } from "./export-file";
import type { MiaHost } from "./mia-host";
import { ensureFolder } from "./vault-files";

/** Writes a subject's questions and answers to a .docx: Downloads on desktop, a vault folder on mobile. */
export async function exportSubjectWord(host: MiaHost, subject: string): Promise<ExportReceipt> {
  const { app, index } = host;
  await index.rebuild();
  const { exportSubjectDocx } = await import("../core/subject-export");
  const result = await exportSubjectDocx(subject, index.registered, (target, source) => readExportImage(app, target, source));
  const safeSubject = subject.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, "_");
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const filename = `${safeSubject} 질문 답변 ${stamp}.docx`;
  if (Platform.isDesktopApp) {
    const path = await writeExportFile(downloadsDirectory(), filename, result.data);
    return { path, count: result.count, warnings: result.warnings,
      openFile: () => openExportFile(path), revealFile: () => revealExportFile(path) };
  }
  const folder = "MIA 출력";
  await ensureFolder(app, folder);
  const stem = `${folder}/${filename.slice(0, -5)}`;
  let path = `${stem}.docx`;
  for (let suffix = 2; app.vault.getAbstractFileByPath(path); suffix++) path = `${stem} ${suffix}.docx`;
  await app.vault.createBinary(path, result.data);
  return { path, count: result.count, warnings: result.warnings };
}

export async function readExportImage(app: App, target: string, source: string): Promise<ExportImage | null> {
  // Resolve vault attachments only; exporting never fetches remote resources.
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//")) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { return null; }
  const file = app.metadataCache.getFirstLinkpathDest(decoded, source);
  if (!(file instanceof TFile)) return null;
  const extension = file.extension.toLowerCase();
  if (extension !== "png" && extension !== "jpg" && extension !== "jpeg" && extension !== "gif" && extension !== "bmp") return null;
  const data = await app.vault.readBinary(file);
  // Image decoders sniff bytes; the document media type must match those bytes too.
  const header = new Uint8Array(data, 0, Math.min(data.byteLength, 8));
  const startsWith = (signature: readonly number[]): boolean => signature.every((byte, index) => header[index] === byte);
  const type: ExportImage["type"] | null = startsWith([137, 80, 78, 71, 13, 10, 26, 10]) ? "png"
    : startsWith([255, 216, 255]) ? "jpg"
    : startsWith([71, 73, 70, 56, 55, 97]) || startsWith([71, 73, 70, 56, 57, 97]) ? "gif"
    : startsWith([66, 77]) ? "bmp" : null;
  if (!type) throw new Error(`지원하지 않는 이미지 형식입니다: ${file.path}`);
  const blob = new Blob([data]);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error(`이미지를 읽을 수 없습니다: ${file.path}`)); image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error(`이미지 크기를 읽을 수 없습니다: ${file.path}`);
    return { data, type, width: image.naturalWidth, height: image.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}
