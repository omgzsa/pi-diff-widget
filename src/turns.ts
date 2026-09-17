import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    generateDiffString,
    isToolCallEventType,
    isWriteToolResult,
} from '@earendil-works/pi-coding-agent';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export interface TurnEdit {
    path: string;
    /** Raw display diff in pi's line-numbered format (`+123 text`). Render with `renderDiff`. */
    diff: string;
}

export interface Turn {
    index: number;
    prompt: string;
    edits: TurnEdit[];
}

export interface WriteDiff {
    path: string;
    diff: string;
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
 * after the write, keyed by tool call id. In-memory: lost on session reload.
 */
export function createWriteDiffTracker(pi: ExtensionAPI): WriteDiffLookup {
    const pending = new Map<string, { path: string; before?: string }>();
    const diffs = new Map<string, WriteDiff>();
    const order: string[] = [];

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
        if (!isWriteToolResult(event)) return;
        const snapshot = pending.get(event.toolCallId);
        if (!snapshot) return;
        pending.delete(event.toolCallId);

        const read = await readSnapshot(resolve(ctx.cwd, snapshot.path));
        const after = read.kind === 'text' ? read.text : '';
        const { diff } = generateDiffString(snapshot.before ?? '', after);
        if (!diff) return;

        diffs.set(event.toolCallId, { path: snapshot.path, diff });
        order.push(event.toolCallId);
        if (order.length > MAX_TRACKED_WRITES) {
            const oldest = order.shift();
            if (oldest !== undefined) diffs.delete(oldest);
        }
    });

    return (toolCallId) => diffs.get(toolCallId);
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
                index: turns.length,
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
            const tracked = lookupWrite(message.toolCallId);
            if (tracked)
                current?.edits.push({ path: tracked.path, diff: tracked.diff });
        }
    }

    return turns.length > MAX_TURNS ? turns.slice(-MAX_TURNS) : turns;
}
