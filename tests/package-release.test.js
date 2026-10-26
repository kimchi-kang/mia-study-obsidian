import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import { packageCandidate } from "../scripts/package-release.mjs";

const folders = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mia-package-")); folders.push(root);
  const manifest = { id: "mia-study", version: "1.3.4", minAppVersion: "1.8.7", isDesktopOnly: false };
  const contents = {
    "manifest.json": JSON.stringify(manifest), "package.json": JSON.stringify({ version: "1.3.4" }),
    "package-lock.json": JSON.stringify({ version: "1.3.4", packages: { "": { version: "1.3.4" } } }),
    "versions.json": JSON.stringify({ "1.3.4": "1.8.7" }), "main.js": "/*! Own license */\n/*! Vendor notices */\nmodule.exports = {};",
    "styles.css": ".mia {}", "LICENSE": "Own license\n", "THIRD-PARTY-NOTICES.txt": "Vendor notices\n",
    "INSTALL.md": "Install guide", "docs/releases/unreleased.md": "Unreleased notes", ".env": "SECRET=private",
    "data.json": "private study data", "main.js.map": "developer sources",
  };
  await mkdir(join(root, "docs/releases"), { recursive: true });
  await Promise.all(Object.entries(contents).map(([name, data]) => writeFile(join(root, name), data)));
  return root;
}
it("packages only installable assets, with matching raw bytes and checksums, deterministically", async () => {
  const root = await fixture();
  const a = await packageCandidate(root, join(root, "candidate-a"));
  const b = await packageCandidate(root, join(root, "candidate-b"));
  const bytes = await readFile(join(a.folder, a.archive));
  expect(await readFile(join(b.folder, b.archive))).toEqual(bytes);
  const zip = await JSZip.loadAsync(bytes);
  expect(Object.keys(zip.files).sort()).toEqual(["main.js", "manifest.json", "styles.css"]);
  for (const name of Object.keys(zip.files)) expect(await zip.file(name).async("nodebuffer")).toEqual(await readFile(join(root, name)));
  const info = JSON.parse(await readFile(join(a.folder, "BUILD-INFO.json"), "utf8"));
  expect(info.status).toBe("unreleased"); expect(info.embeddedVersion).toBe("1.3.4");
  const { createHash } = await import("node:crypto");
  for (const line of (await readFile(join(a.folder, "SHA256SUMS"), "utf8")).trim().split("\n")) {
    const [hash, name] = line.split("  ");
    expect(createHash("sha256").update(await readFile(join(a.folder, name))).digest("hex")).toBe(hash);
  }
  expect(await readdir(a.folder)).not.toContain("data.json");
});
it.each(["package.json", "package-lock.json", "versions.json"])("rejects inconsistent %s before creating output", async (name) => {
  const root = await fixture(); await writeFile(join(root, name), '{}');
  await expect(packageCandidate(root, join(root, "candidate"))).rejects.toThrow("metadata must agree");
  expect(await readdir(root)).not.toContain("candidate");
});
it("rejects development builds, missing assets and absent bundled notices", async () => {
  const root = await fixture(); const output = join(root, "candidate");
  await writeFile(join(root, "main.js"), "//# sourceMappingURL=data:secret");
  await expect(packageCandidate(root, output)).rejects.toThrow("source maps");
  await writeFile(join(root, "main.js"), "module.exports = {};");
  await expect(packageCandidate(root, output)).rejects.toThrow("notices");
  await rm(join(root, "styles.css"));
  await expect(packageCandidate(root, output)).rejects.toThrow();
  expect(await readdir(root)).not.toContain("candidate");
});
it("refuses to overwrite an existing output directory", async () => {
  const root = await fixture(); const output = join(root, "existing");
  await mkdir(output); await writeFile(join(output, "user-file"), "keep");
  await expect(packageCandidate(root, output)).rejects.toThrow();
  expect(await readFile(join(output, "user-file"), "utf8")).toBe("keep");
  expect(await readdir(output)).toEqual(["user-file"]);
});
it("creates an explicitly requested versioned release with the matching notes and keeps candidates", async () => {
  const root = await fixture();
  const candidate = await packageCandidate(root);
  await writeFile(join(root, "docs/releases/1.3.4.md"), "Version-specific release notes");
  const release = await packageCandidate(root, undefined, { release: true });
  expect(release.archive).toBe("mia-study-1.3.4.zip");
  expect(release.folder).toBe(join(root, "artifacts/1.3.4"));
  expect(await readFile(join(release.folder, "RELEASE-NOTES.md"), "utf8")).toBe("Version-specific release notes");
  const info = JSON.parse(await readFile(join(release.folder, "BUILD-INFO.json"), "utf8"));
  expect(info.status).toBe("release-package"); expect(info.publication).toContain("not published");
  const zip = await JSZip.loadAsync(await readFile(join(release.folder, release.archive)));
  expect(JSON.parse(await zip.file("manifest.json").async("string")).version).toBe("1.3.4");
  await expect(packageCandidate(root, undefined, { release: true })).rejects.toThrow();
  expect(await readFile(join(candidate.folder, candidate.archive))).toBeTruthy();
});
it("requires version-specific release notes before creating a release directory", async () => {
  const root = await fixture();
  await expect(packageCandidate(root, join(root, "release"), { release: true })).rejects.toThrow();
  expect(await readdir(root)).not.toContain("release");
});
it.each(["LICENSE", "THIRD-PARTY-NOTICES.txt"])("rejects an empty %s rather than passing an empty-string inclusion check", async (name) => {
  const root = await fixture(); await writeFile(join(root, name), "  \n");
  await expect(packageCandidate(root, join(root, "output"))).rejects.toThrow("notices");
  expect(await readdir(root)).not.toContain("output");
});
