import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BaselineTracker } from '../src/baseline.ts';
import type { DocumentTheme } from '../src/document.ts';
import type { EditSummary } from '../src/view.ts';
import { buildEditSummaryLines, registerDiffWidget } from '../src/widget.ts';
import { commitAll, execFn, initRepo, write } from './support.ts';

const theme: DocumentTheme = {
    fg: (color, text) => `[${color}]${text}`,
    bold: (text) => `*${text}*`,
    strikethrough: (text) => `~~${text}~~`,
};

const summary: EditSummary = {
    fileCount: 3,
    added: 3,
    removed: 0,
    files: [
        { path: 'git.ts', added: 1, removed: 0 },
        { path: 'index.ts', added: 1, removed: 0 },
        { path: 'ui.ts', added: 1, removed: 0 },
    ],
};

test('builds a header plus one line per file', () => {
    const lines = buildEditSummaryLines(summary, theme);
    assert.equal(lines.length, 4);
    assert.match(lines[0] ?? '', /edits/);
    assert.match(lines[0] ?? '', /3 files/);
    assert.match(lines[0] ?? '', /\+3/);
    assert.match(lines[0] ?? '', /-0/);
    assert.match(lines[1] ?? '', /git\.ts/);
});

test('groups the overflow by directory so big sessions name every folder', () => {
    const many: EditSummary = {
        fileCount: 5,
        added: 5,
        removed: 0,
        files: [
            { path: 'keep.ts', added: 1, removed: 0 },
            { path: 'also.ts', added: 1, removed: 0 },
            { path: 'src/radar/a.ts', added: 1, removed: 0 },
            { path: 'src/radar/b.ts', added: 1, removed: 0 },
            { path: 'scripts/x.ts', added: 1, removed: 0 },
        ],
    };
    const lines = buildEditSummaryLines(many, theme, 2);

    assert.equal(lines.length, 5);
    assert.match(lines[3] ?? '', /src\/radar\//);
    assert.match(lines[3] ?? '', /2 files/);
    assert.match(lines[4] ?? '', /scripts\//);
    assert.match(lines[4] ?? '', /1 file/);
});

test('caps the directory groups and counts the rest', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
        path: `dir${i}/f.ts`,
        added: 1,
        removed: 0,
    }));
    const many: EditSummary = {
        fileCount: files.length,
        added: 10,
        removed: 0,
        files,
    };
    const lines = buildEditSummaryLines(many, theme, 2);

    assert.match(lines.at(-1) ?? '', /… 2 more files in 2 folders/);
});

test('names files that could not be tracked instead of dropping them', () => {
    const skipped: EditSummary = {
        fileCount: 1,
        added: 0,
        removed: 0,
        files: [
            {
                path: 'big.json',
                added: 0,
                removed: 0,
                note: 'too large to diff',
            },
        ],
    };
    const lines = buildEditSummaryLines(skipped, theme);

    assert.match(lines[1] ?? '', /big\.json/);
    assert.match(lines[1] ?? '', /too large to diff/);
    assert.doesNotMatch(lines[1] ?? '', /\+0/);
});

test('uses a singular file label', () => {
    const single: EditSummary = {
        fileCount: 1,
        added: 1,
        removed: 0,
        files: [{ path: 'a.ts', added: 1, removed: 0 }],
    };
    assert.match(buildEditSummaryLines(single, theme)[0] ?? '', /1 file/);
});


test('refreshes the panel after a ! bash command', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    await write(repo, 'keep.ts', 'one\n');
    await commitAll(repo, 'init');

    const handlers = new Map<
        string,
        Array<(event: unknown, ctx: unknown) => unknown>
    >();
    const api = {
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        appendEntry() {},
        registerCommand() {},
    } as unknown as ExtensionAPI;
    const baselines = new BaselineTracker();
    registerDiffWidget(api, baselines, execFn);

    const ctx = {
        hasUI: true,
        cwd: repo,
        ui: { setWidget() {} },
    };
    const handler = (handlers.get('user_bash') ?? [])[0];
    const result = (await handler?.(
        {
            type: 'user_bash',
            command: 'echo hi > fresh.ts',
            excludeFromContext: false,
            cwd: repo,
        },
        ctx,
    )) as {
        operations: {
            exec: (
                command: string,
                cwd: string,
                options: { onData: () => void },
            ) => Promise<unknown>;
        };
    };

    await result.operations.exec(
        'echo hi > fresh.ts',
        repo,
        { onData() {} },
    );

    const fresh = join(repo, 'fresh.ts');
    for (let i = 0; i < 50 && !baselines.tracks(fresh); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(baselines.tracks(fresh), true);
});


test('strikes through a deleted file and labels it del', () => {
    const deleted: EditSummary = {
        fileCount: 1,
        added: 0,
        removed: 2,
        files: [
            { path: 'src/gone.ts', added: 0, removed: 2, deleted: true },
        ],
    };
    const lines = buildEditSummaryLines(deleted, theme);

    assert.match(lines[1] ?? '', /~~\[text\]src\/gone\.ts~~/);
    assert.match(lines[1] ?? '', /\[toolDiffRemoved\]del/);
    assert.doesNotMatch(lines[1] ?? '', /-2/);
});
