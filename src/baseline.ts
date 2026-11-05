import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type {
    ExtensionAPI,
    SessionEntry,
} from '@earendil-works/pi-coding-agent';

export const BASELINE_ENTRY = 'pi-diff:baselines';
export const MAX_BASELINE_BYTES = 256 * 1024;

export type SkipReason = 'too-large' | 'unreadable';

export interface BaselineRecord {
    path: string;
    content?: string;
    /** True when the file did not exist when the baseline was captured. */
    missing?: boolean;
    /** Set instead of content when the file cannot be tracked. */
    skipped?: SkipReason;
}

export interface BaselineRead {
    content: string;
    existed: boolean;
}

export type BaselineProbe =
    | ({ kind: 'content' } & BaselineRead)
    | { kind: 'too-large' }
    | { kind: 'unreadable' };

/**
 * Read a file for baselining. A missing file is content-less but `existed`
 * false; a directory is not a file either. Oversized and unreadable files are
 * reported separately so the widget can name them instead of dropping them.
 */
export async function probeBaseline(
    path: string,
    maxBytes = MAX_BASELINE_BYTES,
): Promise<BaselineProbe> {
    let info;
    try {
        info = await stat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { kind: 'content', content: '', existed: false };
        }
        return { kind: 'unreadable' };
    }
    if (!info.isFile()) return { kind: 'content', content: '', existed: false };
    if (info.size > maxBytes) return { kind: 'too-large' };
    try {
        const content = await readFile(path, 'utf8');
        return { kind: 'content', content, existed: true };
    } catch {
        return { kind: 'unreadable' };
    }
}

/** Content and existence, or undefined when the file cannot be tracked. */
export async function readBaseline(
    path: string,
    maxBytes = MAX_BASELINE_BYTES,
): Promise<BaselineRead | undefined> {
    const probe = await probeBaseline(path, maxBytes);
    return probe.kind === 'content'
        ? { content: probe.content, existed: probe.existed }
        : undefined;
}

/**
 * Content only, for callers that do not care whether the file existed. A missing
 * path returns an empty string, not undefined, so callers that must tell a
 * vanished file apart from an empty one use readBaseline or locationGone.
 */
export async function readFileCapped(
    path: string,
    maxBytes = MAX_BASELINE_BYTES,
): Promise<string | undefined> {
    return (await readBaseline(path, maxBytes))?.content;
}

/**
 * True when the path's parent directory is gone. A tracked path whose location
 * no longer exists; the checkout moved or was removed, so its baseline must
 * not read as a deletion.
 */
export async function locationGone(path: string): Promise<boolean> {
    const info = await stat(dirname(path)).catch(() => undefined);
    return info?.isDirectory() !== true;
}

/**
 * Records each file's content the first time the agent touches it, so net agent
 * changes can be diffed against the pre-agent state. Independent of git.
 */
export class BaselineTracker {
    private readonly baselines = new Map<string, string>();
    private readonly missing = new Set<string>();
    private readonly skipped = new Map<string, SkipReason>();
    private readonly unflushed = new Set<string>();
    /** Dirty when the session started; never seeded from HEAD. */
    private readonly preexisting = new Set<string>();

    get(path: string): string | undefined {
        return this.baselines.get(path);
    }

    /** True when the path has content or a skip marker. */
    tracks(path: string): boolean {
        return this.baselines.has(path) || this.skipped.has(path);
    }

    paths(): string[] {
        return [...this.baselines.keys()];
    }

    /** Files tracked but not diffable, with the reason, in path order. */
    skippedPaths(): Array<{ path: string; reason: SkipReason }> {
        return [...this.skipped]
            .map(([path, reason]) => ({ path, reason }))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    /** True when the path did not exist before the agent first touched it. */
    wasMissing(path: string): boolean {
        return this.missing.has(path);
    }

    async capture(cwd: string, path: string): Promise<void> {
        // Real paths keep baselines comparable with git's physical repo root.
        const absolute = await realpath(resolve(cwd, path)).catch(() =>
            resolve(cwd, path),
        );
        if (this.tracks(absolute)) return;
        const probe = await probeBaseline(absolute);
        if (probe.kind === 'content') {
            this.store(absolute, probe);
        } else {
            this.skipped.set(absolute, probe.kind);
        }
        this.unflushed.add(absolute);
    }

    /** Record that a path cannot be tracked, replacing any content baseline. */
    skip(path: string, reason: SkipReason): void {
        this.skipped.set(path, reason);
        this.baselines.delete(path);
        this.missing.delete(path);
        this.unflushed.add(path);
    }

    /**
     * Seed a baseline from a known earlier state, such as HEAD content, for a
     * file the agent changed without going through `edit` or `write`.
     */
    seed(path: string, content: string, existed: boolean): void {
        if (Buffer.byteLength(content, 'utf8') > MAX_BASELINE_BYTES) {
            this.skipped.set(path, 'too-large');
            this.baselines.delete(path);
            this.missing.delete(path);
        } else {
            this.store(path, { content, existed });
        }
        this.unflushed.add(path);
    }

    /** Remember files that were already dirty when the session started. */
    markPreexisting(paths: Iterable<string>): void {
        for (const path of paths) this.preexisting.add(path);
    }

    isPreexisting(path: string): boolean {
        return this.preexisting.has(path);
    }

    /** Accept current content as the new baseline, so net changes drop to zero. */
    async rebaseline(pi: ExtensionAPI): Promise<void> {
        const paths = new Set([...this.baselines.keys(), ...this.skipped.keys()]);
        for (const path of paths) {
            const probe = await probeBaseline(path);
            if (probe.kind === 'content') this.store(path, probe);
            else this.skipped.set(path, probe.kind);
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
                this.unflushed.delete(path);
            }
        }
        for (const path of [...this.skipped.keys()]) {
            if (!keep(path)) {
                this.skipped.delete(path);
                this.unflushed.delete(path);
            }
        }
    }

    private store(path: string, read: BaselineRead): void {
        this.baselines.set(path, read.content);
        this.skipped.delete(path);
        if (read.existed) this.missing.delete(path);
        else this.missing.add(path);
    }

    flush(pi: ExtensionAPI): void {
        if (this.unflushed.size === 0) return;
        const records: BaselineRecord[] = [];
        for (const path of this.unflushed) {
            if (this.baselines.has(path)) {
                records.push({
                    path,
                    content: this.baselines.get(path),
                    missing: this.missing.has(path) ? true : undefined,
                });
                continue;
            }
            const reason = this.skipped.get(path);
            if (reason) records.push({ path, skipped: reason });
        }
        this.unflushed.clear();
        if (records.length > 0) {
            pi.appendEntry(BASELINE_ENTRY, { baselines: records });
        }
    }

    load(branch: SessionEntry[]): void {
        for (const entry of branch) {
            if (
                entry.type !== 'custom' ||
                entry.customType !== BASELINE_ENTRY
            ) {
                continue;
            }
            const records = (
                entry.data as { baselines?: BaselineRecord[] } | undefined
            )?.baselines;
            if (!Array.isArray(records)) continue;
            for (const record of records) {
                if (record.skipped) {
                    this.baselines.delete(record.path);
                    this.missing.delete(record.path);
                    this.skipped.set(record.path, record.skipped);
                    continue;
                }
                if (typeof record.content !== 'string') continue;
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
