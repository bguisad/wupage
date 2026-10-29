import { applyPopupMenuLayout, DEFAULT_POPUP_MENU, normalizePopupMenu, POPUP_MENU_GROUPS, POPUP_MENU_ITEMS,
  type PopupMenuItem, type PopupMenuLayout } from "../shared/popup-menu";
import "./popup-menu.css";

export function setupPopupMenuControls(root: HTMLElement): { render: (value: unknown) => void; read: () => PopupMenuLayout } {
  const list = root.querySelector<HTMLElement>("#popupMenuItems")!;
  const preview = root.querySelector<HTMLElement>("#popupMenuPreview")!;
  const status = root.querySelector<HTMLElement>("#popupMenuStatus")!;
  let draft = normalizePopupMenu(undefined);

  for (const item of POPUP_MENU_ITEMS) {
    const button = document.createElement("button");
    button.type = "button"; button.disabled = true; button.tabIndex = -1;
    button.dataset.popupMenuItem = item.id; button.textContent = item.label;
    if (item.group === "features" || item.id === "paragraphMode") button.className = "menu-preview-feature";
    if (item.id === "pageToggle") button.className = "menu-preview-primary";
    preview.querySelector(`[data-popup-menu-group="${item.group}"]`)!.append(button);
  }

  function paint(focus?: { id: PopupMenuItem; direction?: string }): void {
    list.replaceChildren();
    for (const group of POPUP_MENU_GROUPS) {
      const members = POPUP_MENU_ITEMS.filter(item => item.group === group.id);
      const ids = draft.order.filter(id => members.some(item => item.id === id));
      const fieldset = document.createElement("fieldset"); fieldset.className = "menu-layout-group";
      const legend = document.createElement("legend"); legend.textContent = group.label; fieldset.append(legend);
      for (const [index, id] of ids.entries()) {
        const item = members.find(item => item.id === id)!;
        const row = document.createElement("div"); row.className = "menu-layout-row";
        const label = document.createElement("label");
        const checkbox = document.createElement("input"); checkbox.type = "checkbox";
        checkbox.checked = !draft.hidden.includes(id); checkbox.dataset.menuVisible = id;
        label.append(checkbox, document.createTextNode(item.label)); row.append(label);
        checkbox.addEventListener("change", () => {
          draft.hidden = checkbox.checked ? draft.hidden.filter(hidden => hidden !== id) : [...draft.hidden, id];
          status.textContent = `已${checkbox.checked ? "显示" : "隐藏"}${item.label}，保存后生效。`;
          paint({ id });
        });
        for (const direction of [-1, 1]) {
          const button = document.createElement("button"); button.type = "button";
          const action = direction < 0 ? "上移" : "下移";
          button.className = "menu-layout-move secondary";
          button.textContent = direction < 0 ? "↑" : "↓";
          button.dataset.menuMove = `${id}:${direction}`;
          button.setAttribute("aria-label", `${action}${item.label}`); button.title = `${action}${item.label}`;
          button.disabled = index + direction < 0 || index + direction >= ids.length;
          button.addEventListener("click", () => {
            const other = ids[index + direction], first = draft.order.indexOf(id), second = draft.order.indexOf(other);
            if (!other) return;
            [draft.order[first], draft.order[second]] = [draft.order[second], draft.order[first]];
            status.textContent = `已${action}${item.label}，保存后生效。`;
            paint({ id, direction: String(direction) });
          });
          row.append(button);
        }
        fieldset.append(row);
      }
      list.append(fieldset);
    }
    applyPopupMenuLayout(preview, draft);
    if (focus) {
      const move = root.querySelector<HTMLButtonElement>(`[data-menu-move="${focus.id}:${focus.direction}"]`);
      (move && !move.disabled ? move : root.querySelector<HTMLInputElement>(`[data-menu-visible="${focus.id}"]`))?.focus({ preventScroll: true });
    }
  }
  root.querySelector("#resetPopupMenu")!.addEventListener("click", () => {
    draft = normalizePopupMenu(DEFAULT_POPUP_MENU); paint(); status.textContent = "已恢复默认布局，保存后生效。";
  });
  return {
    render(value) { draft = normalizePopupMenu(value); status.textContent = ""; paint(); },
    read: () => normalizePopupMenu(draft)
  };
}
