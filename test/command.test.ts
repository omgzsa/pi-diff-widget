import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { collectTurns } from '../src/turns.ts';
import type { DocumentTheme } from '../src/document.ts';
import {
    commitAll,
    execFn,
    initRepo,
    makeTempDir,
    write,
} from './support.ts';
import extension from '../src/index.ts';

// The /diff handler builds DiffViewer without overriding the diff renderer, so
// the body uses pi's real renderDiff. That needs the global theme initialized.
initTheme('dark');

const theme: DocumentTheme = {
    fg: (color, text) => `[${color}]${text}`,
    bold: (text) => `*${text}*`,
};

type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

function fakeApi() {
    const commands = new Map<string, Command>();
    const api = {
        registerCommand(name: string, options: Command) {
            commands.set(name, options);
        },
        on() {},
        appendEntry() {},
        exec(command: string, args: string[], options?: { cwd?: string }) {
            return execFn(command, args, options);
        },
    } as unknown as ExtensionAPI;
    return { api, commands };
}

function fakeTui(rows = 24): TUI {
    return {
        terminal: { rows, columns: 80 },
        requestRender() {},
    } as unknown as TUI;
}

function fakeContext(options: { cwd: string; branch?: unknown[] }) {
    const notifications: Array<{ message: string; type?: string }> = [];
    const rendered: string[][] = [];
    const stats = { customCalls: 0 };

    const ctx = {
        mode: 'tui',
        cwd: options.cwd,
        waitForIdle: async () => {},
        sessionManager: { getBranch: () => options.branch ?? [] },
        ui: {
            notify(message: string, type?: string) {
                notifications.push({ message, type });
            },
            custom(factory: (...args: unknown[]) => unknown) {
                stats.customCalls += 1;
                return new Promise((resolve) => {
                    const done = (result: unknown) => resolve(result);
                    const built = factory(fakeTui(), theme, {}, done);
                    Promise.resolve(built).then((value) => {
                        const component = value as {
                            render(width: number): string[];
                        };
                        rendered.push(component.render(80));
                        done(undefined);
                    });
                });
            },
        },
    } as unknown as ExtensionContext;

    return { ctx, notifications, rendered, stats };
}

test('/diff renders uncommitted changes in the overlay', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'keep.txt', 'a\n');
    await commitAll(repo, 'init');
    await write(repo, 'keep.txt', 'a\nb\n');

    const { api, commands } = fakeApi();
    extension(api);
    const command = commands.get('diff');
    assert.ok(command, 'expected a registered diff command');

    const { ctx, notifications, rendered, stats } = fakeContext({ cwd: repo });
    await command.handler('', ctx);

    assert.equal(stats.customCalls, 1);
    assert.equal(notifications.length, 0);
    assert.equal(rendered.length, 1);
    const text = rendered[0]?.join('\n') ?? '';
    assert.match(text, /keep\.txt/);
    assert.match(text, /uncommitted/);
});

test('/diff reports a non-git directory without opening the overlay', async (t) => {
    const dir = await makeTempDir('pi-diff-cmd-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    const { api, commands } = fakeApi();
    extension(api);

    const { ctx, notifications, stats } = fakeContext({ cwd: dir });
    await commands.get('diff')?.handler('', ctx);

    assert.equal(stats.customCalls, 0);
    assert.equal(notifications[0]?.type, 'error');
    assert.match(notifications[0]?.message ?? '', /not a git repository/);
});

test('/diff opens in turns mode when the worktree is clean', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'keep.txt', 'a\n');
    await commitAll(repo, 'init');

    const branch = [
        {
            type: 'message',
            id: 'u1',
            parentId: null,
            message: { role: 'user', content: 'edit something' },
        },
        {
            type: 'message',
            id: 'a1',
            parentId: 'u1',
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'c1',
                        name: 'edit',
                        arguments: { path: 'src/a.ts' },
                    },
                ],
            },
        },
        {
            type: 'message',
            id: 't1',
            parentId: 'a1',
            message: {
                role: 'toolResult',
                toolCallId: 'c1',
                toolName: 'edit',
                content: [],
                details: { diff: '  1 a\n+2 b' },
                isError: false,
            },
        },
    ];

    const { api, commands } = fakeApi();
    extension(api);

    const { ctx, rendered, stats } = fakeContext({ cwd: repo, branch });
    await commands.get('diff')?.handler('', ctx);

    assert.equal(stats.customCalls, 1);
    const header = rendered[0]?.[0] ?? '';
    assert.match(header, /turns/);
    assert.match(header, /edit something/);
});

test('command integration path still agrees with collectTurns', () => {
    // Guards against the handler and the collector drifting apart.
    const branch = [
        {
            type: 'message',
            id: 'u1',
            parentId: null,
            message: { role: 'user', content: 'prompt' },
        },
    ];
    const turns = collectTurns(
        { getBranch: () => branch as never },
        () => undefined,
    );
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.prompt, 'prompt');
});
