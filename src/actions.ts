import type { AutocompleteItem } from '@earendil-works/pi-tui';
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type { BaselineTracker } from './baseline.ts';
import { collectRevertTargets, revertTargets } from './summary.ts';

export type DiffAction = 'view' | 'accept' | 'reject' | 'unknown';

/** Maps `/diff` arguments onto the action they select. Bare means the viewer. */
export function parseDiffAction(args: string): DiffAction {
    const action = args.trim().toLowerCase();
    if (action === '') return 'view';
    if (action === 'accept' || action === 'keep') return 'accept';
    if (action === 'reject') return 'reject';
    return 'unknown';
}

/** Completes a first argument from `items`, and stops once a second word starts. */
export function argumentCompletions(
    items: string[],
): (prefix: string) => AutocompleteItem[] | null {
    return (prefix) => {
        const [first = '', ...rest] = prefix.trimStart().split(/\s+/);
        if (rest.length > 0) return null;
        return items
            .filter((item) => item.startsWith(first))
            .map((item) => ({ value: `${item} `, label: item }));
    };
}

/** Repaint the widget after a baseline change, so the panel is never stale. */
export type Refresh = (ctx: ExtensionCommandContext) => Promise<void>;

/** Keep the agent's edits: the current content becomes the new baseline. */
export async function acceptEdits(
    pi: ExtensionAPI,
    baselines: BaselineTracker,
    refresh: Refresh,
    ctx: ExtensionCommandContext,
): Promise<void> {
    await baselines.rebaseline(pi);
    await refresh(ctx);
    ctx.ui.notify('Edits accepted', 'info');
}

/** Undo the agent's edits, after confirming. Restores pre-agent content. */
export async function rejectEdits(
    baselines: BaselineTracker,
    refresh: Refresh,
    ctx: ExtensionCommandContext,
): Promise<void> {
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
    const rest = targets.length > 5 ? ` and ${targets.length - 5} more` : '';
    const confirmed = await ctx.ui.confirm(
        'Reject agent edits?',
        `Restore ${targets.length} file(s) to their pre-agent content: ${names}${rest}. This cannot be undone.`,
    );
    if (!confirmed) return;

    await revertTargets(targets);
    await refresh(ctx);
    ctx.ui.notify(`Rejected edits to ${targets.length} file(s)`, 'info');
}
