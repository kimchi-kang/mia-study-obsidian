import type { App } from "obsidian";
import type { MiaDataStore } from "./data-store";
import type { QuestionIndex } from "./question-index";

/**
 * What vault operations need from the plugin. Services read these on every
 * call rather than capturing them, because the plugin assigns them during load.
 */
export interface MiaHost {
  readonly app: App;
  readonly store: MiaDataStore;
  readonly index: QuestionIndex;
  readonly managedRoot: string;
}
