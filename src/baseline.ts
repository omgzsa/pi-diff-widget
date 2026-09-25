import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';

export const BASELINE_ENTRY = 'pi-diff:baselines';
const MAX_BASELINE_BYTES = 256 * 1024;

export interface BaselineRecord {
    path: string;
    content: string;
}

/**
 * Read a file. Returns '' when it does not exist (an empty baseline for new
 * files) and undefined when it is too large or unreadable.
 */
export async function readFileCapped(
    path: string,
    maxBytes = MAX_BASELINE_BYTES,
): Promise<string | undefined> {
    const info = await stat(path).catch(() => undefined);
    if (!info || !info.isFile()) return '';
    if (info.size > maxBytes) return undefined;
    return readFile(path, 'utf8').catch(() => undefined);
}

/**
 * Records each file's content the first time the agent touches it, so net agent
 * changes can be diffed against the pre-agent state. Independent of git.
 */
export class BaselineTracker {
    private readonly baselines = new Map<string, string>();
    private readonly unflushed = new Set<string>();

    get(path: string): string | undefined {
        return this.baselines.get(path);
    }

    paths(): string[] {
        return [...this.baselines.keys()];
    }

    async capture(cwd: string, path: string): Promise<void> {
        const absolute = resolve(cwd, path);
        if (this.baselines.has(absolute)) return;
        const content = await readFileCapped(absolute);
        if (content === undefined) return;
        this.baselines.set(absolute, content);
        this.unflushed.add(absolute);
    }

    /** Accept current content as the new baseline, so net changes drop to zero. */
    async rebaseline(pi: ExtensionAPI): Promise<void> {
        for (const path of [...this.baselines.keys()]) {
            const content = await readFileCapped(path);
            if (content === undefined) continue;
            this.baselines.set(path, content);
            this.unflushed.add(path);
        }
        this.flush(pi);
    }

    /** Drop baselines whose absolute path fails the predicate. */
    retain(keep: (path: string) => boolean): void {
        for (const path of [...this.baselines.keys()]) {
            if (!keep(path)) this.baselines.delete(path);
        }
    }

    flush(pi: ExtensionAPI): void {
        if (this.unflushed.size === 0) return;
        const records: BaselineRecord[] = [];
        for (const path of this.unflushed) {
            const content = this.baselines.get(path);
            if (content !== undefined) records.push({ path, content });
        }
        this.unflushed.clear();
        if (records.length > 0) {
            pi.appendEntry(BASELINE_ENTRY, { baselines: records });
        }
    }

    load(branch: SessionEntry[]): void {
        for (const entry of branch) {
            if (entry.type !== 'custom' || entry.customType !== BASELINE_ENTRY) {
                continue;
            }
            const records = (
                entry.data as { baselines?: BaselineRecord[] } | undefined
            )?.baselines;
            if (!Array.isArray(records)) continue;
            for (const record of records) {
                // Later entries win, so accepting can re-baseline a path.
                this.baselines.set(record.path, record.content);
            }
        }
    }
}

export function createBaselineTracker(pi: ExtensionAPI): BaselineTracker {
    const tracker = new BaselineTracker();

    pi.on('session_start', (_event, ctx) => {
        tracker.load(ctx.sessionManager.getBranch());
    });

    pi.on('tool_call', async (event, ctx) => {
        if (isToolCallEventType('edit', event)) {
            await tracker.capture(ctx.cwd, event.input.path);
            return;
        }
        if (isToolCallEventType('write', event)) {
            await tracker.capture(ctx.cwd, event.input.path);
        }
    });

    // Flush at turn boundaries, where it is safe to append a session entry.
    pi.on('turn_end', () => tracker.flush(pi));
    pi.on('agent_settled', () => tracker.flush(pi));

    return tracker;
}
