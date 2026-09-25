import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BaselineTracker, readFileCapped } from '../src/baseline.ts';
import {
    collectRevertTargets,
    computeNetSummary,
    pruneCleanBaselines,
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
