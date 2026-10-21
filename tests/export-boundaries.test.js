import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  Plugin: class {}, Modal: class {}, ItemView: class {}, PluginSettingTab: class {},
  MarkdownView: class {}, TFile: class {}, TFolder: class {}, Component: class {},
  Setting: class {}, Notice: class {}, Platform: { isDesktopApp: false }, normalizePath: path => path,
}));
import { TFile } from "obsidian";
import MiaStudyPlugin from "../src/main";
import { QuestionIndex } from "../src/services/question-index";
import { renderManagedQuestion } from "../src/core/managed-question";
const rasterFixture = extension => Uint8Array.from(readFileSync(new URL(`./fixtures/export-small.${extension}`, import.meta.url))).buffer;
function host(file = null) {
  const plugin = new MiaStudyPlugin();
  const vault = { readBinary: vi.fn(async () => rasterFixture("png")) };
  const resolve = vi.fn(() => file);
  plugin.app = { vault, metadataCache: { getFirstLinkpathDest: resolve } };
  return { plugin, vault, resolve };
}
function attachment(extension = "png") {
  return Object.assign(new TFile(), { path: `attachments/그림.${extension}`, extension });
}
function imageBoundary(outcome = "load", width = 640, height = 480) {
  const create = vi.fn(() => "blob:qa-local-image"), revoke = vi.fn();
  const ActualURL = globalThis.URL;
  vi.stubGlobal("URL", class extends ActualURL {
    static createObjectURL = create;
    static revokeObjectURL = revoke;
  });
  const assigned = [];
  vi.stubGlobal("Image", class {
    naturalWidth = width; naturalHeight = height;
    set src(value) { assigned.push(value); queueMicrotask(() => outcome === "load" ? this.onload() : this.onerror()); }
  });
  return { create, revoke, assigned };
}
afterEach(() => { vi.unstubAllGlobals(); });
describe("export attachment trust and cleanup boundaries", () => {
  it.each([
    "https://example.invalid/private.png", "HTTP://example.invalid/private.png",
    "//example.invalid/private.png", "file:///private/secret.png", "data:image/png;base64,AAA",
    "javascript:alert(1)", "obsidian://open?vault=private", "blob:foreign-resource",
  ])("does not resolve or read a scheme-bearing target: %s", async target => {
    const run = host(attachment());
    expect(await run.plugin.readExportImage(target, "MIA/수학/문제은행.md")).toBeNull();
    expect(run.resolve).not.toHaveBeenCalled(); expect(run.vault.readBinary).not.toHaveBeenCalled();
  });
  it("does not resolve malformed percent encoding", async () => {
    const run = host(attachment());
    expect(await run.plugin.readExportImage("%E0%A4%A", "source.md")).toBeNull();
    expect(run.resolve).not.toHaveBeenCalled(); expect(run.vault.readBinary).not.toHaveBeenCalled();
  });
  it.each(["svg", "html", "pdf", "webp"])("rejects unsupported resolved attachment type: %s", async extension => {
    const run = host(attachment(extension));
    expect(await run.plugin.readExportImage("그림", "source.md")).toBeNull();
    expect(run.vault.readBinary).not.toHaveBeenCalled();
  });
  it("only accepts a resolved vault file", async () => {
    const run = host({ path: "/private/secret.png", extension: "png" });
    expect(await run.plugin.readExportImage("missing.png", "source.md")).toBeNull();
    expect(run.vault.readBinary).not.toHaveBeenCalled();
  });
  it("decodes the local link, keeps its source context and releases the object URL after success", async () => {
    const file = attachment("JPEG"), run = host(file), image = imageBoundary();
    run.vault.readBinary.mockResolvedValue(rasterFixture("jpg"));
    const result = await run.plugin.readExportImage("attachments/%EA%B7%B8%EB%A6%BC.JPEG", "MIA/수학/문제은행.md");
    expect(run.resolve).toHaveBeenCalledWith("attachments/그림.JPEG", "MIA/수학/문제은행.md");
    expect(run.vault.readBinary).toHaveBeenCalledWith(file);
    expect(result).toEqual({ data: rasterFixture("jpg"), type: "jpg", width: 640, height: 480 });
    expect(image.assigned).toEqual(["blob:qa-local-image"]);
    expect(image.revoke).toHaveBeenCalledExactlyOnceWith("blob:qa-local-image");
  });
  it.each([
    ["png", [137, 80, 78, 71, 13, 10, 26, 10]],
    ["jpg", [255, 216, 255]],
    ["gif", [71, 73, 70, 56, 55, 97]],
    ["gif", [71, 73, 70, 56, 57, 97]],
    ["bmp", [66, 77]],
  ])("uses the supported raster content type %s even when the attachment is named PNG", async (type, bytes) => {
    const run = host(attachment("png")), image = imageBoundary();
    run.vault.readBinary.mockResolvedValue(Uint8Array.from(bytes).buffer);
    const result = await run.plugin.readExportImage("renamed.png", "source.md");
    expect(result.type).toBe(type);
    expect(new Uint8Array(result.data)).toEqual(Uint8Array.from(bytes));
    expect(image.revoke).toHaveBeenCalledExactlyOnceWith("blob:qa-local-image");
  });
  it.each([{ bytes: [] }, { bytes: [1, 2, 3] }, { bytes: [...new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')] }])(
    "refuses unsupported contents before decoding or destination writes: $bytes", async ({ bytes }) => {
      const run = host(attachment("png")), image = imageBoundary();
      run.vault.readBinary.mockResolvedValue(Uint8Array.from(bytes).buffer);
      await expect(run.plugin.readExportImage("renamed.png", "source.md")).rejects.toThrow(/이미지 형식/);
      expect(image.create).not.toHaveBeenCalled();
      expect(image.revoke).not.toHaveBeenCalled();
    },
  );
  it("releases the object URL when the decoder fails", async () => {
    const run = host(attachment()), image = imageBoundary("error");
    await expect(run.plugin.readExportImage("그림.png", "source.md")).rejects.toThrow("이미지를 읽을 수 없습니다");
    expect(image.revoke).toHaveBeenCalledExactlyOnceWith("blob:qa-local-image");
  });
  it("releases the object URL when decoded dimensions are invalid", async () => {
    const run = host(attachment()), image = imageBoundary("load", 0, 480);
    await expect(run.plugin.readExportImage("그림.png", "source.md")).rejects.toThrow("이미지 크기");
    expect(image.revoke).toHaveBeenCalledExactlyOnceWith("blob:qa-local-image");
  });
  it("propagates attachment read failure without creating an object URL", async () => {
    const run = host(attachment()), image = imageBoundary();
    run.vault.readBinary.mockRejectedValue(new Error("permission denied"));
    await expect(run.plugin.readExportImage("그림.png", "source.md")).rejects.toThrow("permission denied");
    expect(image.create).not.toHaveBeenCalled(); expect(image.revoke).not.toHaveBeenCalled();
  });
});


describe("attachment failures before export destination writes", () => {
  function exportHost() {
    const run = host(attachment());
    const content = renderManagedQuestion({
      questionMarkdown: "Question", answerMarkdown: "![[image.png]]", questionType: "정의형", coreKeywords: [], subKeywords: [],
    }, "mia-q-test");
    run.vault.getMarkdownFiles = () => [{ path: "MIA/math/a.md", extension: "md" }];
    run.vault.cachedRead = async () => content;
    run.plugin.index = new QuestionIndex(run.plugin.app, () => ["MIA"]);
    run.vault.createBinary = vi.fn(async () => ({}));
    run.vault.createFolder = vi.fn(async () => ({}));
    run.vault.getAbstractFileByPath = vi.fn(() => null);
    run.vault.getRoot = () => ({ children: [] });
    return run;
  }
  it("packages renamed JPEG contents as JPEG media rather than PNG", async () => {
    const run = exportHost(); imageBoundary();
    run.vault.readBinary.mockResolvedValue(rasterFixture("jpg"));
    await run.plugin.exportSubject("math");
    const data = run.vault.createBinary.mock.calls[0][1];
    const zip = await JSZip.loadAsync(data);
    const media = Object.keys(zip.files).filter(path => /^word\/media\/.+\.jpg$/.test(path));
    expect(media).toHaveLength(1);
    expect(await zip.file(media[0]).async("uint8array")).toEqual(new Uint8Array(rasterFixture("jpg")));
  });
  it("does not create a folder or output file when image reading fails", async () => {
    const run = exportHost(); imageBoundary();
    run.vault.readBinary.mockRejectedValue(Error("permission denied"));
    await expect(run.plugin.exportSubject("math")).rejects.toThrow("permission denied");
    expect(run.vault.createFolder).not.toHaveBeenCalled();
    expect(run.vault.createBinary).not.toHaveBeenCalled();
  });
  it("does not create an output on decode failure and permits a later successful retry", async () => {
    const run = exportHost(), failed = imageBoundary("error");
    await expect(run.plugin.exportSubject("math")).rejects.toThrow("이미지를 읽을 수 없습니다");
    expect(failed.revoke).toHaveBeenCalledTimes(1);
    expect(run.vault.createBinary).not.toHaveBeenCalled();
    imageBoundary("load");
    const result = await run.plugin.exportSubject("math");
    expect(result.count).toBe(1); expect(result.warnings).toEqual([]);
    expect(run.vault.createBinary).toHaveBeenCalledTimes(1);
  });
});
