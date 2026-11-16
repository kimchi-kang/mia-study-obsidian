import { spawnSync } from "node:child_process";
// Vitest supplies the same Obsidian module boundary as the render regression tests.
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/study-layout-render.test.js"], {
  stdio: "inherit", env: { ...process.env, MIA_GENERATE_LAYOUT_HARNESS: "1" },
});
process.exit(result.status ?? 1);
