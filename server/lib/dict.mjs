/**
 * Project-level dictionary utilities — shared library, not framework code.
 * Modes that need a persistent key-value store can import these functions.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export function projectDataDir(projectRoot) {
  return join(projectRoot, ".pi", "claro");
}

export async function loadDictionary(projectRoot) {
  const dictPath = join(projectDataDir(projectRoot), "claro-dict.json");
  try {
    const raw = await readFile(dictPath, "utf8");
    return JSON.parse(raw).terms || {};
  } catch {
    return {};
  }
}

export async function saveDictionary(projectRoot, terms) {
  const dictPath = join(projectDataDir(projectRoot), "claro-dict.json");
  await mkdir(dirname(dictPath), { recursive: true });
  await writeFile(
    dictPath,
    JSON.stringify(
      { version: 1, updated_at: new Date().toISOString(), terms },
      null,
      2,
    ),
  );
}
