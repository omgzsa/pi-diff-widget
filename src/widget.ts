import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { generateDiffString } from '@earendil-works/pi-coding-agent';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { readFileCapped, type BaselineTracker } from './baseline.ts';
import { listDirtyPaths, type ExecFn } from './git.ts';
import type { DocumentTheme } from './ui.ts';
import { summarizeDiffs, type EditSummary } from './view.ts';

export const WIDGET_KEY = 'pi-diff';
const MAX_FILES = 8;
const MAX_PATH_WIDTH = 48;

function formatCounts(
    counts: { added: number; removed: number },
    theme: DocumentTheme,
): string {
    const added = theme.fg('toolDiffAdded', `+${counts.added}`);
    const removed = theme.fg('toolDiffRemoved', `-${counts.removed}`);
    return `${added} ${removed}`;
}

/** Zed-style summary: a header with totals, then one line per changed file. */
export function buildEditSummaryLines(
    summary: EditSummary,
    theme: DocumentTheme,
    maxFiles = MAX_FILES,
): string[] {
    const label =
        summary.fileCount === 1 ? '1 file' : `${summary.fileCount} files`;
    const lines = [
        `${theme.fg('accent', theme.bold('edits'))} ${theme.fg('dim', `· ${label} · `)}${formatCounts(summary, theme)}`,
    ];

    const shown = summary.files.slice(0, maxFiles);
    for (const file of shown) {
        const path = truncateToWidth(file.path, MAX_PATH_WIDTH, '…');
        lines.push(`${path}  ${formatCounts(file, theme)}`);
    }
    if (summary.files.length > shown.length) {
        const rest = summary.files.length - shown.length;
        lines.push(theme.fg('dim', `… ${rest} more`));
    }

    return lines;
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
        const current = await readFileCapped(absolute);
        if (current === undefined) continue; // too large or unreadable
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
        const current = await readFileCapped(absolute);
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

class EditSummaryWidget implements Component {
    private readonly lines: string[];

    constructor(lines: string[]) {
        this.lines = lines;
    }

    render(width: number): string[] {
        return this.lines.map((line) => truncateToWidth(line, width));
    }

    invalidate(): void {}
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

/**
 * Show net agent edits above the editor, refreshed at turn boundaries. Hidden
 * when nothing differs from the session baselines, or everything is committed.
 */
export function registerDiffWidget(
    pi: ExtensionAPI,
    baselines: BaselineTracker,
    exec: ExecFn,
): void {
    let visible = true;

    const update = async (ctx: ExtensionContext) => {
        if (!ctx.hasUI) return;
        await pruneCleanBaselines(baselines, exec, ctx.cwd);
        if (!visible) {
            ctx.ui.setWidget(WIDGET_KEY, undefined);
            return;
        }

        const summary = await computeNetSummary(baselines, ctx.cwd);
        if (summary.fileCount === 0) {
            ctx.ui.setWidget(WIDGET_KEY, undefined);
            return;
        }

        ctx.ui.setWidget(
            WIDGET_KEY,
            (_tui: TUI, theme: Theme) =>
                new EditSummaryWidget(buildEditSummaryLines(summary, theme)),
        );
    };

    pi.on('session_start', (_event, ctx) => void update(ctx));
    pi.on('turn_end', (_event, ctx) => void update(ctx));
    pi.on('agent_settled', (_event, ctx) => void update(ctx));
    pi.on('session_shutdown', (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    });

    pi.registerCommand('diff-widget', {
        description:
            'Live edits widget: on, off, accept (keep), or reject (undo)',
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();

            if (action === 'reject') {
                await ctx.waitForIdle();
                const targets = await collectRevertTargets(baselines, ctx.cwd);
                if (targets.length === 0) {
                    ctx.ui.notify('Nothing to reject', 'info');
                    return;
                }
                const names = targets
                    .slice(0, 5)
                    .map((target) => target.relativePath)
                    .join(', ');
                const rest =
                    targets.length > 5 ? ` and ${targets.length - 5} more` : '';
                const confirmed = await ctx.ui.confirm(
                    'Reject agent edits?',
                    `Restore ${targets.length} file(s) to their pre-agent content: ${names}${rest}. This cannot be undone.`,
                );
                if (!confirmed) return;

                await revertTargets(targets);
                await update(ctx);
                ctx.ui.notify(
                    `Rejected edits to ${targets.length} file(s)`,
                    'info',
                );
                return;
            }

            if (action === 'accept' || action === 'keep') {
                await baselines.rebaseline(pi);
                await update(ctx);
                ctx.ui.notify('Edits accepted', 'info');
                return;
            }

            if (action === 'on') visible = true;
            else if (action === 'off') visible = false;
            else if (action === '') visible = !visible;
            else {
                ctx.ui.notify(
                    `Unknown action "${action}". Use on, off, accept, or reject.`,
                    'warning',
                );
                return;
            }

            await update(ctx);
            ctx.ui.notify(`Edits widget ${visible ? 'on' : 'off'}`, 'info');
        },
    });
}
