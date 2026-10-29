import { uiIconMarkup } from "../shared/ui-icons";
import { PDF_FONT, installPdfFont, readPdfFont, removePdfFont } from "./font-store";

export interface PdfExportChoice { fontBytes?: Uint8Array }

export function setupPdfFontControl(): {
  prepareExport: () => Promise<PdfExportChoice | undefined>;
  setExporting: (active: boolean) => void;
  cancel: () => void;
} {
  const action = document.querySelector<HTMLButtonElement>("#pdfFontAction")!;
  const dialog = document.querySelector<HTMLDialogElement>("#pdfFontDialog")!;
  const title = document.querySelector<HTMLElement>("#pdfFontTitle")!;
  const status = document.querySelector<HTMLElement>("#pdfFontStatus")!;
  const progress = document.querySelector<HTMLProgressElement>("#pdfFontProgress")!;
  const install = document.querySelector<HTMLButtonElement>("#pdfFontInstall")!;
  const basic = document.querySelector<HTMLButtonElement>("#pdfFontBasic")!;
  const close = document.querySelector<HTMLButtonElement>("#pdfFontClose")!;
  document.querySelector<HTMLElement>("#pdfFontSize")!.textContent = `完整字体包 · ${(PDF_FONT.bytes / 1_000_000).toFixed(1)} MB · 仅下载一次`;
  let installed = false, exporting = false, skipPrompt = false, disposed = false;
  let choiceRun = 0;
  let mode: "export" | "install" = "install";
  let controller: AbortController | undefined;
  let resolveChoice: ((choice: PdfExportChoice | undefined) => void) | undefined;

  function render(): void {
    action.innerHTML = uiIconMarkup(installed ? "trash" : "wrench");
    action.dataset.state = controller ? "installing" : installed ? "installed" : "missing";
    action.title = installed ? "卸载 PDF 导出字体" : `安装 PDF 导出完整字体包（${(PDF_FONT.bytes / 1_000_000).toFixed(1)} MB）`;
    action.setAttribute("aria-label", action.title);
    action.disabled = exporting || Boolean(controller);
    install.disabled = Boolean(controller);
    install.textContent = controller ? "正在安装…" : mode === "export" ? "安装并导出" : "安装字体包";
    basic.hidden = mode !== "export";
    close.textContent = controller ? "取消下载" : "取消";
    progress.hidden = !controller;
    title.textContent = mode === "export" ? "安装完整字体，提升导出效果" : "安装 PDF 导出字体";
  }

  async function refresh(): Promise<Uint8Array | undefined> {
    try {
      const bytes = await readPdfFont();
      installed = Boolean(bytes);
      return bytes;
    } catch {
      installed = false;
      status.textContent = "无法读取字体缓存，仍可直接导出图像版 PDF。";
      return undefined;
    } finally { if (!disposed) render(); }
  }

  function finish(choice?: PdfExportChoice): void {
    choiceRun++;
    const resolve = resolveChoice;
    resolveChoice = undefined;
    controller?.abort();
    controller = undefined;
    if (dialog.open) dialog.close();
    render();
    resolve?.(choice);
  }

  function show(nextMode: "export" | "install"): void {
    mode = nextMode;
    status.textContent = "字体由 Noto 官方提供。下载仅传输字体数据，不上传文档内容。";
    status.dataset.state = "missing";
    progress.max = PDF_FONT.bytes; progress.value = 0;
    render();
    if (!dialog.open) dialog.showModal();
  }

  async function prepareExport(): Promise<PdfExportChoice | undefined> {
    const run = ++choiceRun;
    const fontBytes = await refresh();
    if (disposed || run !== choiceRun) return undefined;
    if (fontBytes) return { fontBytes };
    if (skipPrompt) return {};
    return new Promise((resolve) => { resolveChoice = resolve; show("export"); });
  }

  install.addEventListener("click", async () => {
    if (controller) return;
    const operation = new AbortController(); controller = operation;
    status.dataset.state = "installing"; status.textContent = "正在下载字体包 · 0%";
    render();
    try {
      const fontBytes = await installPdfFont(operation.signal, (bytes) => {
        if (controller !== operation) return;
        progress.value = bytes;
        status.textContent = bytes === PDF_FONT.bytes ? "下载完成，正在校验…" : `正在下载字体包 · ${Math.floor(bytes / PDF_FONT.bytes * 100)}%`;
      });
      if (controller !== operation || disposed) return;
      installed = true; skipPrompt = false;
      status.textContent = "完整字体已安装，可离线导出可搜索、可复制的 PDF。";
      finish(mode === "export" ? { fontBytes } : undefined);
    } catch (error) {
      if (controller !== operation || disposed) return;
      status.dataset.state = "error";
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (controller === operation) { controller = undefined; render(); }
    }
  });
  basic.addEventListener("click", () => { skipPrompt = true; finish({}); });
  close.addEventListener("click", () => finish());
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(); });
  dialog.addEventListener("close", () => { if (resolveChoice || controller) finish(); });
  action.addEventListener("click", async () => {
    if (exporting || controller) return;
    if (installed) {
      action.disabled = true;
      try { await removePdfFont(); installed = false; skipPrompt = false; render(); }
      catch (error) { show("install"); status.textContent = `卸载失败：${error instanceof Error ? error.message : String(error)}`; }
    } else show("install");
  });
  const onFocus = () => { if (!controller && !exporting) void refresh(); };
  window.addEventListener("focus", onFocus);
  window.addEventListener("pagehide", () => {
    disposed = true; finish(); window.removeEventListener("focus", onFocus);
  }, { once: true });
  void refresh();
  return { prepareExport, cancel: () => finish(), setExporting: (active) => { exporting = active; render(); } };
}
