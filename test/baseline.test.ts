import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type {
    ExtensionAPI,
    SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { BASELINE_ENTRY, BaselineTracker } from '../src/baseline.ts';
import { makeTempDir, write } from './support.ts';

function captureEntry() {
    const entries: Array<{ customType: string; data: unknown }> = [];
    const pi = {
        appendEntry(customType: string, data?: unknown) {
            entries.push({ customType, data });
        },
    } as unknown as ExtensionAPI;
    return { pi, entries };
}

test('flush persists baselines and load restores them', async (t) => {
    const dir = await makeTempDir('pi-diff-baseline-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');

    const { pi, entries } = captureEntry();
    baselines.flush(pi);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.customType, BASELINE_ENTRY);

    const restored = new BaselineTracker();
    restored.load([
        {
            type: 'custom',
            id: 'x1',
            parentId: null,
            customType: BASELINE_ENTRY,
            data: entries[0]?.data,
        } as unknown as SessionEntry,
    ]);
    assert.equal(restored.get(`${dir}/a.ts`), 'one\n');
});

test('flush is a no-op with nothing unflushed', async (t) => {
    const dir = await makeTempDir('pi-diff-baseline-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');

    const { pi, entries } = captureEntry();
    baselines.flush(pi);
    baselines.flush(pi);
    assert.equal(entries.length, 1);
});

test('load ignores entries without a baseline list', () => {
    const restored = new BaselineTracker();
    restored.load([
        {
            type: 'custom',
            id: 'x1',
            parentId: null,
            customType: BASELINE_ENTRY,
            data: {},
        } as unknown as SessionEntry,
    ]);
    assert.deepEqual(restored.paths(), []);
});
