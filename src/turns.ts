import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    generateDiffString,
    isEditToolResult,
    isToolCallEventType,
    isWriteToolResult,
} from '@earendil-works/pi-coding-agent';
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionEntry,
} from '@earendil-works/pi-coding-agent';

export interface TurnEdit {
    path: string;
    /** Raw display diff in pi's line-numbered format (`+123 text`). Render with `renderDiff`. */
    diff: string;
}

export interface Turn {
    prompt: string;
    edits: TurnEdit[];
}

export interface WriteDiff {
    path: string;
    diff: string;
}

/** Session entry type used to persist write diffs across reloads. */
export const WRITE_DIFF_ENTRY = 'pi-diff:writes';
/**
 * Session entry type for diffs of `edit` calls another tool made. pi keeps only
 * a bounded `nestedCalls` argument record on the parent result, never a
 * `details.diff`, so these would otherwise vanish from the turns view.
 */
export const NESTED_EDIT_ENTRY = 'pi-diff:nested-edits';

export interface WriteDiffRecord extends WriteDiff {
    toolCallId: string;
}

/** Maps a `write` tool call id to the diff its execution produced. */
export type WriteDiffLookup = (toolCallId: string) => WriteDiff | undefined;

/** The subset of the session manager `collectTurns` reads. */
export type SessionBranchSource = Pick<
    ExtensionContext['sessionManager'],
    'getBranch'
>;

const MAX_TRACKED_WRITES = 2000;
const MAX_TURNS = 100;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

type SnapshotRead =
    | { kind: 'text'; text: string }
    | { kind: 'missing' }
    | { kind: 'too-large' };

async function readSnapshot(path: string): Promise<SnapshotRead> {
    const info = await stat(path).catch(() => undefined);
    if (!info || !info.isFile()) return { kind: 'missing' };
    if (info.size > MAX_SNAPSHOT_BYTES) return { kind: 'too-large' };
    const text = await readFile(path, 'utf8').catch(() => undefined);
    return text === undefined ? { kind: 'missing' } : { kind: 'text', text };
}

function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(
            (block): block is { type: 'text'; text: string } =>
                typeof block === 'object' &&
                block !== null &&
                (block as { type?: unknown }).type === 'text',
        )
        .map((block) => block.text)
        .join(' ')
        .trim();
}

/**
 * `write` results carry no diff, so snapshot the old content and synthesize one
 * after the write, keyed by tool call id. Diffs are persisted per turn.
 */
export function createWriteDiffTracker(pi: ExtensionAPI): WriteDiffLookup {
    const pending = new Map<string, { path: string; before?: string }>();
    const diffs = new Map<string, WriteDiff>();
    const nestedEdits = new Map<string, WriteDiff>();
    let unflushed: string[] = [];
    let unflushedEdits: string[] = [];

    const flush = () => {
        const records: WriteDiffRecord[] = [];
        for (const toolCallId of unflushed) {
            const diff = diffs.get(toolCallId);
            if (diff) records.push({ toolCallId, ...diff });
        }
        const editRecords: WriteDiffRecord[] = [];
        for (const toolCallId of unflushedEdits) {
            const diff = nestedEdits.get(toolCallId);
            if (diff) editRecords.push({ toolCallId, ...diff });
        }
        unflushed = [];
        unflushedEdits = [];
        if (records.length > 0) {
            pi.appendEntry(WRITE_DIFF_ENTRY, { diffs: records });
        }
        if (editRecords.length > 0) {
            pi.appendEntry(NESTED_EDIT_ENTRY, { diffs: editRecords });
        }
    };

    // Persist at turn boundaries so write diffs survive a session reload. At
    // turn_end no tool result is in flight, so it is safe to append an entry.
    pi.on('turn_end', flush);
    pi.on('agent_settled', () => {
        // A write without a matching result (aborted run) would otherwise linger.
        pending.clear();
        flush();
    });

    pi.on('tool_call', async (event, ctx) => {
        if (!isToolCallEventType('write', event)) return;
        const read = await readSnapshot(resolve(ctx.cwd, event.input.path));
        if (read.kind === 'too-large') return; // don't read or diff oversized files
        pending.set(event.toolCallId, {
            path: event.input.path,
            before: read.kind === 'text' ? read.text : undefined,
        });
    });

    pi.on('tool_result', async (event, ctx) => {
        // A tool that calls tools (codemode) produces nested results that never
        // reach the transcript. Keep their diffs so the turns view can attribute
        // them to the calling turn.
        const parentToolCallId = (event as { parentToolCallId?: string })
            .parentToolCallId;
        if (parentToolCallId && isEditToolResult(event)) {
            const diff = event.details?.diff;
            const path = event.input.path;
            if (!diff || typeof path !== 'string') return;
            nestedEdits.set(event.toolCallId, { path, diff });
            unflushedEdits.push(event.toolCallId);
            while (nestedEdits.size > MAX_TRACKED_WRITES) {
                const oldest = nestedEdits.keys().next().value;
                if (oldest === undefined) break;
                nestedEdits.delete(oldest);
            }
            return;
        }

        if (!isWriteToolResult(event)) return;
        const snapshot = pending.get(event.toolCallId);
        if (!snapshot) return;
        pending.delete(event.toolCallId);

        const read = await readSnapshot(resolve(ctx.cwd, snapshot.path));
        const after = read.kind === 'text' ? read.text : '';
        const { diff } = generateDiffString(snapshot.before ?? '', after);
        if (!diff) return;

        diffs.set(event.toolCallId, { path: snapshot.path, diff });
        unflushed.push(event.toolCallId);
        while (diffs.size > MAX_TRACKED_WRITES) {
            const oldest = diffs.keys().next().value;
            if (oldest === undefined) break;
            diffs.delete(oldest);
        }
    });

    return (toolCallId) => diffs.get(toolCallId);
}

