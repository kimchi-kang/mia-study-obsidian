import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const coreFiles = [
  "follow-up.ts", "fsrs-service.ts", "keyword-note.ts", "keyword-path.ts", "keyword-reference.ts",
  "managed-question.ts", "markdown-structure.ts", "mobile-keyboard-metrics.ts", "models.ts", "navigation.ts", "progress.ts",
  "question-parser.ts", "question-query.ts", "question-writer.ts", "recommendation-engine.ts", "subject-note.ts",
];
const serviceFiles = ["data-store.ts", "question-index.ts"];
const uiFiles = [
  "error-message.ts", "follow-up-modal.ts", "keyword-modal.ts", "manage-modals.ts", "metadata-modal.ts",
  "mobile-keyboard.ts", "question-detail-modal.ts", "settings-tab.ts", "study-result-modal.ts", "study-view.ts",
];

const cases: Array<{ name: string; path: string; forbidden: RegExp }> = [
  ...coreFiles.flatMap((file) => [
    { name: `core/${file} does not depend on Obsidian`, path: `core/${file}`, forbidden: /from ["']obsidian["']/ },
    { name: `core/${file} does not use browser storage`, path: `core/${file}`, forbidden: /localStorage/ },
  ]),
  ...serviceFiles.flatMap((file) => [
    { name: `services/${file} does not depend on UI`, path: `services/${file}`, forbidden: /from ["']\.\.\/ui\// },
    { name: `services/${file} does not use browser storage`, path: `services/${file}`, forbidden: /localStorage/ },
  ]),
  ...uiFiles.map((file) => ({
    name: `ui/${file} does not persist vault data directly`, path: `ui/${file}`, forbidden: /(?:saveData|vault\.process)\s*\(/,
  })),
  { name: "main.ts does not use browser storage", path: "main.ts", forbidden: /localStorage/ },
];

describe("45 architecture boundaries", () => {
  it.each(cases)("$name", async ({ path, forbidden }) => {
    const content = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
    expect(content).not.toMatch(forbidden);
  });
});
