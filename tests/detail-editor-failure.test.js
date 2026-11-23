import { it, expect, vi } from "vitest";
const notices = vi.hoisted(() => []);
vi.mock("obsidian", () => ({
  Plugin: class {}, Modal: class {}, ItemView: class {}, PluginSettingTab: class {}, MarkdownView: class {},
  TFile: class {}, TFolder: class {}, Component: class {}, Setting: class {}, Platform: { isMobile: false }, normalizePath: path => path,
  Notice: class { constructor(message) { notices.push(message); } },
}));
import MiaStudyPlugin from "../src/main";
import { FsrsService } from "../src/core/fsrs-service";

// 1.7.10부터 문제 목록 행에는 편집·연결 버튼이 없고 상세에서만 연다. 상세에서 열기가 실패해도 행 버튼 시절처럼 안내가 떠야 한다.
function detailPlugin() {
  const plugin = new MiaStudyPlugin();
  const question = { id: "mia-q-geo", subject: "지리학", heading: "기후대 구분", questionMarkdown: "질문", answerMarkdown: "정답", coreKeywords: [], subKeywords: [] };
  plugin.app = {};
  plugin.index = { registered: [question], questionById: id => id === question.id ? question : undefined };
  plugin.store = { reviews: {}, getReview: () => undefined, settings: {} };
  plugin.fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
  plugin.loadKeywordMeanings = async () => new Map();
  return { plugin, question };
}

it.each([
  ["edit", "openManagedQuestionEditor", "문제 편집"],
  ["connections", "openFollowUpEditor", "문제 연결"],
])("reports a failure to open the detail's %s editor as a notice", async (action, opener, label) => {
  const { plugin, question } = detailPlugin();
  plugin[opener] = vi.fn(async () => { throw new Error("원본이 바뀌었습니다."); });
  const { actions } = await plugin.questionDetailSource(question);
  const before = notices.length;
  await expect(actions[action]()).resolves.toBeUndefined();
  expect(plugin[opener]).toHaveBeenCalledWith(question);
  expect(notices.slice(before)).toEqual([`${label} 열기 실패: 원본이 바뀌었습니다.`]);
});