/** Collect write diffs persisted by past turns. */
function readPersistedWrites(branch: SessionEntry[]): Map<string, WriteDiff> {
    const writes = new Map<string, WriteDiff>();
    for (const entry of branch) {
        if (entry.type !== 'custom' || entry.customType !== WRITE_DIFF_ENTRY) {
            continue;
        }
        const records = (entry.data as { diffs?: WriteDiffRecord[] } | undefined)
            ?.diffs;
        if (!Array.isArray(records)) continue;
        for (const record of records) {
            writes.set(record.toolCallId, {
                path: record.path,
                diff: record.diff,
            });
        }
    }
    return writes;
}

/**
 * Compare nested call ids (`<parent>/1/2`) so edits appear in call order even
 * though diffs arrive in separate persisted entries.
 */
function compareNestedIds(a: string, b: string): number {
    const left = a.split('/');
    const right = b.split('/');
    const shared = Math.min(left.length, right.length);
    for (let i = 0; i < shared; i += 1) {
        const l = left[i] ?? '';
        const r = right[i] ?? '';
        const ln = Number(l);
        const rn = Number(r);
        if (Number.isFinite(ln) && Number.isFinite(rn) && ln !== rn) {
            return ln - rn;
        }
        if (l !== r) return l.localeCompare(r);
    }
    return left.length - right.length;
}

/**
 * Diffs produced by calls another tool made, keyed by the model-issued call id.
 * Nested ids are `<parent>/<n>`; deeper nesting still starts with the model
 * call's id, so the first segment is the owner.
 */
function readPersistedNested(
    branch: SessionEntry[],
): Map<string, WriteDiff[]> {
    const nested = new Map<string, Map<string, WriteDiff>>();
    for (const entry of branch) {
        if (
            entry.type !== 'custom' ||
            (entry.customType !== WRITE_DIFF_ENTRY &&
                entry.customType !== NESTED_EDIT_ENTRY)
        ) {
            continue;
        }
        const records = (entry.data as { diffs?: WriteDiffRecord[] } | undefined)
            ?.diffs;
        if (!Array.isArray(records)) continue;
        for (const record of records) {
            const slash = record.toolCallId.indexOf('/');
            if (slash < 0) continue; // a direct call, already on its tool result
            const parent = record.toolCallId.slice(0, slash);
            const owned = nested.get(parent) ?? new Map<string, WriteDiff>();
            owned.set(record.toolCallId, {
                path: record.path,
                diff: record.diff,
            });
            nested.set(parent, owned);
        }
    }
    return new Map(
        [...nested].map(([parent, owned]) => [
            parent,
            [...owned]
                .sort(([a], [b]) => compareNestedIds(a, b))
                .map(([, diff]) => diff),
        ]),
    );
}

/**
 * Group edits by user message from persisted session data. No git, no filesystem.
 * `edit` results already carry `details.diff`; `write` results use `lookupWrite`.
 */
export function collectTurns(
    session: SessionBranchSource,
    lookupWrite: WriteDiffLookup,
): Turn[] {
    const branch = session.getBranch();
    const persistedWrites = readPersistedWrites(branch);
    const persistedNested = readPersistedNested(branch);

    const callArguments = new Map<string, Record<string, unknown>>();
    for (const entry of branch) {
        if (entry.type !== 'message' || entry.message.role !== 'assistant')
            continue;
        for (const block of entry.message.content) {
            if (block.type === 'toolCall')
                callArguments.set(block.id, block.arguments ?? {});
        }
    }

    const turns: Turn[] = [];
    let current: Turn | undefined;

    for (const entry of branch) {
        if (entry.type !== 'message') continue;
        const message = entry.message;

        if (message.role === 'user') {
            current = {
                prompt: extractText(message.content),
                edits: [],
            };
            turns.push(current);
            continue;
        }

        if (message.role !== 'toolResult') continue;

        const args = callArguments.get(message.toolCallId);
        const path = typeof args?.path === 'string' ? args.path : '(unknown)';

        if (message.toolName === 'edit') {
            const diff = (message.details as { diff?: string } | undefined)
                ?.diff;
            if (diff) current?.edits.push({ path, diff });
            continue;
        }

        if (message.toolName === 'write') {
            const tracked =
                lookupWrite(message.toolCallId) ??
                persistedWrites.get(message.toolCallId);
            if (tracked)
                current?.edits.push({ path: tracked.path, diff: tracked.diff });
        }

        // Calls another tool made, such as a codemode script's edit/write.
        const nested = persistedNested.get(message.toolCallId);
        if (nested) {
            for (const edit of nested) {
                current?.edits.push({ path: edit.path, diff: edit.diff });
            }
        }
    }

    return turns.length > MAX_TURNS ? turns.slice(-MAX_TURNS) : turns;
}
