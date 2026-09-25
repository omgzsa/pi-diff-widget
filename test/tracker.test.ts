import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createWriteDiffTracker } from '../src/turns.ts';
import { makeTempDir, write } from './support.ts';

type Handler = (event: any, ctx: any) => unknown;
function fakePi() {
    const handlers = new Map<string, Handler[]>();
    const api = {
        on(event: string, handler: Handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
    } as unknown as ExtensionAPI;

    async function emit(event: string, payload: object, ctx: object) {
        for (const handler of handlers.get(event) ?? []) {
            await handler(payload, ctx);
        }
    }

    return { api, emit };
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
