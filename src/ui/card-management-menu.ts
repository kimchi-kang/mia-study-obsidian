import { Menu } from "obsidian";

export function renderCardManagementMenu(
  parent: HTMLElement,
  name: string,
  editLabel: string,
  edit: () => void,
  remove: () => void,
): void {
  const button = parent.createEl("button", {
    cls: "mia-card-menu-button",
    text: "⋯",
    attr: { type: "button", "aria-label": `${name} 관리`, "aria-haspopup": "menu" },
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem(item => item.setTitle(editLabel).onClick(edit));
    menu.addItem(item => {
      item.setTitle("삭제");
      item.setWarning?.(true);
      item.onClick(remove);
    });
    if (event.detail === 0) {
      const { left, bottom } = button.getBoundingClientRect();
      menu.showAtPosition({ x: left, y: bottom }, button.ownerDocument);
    } else {
      menu.showAtMouseEvent(event);
    }
  });
}
