import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import JSZip from "jszip";

const digest = (data) => createHash("sha256").update(data).digest("hex");
const pluginFiles = ["main.js", "styles.css", "manifest.json"];

// Packaging never assigns a version or publishes files. Release mode must be explicit.
export async function packageCandidate(root, output, { release = false } = {}) {
  const json = async (name) => JSON.parse(await readFile(join(root, name), "utf8"));
  const [manifest, pkg, lock, versions] = await Promise.all([
    json("manifest.json"), json("package.json"), json("package-lock.json"), json("versions.json"),
  ]);
  if (manifest.id !== "mia-study" || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || manifest.version !== pkg.version || manifest.version !== lock.version
    || manifest.version !== lock.packages?.[""]?.version || manifest.isDesktopOnly !== false
    || !/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion)
    || versions[manifest.version] !== manifest.minAppVersion) {
    throw new Error("Package, lockfile, manifest and versions metadata must agree.");
  }
  const files = await Promise.all(pluginFiles.map(async (name) => ({ name, data: await readFile(join(root, name)) })));
  if (files.some(({ data }) => data.length === 0)) throw new Error("Empty plugin asset.");
  const bundle = files[0].data.toString("utf8");
  if (/sourceMappingURL\s*=/.test(bundle)) throw new Error("Build a production bundle without source maps first.");
  const [license, notices, install, releaseNotes] = await Promise.all([
    readFile(join(root, "LICENSE")), readFile(join(root, "THIRD-PARTY-NOTICES.txt")),
    readFile(join(root, "INSTALL.md")), readFile(join(root, "docs/releases", release ? `${manifest.version}.md` : "unreleased.md")),
  ]);
  if (!license.toString("utf8").trim() || !notices.toString("utf8").trim() || !bundle.includes(license.toString("utf8").trimEnd()) || !bundle.includes(notices.toString("utf8").trimEnd())) {
    throw new Error("The installable bundle must include license and third-party notices.");
  }
  const checksums = Object.fromEntries(files.map(({ name, data }) => [name, digest(data)]));
  const buildId = digest(JSON.stringify(checksums)).slice(0, 12);
  const archive = release ? `mia-study-${manifest.version}.zip` : `mia-study-unreleased-${buildId}.zip`;
  const zip = new JSZip();
  for (const { name, data } of files) {
    zip.file(name, data, { date: new Date("1980-01-01T00:00:00Z"), unixPermissions: 0o100644 });
  }
  const zipped = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 }, platform: "UNIX" });
  const folder = output ?? join(root, "artifacts", release ? manifest.version : `unreleased-${buildId}`);
  await mkdir(resolve(folder, ".."), { recursive: true });
  await mkdir(folder); // Refuse to overwrite any existing candidate or published artifact.
  const entries = [...files, { name: archive, data: zipped }, { name: "LICENSE", data: license },
    { name: "THIRD-PARTY-NOTICES.txt", data: notices }, { name: "INSTALL.md", data: install },
    { name: "RELEASE-NOTES.md", data: releaseNotes }];
  for (const { name, data } of entries) await writeFile(join(folder, name), data, { flag: "wx" });
  await writeFile(join(folder, "SHA256SUMS"), entries.map(({ name, data }) => `${digest(data)}  ${name}\n`).join(""), { flag: "wx" });
  await writeFile(join(folder, "BUILD-INFO.json"), JSON.stringify({
    status: release ? "release-package" : "unreleased", buildId, embeddedVersion: manifest.version, minAppVersion: manifest.minAppVersion,
    archive, checksums, publication: release ? "Packaged locally; not published." : "Version approval and matching metadata rebuild required before publication.",
  }, null, 2) + "\n", { flag: "wx" });
  return { folder, archive, buildId };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const release = args[0] === "--release";
  if (release) args.shift();
  if (args.length && (args.length !== 2 || args[0] !== "--out-dir" || !args[1])) throw new Error("Usage: npm run package:release -- [--release] [--out-dir <new-directory>]");
  const root = fileURLToPath(new URL("../", import.meta.url));
  console.log(await packageCandidate(root, args[1] ? resolve(args[1]) : undefined, { release }));
}
