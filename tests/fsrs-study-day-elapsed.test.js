import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { buildSync } from "esbuild";

const code = buildSync({ stdin: { contents: `
import { FsrsService } from './src/core/fsrs-service';
import { Rating } from 'ts-fsrs';
const service = new FsrsService({ targetRetention: .9, maximumIntervalDays: 36500 });
const base = service.rate(undefined, Rating.Easy, new Date('2026-09-01T10:00:00+09:00'), 'q');
const out = {};
for (const [name, a, b] of JSON.parse(process.argv[2])) {
  const s1 = service.rate(base, Rating.Good, new Date(a), 'q');
  const s2 = service.rate(s1, Rating.Good, new Date(b), 'q');
  const p = service.preview(s1, new Date(b), 'q').find(x => x.grade === Rating.Good);
  out[name] = { elapsed: s2.card.elapsed_days, stability: s2.card.stability, previewDue: p.due.toISOString(), due: s2.card.due, last: s2.card.last_review, logReview: s2.history.at(-1).review };
}
console.log(JSON.stringify(out));
`, resolveDir: process.cwd() }, bundle: true, packages: "external", platform: "node", format: "esm", write: false }).outputFiles[0].text;

function run(zone, list) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code, "x", JSON.stringify(list)], { cwd: process.cwd(), env: { ...process.env, TZ: zone }, encoding: "utf8" }));
}

describe("FSRS elapsed days follow the local study day", () => {
  const pair = (a, b) => [["case", a, b]];
  it("counts 23:00 then 08:00 (next study day) as one elapsed day in Asia/Seoul", () => {
    const early = run("Asia/Seoul", pair("2026-11-05T23:00:00+09:00", "2026-11-06T08:00:00+09:00")).case;
    const later = run("Asia/Seoul", pair("2026-11-05T23:00:00+09:00", "2026-11-06T10:00:00+09:00")).case;
    expect(early.elapsed).toBe(1);
    expect(later.elapsed).toBe(1);
    expect(early.stability).toBeCloseTo(later.stability, 6);
    expect(early.due).toBe(early.previewDue);
    expect(early.last).toBe(new Date("2026-11-06T08:00:00+09:00").toISOString());
    expect(early.logReview).toBe(early.last);
  });
  it("counts two reviews inside one study day as zero elapsed days", () => {
    expect(run("Asia/Seoul", pair("2026-11-06T05:00:00+09:00", "2026-11-06T08:00:00+09:00")).case.elapsed).toBe(0);
    expect(run("Asia/Seoul", pair("2026-11-06T03:00:00+09:00", "2026-11-06T04:30:00+09:00")).case.elapsed).toBe(1);
  });
  it("stays consistent with the local study day in a DST zone", () => {
    const r = run("America/New_York", pair("2026-11-01T23:00:00-05:00", "2026-11-02T05:00:00-05:00")).case;
    expect(r.elapsed).toBe(1);
    const same = run("America/New_York", pair("2026-11-01T05:00:00-05:00", "2026-11-01T08:00:00-05:00")).case;
    expect(same.elapsed).toBe(0);
  });
});
