// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPopupMenuLayout, DEFAULT_POPUP_MENU, normalizePopupMenu, POPUP_MENU_ITEMS } from "../src/shared/popup-menu";
import { normalizeAppearance } from "../src/shared/appearance";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const mount = () => { document.open(); document.write(readFileSync("popup.html", "utf8")); document.close(); };

describe("popup menu preferences", () => {
  it("keeps all entries for older settings and returns independent arrays", () => {
    const layout = normalizeAppearance(undefined).popupMenu;
    expect(layout).toEqual(DEFAULT_POPUP_MENU);
    layout.hidden.push("debug"); layout.order.reverse();
    expect(normalizePopupMenu(undefined)).toEqual(DEFAULT_POPUP_MENU);
  });

  it("drops unknown and duplicate IDs, retains explicit hiding and appends missing entries", () => {
    const result = normalizePopupMenu({ order: ["videoTranslation", "videoTranslation", "unknown", null], hidden: ["debug", "debug", "bad"] });
    expect(result.order[0]).toBe("videoTranslation");
    expect(new Set(result.order).size).toBe(POPUP_MENU_ITEMS.length);
    expect(result.hidden).toEqual(["debug"]);
    expect(normalizePopupMenu({ order: "invalid", hidden: false })).toEqual(DEFAULT_POPUP_MENU);
  });

  it("reorders existing controls without replacing their listeners, values or OCR helpers", () => {
    mount();
    const button = document.querySelector<HTMLButtonElement>("#contextMenuTranslation")!;
    const helper = document.querySelector("#ocrModelAction");
    button.disabled = false; button.setAttribute("aria-pressed", "true");
    const clicked = vi.fn(); button.addEventListener("click", clicked);
    const order = [...DEFAULT_POPUP_MENU.order].reverse();
    applyPopupMenuLayout(document, { order, hidden: [] });
    expect([...document.querySelector('[data-popup-menu-group="features"]')!.children].map(node => (node as HTMLElement).dataset.popupMenuItem))
      .toEqual(["videoTranslation", "imageTranslation", "selectionTranslation", "floatingBall", "contextMenuTranslation"]);
    expect(document.querySelector("#contextMenuTranslation")).toBe(button);
    expect(document.querySelector("#ocrModelAction")).toBe(helper);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.click(); expect(clicked).toHaveBeenCalledOnce();
    applyPopupMenuLayout(document, DEFAULT_POPUP_MENU); button.click(); expect(clicked).toHaveBeenCalledTimes(2);
  });

  it("collapses empty groups while keeping settings accessible and preserving feature state", () => {
    mount();
    const video = document.querySelector<HTMLElement>("#videoTranslation")!; video.setAttribute("aria-pressed", "true");
    applyPopupMenuLayout(document, { hidden: DEFAULT_POPUP_MENU.order });
    expect([...document.querySelectorAll<HTMLElement>("[data-popup-menu-group]")].every(group => group.hidden)).toBe(true);
    expect(document.querySelector<HTMLElement>("#openOptions")!.hidden).toBe(false);
    expect(video.getAttribute("aria-pressed")).toBe("true");
    applyPopupMenuLayout(document, DEFAULT_POPUP_MENU);
    expect(document.querySelector("#videoTranslation")).toBe(video);
    expect(video.hasAttribute("data-popup-menu-hidden")).toBe(false);
  });

  it("respects touch-only paragraph visibility and fills the remaining action row", () => {
    mount();
    const paragraph = document.querySelector<HTMLElement>("#paragraphMode")!;
    paragraph.hidden = true;
    applyPopupMenuLayout(document, DEFAULT_POPUP_MENU);
    expect(paragraph.hidden).toBe(true);
    expect(document.querySelector("#pageToggle")!.hasAttribute("data-popup-menu-wide")).toBe(true);
    applyPopupMenuLayout(document, { hidden: ["pageToggle"] });
    expect(document.querySelector<HTMLElement>('[data-popup-menu-group="translation"]')!.hidden).toBe(true);
    paragraph.hidden = false; applyPopupMenuLayout(document, { hidden: ["pageToggle"] });
    expect(document.querySelector<HTMLElement>('[data-popup-menu-group="translation"]')!.hidden).toBe(false);
    expect(paragraph.hasAttribute("data-popup-menu-wide")).toBe(true);
  });

  it("does not mutate an unchanged layout during unrelated settings saves", () => {
    mount(); applyPopupMenuLayout(document, DEFAULT_POPUP_MENU);
    const observer = new MutationObserver(() => {}); observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    applyPopupMenuLayout(document, DEFAULT_POPUP_MENU);
    expect(observer.takeRecords()).toEqual([]); observer.disconnect();
  });
});
