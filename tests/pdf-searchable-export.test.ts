import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, PDFName, PDFRawStream, PDFDict, decodePDFRawStream } from "pdf-lib";
import { removePdfText } from "../src/pdf/content-stream";
import { buildSearchablePdf } from "../src/pdf/vector-export";

describe("searchable PDF export", () => {
  it("removes text operands without interpreting operators inside strings, arrays or comments", () => {
    const source = String.raw`q 1 0 0 1 10 20 cm BT /F1 10 Tf (text Tj \(parentheses\)) Tj [<0031> 20 (BT ET)] TJ 1 2 (next) " (line) ' ET
% (comment Tj)
0 0 m 30 40 l S Q`;
    const clean = new TextDecoder().decode(removePdfText(new TextEncoder().encode(source)));
    expect(clean).not.toContain("parentheses");
    expect(clean).not.toContain("0031");
    expect(clean).not.toContain("/F1");
    expect(clean).toContain("0 0 m 30 40 l S");
    expect(clean).toContain("% (comment Tj)");
    expect(removePdfText(new TextEncoder().encode("BI /W 1 /H 1 ID opaque EI"))).toBeUndefined();
    expect(removePdfText(new TextEncoder().encode("BT 7 Tr (mask) Tj ET"))).toBeUndefined();
  });

  it("embeds Unicode text and retains vector graphics while removing the replaced source text", async () => {
    const source = await PDFDocument.create(), page = source.addPage([400, 500]);
    const latin = await source.embedFont(StandardFonts.Helvetica);
    page.drawText("Original words must be removed.", { x: 30, y: 420, size: 12, font: latin });
    page.drawLine({ start: { x: 20, y: 100 }, end: { x: 300, y: 150 }, thickness: 2 });
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const fontBytes = new Uint8Array(await readFile("public/pdf-fonts/NotoSansCJKsc-VF.ttf"));
    const bytes = await buildSearchablePdf([{ width: 400, height: 500, imageBytes: png, format: "png", scene: {
      unchanged: false, transform: [1, 0, 0, -1, 0, 500], images: [], text: [{ text: "中文译文 日本語 한국어 Русский", x: 30, y: 80, size: 12, width: 250, color: [0, 0, 0] }]
    } }], "Searchable translation", await source.save(), fontBytes);
    const exported = await PDFDocument.load(bytes);
    expect(exported.getPageCount()).toBe(1);
    const streams = exported.context.enumerateIndirectObjects().flatMap(([, object]) => object instanceof PDFRawStream
      ? [new TextDecoder().decode(decodePDFRawStream(object).decode())] : []);
    expect(streams.some((text) => text.includes("beginbfchar"))).toBe(true);
    expect(streams.some((text) => text.includes(" m\n") && text.includes(" l\n"))).toBe(true);
    expect(exported.getPage(0).node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict)).toBeDefined();
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: bytes.slice() }), pdf = await loading.promise;
    const text = (await (await pdf.getPage(1)).getTextContent()).items.flatMap((item) => "str" in item ? [item.str] : []).join("");
    expect(text).toBe("中文译文 日本語 한국어 Русский");
    expect(text).not.toContain("Original words");
    await loading.destroy();
  }, 20000);
});
