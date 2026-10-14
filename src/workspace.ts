import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".cache",
  ".idea",
  ".gradle",
]);
const MAX_FILES = 400;
const MAX_DIFF_CHARS = 15_000;

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? undefined : stdout.trim()),
    );
  });
}

async function listFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push(full);
      } else {
        files.push(relative(root, full));
        if (files.length >= MAX_FILES) return { files, truncated: true };
      }
    }
  }
  return { files, truncated: false };
}

/** Text overview of a work directory for orchestrators that can't read files themselves. */
export async function snapshotWorkspace(workDir: string): Promise<string> {
  const { files, truncated } = await listFiles(workDir);
  const sections = [
    `### Files (${files.length}${truncated ? "+, truncated" : ""})\n${files.join("\n") || "(empty)"}`,
  ];

  const status = await git(workDir, ["status", "--short"]);
  if (status !== undefined) {
    sections.push(`### git status --short\n${status || "(clean)"}`);
    const diff = await git(workDir, ["diff", "HEAD"]);
    if (diff) {
      const clipped =
        diff.length > MAX_DIFF_CHARS
          ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated, ${diff.length} chars total)`
          : diff;
      sections.push(`### git diff HEAD\n${clipped}`);
    }
  } else {
    sections.push("(not a git repository; no diff available)");
  }

  return sections.join("\n\n");
}
