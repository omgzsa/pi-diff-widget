import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectUncommitted } from '../src/git.ts';
import {
    commitAll,
    execFn,
    initRepo,
    makeTempDir,
    run,
    write,
    writeBytes,
} from './support.ts';

test('collects modified, deleted, staged, and untracked files', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'keep.txt', 'a\nb\nc\n');
    await write(repo, 'gone.txt', 'bye\n');
    await commitAll(repo, 'init');

    await write(repo, 'keep.txt', 'a\nB\nc\nd\n');
    await rm(join(repo, 'gone.txt'));
    await write(repo, 'added.txt', 'new\n');
    await run(repo, ['git', 'add', 'added.txt']);
    await write(repo, 'untracked.txt', 'loose\n');

    const files = await collectUncommitted(execFn, repo);
    const statuses = Object.fromEntries(files.map((f) => [f.path, f.status]));

    assert.deepEqual(statuses, {
        'added.txt': 'added',
        'gone.txt': 'deleted',
        'keep.txt': 'modified',
        'untracked.txt': 'added',
    });

    const keep = files.find((f) => f.path === 'keep.txt');
    assert.match(keep?.diff ?? '', /\+\d+ B/);
});

test('lists staged and untracked files in a repo with no commits', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'a.txt', 'a\n');
    await write(repo, 'b.txt', 'b\n');
    await run(repo, ['git', 'add', 'a.txt']);

    const files = await collectUncommitted(execFn, repo);
    assert.deepEqual(
        files.map((f) => [f.path, f.status]),
        [
            ['a.txt', 'added'],
            ['b.txt', 'added'],
        ],
    );
});

test('flags binary files and skips their diff', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await writeBytes(repo, 'blob.bin', Buffer.from([0, 1, 2, 0, 3]));

    const files = await collectUncommitted(execFn, repo);
    const blob = files.find((f) => f.path === 'blob.bin');
    assert.equal(blob?.status, 'binary');
    assert.equal(blob?.diff, '');
});

test('flags files over the text cap as too-large', async (t) => {
    const repo = await initRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    await write(repo, 'big.txt', 'x'.repeat(600 * 1024));

    const files = await collectUncommitted(execFn, repo);
    const big = files.find((f) => f.path === 'big.txt');
    assert.equal(big?.status, 'too-large');
    assert.equal(big?.diff, '');
});

test('throws outside a git repository', async (t) => {
    const dir = await makeTempDir('pi-diff-nogit-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    await assert.rejects(
        () => collectUncommitted(execFn, dir),
        /not a git repository/,
    );
});
