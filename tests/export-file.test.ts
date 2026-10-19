import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeExportFile } from "../src/services/export-file";

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "mia-export-save-")); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("desktop export file storage", () => {
  it("writes into the selected system folder and never replaces an existing file, including concurrent exports", async () => {
    const folder = await directory();
    await writeFile(join(folder, "수학.docx"), "existing file");
    const data = new TextEncoder().encode("new Word data").buffer;
    const paths = await Promise.all([writeExportFile(folder, "수학.docx", data), writeExportFile(folder, "수학.docx", data)]);
    expect(new Set(paths)).toEqual(new Set([join(folder, "수학 2.docx"), join(folder, "수학 3.docx")]));
    expect(await readFile(join(folder, "수학.docx"), "utf8")).toBe("existing file");
    for (const path of paths) expect(await readFile(path, "utf8")).toBe("new Word data");
  });
  it("reports storage failure and rejects paths outside the chosen folder", async () => {
    const folder = await directory();
    const data = new ArrayBuffer(0);
    await expect(writeExportFile(join(folder, "missing"), "수학.docx", data)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(writeExportFile(folder, "../escape.docx", data)).rejects.toThrow("잘못된 출력 파일 이름");
  });
});
