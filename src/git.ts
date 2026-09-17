import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";

export type FileStatus = "added" | "modified" | "deleted" | "binary" | "too-large";

export interface DiffFile {
  path: string;
  status: FileStatus;
  /** Raw display diff in pi's line-numbered format (`+123 text`). Render with `renderDiff`. */
  diff: string;
}

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 4000;

function splitNul(value: string): string[] {
  return value.split("\0").filter((part) => part.length > 0);
}

function looksBinary(text: string): boolean {
  return text.includes("\0");
}

function capLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_DIFF_LINES) return text;
  const kept = lines.slice(0, MAX_DIFF_LINES);
  kept.push(`... ${lines.length - MAX_DIFF_LINES} more lines`);
  return kept.join("\n");
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<ExecResult> {
  return pi.exec("git", args, { cwd });
}

async function readHead(pi: ExtensionAPI, cwd: string, path: string): Promise<string | undefined> {
  const result = await runGit(pi, cwd, ["show", `HEAD:${path}`]);
  return result.code === 0 ? result.stdout : undefined;
}

type WorktreeRead =
  | { kind: "text"; text: string }
  | { kind: "missing" }
  | { kind: "binary" }
  | { kind: "too-large" };

async function readWorktree(absolutePath: string): Promise<WorktreeRead> {
  try {
    const buffer = await readFile(absolutePath);
    if (buffer.byteLength > MAX_TEXT_BYTES) return { kind: "too-large" };
    if (buffer.includes(0)) return { kind: "binary" };
    return { kind: "text", text: buffer.toString("utf8") };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Read every uncommitted change in `cwd`: staged and unstaged tracked edits,
 * plus untracked files. Uses `--no-renames` so renames arrive as a delete plus
 * an add, which keeps content diffing simple.
 */
export async function collectUncommitted(pi: ExtensionAPI, cwd: string): Promise<DiffFile[]> {
  const insideRepo = await runGit(pi, cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (insideRepo.code !== 0 || insideRepo.stdout.trim() !== "true") {
    throw new Error("not a git repository");
  }

  const hasHead = (await runGit(pi, cwd, ["rev-parse", "--verify", "HEAD"])).code === 0;

  const paths = new Set<string>();
  if (hasHead) {
    const tracked = await runGit(pi, cwd, ["diff", "--name-only", "-z", "--no-renames", "HEAD"]);
    if (tracked.code !== 0) {
      throw new Error(tracked.stderr.trim() || "git diff failed");
    }
    for (const path of splitNul(tracked.stdout)) paths.add(path);
    const untracked = await runGit(pi, cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of splitNul(untracked.stdout)) paths.add(path);
  } else {
    // No commits yet: every staged or untracked file is new.
    const all = await runGit(pi, cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    for (const path of splitNul(all.stdout)) paths.add(path);
  }

  const files: DiffFile[] = [];
  for (const path of [...paths].sort()) {
    const head = hasHead ? await readHead(pi, cwd, path) : undefined;
    const work = await readWorktree(resolve(cwd, path));

    if (work.kind === "binary" || (head !== undefined && looksBinary(head))) {
      files.push({ path, status: "binary", diff: "" });
      continue;
    }
    if (work.kind === "too-large") {
      files.push({ path, status: "too-large", diff: "" });
      continue;
    }

    const before = head ?? "";
    const after = work.kind === "text" ? work.text : "";
    const status: FileStatus =
      head === undefined ? "added" : work.kind === "missing" ? "deleted" : "modified";

    const { diff } = generateDiffString(before, after);
    if (!diff && status === "modified") continue; // mode-only change, nothing to show
    files.push({ path, status, diff: capLines(diff) });
  }

  return files;
}
