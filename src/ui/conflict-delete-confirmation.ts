import type { App } from "obsidian";
import { ConfirmDeleteModal } from "./manage-modals";

export function confirmConflictDeletion(
  app: App, label: string, description: string, remove: () => Promise<void>, setBusy: (busy: boolean) => void,
): void {
  let open = true;
  let saving = false;
  const confirm = new ConfirmDeleteModal(app, label, description, "지우기", async () => {
    saving = true;
    try { await remove(); }
    finally { saving = false; if (!open) setBusy(false); }
  }, "보관 기록 지우기 실패");
  const close = confirm.onClose.bind(confirm);
  confirm.onClose = () => {
    close();
    open = false;
    if (!saving) setBusy(false);
  };
  setBusy(true);
  try { confirm.open(); }
  catch (error) { setBusy(false); throw error; }
}
