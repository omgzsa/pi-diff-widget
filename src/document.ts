import { renderDiff } from '@earendil-works/pi-coding-agent';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { DiffSection } from './view.ts';

/** The theme methods `buildDocument` uses. */
export type DocumentTheme = Pick<Theme, 'fg' | 'bold'>;

/** Turns one raw display diff into styled, newline-joined lines. */
export type DiffTextRenderer = (diff: string) => string;

export interface DiffDocument {
    lines: string[];
    sectionStarts: number[];
}

/**
 * Flatten sections into one scrollable document. Pure and TUI-free. The body
 * renderer is injected so tests avoid pi's global theme; defaults to renderDiff.
 */
export function buildDocument(
    sections: DiffSection[],
    theme: DocumentTheme,
    renderDiffText: DiffTextRenderer = renderDiff,
): DiffDocument {
    const lines: string[] = [];
    const sectionStarts: number[] = [];

    if (sections.length === 0) {
        lines.push(theme.fg('dim', 'No changes to show.'));
        return { lines, sectionStarts };
    }

    for (const section of sections) {
        sectionStarts.push(lines.length);
        const detail = section.detail
            ? `  ${theme.fg('dim', section.detail)}`
            : '';
        lines.push(`${theme.fg('accent', theme.bold(section.title))}${detail}`);
        if (section.diff) {
            for (const line of renderDiffText(section.diff).split('\n')) {
                lines.push(line);
            }
        } else {
            lines.push(theme.fg('dim', section.note ?? '(no textual diff)'));
        }
        lines.push('');
    }

    return { lines, sectionStarts };
}
