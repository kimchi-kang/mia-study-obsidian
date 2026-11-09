import type { App } from "obsidian";
import type { MiaDataStore } from "./data-store";
import type { QuestionIndex } from "./question-index";

/**
 * What vault operations need from the plugin. Read each member at the point of
 * use, never once at the start of an operation: `managedRoot` follows the
 * settings, which can change while an operation awaits the vault.
 */
export interface MiaHost {
  readonly app: App;
  readonly store: MiaDataStore;
  readonly index: QuestionIndex;
  readonly managedRoot: string;
}
