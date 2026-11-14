/** The small portion of Obsidian's Modal contract needed for guarded opening. */
export interface OpenableModal {
  open(): void;
  onClose?: () => void;
}

/** A stable key for one dialog kind and, when needed, its target. */
export function dialogKey(kind: string, target?: string): string {
  return JSON.stringify([kind, target ?? null]);
}

/** Prevents duplicate modal instances while preserving their normal close lifecycle. */
export class ModalOpenGuard {
  private readonly active = new Set<string>();

  open(key: string, create: () => OpenableModal): boolean {
    const release = this.claim(key);
    if (!release) return false;
    try {
      return this.present(create(), release);
    } catch (error) {
      release();
      throw error;
    }
  }

  openAsync(key: string, create: () => OpenableModal | null | Promise<OpenableModal | null>): Promise<boolean> {
    const release = this.claim(key);
    if (!release) return Promise.resolve(false);
    let created: OpenableModal | null | Promise<OpenableModal | null>;
    try {
      // Invoke synchronously so existing setup starts before the caller resumes,
      // while the reserved key still covers any asynchronous preparation.
      created = create();
    } catch (error) {
      release();
      return Promise.reject(error);
    }
    return Promise.resolve(created)
      .then((modal) => {
        if (!modal) {
          release();
          return false;
        }
        return this.present(modal, release);
      })
      .catch((error: unknown) => {
        release();
        throw error;
      });
  }

  private claim(key: string): (() => void) | null {
    if (this.active.has(key)) return null;
    this.active.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(key);
    };
  }

  private present(modal: OpenableModal, release: () => void): boolean {
    const originalOnClose = modal.onClose;
    if (typeof originalOnClose === "function") {
      modal.onClose = () => {
        try {
          originalOnClose.call(modal);
        } finally {
          release();
        }
      };
    }
    try {
      modal.open();
      // Test doubles and non-Obsidian modal adapters may omit the close hook.
      if (typeof originalOnClose !== "function") release();
      return true;
    } catch (error) {
      release();
      throw error;
    }
  }
}
