import { readFile, writeFile, mkdir, rename, unlink, realpath, stat } from "node:fs/promises";
import { join, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--vault" || !args[1] || !isAbsolute(args[1])) {
  throw new Error("Usage: npm run install:local -- --vault <absolute-vault-path> (default .obsidian config folder)");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.id !== "mia-study" || manifest.version !== pkg.version || manifest.isDesktopOnly !== false) throw new Error("Inconsistent plugin manifest");
const files = await Promise.all(["main.js", "styles.css", "manifest.json"].map(async (name) => ({ name, data: await readFile(join(root, name)) })));
if (files.some((file) => !file.data.length)) throw new Error("Empty plugin file");
const vault = await realpath(args[1]);
if (!(await stat(vault)).isDirectory()) throw new Error("Vault path must be an existing directory");
let folder = vault;
for (const part of [".obsidian", "plugins", "mia-study"]) {
  const next = join(folder, part);
  try { await mkdir(next); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const resolved = await realpath(next);
  const inside = relative(vault, resolved);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error("Plugin configuration path resolves outside the selected vault");
  }
  if (!(await stat(resolved)).isDirectory()) throw new Error("Plugin configuration path is not a directory");
  folder = resolved;
}
// Replace complete files, with the version manifest last. Never toggle the shared activation list.
for (const { name, data } of files) {
  const temporary = join(folder, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: "wx" });
    await rename(temporary, join(folder, name));
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
// Overlapping installers can replace a complete file after our rename.
// Verify the whole requested set before acknowledging this installation.
for (const { name, data } of files) {
  if (!(await readFile(join(folder, name))).equals(data)) {
    throw new Error("설치 파일 검증에 실패했습니다. 다른 설치 또는 동기화를 멈추고, Obsidian을 닫은 상태에서 같은 빌드로 다시 설치하세요.");
  }
}
console.log(`Installed MIA ${manifest.version}. Activation settings and user data were not changed. Restart Obsidian to load the updated files.`);
