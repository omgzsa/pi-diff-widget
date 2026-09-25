import type { DiffFile } from './git.ts';
import type { Turn } from './turns.ts';

export interface DiffSection {
    title: string;
    detail?: string;
    /** Raw display diff in pi's line-numbered format. Rendered with `renderDiff`. */
    diff?: string;
    note?: string;
}

export interface TurnView {
    label: string;
    sections: DiffSection[];
}

export type ViewMode = 'uncommitted' | 'turns';

/** First non-empty line of a prompt, trimmed and capped for a header label. */
export function summarizePrompt(prompt: string): string {
    const line =
        prompt.split('\n').find((part) => part.trim().length > 0) ?? '';
    const trimmed = line.trim();
    return trimmed.length > 64 ? `${trimmed.slice(0, 61)}...` : trimmed;
}

const NOTE_BY_STATUS: Partial<Record<DiffFile['status'], string>> = {
    binary: 'binary file, no text diff',
    'too-large': 'file too large to diff',
    unreadable: 'file could not be read',
};

function fileSection(file: DiffFile): DiffSection {
    return {
        title: file.path,
        detail: file.status,
        diff: file.diff || undefined,
        note: NOTE_BY_STATUS[file.status],
    };
}

export function toUncommittedSections(files: DiffFile[]): DiffSection[] {
    return files.map((file) => fileSection(file));
}

export function toTurnViews(turns: Turn[]): TurnView[] {
    return turns
        .filter((turn) => turn.edits.length > 0)
        .map((turn, position) => ({
            label: summarizePrompt(turn.prompt) || `prompt ${position + 1}`,
            sections: turn.edits.map((edit) => ({
                title: edit.path,
                diff: edit.diff,
            })),
        }));
}
