import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let root, worker;
const children = new Set();
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mia-crash-storage-")); worker = join(root, "worker.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("./fixtures/crash-storage-worker.mjs", import.meta.url))], bundle: true, platform: "node", format: "esm", target: "node22", outfile: worker });
});
afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(child => child.done));
  if (root) await rm(root, { recursive: true, force: true });
});
function launch(mode, directory, stage = "", action = "") {
  const child = spawn(process.execPath, [worker, mode, directory, stage, action], { stdio: ["ignore", "pipe", "pipe"] });
  child.output = ""; child.errors = "";
  child.stdout.on("data", chunk => { child.output += chunk; }); child.stderr.on("data", chunk => { child.errors += chunk; });
  child.done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  children.add(child); child.done.finally(() => children.delete(child));
  return child;
}
async function run(mode, directory) {
  const child = launch(mode, directory), exit = await child.done;
  expect(exit, child.errors).toEqual({ code: 0, signal: null });
  return mode === "inspect" || mode === "probe" ? JSON.parse(child.output) : undefined;
}
async function stopAt(directory, stage, action) {
  const child = launch("crash", directory, stage, action);
  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline) {
      try {
        const checkpoint = JSON.parse(await readFile(join(directory, "checkpoint.json"), "utf8"));
        expect(checkpoint.stage).toBe(stage);
        expect(child.kill("SIGKILL")).toBe(true);
        expect(await child.done).toEqual({ code: null, signal: "SIGKILL" });
        return checkpoint;
      } catch (error) {
        if (!(error instanceof SyntaxError) && error.code !== "ENOENT") throw error;
      }
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`Worker exited before checkpoint: ${child.errors}`);
      await pause(10);
    }
    throw Error(`Worker did not reach ${stage}`);
  } finally { if (children.has(child)) { child.kill("SIGKILL"); await child.done; } }
}
const read = (directory, file) => readFile(join(directory, file), "utf8");
const stages = ["before-primary", "primary-truncated", "primary-partial", "after-primary", "recovery-partial", "after-recovery", "after-ack"];

describe("real filesystem process termination and fresh-process recovery", () => {
  it.each(["grade", "reset"].flatMap(action => stages.map(stage => ({ action, stage }))))("preserves the last complete commit after $action at $stage", async ({ action, stage }) => {
    const directory = await mkdtemp(join(root, "case-")); await run("seed", directory);
    const initial = JSON.parse(await read(directory, "data.json"));
    const receipt = await stopAt(directory, stage, action);
    const bytesBefore = await Promise.all([read(directory, "data.json"), read(directory, "recovery.json")]);
    const inspected = await run("inspect", directory);
    expect(inspected.loaded).toBe(true);
    // The older recovery copy remains inspectable when the reset reached only the primary.
    expect(inspected.conflicts).toEqual(action === "reset" && stage === "after-primary" ? { q: [initial.reviews.q] } : {});
    const primaryComplete = ["after-primary", "recovery-partial", "after-recovery", "after-ack"].includes(stage);
    const intended = JSON.parse(await read(directory, "intended-reviews.json"));
    expect(inspected.reviews).toEqual(primaryComplete ? intended : initial.reviews);
    expect(receipt.acknowledged).toBe(stage === "after-ack");
    if (["primary-truncated", "primary-partial", "recovery-partial"].includes(stage)) expect(inspected.warnings.join(" ")).toMatch(/복구/);
    else expect(inspected.warnings).toEqual([]);
    if (primaryComplete && action === "reset") {
      const persisted = JSON.parse(bytesBefore[0]);
      expect(persisted.reviewVersions.q).not.toBe(initial.reviewVersions.q);
      expect(inspected.reviews.q).toBeUndefined();
    }
    if (["primary-truncated", "primary-partial"].includes(stage)) {
      const probe = await run("probe", directory);
      expect(probe.loaded).toBe(true); expect(probe.writeRejected).toBe(true);
      expect(probe.reviews).toEqual(initial.reviews);
    }
    // Inspection is non-destructive even when one stored copy is malformed.
    expect(await Promise.all([read(directory, "data.json"), read(directory, "recovery.json")])).toEqual(bytesBefore);
  });
  it("refuses to manufacture an empty installation when both stored copies are torn", async () => {
    const directory = await mkdtemp(join(root, "both-torn-")); await run("seed", directory);
    await writeFile(join(directory, "recovery.json"), '{"version":');
    await stopAt(directory, "primary-partial", "grade");
    const before = await Promise.all([read(directory, "data.json"), read(directory, "recovery.json")]);
    expect((await run("inspect", directory)).loaded).toBe(false);
    expect(await Promise.all([read(directory, "data.json"), read(directory, "recovery.json")])).toEqual(before);
  });
});


it.each(["before-primary", "after-primary", "after-ack"])("preserves the review/checkpoint mismatch across SIGKILL at %s", async stage => {
  const directory = await mkdtemp(join(root, "ui-gap-")); await run("seed", directory); await run("resume-checkpoint", directory);
  const checkpointBefore = await read(directory, "ui-state.json");
  await stopAt(directory, stage, "grade");
  const restarted = await run("inspect", directory);
  expect(restarted.loaded).toBe(true); expect(restarted.resume.queueIndex).toBe(0);
  expect(await read(directory, "ui-state.json")).toBe(checkpointBefore);
  if (stage === "before-primary") {
    expect(restarted.reviews.q.history).toHaveLength(1);
    expect(restarted.resume.reviewCheckpoint.version).toBe(restarted.reviewVersion);
  } else {
    expect(restarted.reviews.q.history).toHaveLength(2);
    expect(restarted.resume.reviewCheckpoint.version).not.toBe(restarted.reviewVersion);
  }
});
