import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocumentTheme } from '../src/ui.ts';
import type { EditSummary } from '../src/view.ts';
import { buildEditSummaryLines } from '../src/widget.ts';

const theme: DocumentTheme = {
    fg: (color, text) => `[${color}]${text}`,
    bold: (text) => `*${text}*`,
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

test('caps the file list and notes the remainder', () => {
    const many: EditSummary = {
        ...summary,
        fileCount: 12,
        files: Array.from({ length: 12 }, (_, i) => ({
            path: `f${i}.ts`,
            added: 1,
            removed: 0,
        })),
    };
    const lines = buildEditSummaryLines(many, theme, 8);
    assert.equal(lines.length, 10);
    assert.match(lines[9] ?? '', /4 more/);
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
