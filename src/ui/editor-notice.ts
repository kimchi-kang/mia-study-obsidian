import { Notice } from "obsidian";
import { errorMessage } from "./error-message";

export async function openEditorWithNotice(label: string, open: () => void | Promise<void>): Promise<void> {
  try {
    await open();
  } catch (error) {
    new Notice(`${label} 열기 실패: ${errorMessage(error)}`);
  }
}
