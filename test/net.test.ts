import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { BaselineTracker, readFileCapped } from '../src/baseline.ts';
import { computeNetSummary } from '../src/widget.ts';
import { makeTempDir, write } from './support.ts';

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

test('readFileCapped returns undefined for oversized files', async (t) => {
    const dir = await makeTempDir('pi-diff-net-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await write(dir, 'big.txt', 'x'.repeat(64));
    assert.equal(await readFileCapped(`${dir}/big.txt`, 16), undefined);
    assert.equal(await readFileCapped(`${dir}/big.txt`, 128), 'x'.repeat(64));
});
