import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { collectUncommitted, type DiffFile, type ExecFn } from './git.ts';
import { createBaselineTracker } from './baseline.ts';
import { collectTurns, createWriteDiffTracker } from './turns.ts';
import { DiffViewer } from './ui.ts';
import { toTurnViews, toUncommittedSections, type ViewMode } from './view.ts';
import { registerDiffWidget } from './widget.ts';

export default function (pi: ExtensionAPI) {
    const lookupWrite = createWriteDiffTracker(pi);
    const baselines = createBaselineTracker(pi);
    const exec: ExecFn = (command, args, options) =>
        pi.exec(command, args, options);

    registerDiffWidget(pi, baselines);

    pi.registerCommand('diff', {
        description:
            'Show uncommitted changes and per-turn edits in a scrollable viewer',
        handler: async (_args, ctx) => {
            if (ctx.mode !== 'tui') {
                ctx.ui.notify('/diff needs the interactive TUI', 'warning');
                return;
            }

            await ctx.waitForIdle();

            let files: DiffFile[] = [];
            let gitError: string | undefined;
            try {
                files = await collectUncommitted(exec, ctx.cwd);
            } catch (error) {
                gitError =
                    error instanceof Error ? error.message : String(error);
            }

            const turns = toTurnViews(
                collectTurns(ctx.sessionManager, lookupWrite),
            );

            const uncommitted = toUncommittedSections(files);

            if (uncommitted.length === 0 && turns.length === 0) {
                if (gitError) ctx.ui.notify(`/diff: ${gitError}`, 'error');
                else
                    ctx.ui.notify(
                        'No uncommitted changes and no edits this session',
                        'info',
                    );
                return;
            }

            const initialMode: ViewMode =
                uncommitted.length === 0 ? 'turns' : 'uncommitted';

            await ctx.ui.custom<void>(
                (tui, theme, _keybindings, done) =>
                    new DiffViewer({
                        title: 'pi diff',
                        uncommitted,
                        turns,
                        initialMode,
                        tui,
                        theme,
                        onClose: () => done(undefined),
                    }),
                {
                    overlay: true,
                    overlayOptions: {
                        width: '100%',
                        maxHeight: '100%',
                        margin: 0,
                        anchor: 'center',
                    },
                },
            );
        },
    });
}
