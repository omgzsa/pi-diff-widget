import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';

export const BASELINE_ENTRY = 'pi-diff:baselines';
const MAX_BASELINE_BYTES = 256 * 1024;

export interface BaselineRecord {
    path: string;
    content: string;
    /** True when the file did not exist when the baseline was captured. */
    missing?: boolean;
}

export interface BaselineRead {
    content: string;
    existed: boolean;
}

/**
 * Read a file for baselining. `existed` distinguishes a missing file (empty
 * baseline) from a genuinely empty file, which reject needs in order to delete
 * versus empty. Returns undefined when the file is too large or unreadable.
 */
export async function readBaseline(
    path: string,
    maxBytes = MAX_BASELINE_BYTES,
): Promise<BaselineRead | undefined> {
    const info = await stat(path).catch(() => undefined);
    if (!info || !info.isFile()) return { content: '', existed: false };
    if (info.size > maxBytes) return undefined;
    const content = await readFile(path, 'utf8').catch(() => undefined);
    if (content === undefined) return undefined;
    return { content, existed: true };
}

/** Content only, for callers that do not care whether the file existed. */
export async function readFileCapped(
    path: string,
    maxBytes = MAX_BASELINE_BYTES,
): Promise<string | undefined> {
    return (await readBaseline(path, maxBytes))?.content;
}

/**
 * Records each file's content the first time the agent touches it, so net agent
 * changes can be diffed against the pre-agent state. Independent of git.
 */
export class BaselineTracker {
    private readonly baselines = new Map<string, string>();
    private readonly missing = new Set<string>();
    private readonly unflushed = new Set<string>();

    get(path: string): string | undefined {
        return this.baselines.get(path);
    }

    paths(): string[] {
        return [...this.baselines.keys()];
    }

    /** True when the path did not exist before the agent first touched it. */
    wasMissing(path: string): boolean {
        return this.missing.has(path);
    }

    async capture(cwd: string, path: string): Promise<void> {
        const absolute = resolve(cwd, path);
        if (this.baselines.has(absolute)) return;
        const read = await readBaseline(absolute);
        if (read === undefined) return;
        this.store(absolute, read);
        this.unflushed.add(absolute);
    }

    /** Accept current content as the new baseline, so net changes drop to zero. */
    async rebaseline(pi: ExtensionAPI): Promise<void> {
        for (const path of [...this.baselines.keys()]) {
            const read = await readBaseline(path);
            if (read === undefined) continue;
            this.store(path, read);
            this.unflushed.add(path);
        }
        this.flush(pi);
    }

    /** Drop baselines whose absolute path fails the predicate. */
    retain(keep: (path: string) => boolean): void {
        for (const path of [...this.baselines.keys()]) {
            if (!keep(path)) {
                this.baselines.delete(path);
                this.missing.delete(path);
            }
        }
    }

    private store(path: string, read: BaselineRead): void {
        this.baselines.set(path, read.content);
        if (read.existed) this.missing.delete(path);
        else this.missing.add(path);
    }

    flush(pi: ExtensionAPI): void {
        if (this.unflushed.size === 0) return;
        const records: BaselineRecord[] = [];
        for (const path of this.unflushed) {
            const content = this.baselines.get(path);
            if (content === undefined) continue;
            records.push({
                path,
                content,
                missing: this.missing.has(path) ? true : undefined,
            });
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
                this.store(record.path, {
                    content: record.content,
                    existed: record.missing !== true,
                });
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
