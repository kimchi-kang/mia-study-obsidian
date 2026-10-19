interface LocalStore {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: unknown): void;
}
type StartupPhase = "starting" | "loaded" | "failed" | "unloaded";
interface StartupEvent { phase: StartupPhase; version: string; at: string; errorName?: string }
const KEY = "mia-study:startup-diagnostics:v1";
const phases: readonly string[] = ["starting", "loaded", "failed", "unloaded"];
function events(value: unknown): StartupEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is StartupEvent => entry !== null && typeof entry === "object"
    && phases.includes(entry.phase) && typeof entry.version === "string" && typeof entry.at === "string"
    && (entry.errorName === undefined || typeof entry.errorName === "string"));
}

// Device-local only. Do not put note contents, paths or error messages in shared diagnostics.
export class StartupDiagnostics {
  private history: StartupEvent[] = [];
  constructor(private readonly store: LocalStore, private readonly version: string) {
    try { this.history = events(store.loadLocalStorage(KEY)); }
    catch (error) { console.warn("MIA 시작 기록 읽기 실패", error); }
  }
  record(phase: StartupPhase, error?: unknown): void {
    this.history = [...this.history.slice(-19), { phase, version: this.version, at: new Date().toISOString(),
      ...(error instanceof Error ? { errorName: error.name } : {}) }];
    try { this.store.saveLocalStorage(KEY, this.history); }
    catch (storageError) { console.warn("MIA 시작 기록 저장 실패", storageError); }
  }
  summary(): string {
    const latest = this.history.at(-1);
    const failure = [...this.history].reverse().find((event) => event.phase === "failed");
    const labels: Record<StartupPhase, string> = { starting: "시작 중", loaded: "플러그인 불러옴", failed: "시작 실패", unloaded: "종료됨" };
    return `MIA ${this.version} · 현재 ${latest ? labels[latest.phase] : "기록 없음"}${failure ? ` · 최근 시작 실패 ${failure.at} (${failure.errorName ?? "알 수 없는 오류"})` : " · 기록된 시작 실패 없음"} · 활성화 목록 변경의 주체는 이 기록만으로 알 수 없습니다.`;
  }
}
