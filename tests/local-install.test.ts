import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("updates plugin files without touching activation settings or study data", async () => {
  const vault = await mkdtemp(join(tmpdir(), "mia-install-"));
  try {
    const plugin = join(vault, ".obsidian/plugins/mia-study");
    await mkdir(plugin, { recursive: true });
    const config = join(vault, ".obsidian/community-plugins.json");
    await writeFile(config, '["other","mia-study"]');
    await writeFile(join(plugin, "data.json"), '{"personal":"keep"}');
    await writeFile(join(plugin, "ui-state.json"), '{"resume":"keep"}');
    execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/install-local.mjs", import.meta.url)), "--vault", vault]);
    expect(await readFile(config, "utf8")).toBe('["other","mia-study"]');
    expect(await readFile(join(plugin, "data.json"), "utf8")).toBe('{"personal":"keep"}');
    expect(await readFile(join(plugin, "ui-state.json"), "utf8")).toBe('{"resume":"keep"}');
    expect(await readFile(join(plugin, "main.js"))).toEqual(await readFile(new URL("../main.js", import.meta.url)));
    expect((await readdir(plugin)).some((name) => name.endsWith(".tmp"))).toBe(false);
  } finally { await rm(vault, { recursive: true, force: true }); }
});
