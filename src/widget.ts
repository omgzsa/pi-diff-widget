import { relative } from 'node:path';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { generateDiffString } from '@earendil-works/pi-coding-agent';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { readFileCapped, type BaselineTracker } from './baseline.ts';
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
 * when nothing differs from the session baselines.
 */
export function registerDiffWidget(
    pi: ExtensionAPI,
    baselines: BaselineTracker,
): void {
    let visible = true;

    const update = async (ctx: ExtensionContext) => {
        if (!ctx.hasUI) return;
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
            'Toggle the live edits widget: on, off, or reset (accept current state)',
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();

            if (action === 'reset') {
                await baselines.reset(pi);
                await update(ctx);
                ctx.ui.notify('Edits widget reset', 'info');
                return;
            }

            if (action === 'on') visible = true;
            else if (action === 'off') visible = false;
            else visible = !visible;

            await update(ctx);
            ctx.ui.notify(`Edits widget ${visible ? 'on' : 'off'}`, 'info');
        },
    });
}
