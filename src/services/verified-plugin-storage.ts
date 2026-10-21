import type { DataAdapter } from "obsidian";

export interface PluginDataStorage {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export class VerifiedPluginStorage implements PluginDataStorage {
  constructor(
    private readonly plugin: PluginDataStorage,
    private readonly adapter: Pick<DataAdapter, "exists" | "read">,
    private readonly path: string,
  ) {}

  async loadData(): Promise<unknown> {
    const data = await this.plugin.loadData();
    if (data !== null && data !== undefined) return data;
    if (!await this.adapter.exists(this.path)) return null;
    const existing = await this.readExisting();
    if (existing === null) throw new Error("복습 기록 파일에 유효한 데이터가 없습니다. 기존 파일을 덮어쓰지 않았습니다.");
    return existing;
  }

  async saveData(data: unknown): Promise<void> {
    // Some Obsidian versions swallow adapter write errors. Keep native change tracking,
    // but acknowledge success only after the requested bytes can be read as the same data.
    await this.plugin.saveData(data);
    const content = await this.adapter.read(this.path);
    const pretty = content.startsWith("{\n  ") || content.startsWith("[\n  ");
    const requested = JSON.stringify(data, undefined, pretty ? 2 : undefined);
    // Exact JSON bytes prove equality without parsing and reserializing the full file.
    if (content === requested) return;
    const persisted = this.parseContent(content);
    if (JSON.stringify(persisted) !== (pretty ? JSON.stringify(data) : requested)) {
      throw new Error("복습 기록을 저장한 뒤 파일에서 같은 내용을 확인하지 못했습니다. 최신 기록을 확인한 뒤 다시 시도하세요.");
    }
  }

  private async readExisting(): Promise<unknown> {
    return this.parseContent(await this.adapter.read(this.path));
  }

  private parseContent(content: string): unknown {
    try { return JSON.parse(content); }
    catch { throw new Error("복습 기록 파일의 형식을 읽지 못했습니다. 기존 파일을 덮어쓰지 않았습니다."); }
  }
}
