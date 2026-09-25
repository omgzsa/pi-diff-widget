import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiffFile } from '../src/git.ts';
import type { Turn } from '../src/turns.ts';
import {
    summarizePrompt,
    countDiffLines,
    summarizeDiffs,
    toTurnViews,
    toUncommittedSections,
    type EditSummary,
} from '../src/view.ts';

test('summarizePrompt uses the first non-empty line, trimmed', () => {
    assert.equal(summarizePrompt('\n\n  hello world  \nsecond'), 'hello world');
});

test('summarizePrompt returns empty for an empty prompt', () => {
    assert.equal(summarizePrompt('   \n  '), '');
});

test('summarizePrompt caps long lines to 64 characters', () => {
    const summary = summarizePrompt('x'.repeat(100));
    assert.equal(summary.length, 64);
    assert.ok(summary.endsWith('...'));
});

test('toUncommittedSections maps status, diff, and notes', () => {
    const files: DiffFile[] = [
        { path: 'a.ts', status: 'modified', diff: '+1 b' },
        { path: 'blob.bin', status: 'binary', diff: '' },
        { path: 'big.log', status: 'too-large', diff: '' },
    ];
    const sections = toUncommittedSections(files);

    assert.deepEqual(sections[0], {
        title: 'a.ts',
        detail: 'modified',
        diff: '+1 b',
        note: undefined,
    });
    assert.equal(sections[1]?.diff, undefined);
    assert.equal(sections[1]?.note, 'binary file, no text diff');
    assert.equal(sections[2]?.note, 'file too large to diff');
});

test('toTurnViews drops turns with no edits and maps the rest', () => {
    const turns: Turn[] = [
        {
            prompt: 'first prompt\nmore',
            edits: [{ path: 'a.ts', diff: '+1 b' }],
        },
        { prompt: 'no edits here', edits: [] },
        { prompt: '   ', edits: [{ path: 'c.ts', diff: '+1 d' }] },
    ];
    const views = toTurnViews(turns);

    assert.equal(views.length, 2);
    assert.equal(views[0]?.label, 'first prompt');
    assert.deepEqual(views[0]?.sections, [{ title: 'a.ts', diff: '+1 b' }]);
    assert.equal(views[1]?.label, 'prompt 2');
});

test('countDiffLines counts added and removed lines, ignoring separators', () => {
    assert.deepEqual(countDiffLines('  1 a\n+2 b\n-1 c\n+3 d\n    ...'), {
        added: 2,
        removed: 1,
    });
});

test('summarizeDiffs aggregates per file and sorts by path', () => {
    const summary: EditSummary = summarizeDiffs([
        { path: 'b.ts', diff: '+1 x' },
        { path: 'a.ts', diff: '+1 y' },
        { path: 'b.ts', diff: '+1 z\n-1 q' },
    ]);

    assert.equal(summary.fileCount, 2);
    assert.equal(summary.added, 3);
    assert.equal(summary.removed, 1);
    assert.deepEqual(summary.files, [
        { path: 'a.ts', added: 1, removed: 0 },
        { path: 'b.ts', added: 2, removed: 1 },
    ]);
});
