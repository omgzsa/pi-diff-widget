import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import {
    DiffViewer,
    type DiffSection,
    type DocumentTheme,
    type TurnView,
    type ViewMode,
} from '../src/ui.ts';

const theme: DocumentTheme = {
    fg: (color, text) => `[${color}]${text}`,
    bold: (text) => `*${text}*`,
};

const renderDiffText = (diff: string) =>
    diff
        .split('\n')
        .map((line) => `R:${line}`)
        .join('\n');

function fakeTui(rows = 24): TUI {
    return {
        terminal: { rows, columns: 80 },
        requestRender() {},
    } as unknown as TUI;
}

function makeViewer(options: {
    uncommitted?: DiffSection[];
    turns?: TurnView[];
    initialMode?: ViewMode;
    rows?: number;
    width?: number;
    onClose?: () => void;
} = {}): DiffViewer {
    return new DiffViewer({
        title: 'pi diff',
        uncommitted: options.uncommitted ?? [
            { title: 'README.md', detail: 'modified', diff: 'a' },
        ],
        turns: options.turns ?? [
            {
                label: 'first prompt',
                sections: [{ title: 'src/a.ts', diff: 'x' }],
            },
            {
                label: 'second prompt',
                sections: [{ title: 'src/b.ts', diff: 'y' }],
            },
        ],
        initialMode: options.initialMode ?? 'uncommitted',
        tui: fakeTui(options.rows ?? 24),
        theme,
        renderDiffText,
        onClose: options.onClose ?? (() => {}),
    });
}

test('renders one line per row minus one and respects width', () => {
    const viewer = makeViewer();
    const lines = viewer.render(80);
    assert.equal(lines.length, 23);
    for (const line of lines) {
        assert.ok(
            visibleWidth(line) <= 80,
            `line over width: ${JSON.stringify(line)}`,
        );
    }
});

test('Tab switches to the turns source at the newest turn', () => {
    const viewer = makeViewer();
    viewer.render(80);
    viewer.handleInput('\t');
    const header = viewer.render(80)[0] ?? '';
    assert.match(header, /turns/);
    assert.match(header, /second prompt/);
});

test('bracket keys step turns while in the turns source', () => {
    const viewer = makeViewer({ initialMode: 'turns' });
    viewer.handleInput('[');
    const header = viewer.render(80)[0] ?? '';
    assert.match(header, /first prompt/);
});

test('truncates content wider than a narrow terminal', () => {
    const viewer = makeViewer({
        uncommitted: [{ title: 'x'.repeat(200), diff: 'y'.repeat(200) }],
    });
    for (const line of viewer.render(40)) {
        assert.ok(visibleWidth(line) <= 40);
    }
});

test('Escape closes the viewer', () => {
    let closed = false;
    const viewer = makeViewer({ onClose: () => (closed = true) });
    viewer.handleInput('\u001b');
    assert.equal(closed, true);
});

test('shows a placeholder when the active source is empty', () => {
    const viewer = makeViewer({ uncommitted: [], initialMode: 'uncommitted' });
    const lines = viewer.render(80);
    assert.ok(lines.some((line) => line.includes('No changes to show')));
});
