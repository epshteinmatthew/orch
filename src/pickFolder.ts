import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

interface PickerCommand {
  cmd: string;
  args: string[];
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(err);
        return;
      }
      const code = err ? Number((err as { code?: unknown }).code ?? 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

function candidates(start: string): PickerCommand[] {
  if (process.platform === "darwin") {
    const script = `POSIX path of (choose folder with prompt "Select work folder" default location POSIX file ${JSON.stringify(start)})`;
    return [{ cmd: "osascript", args: ["-e", script] }];
  }
  const dir = start.endsWith("/") ? start : `${start}/`;
  return [
    {
      cmd: "zenity",
      args: ["--file-selection", "--directory", "--title=Select work folder", `--filename=${dir}`],
    },
    { cmd: "kdialog", args: ["--getexistingdirectory", start, "--title", "Select work folder"] },
  ];
}

/** Opens a native folder dialog on the machine running the server. Returns null if cancelled. */
export async function pickFolder(startDir?: string): Promise<string | null> {
  const start = startDir && existsSync(startDir) ? startDir : homedir();

  for (const { cmd, args } of candidates(start)) {
    let result;
    try {
      result = await run(cmd, args);
    } catch {
      continue;
    }
    if (result.code !== 0) {
      if (result.stderr.trim() && !/cancel/i.test(result.stderr)) {
        throw new Error(`${cmd} failed: ${result.stderr.trim()}`);
      }
      return null;
    }
    const picked = result.stdout.trim().replace(/\/$/, "");
    return picked || null;
  }

  throw new Error(
    "No native folder picker found. Install zenity (or kdialog), or type the path manually.",
  );
}
