import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const VALID_LIST_FILE_NAME = /^[a-z0-9!-]+$/;

export async function loadListsFromDirectory(dataDir: string): Promise<Record<string, string>> {
  const entries = await readdir(dataDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && VALID_LIST_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const output: Record<string, string> = {};

  for (const fileName of files) {
    const fullPath = path.join(dataDir, fileName);
    output[fileName] = await readFile(fullPath, "utf8");
  }

  return output;
}
