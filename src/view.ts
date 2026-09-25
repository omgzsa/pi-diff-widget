import type { DiffFile } from './git.ts';
import type { Turn } from './turns.ts';

export interface DiffSection {
    title: string;
    detail?: string;
    /** Raw display diff in pi's line-numbered format. Rendered with `renderDiff`. */
    diff?: string;
    note?: string;
}
// TEST LINE FOR DIFF
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

export interface FileEditSummary {
    path: string;
    added: number;
    removed: number;
}

export interface EditSummary {
    fileCount: number;
    added: number;
    removed: number;
    files: FileEditSummary[];
}

/** Count `+` and `-` lines in a raw display diff. `...` separators are ignored. */
export function countDiffLines(diff: string): {
    added: number;
    removed: number;
} {
    let added = 0;
    let removed = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+')) added += 1;
        else if (line.startsWith('-')) removed += 1;
    }
    return { added, removed };
}

/**
 * Aggregate raw diffs per file. Counts are net when each file appears once,
 * which is how the baseline widget feeds it.
 */
export function summarizeDiffs(
    diffs: Array<{ path: string; diff: string }>,
): EditSummary {
    const byPath = new Map<string, FileEditSummary>();

    for (const item of diffs) {
        const counts = countDiffLines(item.diff);
        const existing = byPath.get(item.path);
        if (existing) {
            existing.added += counts.added;
            existing.removed += counts.removed;
        } else {
            byPath.set(item.path, {
                path: item.path,
                added: counts.added,
                removed: counts.removed,
            });
        }
    }

    const files = [...byPath.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
    );
    return {
        fileCount: files.length,
        added: files.reduce((sum, file) => sum + file.added, 0),
        removed: files.reduce((sum, file) => sum + file.removed, 0),
        files,
    };
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
