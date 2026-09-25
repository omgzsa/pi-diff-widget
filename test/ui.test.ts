import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDocument, type DocumentTheme } from '../src/ui.ts';
import type { DiffSection } from '../src/view.ts';

const theme: DocumentTheme = {
    fg: (color, text) => `[${color}]${text}`,
    bold: (text) => `*${text}*`,
};

test('renders a placeholder for an empty document', () => {
    const document = buildDocument([], theme);
    assert.deepEqual(document.sectionStarts, []);
    assert.deepEqual(document.lines, ['[dim]No changes to show.']);
});

test('flattens sections with headers, body, and blank separators', () => {
    const sections: DiffSection[] = [
        { title: 'a.ts', detail: 'modified', diff: 'x\ny' },
        { title: 'b.bin', note: 'binary file' },
    ];
    const document = buildDocument(sections, theme, (diff) =>
        diff
            .split('\n')
            .map((line) => `R:${line}`)
            .join('\n'),
    );

    assert.deepEqual(document.lines, [
        '[accent]*a.ts*  [dim]modified',
        'R:x',
        'R:y',
        '',
        '[accent]*b.bin*',
        '[dim]binary file',
        '',
    ]);
    assert.deepEqual(document.sectionStarts, [0, 4]);
});

test('falls back to a default note when a section has no diff', () => {
    const document = buildDocument([{ title: 'x' }], theme, () => 'unused');
    assert.deepEqual(document.lines, [
        '[accent]*x*',
        '[dim](no textual diff)',
        '',
    ]);
});
