import esbuild from "esbuild";
import process from "node:process";
import { readFileSync } from "node:fs";

// Include notices in the shipped bundle: Obsidian installs only the three plugin assets.
const notices = readFileSync(new URL("./THIRD-PARTY-NOTICES.txt", import.meta.url), "utf8").trimEnd();
if (notices.includes("*/")) throw new Error("Third-party notices contain a JavaScript comment terminator.");

const production = process.argv[2] === "production";
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "node:*", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
  banner: { js: `/*! MIA third-party notices\n${notices}\n*/` },
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
