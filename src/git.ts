import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { generateDiffString } from '@earendil-works/pi-coding-agent';
import type { ExecResult } from '@earendil-works/pi-coding-agent';
import type { ExecFn } from './exec.ts';

export type FileStatus =
    | 'added'
    | 'modified'
    | 'deleted'
    | 'binary'
    | 'too-large'
    | 'unreadable';

export interface DiffFile {
    path: string;
    status: FileStatus;
    /** Raw display diff in pi's line-numbered format (`+123 text`). Render with `renderDiff`. */
    diff: string;
}

/** A changed file, addressed from the repository root regardless of `cwd`. */
export interface DirtyFile {
    absolutePath: string;
    rootRelativePath: string;
    /** True when HEAD or the index knows the path. Untracked files are new. */
    tracked: boolean;
}

export interface RepoChanges {
    /** Absolute top level of the work tree. */
    root: string;
    /** Real path of the caller's cwd, for display comparisons. */
    cwd: string;
    hasHead: boolean;
    files: DirtyFile[];
}

// Files larger than this are reported as too-large instead of read into memory,
// and diffs are cut off at the line cap so one huge file cannot stall the view.
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 4000;
const MAX_PATHSPECS_PER_CALL = 100;

function splitNul(value: string): string[] {
    return value.split('\0').filter((part) => part.length > 0);
}

function looksBinary(text: string): boolean {
    return text.includes('\0');
}

function capLines(text: string): string {
    const lines = text.split('\n');
    if (lines.length <= MAX_DIFF_LINES) return text;
    const kept = lines.slice(0, MAX_DIFF_LINES);
    kept.push(`... ${lines.length - MAX_DIFF_LINES} more lines`);
    return kept.join('\n');
}

async function runGit(
    exec: ExecFn,
    cwd: string,
    args: string[],
): Promise<ExecResult> {
    return exec('git', args, { cwd });
}

/** HEAD content for a root-relative path, or undefined when HEAD lacks it. */
export async function readHeadContent(
    exec: ExecFn,
    root: string,
    rootRelativePath: string,
): Promise<string | undefined> {
    const result = await runGit(exec, root, [
        'show',
        `HEAD:${rootRelativePath}`,
    ]);
    return result.code === 0 ? result.stdout : undefined;
}

/** Path as the user sees it: relative to `cwd`, absolute when outside it. */
export function displayPathOf(cwd: string, absolute: string): string {
    const rel = relative(cwd, absolute);
    return rel.startsWith('..') ? absolute : rel;
}

/** Path as the user sees it, from a root-relative path. */
function displayPath(
    cwd: string,
    root: string,
    rootRelativePath: string,
): string {
    return displayPathOf(cwd, resolve(root, rootRelativePath));
}

type WorktreeRead =
    | { kind: 'text'; text: string }
    | { kind: 'missing' }
    | { kind: 'binary' }
    | { kind: 'too-large' }
    | { kind: 'unreadable' };

async function readWorktree(absolutePath: string): Promise<WorktreeRead> {
    try {
        const buffer = await readFile(absolutePath);
        if (buffer.byteLength > MAX_TEXT_BYTES) return { kind: 'too-large' };
        if (buffer.includes(0)) return { kind: 'binary' };
        return { kind: 'text', text: buffer.toString('utf8') };
    } catch (error) {
        // Only ENOENT means the file is gone. Anything else is a read failure.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { kind: 'missing' };
        }
        return { kind: 'unreadable' };
    }
}

interface ChangedPaths {
    root: string;
    /** Real path of the caller's cwd, so paths compare after symlink resolution. */
    cwd: string;
    hasHead: boolean;
    /** Root-relative paths with changes against HEAD. */
    tracked: Set<string>;
    /** Root-relative untracked files, gitignore respected. */
    untracked: Set<string>;
}

/**
 * Root-relative changed paths. Git reports tracked changes from the repository
 * root but untracked files from the current directory, so every command runs at
 * the root and results are normalized there. Resolving both against `cwd` is
 * what broke subdirectories.
 */
async function collectChangedPaths(
    exec: ExecFn,
    cwd: string,
): Promise<ChangedPaths | undefined> {
    const top = await runGit(exec, cwd, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) return undefined;
    const reportedRoot = top.stdout.trim();
    if (!reportedRoot) return undefined;
    // git reports the physical path; a caller through a symlinked prefix (macOS
    // /var vs /private/var) must compare against the physical cwd too.
    const root = await realpath(reportedRoot).catch(() => reportedRoot);
    const realCwd = await realpath(cwd).catch(() => cwd);

    const hasHead =
        (await runGit(exec, root, ['rev-parse', '--verify', 'HEAD'])).code === 0;

    const tracked = new Set<string>();
    const untracked = new Set<string>();
    if (hasHead) {
        const trackedResult = await runGit(exec, root, [
            'diff',
            '--name-only',
            '-z',
            '--no-renames',
            'HEAD',
        ]);
        if (trackedResult.code !== 0) {
            throw new Error(trackedResult.stderr.trim() || 'git diff failed');
        }
        for (const path of splitNul(trackedResult.stdout)) tracked.add(path);

        const untrackedResult = await runGit(exec, root, [
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
        ]);
        for (const path of splitNul(untrackedResult.stdout)) untracked.add(path);
    } else {
        // No commits yet: every staged or untracked file is new.
        const all = await runGit(exec, root, [
            'ls-files',
            '--cached',
            '--others',
            '--exclude-standard',
            '-z',
        ]);
        for (const path of splitNul(all.stdout)) untracked.add(path);
    }

    return { root, cwd: realCwd, hasHead, tracked, untracked };
}

