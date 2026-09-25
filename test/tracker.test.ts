import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createWriteDiffTracker } from '../src/turns.ts';
import { makeTempDir, write } from './support.ts';

type Handler = (event: any, ctx: any) => unknown;
function fakePi() {
    const handlers = new Map<string, Handler[]>();
    const entries: Array<{ customType: string; data: unknown }> = [];
    const api = {
        on(event: string, handler: Handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry(customType: string, data?: unknown) {
            entries.push({ customType, data });
        },
    } as unknown as ExtensionAPI;

    async function emit(event: string, payload: object, ctx: object) {
        for (const handler of handlers.get(event) ?? []) {
            await handler(payload, ctx);
        }
    }

    return { api, emit, entries };
}

function writeCall(toolCallId: string, path: string) {
    return {
        type: 'tool_call',
        toolCallId,
        toolName: 'write',
        input: { path, content: 'x' },
    };
}

function writeResult(toolCallId: string) {
    return {
        type: 'tool_result',
        toolCallId,
        toolName: 'write',
        input: {},
        content: [],
        isError: false,
        details: undefined,
    };
}

test('tracks the diff a write produced', async (t) => {
    const dir = await makeTempDir('pi-diff-tracker-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'file.txt', 'before\n');
    const { api, emit } = fakePi();
    const lookup = createWriteDiffTracker(api);

    await emit('tool_call', writeCall('c1', 'file.txt'), { cwd: dir });
    await write(dir, 'file.txt', 'after\n');
    await emit('tool_result', writeResult('c1'), { cwd: dir });

    const tracked = lookup('c1');
    assert.equal(tracked?.path, 'file.txt');
    assert.match(tracked?.diff ?? '', /before/);
    assert.match(tracked?.diff ?? '', /after/);
});

test('clears pending snapshots on agent_settled', async (t) => {
    const dir = await makeTempDir('pi-diff-tracker-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'file.txt', 'before\n');
    const { api, emit } = fakePi();
    const lookup = createWriteDiffTracker(api);

    await emit('tool_call', writeCall('c1', 'file.txt'), { cwd: dir });
    await emit('agent_settled', {}, { cwd: dir });
    await write(dir, 'file.txt', 'after\n');
    await emit('tool_result', writeResult('c1'), { cwd: dir });

    assert.equal(lookup('c1'), undefined);
});

test('persists write diffs at turn_end', async (t) => {
    const dir = await makeTempDir('pi-diff-tracker-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'file.txt', 'before\n');
    const { api, emit, entries } = fakePi();
    createWriteDiffTracker(api);

    await emit('tool_call', writeCall('c1', 'file.txt'), { cwd: dir });
    await write(dir, 'file.txt', 'after\n');
    await emit('tool_result', writeResult('c1'), { cwd: dir });
    await emit('turn_end', {}, { cwd: dir });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.customType, 'pi-diff:writes');
    const diffs = (entries[0]?.data as { diffs: Array<{ toolCallId: string }> })
        .diffs;
    assert.deepEqual(
        diffs.map((d) => d.toolCallId),
        ['c1'],
    );
});

test('flushes pending write diffs on agent_settled', async (t) => {
    const dir = await makeTempDir('pi-diff-tracker-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'file.txt', 'before\n');
    const { api, emit, entries } = fakePi();
    createWriteDiffTracker(api);

    await emit('tool_call', writeCall('c1', 'file.txt'), { cwd: dir });
    await write(dir, 'file.txt', 'after\n');
    await emit('tool_result', writeResult('c1'), { cwd: dir });
    await emit('agent_settled', {}, { cwd: dir });

    assert.equal(entries.length, 1);
});

test('does not persist a turn without writes', async () => {
    const { api, emit, entries } = fakePi();
    createWriteDiffTracker(api);

    await emit('turn_end', {}, {});
    await emit('agent_settled', {}, {});

    assert.equal(entries.length, 0);
});
