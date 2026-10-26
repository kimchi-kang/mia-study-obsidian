import type { DataAdapter } from "obsidian";
import { mergeReviewData } from "../core/review-sync";
import { parsePluginData } from "./data-store";
import { parseStudyResume } from "./study-ui-store";
import type { PluginDataStorage } from "./verified-plugin-storage";

type Adapter = Pick<DataAdapter, "exists" | "read" | "write" | "mkdir">;
export const PORTABLE_STUDY_FOLDER = "MIA Study Sync";
export const PORTABLE_DATA_PATH = `${PORTABLE_STUDY_FOLDER}/study-data.md`;
export const PORTABLE_RESUME_PATH = `${PORTABLE_STUDY_FOLDER}/study-resume.md`;
const MODE_PATH = `${PORTABLE_STUDY_FOLDER}/sync-mode.md`;
type Kind = "records" | "resume" | "mode";
const prefix = (kind: Kind) => `<!-- mia-study-sync:${kind}:v1 -->\n\n이 파일은 MIA Study가 관리합니다. 직접 편집하지 마세요.\n\n\`\`\`json\n`;
const suffix = "\n```\n";
function encode(kind: Kind, value: unknown): string { return prefix(kind) + JSON.stringify(value, null, 2) + suffix; }
function decode(kind: Kind, text: string): unknown {
  if (!text.startsWith(prefix(kind)) || !text.endsWith(suffix)) throw new Error("범용 동기화 파일 형식을 확인하세요. 원본을 덮어쓰지 않았습니다.");
  return JSON.parse(text.slice(prefix(kind).length, -suffix.length));
}
function parseRecords(raw: unknown) {
  if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version === undefined || raw.version === null) throw new Error("범용 복습 기록 형식을 확인하세요.");
  return parsePluginData(raw);
}
function parseResume(raw: unknown) {
  if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 || !("resume" in raw)) throw new Error("범용 이어하기 형식을 확인하세요.");
  const resume = parseStudyResume(raw.resume);
  if (raw.resume !== null && !resume) throw new Error("범용 이어하기 정보가 손상되었습니다.");
  const updatedAt = "updatedAt" in raw && typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : resume?.updatedAt ?? "1970-01-01T00:00:00.000Z";
  return { version: 1, resume, updatedAt };
}

/** Ordinary Markdown files can travel with notes without syncing hidden app settings. */
export class PortableStudyStorage implements PluginDataStorage {
  constructor(private readonly adapter: Adapter) {}
  async loadData(): Promise<unknown> { return parseRecords(decode("records", await this.adapter.read(PORTABLE_DATA_PATH))); }
  async saveData(data: unknown): Promise<void> { await this.writeVerified(PORTABLE_DATA_PATH, encode("records", parseRecords(data))); }
  readonly resumeAdapter: Pick<DataAdapter, "exists" | "read" | "write"> = {
    exists: path => this.adapter.exists(path),
    read: async path => JSON.stringify(parseResume(decode("resume", await this.adapter.read(path)))),
    write: async (path, text) => this.writeVerified(path, encode("resume", parseResume(JSON.parse(text)))),
  };
  private async writeVerified(path: string, text: string): Promise<void> {
    await this.adapter.write(path, text);
    if (await this.adapter.read(path) !== text) throw new Error("범용 동기화 파일의 저장 결과가 달라졌습니다. 최신 기록을 확인하세요.");
  }
}

export async function selectPortableStudyStorage(adapter: Adapter, previouslyEnabled: boolean): Promise<PortableStudyStorage | null> {
  if (!await adapter.exists(MODE_PATH)) {
    if (previouslyEnabled) throw new Error("범용 동기화 폴더가 아직 도착하지 않았습니다. 보관함 동기화를 마친 뒤 다시 시작하세요.");
    return null;
  }
  const mode = decode("mode", await adapter.read(MODE_PATH));
  if (!mode || typeof mode !== "object" || !("version" in mode) || mode.version !== 1) throw new Error("지원하지 않는 범용 동기화 버전입니다. 모든 기기의 MIA를 업데이트하세요.");
  for (const path of [PORTABLE_DATA_PATH, PORTABLE_RESUME_PATH]) if (!await adapter.exists(path)) throw new Error("범용 학습 파일이 아직 모두 도착하지 않았습니다. 보관함 동기화를 마친 뒤 다시 시작하세요.");
  return new PortableStudyStorage(adapter);
}

/** Copy/merge first, publish the mode last; the legacy files remain intact. */
export async function preparePortableStudyStorage(adapter: Adapter, legacy: PluginDataStorage, localResume: unknown): Promise<void> {
  // Reject a future or damaged mode before touching any shared payload.
  await selectPortableStudyStorage(adapter, false);
  const oldMode = await adapter.exists(MODE_PATH) ? await adapter.read(MODE_PATH) : null;
  if (oldMode !== null) {
    const mode = decode("mode", oldMode);
    if (!mode || typeof mode !== "object" || !("version" in mode) || mode.version !== 1) throw new Error("지원하지 않는 범용 동기화 버전입니다.");
  }
  const local = parsePluginData(await legacy.loadData());
  const resume = parseResume(localResume);
  const oldData = await adapter.exists(PORTABLE_DATA_PATH) ? await adapter.read(PORTABLE_DATA_PATH) : null;
  const oldResume = await adapter.exists(PORTABLE_RESUME_PATH) ? await adapter.read(PORTABLE_RESUME_PATH) : null;
  const remote = oldData === null ? null : parseRecords(decode("records", oldData));
  const remoteResume = oldResume === null ? null : parseResume(decode("resume", oldResume));
  const merged = remote ? mergeReviewData(local, remote) : local;
  const chosenResume = remoteResume && Date.parse(remoteResume.updatedAt) > Date.parse(resume.updatedAt) ? remoteResume : resume;
  if (!await adapter.exists(PORTABLE_STUDY_FOLDER)) await adapter.mkdir(PORTABLE_STUDY_FOLDER);
  const write = async (path: string, previous: string | null, text: string) => {
    const current = await adapter.exists(path) ? await adapter.read(path) : null;
    if (current !== previous) throw new Error("다른 기기가 공유 파일을 변경했습니다. 다시 시도하세요.");
    if (current === text) return;
    await adapter.write(path, text);
    if (await adapter.read(path) !== text) throw new Error("공유 폴더 준비 중 저장 확인에 실패했습니다. 기존 기록은 유지됩니다.");
  };
  await write(PORTABLE_DATA_PATH, oldData, encode("records", merged));
  await write(PORTABLE_RESUME_PATH, oldResume, encode("resume", chosenResume));
  const marker = encode("mode", { version: 1 });
  await write(MODE_PATH, oldMode, marker);
}
