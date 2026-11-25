import { expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { DEFAULT_PLUGIN_DATA } from "../src/core/models";
import { MiaDataStore } from "../src/services/data-store";

function environment() {
  const storage = {
    loadData: vi.fn(async (): Promise<unknown> => structuredClone(DEFAULT_PLUGIN_DATA)),
    saveData: vi.fn(async () => {}),
  };
  const recovery = { read: () => null, write: vi.fn() };
  return { storage, recovery, store: new MiaDataStore(storage, recovery) };
}

it("정규화 결과가 같아도 디스크 원본이 바뀌면 다시 검증한다", async () => {
  const { storage, recovery, store } = environment();
  await store.load();
  await store.synchronize();
  recovery.write.mockClear();

  const raw = { ...DEFAULT_PLUGIN_DATA, unusedField: true };
  storage.loadData.mockImplementation(async () => structuredClone(raw));
  await store.synchronize();
  expect(recovery.write).toHaveBeenCalledOnce();
  expect(storage.saveData).not.toHaveBeenCalled();

  await store.synchronize();
  expect(recovery.write).toHaveBeenCalledOnce();
});

/** 디스크를 문자열로 들고 있어 "예전 내용으로 되돌리기"를 그대로 재현한다. */
function diskEnvironment() {
  const disk = { text: JSON.stringify(DEFAULT_PLUGIN_DATA) };
  const storage = {
    loadData: async (): Promise<unknown> => JSON.parse(disk.text),
    saveData: async (value: unknown) => { disk.text = JSON.stringify(value); },
  };
  return { disk, store: new MiaDataStore(storage, { read: () => null, write: () => {} }) };
}

// 빠른 경로가 "디스크 원본이 같다"만 보고 건너뛰면, 로컬 변경 뒤 디스크가
// 예전 내용으로 되돌아간 경우(다른 기기·동기화 도구가 옛 파일을 덮어씀) 로컬 변경을 다시 저장하지 않는다.
it("로컬 복습 기록 뒤 디스크가 예전 내용으로 돌아가면 기록을 지키고 다시 저장한다", async () => {
  const { disk, store } = diskEnvironment();
  await store.load();
  await store.synchronize(); await store.synchronize();
  const before = disk.text;

  const state = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 })
    .rate(undefined, Rating.Good, new Date("2026-10-27T00:00:00Z"), "local");
  await store.setReview("local", state);
  disk.text = before;
  await store.synchronize();

  expect(store.getReview("local")).toEqual(state);
  expect(JSON.parse(disk.text).reviews.local).toEqual(state);
});

it("로컬 설정 변경 뒤 디스크가 예전 내용으로 돌아가면 설정을 지키고 다시 저장한다", async () => {
  const { disk, store } = diskEnvironment();
  await store.load();
  await store.synchronize(); await store.synchronize();
  const before = disk.text;

  await store.updateSettings({ targetRetention: 0.85 });
  disk.text = before;
  await store.synchronize();

  expect(store.settings.targetRetention).toBe(0.85);
  expect(JSON.parse(disk.text).settings.targetRetention).toBe(0.85);
});

it("디스크 읽기 오류 이후에는 이전 원본과 같아도 전체 동기화를 다시 수행한다", async () => {
  const { storage, recovery, store } = environment();
  await store.load();
  await store.synchronize();
  recovery.write.mockClear();

  storage.loadData.mockRejectedValueOnce(new Error("파일 읽기 실패"));
  await expect(store.synchronize()).rejects.toThrow("파일 읽기 실패");
  expect(recovery.write).not.toHaveBeenCalled();

  await store.synchronize();
  expect(recovery.write).toHaveBeenCalledOnce();
  expect(storage.saveData).not.toHaveBeenCalled();
});