/**
 * Every changed file with its absolute path, root-relative path, and whether
 * git knows it. Undefined when `cwd` is not inside a git work tree.
 */
export async function listDirtyFiles(
    exec: ExecFn,
    cwd: string,
): Promise<RepoChanges | undefined> {
    const changed = await collectChangedPaths(exec, cwd);
    if (!changed) return undefined;

    const files: DirtyFile[] = [];
    for (const path of changed.tracked) {
        files.push({
            absolutePath: resolve(changed.root, path),
            rootRelativePath: path,
            tracked: true,
        });
    }
    for (const path of changed.untracked) {
        files.push({
            absolutePath: resolve(changed.root, path),
            rootRelativePath: path,
            tracked: false,
        });
    }

    return { root: changed.root, cwd: changed.cwd, hasHead: changed.hasHead, files };
}

/**
 * Paths relative to `cwd` with uncommitted changes, or undefined when `cwd` is
 * not a git repository. Cheaper than `collectUncommitted`: it reads no file
 * contents.
 */
export async function listDirtyPaths(
    exec: ExecFn,
    cwd: string,
): Promise<Set<string> | undefined> {
    const changed = await listDirtyFiles(exec, cwd);
    if (!changed) return undefined;
    return new Set(
        changed.files.map((file) =>
            displayPath(changed.cwd, changed.root, file.rootRelativePath),
        ),
    );
}

/**
 * Root-relative subset of `paths` that the index tracks. Untracked and ignored
 * paths are absent, which is how prune tells "committed" from "git cannot say".
 */
export async function listTrackedInIndex(
    exec: ExecFn,
    root: string,
    paths: string[],
): Promise<Set<string>> {
    const tracked = new Set<string>();
    for (let i = 0; i < paths.length; i += MAX_PATHSPECS_PER_CALL) {
        const chunk = paths.slice(i, i + MAX_PATHSPECS_PER_CALL);
        const result = await runGit(exec, root, [
            'ls-files',
            '-z',
            '--',
            ...chunk,
        ]);
        if (result.code !== 0) continue;
        for (const path of splitNul(result.stdout)) tracked.add(path);
    }
    return tracked;
}

/**
 * Read every uncommitted change in `cwd`: staged and unstaged tracked edits,
 * plus untracked files. Uses `--no-renames` so renames arrive as a delete plus
 * an add, which keeps content diffing simple.
 */
export async function collectUncommitted(
    exec: ExecFn,
    cwd: string,
): Promise<DiffFile[]> {
    const changed = await listDirtyFiles(exec, cwd);
    if (!changed) {
        throw new Error('not a git repository');
    }
    const { hasHead, root } = changed;

    const files: DiffFile[] = [];
    const sorted = [...changed.files].sort((a, b) =>
        displayPath(changed.cwd, root, a.rootRelativePath).localeCompare(
            displayPath(changed.cwd, root, b.rootRelativePath),
        ),
    );

    for (const file of sorted) {
        const path = displayPath(changed.cwd, root, file.rootRelativePath);
        const head =
            hasHead && file.tracked
                ? await readHeadContent(exec, root, file.rootRelativePath)
                : undefined;
        const work = await readWorktree(file.absolutePath);

        if (work.kind === 'unreadable') {
            files.push({ path, status: 'unreadable', diff: '' });
            continue;
        }
        if (
            work.kind === 'binary' ||
            (head !== undefined && looksBinary(head))
        ) {
            files.push({ path, status: 'binary', diff: '' });
            continue;
        }
        if (work.kind === 'too-large') {
            files.push({ path, status: 'too-large', diff: '' });
            continue;
        }

        const before = head ?? '';
        const after = work.kind === 'text' ? work.text : '';
        const status: FileStatus =
            head === undefined
                ? 'added'
                : work.kind === 'missing'
                  ? 'deleted'
                  : 'modified';

        const { diff } = generateDiffString(before, after);
        if (!diff && status === 'modified') continue; // mode-only change, nothing to show
        files.push({ path, status, diff: capLines(diff) });
    }

    return files;
}
