import { obsidianLayoutBoundary } from "./study-layout-obsidian";

// Only host UI primitives are simulated; every plugin screen uses its real renderer.
export function slimLayoutBoundary() {
  class Modal {
    constructor(app) {
      this.app = app;
      this.containerEl = document.body.createDiv({ cls: "modal-container" });
      this.containerEl.createDiv({ cls: "modal-bg" }).addEventListener("click", () => this.close());
      this.modalEl = this.containerEl.createDiv({ cls: "modal" });
      this.modalEl.createDiv({ cls: "modal-close-button" }).addEventListener("click", () => this.close());
      this.titleEl = this.modalEl.createDiv({ cls: "modal-header" }).createDiv({ cls: "modal-title" });
      this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
    }
    setTitle(title) { this.titleEl.setText(title); }
    escape = event => {
      if (event.key === "Escape" && [...document.querySelectorAll(".modal-container")].at(-1) === this.containerEl) this.close();
    };
    open() { document.addEventListener("keydown", this.escape); this.onOpen(); }
    close() {
      document.removeEventListener("keydown", this.escape);
      this.onClose?.();
      this.containerEl.remove();
    }
  }
  class Setting {
    constructor(parent) {
      this.settingEl = parent.createDiv({ cls: "setting-item" });
      this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
      this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
      this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
      this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
    }
    setName(text) { this.nameEl.setText(text); return this; }
    setDesc(text) { this.descEl.setText(text); return this; }
    addControl(tag, key, callback) {
      const el = this.controlEl.createEl(tag);
      if (tag === "select") el.className = "dropdown";
      const control = {
        [key]: el,
        setDisabled(value) { el.disabled = value; return this; },
        setValue(value) { el.value = value; return this; },
        setPlaceholder(value) { el.placeholder = value; return this; },
        addOption(value, text) { const option = el.createEl("option", { text }); option.value = value; return this; },
        onChange(fn) { el.addEventListener("change", () => fn(el.value)); return this; },
      };
      callback(control); return this;
    }
    addButton(callback) {
      const el = this.controlEl.createEl("button");
      const control = {
        buttonEl: el,
        setButtonText(text) { el.setText(text); return this; },
        setCta() { el.addClass("mod-cta"); return this; },
        setWarning() { el.addClass("mod-warning"); return this; },
        setDisabled(value) { el.disabled = value; return this; },
        onClick(fn) { el.addEventListener("click", fn); return this; },
      };
      callback(control); return this;
    }
    addSearch(fn) { return this.addControl("input", "inputEl", control => { control.inputEl.type = "search"; fn(control); }); }
    addText(fn) { return this.addControl("input", "inputEl", fn); }
    addTextArea(fn) { return this.addControl("textarea", "inputEl", fn); }
    addDropdown(fn) { return this.addControl("select", "selectEl", fn); }
    addToggle(fn) {
      this.settingEl.addClass("mod-toggle");
      const el = this.controlEl.createDiv({ cls: "checkbox-container", attr: { role: "checkbox", tabindex: "0" } });
      const input = el.createEl("input", { attr: { type: "checkbox" } });
      fn({ toggleEl: el, setValue(value) { input.checked = value; el.toggleClass("is-enabled", value); el.setAttr("aria-checked", String(value)); return this; }, onChange(callback) { input.addEventListener("change", () => callback(input.checked)); return this; } });
      return this;
    }
  }
  return { ...obsidianLayoutBoundary(), Modal, Setting,
    PluginSettingTab: class { constructor(app) { this.app = app; this.containerEl = document.body.createDiv({ cls: "vertical-tab-content" }); } hide() {} },
  };
}

/** Obsidian createEl also accepts native attributes outside `attr`. */
export function installLayoutOptions(dom) {
  const prototype = dom.window.HTMLElement.prototype;
  const create = prototype.createEl;
  prototype.createEl = function(tag, options = {}) {
    const element = create.call(this, tag, options);
    for (const key of ["type", "value", "placeholder", "title", "href"]) {
      if (options[key] !== undefined) element.setAttribute(key, String(options[key]));
    }
    return element;
  };
}

/** outerHTML alone drops live input values, textarea contents and selections. */
export function snapshotLayout(root) {
  const clone = root.cloneNode(true);
  const controls = root.querySelectorAll("input, textarea, select");
  const copies = clone.querySelectorAll("input, textarea, select");
  controls.forEach((control, index) => {
    const copy = copies[index];
    if (control.tagName === "TEXTAREA") copy.textContent = control.value;
    else if (control.tagName === "SELECT") {
      [...control.options].forEach((option, position) => {
        copies[index].options[position].toggleAttribute("selected", option.selected);
      });
    } else {
      copy.setAttribute("value", control.value);
      if (["checkbox", "radio"].includes(control.type)) copy.toggleAttribute("checked", control.checked);
    }
  });
  return clone.outerHTML;
}
