import { dirname } from 'node:path';
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Refresh } from './actions.ts';
import { argumentCompletions } from './actions.ts';
import type { BaselineTracker } from './baseline.ts';
import type { DocumentTheme } from './document.ts';
import type { ExecFn } from './exec.ts';
import {
    computeNetSummary,
    recordPreexisting,
    syncBaselines,
} from './summary.ts';
import type { EditSummary } from './view.ts';

export const WIDGET_KEY = 'pi-diff';
const MAX_FILES = 8;
const MAX_GROUPS = 6;
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
        const label = truncateToWidth(file.path, MAX_PATH_WIDTH, '…');
        const path = file.deleted
            ? theme.strikethrough(theme.fg('text', label))
            : label;
        const detail = file.note
            ? theme.fg('dim', file.note)
            : file.deleted
              ? theme.fg('toolDiffRemoved', 'del')
              : formatCounts(file, theme);
        lines.push(`${path}  ${detail}`);
    }

    // Overflow is grouped by directory, so a big session still names every
    // folder with edits instead of hiding most of them behind one counter.
    const rest = summary.files.slice(shown.length);
    if (rest.length > 0) {
        const groups = new Map<
            string,
            { count: number; added: number; removed: number }
        >();
        for (const file of rest) {
            const dir = dirname(file.path);
            const key = dir === '.' ? './' : `${dir}/`;
            const group = groups.get(key) ?? {
                count: 0,
                added: 0,
                removed: 0,
            };
            group.count += 1;
            group.added += file.added;
            group.removed += file.removed;
            groups.set(key, group);
        }

        const ordered = [...groups].sort(
            (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
        );
        for (const [dir, group] of ordered.slice(0, MAX_GROUPS)) {
            const path = truncateToWidth(dir, MAX_PATH_WIDTH, '…');
            const files = group.count === 1 ? '1 file' : `${group.count} files`;
            lines.push(
                `${path}  ${theme.fg('dim', files)}  ${formatCounts(group, theme)}`,
            );
        }
        const hidden = ordered.slice(MAX_GROUPS);
        if (hidden.length > 0) {
            const files = hidden.reduce((sum, [, group]) => sum + group.count, 0);
            lines.push(
                theme.fg(
                    'dim',
                    `… ${files} more files in ${hidden.length} folders`,
                ),
            );
        }
    }

    return lines;
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
 * Show net agent edits above the editor, refreshed at turn boundaries. Hidden
 * when nothing differs from the session baselines, or everything is committed.
 */
export function registerDiffWidget(
    pi: ExtensionAPI,
    baselines: BaselineTracker,
    exec: ExecFn,
): Refresh {
    let visible = true;

    const update = async (ctx: ExtensionContext) => {
        if (!ctx.hasUI) return;
        // Files changed outside `edit`/`write` (bash, codegen, other sessions)
        // get a HEAD baseline so they still appear, then prune committed work.
        await syncBaselines(baselines, exec, ctx.cwd);
        baselines.flush(pi);
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

    pi.on('session_start', async (_event, ctx) => {
        await recordPreexisting(baselines, exec, ctx.cwd);
        await update(ctx);
    });
    pi.on('turn_end', (_event, ctx) => void update(ctx));
    pi.on('agent_settled', (_event, ctx) => void update(ctx));

    // `!` and `!!` commands run outside the agent loop and emit no turn
    // boundary, so wrap the local backend and refresh once the command exits.
    pi.on('user_bash', (_event, ctx) => {
        const local = createLocalBashOperations();
        return {
            operations: {
                async exec(command, cwd, options) {
                    try {
                        return await local.exec(command, cwd, options);
                    } finally {
                        void update(ctx);
                    }
                },
            },
        };
    });
    pi.on('session_shutdown', (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    });

    pi.registerCommand('diff-widget', {
        description: 'Live edits widget: on, off, or toggle',
        getArgumentCompletions: argumentCompletions(['on', 'off']),
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();

            if (action === 'on') visible = true;
            else if (action === 'off') visible = false;
            else if (action === '') visible = !visible;
            else {
                ctx.ui.notify(
                    `Unknown action "${action}". Use on or off. To keep or undo the edits, use /diff accept or /diff reject.`,
                    'warning',
                );
                return;
            }

            await update(ctx);
            ctx.ui.notify(`Edits widget ${visible ? 'on' : 'off'}`, 'info');
        },
    });

    return update;
}
