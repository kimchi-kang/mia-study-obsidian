import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
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
const folder = resolve(args[1], ".obsidian/plugins/mia-study");
const files = await Promise.all(["main.js", "styles.css", "manifest.json"].map(async (name) => ({ name, data: await readFile(join(root, name)) })));
if (files.some((file) => !file.data.length)) throw new Error("Empty plugin file");
await mkdir(folder, { recursive: true });
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
console.log(`Installed MIA ${manifest.version}. Activation settings and user data were not changed. Restart Obsidian to load the updated files.`);
