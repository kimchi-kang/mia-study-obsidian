import type { MiaPluginData, SettingsSnapshot } from "./models";

export function settingsKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(settingsKey).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${settingsKey(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

// Legacy snapshots have no edit identity. Preserve their complete value rather
// than inventing a common edit base or inferring causality from device clocks.
export function settingsSnapshot(data: MiaPluginData): SettingsSnapshot {
  return { id: data.settingsSync?.id ?? `legacy:${settingsKey(data.settings)}`,
    ancestors: [...(data.settingsSync?.ancestors ?? [])], settings: structuredClone(data.settings) };
}
export function mergeSettings(local: MiaPluginData, incoming: MiaPluginData, next: MiaPluginData): void {
  if (!local.settingsSync && !incoming.settingsSync && settingsKey(local.settings) === settingsKey(incoming.settings)) return;
  const left = settingsSnapshot(local), right = settingsSnapshot(incoming);
  if (left.id === right.id && settingsKey(left.settings) !== settingsKey(right.settings)) throw new Error("같은 설정 변경 번호의 내용이 달라 저장을 중단했습니다. 양쪽 파일을 보존하세요.");
  const leftAfter = left.ancestors.includes(right.id), rightAfter = right.ancestors.includes(left.id);
  if (leftAfter && rightAfter) throw new Error("설정 변경 계보가 순환하여 저장을 중단했습니다.");
  const winner = leftAfter ? left : rightAfter ? right : left.id > right.id ? left : right;
  const alternatives = [...(local.settingsSync?.conflicts ?? []), ...(incoming.settingsSync?.conflicts ?? [])];
  if (left.id !== right.id && !leftAfter && !rightAfter) alternatives.push(winner === left ? right : left);
  const unique = new Map<string, SettingsSnapshot>();
  for (const item of alternatives) {
    const existing = unique.get(item.id);
    if (existing && settingsKey(existing) !== settingsKey(item)) throw new Error("보관된 설정 변경 번호가 충돌했습니다. 원본을 보존하세요.");
    if (item.id !== winner.id) unique.set(item.id, structuredClone(item));
  }
  next.settings = structuredClone(winner.settings);
  next.settingsSync = { id: winner.id, ancestors: [...winner.ancestors], conflicts: [...unique.values()].sort((a,b)=>a.id.localeCompare(b.id)) };
}
export function reviseSettings(data: MiaPluginData): void {
  const previous = settingsSnapshot(data);
  data.settingsSync = { id: crypto.randomUUID(), ancestors: [...new Set([...previous.ancestors,previous.id])].sort(), conflicts: structuredClone(data.settingsSync?.conflicts ?? []) };
}

/** Three-way editing only with an explicitly captured base. Arrays are atomic. */
export function rebaseSettings(base: unknown, desired: unknown, current: unknown, path = ""): { value: unknown; conflicts: string[] } {
  const equal = (a: unknown, b: unknown) => settingsKey(a) === settingsKey(b);
  if (equal(base, desired)) return { value: structuredClone(current), conflicts: [] };
  if (equal(base, current) || equal(desired, current)) return { value: structuredClone(desired), conflicts: [] };
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (record(base) && record(desired) && record(current)) {
    const value: Record<string, unknown> = {}, conflicts: string[] = [];
    for (const key of new Set([...Object.keys(base), ...Object.keys(desired), ...Object.keys(current)])) {
      const result = rebaseSettings(base[key], desired[key], current[key], path ? `${path}.${key}` : key);
      if (result.value !== undefined) value[key] = result.value;
      conflicts.push(...result.conflicts);
    }
    return { value, conflicts };
  }
  return { value: structuredClone(current), conflicts: [path] };
}
