// Desktop APIs are loaded only when used, so the mobile plugin can still load.
interface DesktopExportApi {
  remote: { app: { getPath(name: "downloads"): string } };
  shell: { openPath(path: string): Promise<string>; showItemInFolder(path: string): void };
}
function desktopApi(): DesktopExportApi { return require("electron"); }

export async function writeExportFile(directory: string, filename: string, data: ArrayBuffer): Promise<string> {
  const { writeFile }: typeof import("node:fs/promises") = require("node:fs/promises");
  const { join, basename }: typeof import("node:path") = require("node:path");
  if (basename(filename) !== filename || !filename.endsWith(".docx")) throw new Error("잘못된 출력 파일 이름입니다.");
  const stem = filename.slice(0, -5);
  for (let suffix = 1; ; suffix++) {
    const path = join(directory, `${stem}${suffix === 1 ? "" : ` ${suffix}`}.docx`);
    try { await writeFile(path, new Uint8Array(data), { flag: "wx" }); return path; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
}

export function downloadsDirectory(): string { return desktopApi().remote.app.getPath("downloads"); }
export async function openExportFile(path: string): Promise<void> {
  const error = await desktopApi().shell.openPath(path);
  if (error) throw new Error(error);
}
export function revealExportFile(path: string): void { desktopApi().shell.showItemInFolder(path); }
