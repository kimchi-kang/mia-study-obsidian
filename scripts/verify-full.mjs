import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const auditNames = [
  "parses every question callout without empty prompts, answers, or diagnostics",
  "round-trips dummy metadata for every question entirely in memory",
];

export function assertFullTestReport(report) {
  const files = report.testResults ?? [];
  const assertions = files.flatMap((file) => file.assertionResults ?? []);
  if (!report.success || !assertions.length || files.some((file) => file.status !== "passed")
    || assertions.some((test) => test.status !== "passed")
    || report.numFailedTests !== 0 || report.numPendingTests !== 0
    || report.numPassedTests !== assertions.length || report.numTotalTests !== assertions.length) {
    throw new Error("Full verification requires every test to run and pass; failed, skipped, pending or empty results are not success.");
  }
  const audit = files.filter((file) => basename(file.name) === "vault-audit.test.ts")
    .flatMap((file) => file.assertionResults ?? []);
  for (const name of auditNames) {
    if (audit.filter((test) => test.title === name && test.status === "passed").length !== 1) {
      throw new Error(`Required synthetic vault audit did not run: ${name}`);
    }
  }
  return { files: files.length, passed: assertions.length, failed: 0, skipped: 0 };
}

async function verifyFull() {
  if (process.argv.length !== 2) throw new Error("Usage: npm run verify:full (no test filters)");
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run with npm run verify:full.");
  createRequire(import.meta.url).resolve("jsdom"); // Use this project's declared dependencies; npm ci first.
  const reports = join(root, "artifacts", "verification");
  await mkdir(reports, { recursive: true });
  const output = await mkdtemp(join(reports, "run-"));
  const temporary = await mkdtemp(join(tmpdir(), "mia-full-verification-"));
  const vault = join(temporary, "synthetic-vault");
  const summary = { status: "running", startedAt: new Date().toISOString(), node: process.version };
  const record = () => writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`Verification reports: ${output}`);
  try {
    // The committed synthetic fixture is the only source, even if a caller has
    // MIA_AUDIT_VAULT set to a personal vault. Copy it into a fresh temporary vault.
    const source = join(root, "tests", "fixtures", "vault");
    const entries = await readdir(source, { recursive: true, withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink())
      || !entries.some((entry) => entry.isFile() && entry.name.endsWith(".md"))) {
      throw new Error("Synthetic vault preparation requires regular Markdown fixtures and no symbolic links.");
    }
    await cp(source, vault, { recursive: true, force: false, errorOnExist: true });
    const env = { ...process.env, MIA_AUDIT_VAULT: vault };
    delete env.NODE_PATH;
    const run = (label, args) => {
      console.log(`\n[verify:full] ${label}`);
      const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: root, env, stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${label} failed (${result.signal ?? result.status}).`);
    };
    await record();
    const testReport = join(output, "tests.json");
    run("all tests and required synthetic vault audits", ["run", "test", "--", "--reporter=default", "--reporter=json", `--outputFile=${testReport}`]);
    summary.tests = assertFullTestReport(JSON.parse(await readFile(testReport, "utf8")));
    await record();
    run("type check and production build", ["run", "build"]);
    summary.typecheck = "passed";
    summary.productionBuild = "passed";
    summary.status = "passed";
  } catch (error) {
    summary.status = "failed";
    summary.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    summary.finishedAt = new Date().toISOString();
    await record();
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`\nFull verification passed: ${summary.tests.passed} tests, 0 failed, 0 skipped; type check and production build passed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyFull();
}
