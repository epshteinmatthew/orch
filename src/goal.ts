import { readFile } from "node:fs/promises";
import { join } from "node:path";

const GOAL_FILES = ["GOAL.md", "PROMPT.md", "goal.md", "prompt.md"] as const;

async function readFirstExisting(workDir: string): Promise<string | undefined> {
  for (const name of GOAL_FILES) {
    try {
      const text = await readFile(join(workDir, name), "utf8");
      const trimmed = text.trim();
      if (trimmed) return trimmed;
    } catch {
      // missing or unreadable — try next
    }
  }
  return undefined;
}

/** Merge UI goal text with optional GOAL.md / PROMPT.md from the work folder. */
export async function resolveGoal(
  workDir: string,
  uiGoal?: string,
): Promise<string> {
  const fromUi = uiGoal?.trim() ?? "";
  const fromFile = await readFirstExisting(workDir);

  if (fromUi && fromFile) {
    return `${fromUi}\n\n---\n\n(From folder goal file)\n\n${fromFile}`;
  }
  if (fromUi) return fromUi;
  if (fromFile) return fromFile;
  throw new Error(
    "No goal provided. Enter a goal in the UI or add GOAL.md / PROMPT.md in the work folder.",
  );
}
