import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

async function manifests(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await manifests(root, path));
    else if (entry.name.toLowerCase() === "manifest.json") result.push(relative(root, path));
  }
  return result.sort();
}

describe("extension package resources", () => {
  it("ships a single root extension manifest, including public assets", async () => {
    expect(await manifests("public")).toEqual(["manifest.json"]);
  });

  it("keeps PDF font and license bytes consistent with their provenance", async () => {
    const root = "public/pdf-fonts";
    const metadata = JSON.parse(await readFile(join(root, "font-metadata.json"), "utf8")) as {
      files: Record<string, { bytes: number; sha256: string }>;
    };
    for (const [name, expected] of Object.entries(metadata.files)) {
      const bytes = await readFile(join(root, name));
      expect(bytes.byteLength, name).toBe(expected.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(expected.sha256);
    }
  });
});
