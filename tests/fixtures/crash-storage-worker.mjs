import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MiaDataStore } from "../../src/services/data-store";
import { VerifiedPluginStorage } from "../../src/services/verified-plugin-storage";
import { StudyUiStore } from "../../src/services/study-ui-store";
import { FsrsService } from "../../src/core/fsrs-service";

const [mode, directory, stage, action] = process.argv.slice(2);
if (!directory) throw new Error("Missing isolated test directory");
const primary = join(directory, "data.json"), recovery = join(directory, "recovery.json");
const checkpoint = name => {
  if (stage !== name) return;
  writeFileSync(join(directory, "checkpoint.json"), JSON.stringify({ stage: name, acknowledged: name === "after-ack" }));
  // The parent terminates this process with SIGKILL; no cleanup handlers can run.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const native = {
  async loadData() {
    if (!existsSync(primary)) return null;
    try { return JSON.parse(await readFile(primary, "utf8")); }
    catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
  },
  async saveData(value) {
    const content = JSON.stringify(value, undefined, 2);
    checkpoint("before-primary");
    await writeFile(primary, ""); checkpoint("primary-truncated");
    await writeFile(primary, content.slice(0, Math.floor(content.length / 2))); checkpoint("primary-partial");
    await writeFile(primary, content); checkpoint("after-primary");
  },
};
const adapter = { exists: async path => existsSync(path), read: path => readFile(path, "utf8"), write: (path, value) => writeFile(path, value) };
const store = new MiaDataStore(new VerifiedPluginStorage(native, adapter, primary), {
  read: () => existsSync(recovery) ? JSON.parse(readFileSync(recovery, "utf8")) : null,
  write(value) {
    const content = JSON.stringify(value);
    writeFileSync(recovery, content.slice(0, Math.floor(content.length / 2))); checkpoint("recovery-partial");
    writeFileSync(recovery, content); checkpoint("after-recovery");
  },
});
const fsrs = new FsrsService({ targetRetention: .9, maximumIntervalDays: 36500 });
if (mode === "inspect" || mode === "probe") {
  try {
    await store.load();
    let writeRejected;
    if (mode === "probe") {
      try { await store.setReview("after", fsrs.rate(undefined, 3, new Date("2026-10-20T00:20:00Z"), "after")); writeRejected = false; }
      catch { writeRejected = true; }
    }
    let resume;
    if (existsSync(join(directory, "ui-state.json"))) {
      const ui = new StudyUiStore({ vault: { adapter }, loadLocalStorage: () => null, saveLocalStorage() {} }, join(directory, "ui-state.json"));
      await ui.load(); resume = ui.resume;
    }
    process.stdout.write(JSON.stringify({ loaded: true, writeRejected, resume, reviewVersion: store.getReviewVersion("q"), reviews: store.reviews, warnings: store.loadWarnings, conflicts: store.conflicts }));
  } catch (error) { process.stdout.write(JSON.stringify({ loaded: false, error: error instanceof Error ? error.message : String(error) })); }
} else {
  await store.load();
  if (mode === "seed") {
    await store.setReview("q", fsrs.rate(undefined, 3, new Date("2026-10-20T00:00:00Z"), "q"));
  } else if (mode === "resume-checkpoint") {
    const ui = new StudyUiStore({ vault: { adapter }, loadLocalStorage: () => null, saveLocalStorage() {} }, join(directory, "ui-state.json"));
    await ui.saveResume({ queue: ["q"], seed: ["q"], skipped: [], queueIndex: 0, answerVisible: true, sessionMode: "browse", updatedAt: "2026-10-20T00:05:00Z", reviewCheckpoint: { id: "q", version: store.getReviewVersion("q") } });
  } else if (mode === "crash") {
    const intended = action === "reset" ? {} : { q: fsrs.rate(store.getReview("q"), 2, new Date("2026-10-20T00:10:00Z"), "q") };
    writeFileSync(join(directory, "intended-reviews.json"), JSON.stringify(intended));
    if (action === "reset") await store.removeReview("q");
    else await store.setReview("q", intended.q);
    checkpoint("after-ack");
    throw new Error("Requested checkpoint was never reached");
  } else throw new Error("Unknown mode");
}
