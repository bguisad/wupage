export const POPUP_MENU_GROUPS = [
  { id: "features", label: "功能开关" }, { id: "translation", label: "翻译操作" },
  { id: "tools", label: "工具" }, { id: "links", label: "链接" }
] as const;
export const POPUP_MENU_ITEMS = [
  { id: "contextMenuTranslation", label: "右键翻译", group: "features" },
  { id: "floatingBall", label: "悬浮球", group: "features" },
  { id: "selectionTranslation", label: "划词翻译", group: "features" },
  { id: "imageTranslation", label: "图片翻译", group: "features" },
  { id: "videoTranslation", label: "视频字幕", group: "features" },
  { id: "pageToggle", label: "翻译全文", group: "translation" },
  { id: "paragraphMode", label: "段落翻译", group: "translation" },
  { id: "openPdfWorkspace", label: "打开 PDF", group: "tools" },
  { id: "debug", label: "Debug", group: "tools" },
  { id: "clearCache", label: "清除缓存", group: "tools" },
  { id: "openGithub", label: "GitHub", group: "links" },
  { id: "openWebsite", label: "官网", group: "links" }
] as const;
export type PopupMenuItem = typeof POPUP_MENU_ITEMS[number]["id"];
export interface PopupMenuLayout { order: PopupMenuItem[]; hidden: PopupMenuItem[] }
export const DEFAULT_POPUP_MENU: PopupMenuLayout = { order: POPUP_MENU_ITEMS.map(item => item.id), hidden: [] };

export function normalizePopupMenu(value: unknown): PopupMenuLayout {
  const input = value && typeof value === "object" ? value as Partial<PopupMenuLayout> : {};
  const known = new Set<string>(DEFAULT_POPUP_MENU.order);
  const valid = (list: unknown): PopupMenuItem[] => Array.isArray(list)
    ? [...new Set(list.filter((id): id is PopupMenuItem => typeof id === "string" && known.has(id)))] : [];
  const order = valid(input.order);
  return { order: [...order, ...DEFAULT_POPUP_MENU.order.filter(id => !order.includes(id))], hidden: valid(input.hidden) };
}

/** Move existing controls, retaining their events, state and capability visibility. */
export function applyPopupMenuLayout(root: ParentNode, value: unknown): void {
  const layout = normalizePopupMenu(value), hidden = new Set(layout.hidden);
  const nodes = new Map([...root.querySelectorAll<HTMLElement>("[data-popup-menu-item]")]
    .map(node => [node.dataset.popupMenuItem!, node]));
  for (const { id } of POPUP_MENU_GROUPS) {
    const group = root.querySelector<HTMLElement>(`[data-popup-menu-group="${id}"]`);
    if (!group) continue;
    const members = new Set<string>(POPUP_MENU_ITEMS.filter(item => item.group === id).map(item => item.id));
    const items = layout.order.filter(item => members.has(item)).map(item => nodes.get(item)).filter((node): node is HTMLElement => !!node);
    for (const [index, node] of items.entries()) {
      const before = group.children[index];
      if (node !== before) group.insertBefore(node, before ?? null);
      node.toggleAttribute("data-popup-menu-hidden", hidden.has(node.dataset.popupMenuItem as PopupMenuItem));
    }
    const visible = items.filter(node => !node.hidden && !node.hasAttribute("data-popup-menu-hidden"));
    const wide = new Set<HTMLElement>();
    let run: HTMLElement[] = [];
    const finish = () => { if (run.length % 2) wide.add(run.at(-1)!); run = []; };
    for (const node of visible) {
      if (node.dataset.popupMenuItem === "openPdfWorkspace") { finish(); wide.add(node); }
      else run.push(node);
    }
    finish();
    for (const node of items) node.toggleAttribute("data-popup-menu-wide", wide.has(node));
    if (group.hidden !== !visible.length) group.hidden = !visible.length;
  }
}
