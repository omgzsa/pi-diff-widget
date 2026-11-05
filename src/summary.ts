import { mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { generateDiffString } from '@earendil-works/pi-coding-agent';
import {
    probeBaseline,
    readFileCapped,
    locationGone,
    type BaselineTracker,
    type SkipReason,
} from './baseline.ts';
import {
    displayPathOf,
    listDirtyFiles,
    listTrackedInIndex,
    readHeadContent,
    type RepoChanges,
} from './git.ts';
import type { ExecFn } from './exec.ts';
import { summarizeDiffs, type EditSummary } from './view.ts';

const SKIP_NOTE: Record<SkipReason, string> = {
    'too-large': 'too large to diff',
    unreadable: 'file could not be read',
};

/**
 * Current content for a tracked path, or undefined when it cannot be accounted
 * for: too large, unreadable, or its whole location is gone.
 */
async function realCwd(cwd: string): Promise<string> {
    return realpath(cwd).catch(() => cwd);
}

async function readCurrent(absolute: string): Promise<string | undefined> {
    if (await locationGone(absolute)) return undefined;
    return readFileCapped(absolute);
}

/**
 * Net agent changes: for each file the agent touched, diff its current content
 * against the baseline captured before the first touch. Reverted files vanish.
 * Files that cannot be tracked are listed with a note rather than dropped.
 */
export async function computeNetSummary(
    baselines: BaselineTracker,
    cwd: string,
): Promise<EditSummary> {
    const diffs: Array<{ path: string; diff: string; note?: string }> = [];
    const displayCwd = await realCwd(cwd);

    for (const absolute of baselines.paths()) {
        const current = await readCurrent(absolute);
        if (current === undefined) {
            if (await locationGone(absolute)) continue;
            const probe = await probeBaseline(absolute);
            if (probe.kind !== 'content') {
                diffs.push({
                    path: displayPathOf(displayCwd, absolute),
                    diff: '',
                    note: SKIP_NOTE[probe.kind],
                });
            }
            continue;
        }
        const baseline = baselines.get(absolute) ?? '';
        const { diff } = generateDiffString(baseline, current);
        if (!diff) continue;

        diffs.push({ path: displayPathOf(displayCwd, absolute), diff });
    }

    for (const { path, reason } of baselines.skippedPaths()) {
        diffs.push({
            path: displayPathOf(displayCwd, path),
            diff: '',
            note: SKIP_NOTE[reason],
        });
    }

    return summarizeDiffs(diffs);
}

export interface RevertTarget {
    absolutePath: string;
    relativePath: string;
    baseline: string;
    missing: boolean;
}

/** Files whose current content differs from their baseline. */
export async function collectRevertTargets(
    baselines: BaselineTracker,
    cwd: string,
): Promise<RevertTarget[]> {
    const targets: RevertTarget[] = [];
    const displayCwd = await realCwd(cwd);
    for (const absolute of baselines.paths()) {
        const current = await readCurrent(absolute);
        if (current === undefined) continue;
        const baseline = baselines.get(absolute) ?? '';
        const { diff } = generateDiffString(baseline, current);
        if (!diff) continue;
        targets.push({
            absolutePath: absolute,
            relativePath: displayPathOf(displayCwd, absolute),
            baseline,
            missing: baselines.wasMissing(absolute),
        });
    }
    return targets;
}

/**
 * Restore files to their baselines: write the original content back, or delete
 * files the agent created. The caller confirms first, since this is destructive.
 */
export async function revertTargets(targets: RevertTarget[]): Promise<void> {
    for (const target of targets) {
        if (target.missing) {
            await unlink(target.absolutePath).catch(() => undefined);
            continue;
        }
        await mkdir(dirname(target.absolutePath), { recursive: true });
        await writeFile(target.absolutePath, target.baseline, 'utf8');
    }
}

/** Root-relative path, or undefined when the path is outside the work tree. */
function toRootRelative(root: string, absolute: string): string | undefined {
    const rel = relative(root, absolute);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return rel.split(sep).join('/');
}

/**
 * Remember which files were already dirty when the session started. They are
 * never seeded from HEAD, so the user's own uncommitted work is not claimed by
 * the agent or reverted by `/diff reject`.
 */
export async function recordPreexisting(
    baselines: BaselineTracker,
    exec: ExecFn,
    cwd: string,
): Promise<void> {
    const repo = await listDirtyFiles(exec, cwd).catch(() => undefined);
    if (!repo) return;
    baselines.markPreexisting(repo.files.map((file) => file.absolutePath));
}

/**
 * Seed baselines for files that became dirty without going through `edit` or
 * `write`: bash redirection, codegen, another session, a subagent. The baseline
 * is HEAD content (or missing for new files), so the whole uncommitted change is
 * shown and `/diff reject` can undo it. Returns how many baselines were seeded.
 */
export async function reconcileBaselines(
    baselines: BaselineTracker,
    exec: ExecFn,
    cwd: string,
): Promise<number> {
    const repo = await listDirtyFiles(exec, cwd).catch(() => undefined);
    if (!repo) return 0;
    return seedMissingBaselines(baselines, exec, repo);
}

async function seedMissingBaselines(
    baselines: BaselineTracker,
    exec: ExecFn,
    repo: RepoChanges,
): Promise<number> {
    let seeded = 0;
    for (const file of repo.files) {
        if (baselines.tracks(file.absolutePath)) continue;
        if (baselines.isPreexisting(file.absolutePath)) continue;

        if (repo.hasHead && file.tracked) {
            const head = await readHeadContent(
                exec,
                repo.root,
                file.rootRelativePath,
            );
            if (head === undefined) continue;
            baselines.seed(file.absolutePath, head, true);
        } else {
            const probe = await probeBaseline(file.absolutePath);
            if (probe.kind === 'content') {
                baselines.seed(file.absolutePath, '', false);
            } else {
                baselines.skip(file.absolutePath, probe.kind);
            }
        }
        seeded += 1;
    }

    return seeded;
}

/**
 * Drop files that no longer have uncommitted changes, so committing clears the
 * panel. A path git cannot judge, such as an ignored file or one inside a nested
 * repository, is kept: it may be part of the agent's work that git never lists.
 */
export async function pruneCleanBaselines(
    baselines: BaselineTracker,
    exec: ExecFn,
    cwd: string,
): Promise<void> {
    const repo = await listDirtyFiles(exec, cwd).catch(() => undefined);
    await pruneRepoBaselines(baselines, exec, repo);
}

/**
 * One repository read for both passes, so a turn boundary shells out to git once
 * instead of twice.
 */
export async function syncBaselines(
    baselines: BaselineTracker,
    exec: ExecFn,
    cwd: string,
): Promise<number> {
    const repo = await listDirtyFiles(exec, cwd).catch(() => undefined);
    if (!repo) {
        await pruneRepoBaselines(baselines, exec, undefined);
        return 0;
    }
    const seeded = await seedMissingBaselines(baselines, exec, repo);
    await pruneRepoBaselines(baselines, exec, repo);
    return seeded;
}

async function pruneRepoBaselines(
    baselines: BaselineTracker,
    exec: ExecFn,
    repo: RepoChanges | undefined,
): Promise<void> {
    // A baseline whose location is gone can never be shown or reverted again,
    // and keeping it would let reject rebuild a directory that was moved away.
    const live = new Set<string>();
    const tracked = [
        ...baselines.paths(),
        ...baselines.skippedPaths().map((item) => item.path),
    ];
    for (const absolute of tracked) {
        if (!(await locationGone(absolute))) live.add(absolute);
    }
    baselines.retain((absolute) => live.has(absolute));

    if (!repo) return;

    const dirty = new Set(repo.files.map((file) => file.absolutePath));
    const candidates: Array<{ absolute: string; rootRelative: string }> = [];
    for (const absolute of live) {
        if (dirty.has(absolute)) continue;
        const rootRelative = toRootRelative(repo.root, absolute);
        if (rootRelative === undefined) continue; // outside the repo, cannot judge
        candidates.push({ absolute, rootRelative });
    }

    const known = await listTrackedInIndex(
        exec,
        repo.root,
        candidates.map((candidate) => candidate.rootRelative),
    );
    const committed = new Set(
        candidates
            .filter((candidate) => known.has(candidate.rootRelative))
            .map((candidate) => candidate.absolute),
    );

    baselines.retain((absolute) => dirty.has(absolute) || !committed.has(absolute));
}
