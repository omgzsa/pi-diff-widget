import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
    acceptEdits,
    argumentCompletions,
    parseDiffAction,
    rejectEdits,
} from '../src/actions.ts';
import { BaselineTracker } from '../src/baseline.ts';
import { computeNetSummary } from '../src/summary.ts';
import { makeTempDir, write } from './support.ts';

const pi = { appendEntry() {} } as unknown as ExtensionAPI;
const noRefresh = async () => {};

function fakeContext(cwd: string, confirm = true) {
    const notifications: Array<{ message: string; type?: string }> = [];
    const confirmations: string[] = [];
    const ctx = {
        mode: 'tui',
        hasUI: true,
        cwd,
        waitForIdle: async () => {},
        ui: {
            notify(message: string, type?: string) {
                notifications.push({ message, type });
            },
            async confirm(title: string, message: string) {
                confirmations.push(`${title} ${message}`);
                return confirm;
            },
        },
    } as unknown as ExtensionCommandContext;
    return { ctx, notifications, confirmations };
}

test('parseDiffAction maps arguments onto actions', () => {
    assert.equal(parseDiffAction(''), 'view');
    assert.equal(parseDiffAction('   '), 'view');
    assert.equal(parseDiffAction('accept'), 'accept');
    assert.equal(parseDiffAction('KEEP'), 'accept');
    assert.equal(parseDiffAction('  reject  '), 'reject');
    assert.equal(parseDiffAction('reset'), 'unknown');
});

test('argumentCompletions completes the first word only', () => {
    const complete = argumentCompletions(['accept', 'reject']);
    assert.deepEqual(complete(''), [
        { value: 'accept ', label: 'accept' },
        { value: 'reject ', label: 'reject' },
    ]);
    assert.deepEqual(complete('re'), [{ value: 'reject ', label: 'reject' }]);
    assert.deepEqual(complete('zz'), []);
    assert.equal(complete('accept '), null);
});

test('accept makes the current content the baseline', async (t) => {
    const dir = await makeTempDir('pi-diff-actions-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');
    await write(dir, 'a.ts', 'two\n');

    const { ctx, notifications } = fakeContext(dir);
    await acceptEdits(pi, baselines, noRefresh, ctx);

    assert.equal((await computeNetSummary(baselines, dir)).fileCount, 0);
    assert.equal(notifications[0]?.message, 'Edits accepted');
});

test('reject restores pre-agent content after confirming', async (t) => {
    const dir = await makeTempDir('pi-diff-actions-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');
    await write(dir, 'a.ts', 'two\n');

    let refreshed = 0;
    const { ctx, notifications, confirmations } = fakeContext(dir);
    await rejectEdits(
        baselines,
        async () => {
            refreshed += 1;
        },
        ctx,
    );

    assert.equal(await readFile(join(dir, 'a.ts'), 'utf8'), 'one\n');
    assert.match(confirmations[0] ?? '', /Restore 1 file\(s\)/);
    assert.match(notifications[0]?.message ?? '', /Rejected edits to 1 file/);
    assert.equal(refreshed, 1);
});

test('reject leaves files alone when the confirmation is declined', async (t) => {
    const dir = await makeTempDir('pi-diff-actions-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');
    await write(dir, 'a.ts', 'two\n');

    const { ctx, notifications } = fakeContext(dir, false);
    await rejectEdits(baselines, noRefresh, ctx);

    assert.equal(await readFile(join(dir, 'a.ts'), 'utf8'), 'two\n');
    assert.deepEqual(notifications, []);
});

test('reject reports when there is nothing to undo', async (t) => {
    const dir = await makeTempDir('pi-diff-actions-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');

    const { ctx, notifications, confirmations } = fakeContext(dir);
    await rejectEdits(baselines, noRefresh, ctx);

    assert.equal(notifications[0]?.message, 'Nothing to reject');
    assert.deepEqual(confirmations, []);
});
