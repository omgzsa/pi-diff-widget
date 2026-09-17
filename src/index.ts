import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { collectUncommitted, type DiffFile, type ExecFn } from './git.ts';
import { collectTurns, createWriteDiffTracker } from './turns.ts';
import {
    DiffViewer,
    type DiffSection,
    type TurnView,
    type ViewMode,
} from './ui.ts';

function fileSection(file: DiffFile): DiffSection {
    return {
        title: file.path,
        detail: file.status,
        diff: file.diff || undefined,
        note: '(no textual diff)',
    };
}

function summarizePrompt(prompt: string): string {
    const line =
        prompt.split('\n').find((part) => part.trim().length > 0) ?? '';
    const trimmed = line.trim();
    return trimmed.length > 64 ? `${trimmed.slice(0, 61)}...` : trimmed;
}

export default function (pi: ExtensionAPI) {
    const lookupWrite = createWriteDiffTracker(pi);
    const exec: ExecFn = (command, args, options) =>
        pi.exec(command, args, options);

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

            const turns = collectTurns(ctx.sessionManager, lookupWrite)
                .filter((turn) => turn.edits.length > 0)
                .map<TurnView>((turn) => ({
                    label:
                        summarizePrompt(turn.prompt) ||
                        `prompt ${turn.index + 1}`,
                    sections: turn.edits.map((edit) => ({
                        title: edit.path,
                        diff: edit.diff,
                    })),
                }));

            const uncommitted = files.map(fileSection);

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
