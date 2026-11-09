import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Discover files instead of listing them, so new modules are checked automatically.
const SRC = new URL("../src/", import.meta.url);
const LAYERS = ["core", "services", "ui"] as const;
type Layer = (typeof LAYERS)[number];

const sourceFiles = (layer: Layer): string[] =>
  readdirSync(new URL(`${layer}/`, SRC)).filter((file) => file.endsWith(".ts")).sort();

const read = (path: string): string => readFileSync(new URL(path, SRC), "utf8");

const OBSIDIAN_IMPORT = /from ["']obsidian["']/;
const OUTER_LAYER_IMPORT = /from ["']\.\.\/(?:services|ui)\/|from ["']\.\.\/main["']/;
const UI_IMPORT = /from ["']\.\.\/ui\//;
// Raw Web Storage only. Obsidian's per-vault `app.loadLocalStorage`/`saveLocalStorage`
// API is allowed in main.ts, which injects it into services as recovery callbacks.
const WEB_STORAGE = /\blocalStorage\b/;
const DIRECT_VAULT_PERSISTENCE = /(?:saveData|vault\.process)\s*\(/;

interface Rule { name: string; path: string; forbidden: RegExp }

const rulesFor: Record<Layer, (file: string) => Rule[]> = {
  core: (file) => [
    { name: `core/${file} does not depend on Obsidian`, path: `core/${file}`, forbidden: OBSIDIAN_IMPORT },
    { name: `core/${file} does not import services, UI or main`, path: `core/${file}`, forbidden: OUTER_LAYER_IMPORT },
    { name: `core/${file} does not use Web Storage`, path: `core/${file}`, forbidden: WEB_STORAGE },
  ],
  services: (file) => [
    { name: `services/${file} does not depend on UI`, path: `services/${file}`, forbidden: UI_IMPORT },
    { name: `services/${file} does not use Web Storage`, path: `services/${file}`, forbidden: WEB_STORAGE },
  ],
  ui: (file) => [
    { name: `ui/${file} does not persist vault data directly`, path: `ui/${file}`, forbidden: DIRECT_VAULT_PERSISTENCE },
  ],
};

const cases: Rule[] = [
  ...LAYERS.flatMap((layer) => sourceFiles(layer).flatMap(rulesFor[layer])),
  { name: "main.ts does not use Web Storage", path: "main.ts", forbidden: WEB_STORAGE },
];

describe("architecture boundaries", () => {
  it("every source file belongs to a checked layer", () => {
    const entries = readdirSync(SRC, { withFileTypes: true });
    const unchecked = entries
      .filter((entry) => entry.isDirectory() ? !(LAYERS as readonly string[]).includes(entry.name) : entry.name !== "main.ts")
      .map((entry) => entry.name);
    expect(unchecked).toEqual([]);
    for (const layer of LAYERS) {
      const nested = readdirSync(new URL(`${layer}/`, SRC), { withFileTypes: true }).filter((entry) => entry.isDirectory());
      expect(nested.map((entry) => entry.name), `${layer}/ has unchecked subfolders`).toEqual([]);
      expect(sourceFiles(layer).length, `${layer}/ has no source files`).toBeGreaterThan(0);
    }
  });

  it.each(cases)("$name", ({ path, forbidden }) => {
    expect(read(path)).not.toMatch(forbidden);
  });
});
