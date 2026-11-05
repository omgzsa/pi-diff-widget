import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
    NESTED_EDIT_ENTRY,
    WRITE_DIFF_ENTRY,
    collectTurns,
    type SessionBranchSource,
    type WriteDiffLookup,
} from '../src/turns.ts';

function fakeSession(entries: unknown[]): SessionBranchSource {
    return { getBranch: () => entries as SessionEntry[] };
}

function userMessage(text: string) {
    return {
        type: 'message',
        id: `u-${text}`,
        parentId: null,
        message: { role: 'user', content: [{ type: 'text', text }] },
    };
}

function assistantWithCalls(calls: Array<{ id: string; name: string; args: unknown }>) {
    return {
        type: 'message',
        id: 'a1',
        parentId: null,
        message: {
            role: 'assistant',
            content: calls.map((call) => ({
                type: 'toolCall',
                id: call.id,
                name: call.name,
                arguments: call.args,
            })),
        },
    };
}

function toolResult(
    id: string,
    toolCallId: string,
    toolName: string,
    details: unknown,
) {
    return {
        type: 'message',
        id,
        parentId: null,
        message: {
            role: 'toolResult',
            toolCallId,
            toolName,
            content: [],
            details,
            isError: false,
        },
    };
}

test('groups edits by user prompt and joins write diffs', () => {
    const entries = [
        userMessage('first prompt'),
        assistantWithCalls([
            { id: 'c1', name: 'edit', args: { path: 'src/a.ts' } },
            { id: 'c2', name: 'write', args: { path: 'src/b.ts' } },
        ]),
        toolResult('t1', 'c1', 'edit', { diff: '  1 a\n+2 b' }),
        toolResult('t2', 'c2', 'write', undefined),
        userMessage('second prompt'),
    ];

    const lookup: WriteDiffLookup = (id) =>
        id === 'c2' ? { path: 'src/b.ts', diff: '+1 x' } : undefined;

    const turns = collectTurns(fakeSession(entries), lookup);

    assert.equal(turns.length, 2);
    assert.deepEqual(
        turns[0]?.edits.map((edit) => edit.path),
        ['src/a.ts', 'src/b.ts'],
    );
    assert.equal(turns[1]?.edits.length, 0);
});

test('skips write results with no tracked diff', () => {
    const entries = [
        userMessage('prompt'),
        assistantWithCalls([
            { id: 'c1', name: 'write', args: { path: 'src/b.ts' } },
        ]),
        toolResult('t1', 'c1', 'write', undefined),
    ];

    const turns = collectTurns(fakeSession(entries), () => undefined);
    assert.equal(turns[0]?.edits.length, 0);
});

test('extracts prompt text from string and block content', () => {
    const stringPrompt = {
        type: 'message',
        id: 'u1',
        parentId: null,
        message: { role: 'user', content: 'plain string' },
    };
    const blockPrompt = {
        type: 'message',
        id: 'u2',
        parentId: null,
        message: {
            role: 'user',
            content: [
                { type: 'text', text: 'from' },
                { type: 'text', text: 'blocks' },
            ],
        },
    };

    const turns = collectTurns(
        fakeSession([stringPrompt, blockPrompt]),
        () => undefined,
    );
    assert.equal(turns[0]?.prompt, 'plain string');
    assert.equal(turns[1]?.prompt, 'from blocks');
});

test('keeps only the last 100 turns', () => {
    const entries = Array.from({ length: 105 }, (_, i) =>
        userMessage(`prompt ${i}`),
    );
    const turns = collectTurns(fakeSession(entries), () => undefined);

    assert.equal(turns.length, 100);
    assert.equal(turns[0]?.prompt, 'prompt 5');
    assert.equal(turns[99]?.prompt, 'prompt 104');
});

function persistedEntry(diffs: Array<{ toolCallId: string; path: string; diff: string }>) {
    return {
        type: 'custom',
        id: 'x1',
        parentId: null,
        customType: WRITE_DIFF_ENTRY,
        data: { diffs },
    };
}

test('uses write diffs persisted by past turns', () => {
    const entries = [
        userMessage('prompt'),
        assistantWithCalls([
            { id: 'c1', name: 'write', args: { path: 'src/b.ts' } },
        ]),
        toolResult('t1', 'c1', 'write', undefined),
        persistedEntry([
            { toolCallId: 'c1', path: 'src/b.ts', diff: '+1 persisted' },
        ]),
    ];

    const turns = collectTurns(fakeSession(entries), () => undefined);
    assert.equal(turns[0]?.edits[0]?.diff, '+1 persisted');
});

test('prefers the live lookup over persisted data', () => {
    const entries = [
        userMessage('prompt'),
        assistantWithCalls([
            { id: 'c1', name: 'write', args: { path: 'src/b.ts' } },
        ]),
        toolResult('t1', 'c1', 'write', undefined),
        persistedEntry([
            { toolCallId: 'c1', path: 'src/b.ts', diff: '+1 persisted' },
        ]),
    ];

    const lookup: WriteDiffLookup = () => ({
        path: 'src/b.ts',
        diff: '+1 live',
    });
    const turns = collectTurns(fakeSession(entries), lookup);
    assert.equal(turns[0]?.edits[0]?.diff, '+1 live');
});

function nestedDiffsEntry(
    customType: string,
    diffs: Array<{ toolCallId: string; path: string; diff: string }>,
) {
    return {
        type: 'custom',
        id: 'x2',
        parentId: null,
        customType,
        data: { diffs },
    };
}

test('attributes nested codemode edit and write diffs to the calling turn', () => {
    const entries = [
        userMessage('refactor radar'),
        assistantWithCalls([
            { id: 'c1', name: 'codemode', args: { code: '...' } },
        ]),
        toolResult('t1', 'c1', 'codemode', undefined),
        nestedDiffsEntry(NESTED_EDIT_ENTRY, [
            { toolCallId: 'c1/1', path: 'src/a.ts', diff: '+1 edited' },
        ]),
        nestedDiffsEntry(WRITE_DIFF_ENTRY, [
            { toolCallId: 'c1/2', path: 'src/b.ts', diff: '+1 written' },
        ]),
    ];

    const turns = collectTurns(fakeSession(entries), () => undefined);
    assert.deepEqual(
        turns[0]?.edits.map((edit) => [edit.path, edit.diff]),
        [
            ['src/a.ts', '+1 edited'],
            ['src/b.ts', '+1 written'],
        ],
    );
});

test('does not list a direct call as its own nested diff', () => {
    const entries = [
        userMessage('write it'),
        assistantWithCalls([
            { id: 'c1', name: 'write', args: { path: 'src/b.ts' } },
        ]),
        toolResult('t1', 'c1', 'write', undefined),
        nestedDiffsEntry(WRITE_DIFF_ENTRY, [
            { toolCallId: 'c1', path: 'src/b.ts', diff: '+1 direct' },
        ]),
    ];

    const turns = collectTurns(fakeSession(entries), () => undefined);
    assert.equal(turns[0]?.edits.length, 1);
});
