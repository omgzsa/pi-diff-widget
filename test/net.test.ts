import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
    ExtensionAPI,
    SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { BaselineTracker, readFileCapped } from '../src/baseline.ts';
import {
    collectRevertTargets,
    computeNetSummary,
    pruneCleanBaselines,
    reconcileBaselines,
    recordPreexisting,
    revertTargets,
} from '../src/summary.ts';
import { commitAll, execFn, initRepo, makeTempDir, write } from './support.ts';

test('net summary diffs current content against the baseline', async (t) => {
    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\ntwo\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');

    await write(dir, 'a.ts', 'one\nTWO\nthree\n');

    const summary = await computeNetSummary(baselines, dir);
    assert.equal(summary.fileCount, 1);
    assert.equal(summary.files[0]?.path, 'a.ts');
    assert.equal(summary.files[0]?.added, 2);
    assert.equal(summary.files[0]?.removed, 1);
});

test('a file reverted to its baseline drops out of the summary', async (t) => {
    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\ntwo\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');

    await write(dir, 'a.ts', 'changed\n');
    assert.equal((await computeNetSummary(baselines, dir)).fileCount, 1);

    await write(dir, 'a.ts', 'one\ntwo\n');
    assert.equal((await computeNetSummary(baselines, dir)).fileCount, 0);
});

test('first baseline wins when a file is touched twice', async (t) => {
    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'original\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');

    await write(dir, 'a.ts', 'second\n');
    await baselines.capture(dir, 'a.ts');

    await write(dir, 'a.ts', 'third\n');
    const summary = await computeNetSummary(baselines, dir);
    assert.equal(summary.files[0]?.added, 1);
    assert.equal(summary.files[0]?.removed, 1);
});

test('a new file gets an empty baseline and reads as all added', async (t) => {
    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'fresh.ts');

    await write(dir, 'fresh.ts', 'hello\n');
    const summary = await computeNetSummary(baselines, dir);
    assert.equal(summary.files[0]?.added, 1);
    assert.equal(summary.files[0]?.removed, 0);
});

test('a deleted file reads as a full deletion while its directory exists', async (t) => {
    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\ntwo\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');
    await rm(join(dir, 'a.ts'));

    const summary = await computeNetSummary(baselines, dir);
    assert.equal(summary.files[0]?.added, 0);
    assert.equal(summary.files[0]?.removed, 2);
    assert.equal(summary.files[0]?.deleted, true);
});

test('an emptied file is not marked deleted', async (t) => {
    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\ntwo\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');
    await write(dir, 'a.ts', '');

    const summary = await computeNetSummary(baselines, dir);
    assert.equal(summary.files[0]?.removed, 2);
    assert.equal(summary.files[0]?.deleted, undefined);
});

test('a file whose directory is gone is not a net change', async (t) => {
    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'sub/a.ts', 'one\ntwo\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'sub/a.ts');
    await rm(join(dir, 'sub'), { recursive: true });

    assert.equal((await computeNetSummary(baselines, dir)).fileCount, 0);
    assert.deepEqual(await collectRevertTargets(baselines, dir), []);
});

test('accept re-baselines so the summary drops to zero', async (t) => {
    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');

    await write(dir, 'a.ts', 'two\n');
    assert.equal((await computeNetSummary(baselines, dir)).fileCount, 1);

    const pi = { appendEntry() {} } as unknown as ExtensionAPI;
    await baselines.rebaseline(pi);

    assert.equal((await computeNetSummary(baselines, dir)).fileCount, 0);
});

test('committing a file drops it from the widget inputs', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'a.ts', 'one\n');
    await commitAll(repo, 'init');

    const baselines = new BaselineTracker();
    await baselines.capture(repo, 'a.ts');
    await write(repo, 'a.ts', 'two\n');
    assert.equal((await computeNetSummary(baselines, repo)).fileCount, 1);

    await commitAll(repo, 'change');
    await pruneCleanBaselines(baselines, execFn, repo);

    assert.deepEqual(baselines.paths(), []);
    assert.equal((await computeNetSummary(baselines, repo)).fileCount, 0);
});

