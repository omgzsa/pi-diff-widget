import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { generateDiffString } from '@earendil-works/pi-coding-agent';
import { readFileCapped, locationGone, type BaselineTracker } from './baseline.ts';
import { listDirtyPaths } from './git.ts';
import type { ExecFn } from './exec.ts';
import { summarizeDiffs, type EditSummary } from './view.ts';

/**
 * Current content for a tracked path, or undefined when it cannot be accounted
 * for: too large, unreadable, or its whole location is gone.
 */
async function readCurrent(absolute: string): Promise<string | undefined> {
    if (await locationGone(absolute)) return undefined;
    return readFileCapped(absolute);
}

/**
 * Net agent changes: for each file the agent touched, diff its current content
 * against the baseline captured before the first touch. Reverted files vanish.
 */
export async function computeNetSummary(
    baselines: BaselineTracker,
    cwd: string,
): Promise<EditSummary> {
    const diffs: Array<{ path: string; diff: string }> = [];

    for (const absolute of baselines.paths()) {
        const current = await readCurrent(absolute);
        if (current === undefined) continue;
        const baseline = baselines.get(absolute) ?? '';
        const { diff } = generateDiffString(baseline, current);
        if (!diff) continue;

        const rel = relative(cwd, absolute);
        diffs.push({ path: rel.startsWith('..') ? absolute : rel, diff });
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
    for (const absolute of baselines.paths()) {
        const current = await readCurrent(absolute);
        if (current === undefined) continue;
        const baseline = baselines.get(absolute) ?? '';
        const { diff } = generateDiffString(baseline, current);
        if (!diff) continue;
        const rel = relative(cwd, absolute);
        targets.push({
            absolutePath: absolute,
            relativePath: rel.startsWith('..') ? absolute : rel,
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

/**
 * Drop files that no longer have uncommitted changes, so committing clears the
 * panel. Files outside the repository, or sessions outside git, are kept.
 */
export async function pruneCleanBaselines(
    baselines: BaselineTracker,
    exec: ExecFn,
    cwd: string,
): Promise<void> {
    // A baseline whose location is gone can never be shown or reverted again,
    // and keeping it would let reject rebuild a directory that was moved away.
    const live = new Set<string>();
    for (const absolute of baselines.paths()) {
        if (!(await locationGone(absolute))) live.add(absolute);
    }
    baselines.retain((absolute) => live.has(absolute));

    let dirty: Set<string> | undefined;
    try {
        dirty = await listDirtyPaths(exec, cwd);
    } catch {
        return;
    }
    if (!dirty) return;

    baselines.retain((absolute) => {
        const rel = relative(cwd, absolute);
        if (rel.startsWith('..')) return true; // outside the repo, cannot judge
        return dirty.has(rel);
    });
}