test('prune drops baselines whose directory is gone', async (t) => {
    const dir = await makeTempDir('pi-diff-prune-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'sub/a.ts', 'one\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'sub/a.ts');
    await rm(join(dir, 'sub'), { recursive: true });

    await pruneCleanBaselines(baselines, execFn, dir);

    assert.deepEqual(baselines.paths(), []);
});

test('reject restores a modified file to its baseline', async (t) => {
    const dir = await makeTempDir('pi-diff-revert-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'a.ts', 'one\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'a.ts');
    await write(dir, 'a.ts', 'two\n');

    const targets = await collectRevertTargets(baselines, dir);
    assert.equal(targets.length, 1);
    await revertTargets(targets);

    assert.equal(await readFile(join(dir, 'a.ts'), 'utf8'), 'one\n');
    assert.equal((await computeNetSummary(baselines, dir)).fileCount, 0);
});

test('reject deletes a file the agent created', async (t) => {
    const dir = await makeTempDir('pi-diff-revert-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'fresh.ts');
    await write(dir, 'fresh.ts', 'new\n');

    const targets = await collectRevertTargets(baselines, dir);
    await revertTargets(targets);

    await assert.rejects(() => readFile(join(dir, 'fresh.ts'), 'utf8'));
});

test('reject recreates a file the agent deleted', async (t) => {
    const dir = await makeTempDir('pi-diff-revert-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'gone.ts', 'original\n');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'gone.ts');
    await rm(join(dir, 'gone.ts'));

    const targets = await collectRevertTargets(baselines, dir);
    await revertTargets(targets);

    assert.equal(await readFile(join(dir, 'gone.ts'), 'utf8'), 'original\n');
});

test('reject empties a file that was empty before, rather than deleting it', async (t) => {
    const dir = await makeTempDir('pi-diff-revert-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'empty.ts', '');
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'empty.ts');
    await write(dir, 'empty.ts', 'filled\n');

    assert.equal(baselines.wasMissing(`${dir}/empty.ts`), false);
    await revertTargets(await collectRevertTargets(baselines, dir));

    assert.equal(await readFile(join(dir, 'empty.ts'), 'utf8'), '');
});

test('readFileCapped returns undefined for oversized files', async (t) => {    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'big.txt', 'x'.repeat(64));
    assert.equal(await readFileCapped(`${dir}/big.txt`, 16), undefined);
    assert.equal(await readFileCapped(`${dir}/big.txt`, 128), 'x'.repeat(64));
});

test('prune keeps baselines git cannot judge, such as ignored files', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, '.gitignore', '.scratch/\n');
    await commitAll(repo, 'init');

    await write(repo, '.scratch/notes.md', 'one\n');
    const baselines = new BaselineTracker();
    await baselines.capture(repo, '.scratch/notes.md');
    await write(repo, '.scratch/notes.md', 'two\n');

    await pruneCleanBaselines(baselines, execFn, repo);

    assert.equal(
        baselines.tracks(join(repo, '.scratch/notes.md')),
        true,
    );
    assert.equal((await computeNetSummary(baselines, repo)).fileCount, 1);
});

test('reconcile seeds HEAD content for edits made outside edit and write', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'a.ts', 'one\ntwo\n');
    await commitAll(repo, 'init');
    await write(repo, 'a.ts', 'one\nTWO\n'); // as bash would

    const baselines = new BaselineTracker();
    assert.equal(await reconcileBaselines(baselines, execFn, repo), 1);

    const summary = await computeNetSummary(baselines, repo);
    assert.equal(summary.fileCount, 1);
    assert.equal(summary.files[0]?.added, 1);
    assert.equal(summary.files[0]?.removed, 1);

    const targets = await collectRevertTargets(baselines, repo);
    assert.equal(targets.length, 1);
    await revertTargets(targets);
    assert.equal(await readFile(join(repo, 'a.ts'), 'utf8'), 'one\ntwo\n');
});

test('reconcile does not claim files that were already dirty at session start', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'a.ts', 'one\n');
    await commitAll(repo, 'init');
    await write(repo, 'a.ts', 'user work\n');

    const baselines = new BaselineTracker();
    await recordPreexisting(baselines, execFn, repo);
    await write(repo, 'a.ts', 'user work and more\n');

    assert.equal(await reconcileBaselines(baselines, execFn, repo), 0);
    assert.equal((await computeNetSummary(baselines, repo)).fileCount, 0);
});

test('reconcile treats a new untracked file as all added', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'keep.ts', 'one\n');
    await commitAll(repo, 'init');
    await write(repo, 'fresh.ts', 'hello\n');

    const baselines = new BaselineTracker();
    assert.equal(await reconcileBaselines(baselines, execFn, repo), 1);

    const summary = await computeNetSummary(baselines, repo);
    assert.deepEqual(
        summary.files.map((file) => file.path),
        ['fresh.ts'],
    );
    assert.equal(summary.files[0]?.added, 1);
});

test('a file over the baseline cap is listed with a note', async (t) => {
    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'big.json', 'x'.repeat(300 * 1024));
    const baselines = new BaselineTracker();
    await baselines.capture(dir, 'big.json');

    assert.deepEqual(baselines.skippedPaths(), [
        { path: join(dir, 'big.json'), reason: 'too-large' },
    ]);
    const summary = await computeNetSummary(baselines, dir);
    assert.equal(summary.fileCount, 1);
    assert.equal(summary.files[0]?.note, 'too large to diff');
});

test('reconcile marks an oversized new file instead of hiding it', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'keep.ts', 'one\n');
    await commitAll(repo, 'init');
    await write(repo, 'dump.json', 'x'.repeat(300 * 1024));

    const baselines = new BaselineTracker();
    assert.equal(await reconcileBaselines(baselines, execFn, repo), 1);

    const summary = await computeNetSummary(baselines, repo);
    assert.equal(summary.files[0]?.path, 'dump.json');
    assert.equal(summary.files[0]?.note, 'too large to diff');
});

test('reconcile marks a file deleted outside edit and write', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'gone.ts', 'one\ntwo\n');
    await commitAll(repo, 'init');
    await rm(join(repo, 'gone.ts'));

    const baselines = new BaselineTracker();
    assert.equal(await reconcileBaselines(baselines, execFn, repo), 1);

    const summary = await computeNetSummary(baselines, repo);
    assert.equal(summary.files[0]?.path, 'gone.ts');
    assert.equal(summary.files[0]?.deleted, true);
    assert.equal(summary.files[0]?.removed, 2);
});

test('a commit clears the pre-existing mark so later edits reconcile', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'a.ts', 'one\n');
    await commitAll(repo, 'init');
    await write(repo, 'a.ts', 'user work\n');

    const baselines = new BaselineTracker();
    await recordPreexisting(baselines, execFn, repo);

    await commitAll(repo, 'user work');
    await pruneCleanBaselines(baselines, execFn, repo);

    await write(repo, 'a.ts', 'later\n');
    assert.equal(await reconcileBaselines(baselines, execFn, repo), 1);
    assert.equal((await computeNetSummary(baselines, repo)).fileCount, 1);
});

test('a reload does not resurrect a baseline dropped by a commit', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'a.ts', 'one\n');
    await commitAll(repo, 'init');

    const appended: Array<{ customType: string; data: unknown }> = [];
    const pi = {
        appendEntry(customType: string, data?: unknown) {
            appended.push({ customType, data });
        },
    } as unknown as ExtensionAPI;

    const baselines = new BaselineTracker();
    await baselines.capture(repo, 'a.ts');
    await write(repo, 'a.ts', 'two\n');
    baselines.flush(pi);

    await commitAll(repo, 'agent work');
    await pruneCleanBaselines(baselines, execFn, repo);
    baselines.flush(pi);

    const restored = new BaselineTracker();
    restored.load(
        appended.map(
            (entry, i) =>
                ({
                    type: 'custom',
                    id: `x${i}`,
                    parentId: null,
                    customType: entry.customType,
                    data: entry.data,
                }) as unknown as SessionEntry,
        ),
    );
    assert.deepEqual(restored.paths(), []);

    await write(repo, 'a.ts', 'three\n');
    assert.equal(await reconcileBaselines(restored, execFn, repo), 1);
    assert.equal((await computeNetSummary(restored, repo)).files[0]?.removed, 1);
});
