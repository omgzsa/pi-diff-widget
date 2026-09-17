import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExecFn } from '../src/git.ts';

/** Runs real git through a promise wrapper, matching pi's `exec` shape. */
export const execFn: ExecFn = (command, args, options) =>
    new Promise((resolve) => {
        execFile(
            command,
            args,
            { cwd: options?.cwd, maxBuffer: 32 * 1024 * 1024 },
            (error, stdout, stderr) => {
                const raw = (error as { code?: unknown } | null)?.code;
                const code = error ? (typeof raw === 'number' ? raw : 1) : 0;
                resolve({ stdout, stderr, code, killed: false });
            },
        );
    });

export async function makeTempDir(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix));
}

export async function initRepo(): Promise<string> {
    const dir = await makeTempDir('pi-diff-repo-');
    await run(dir, ['git', 'init', '-q']);
    await run(dir, ['git', 'config', 'user.email', 'test@example.com']);
    await run(dir, ['git', 'config', 'user.name', 'pi-diff test']);
    return dir;
}

export async function run(cwd: string, argv: string[]): Promise<void> {
    const [command, ...args] = argv;
    const result = await execFn(command ?? '', args, { cwd });
    if (result.code !== 0) {
        throw new Error(`${argv.join(' ')} failed: ${result.stderr}`);
    }
}

export async function write(
    cwd: string,
    path: string,
    content: string,
): Promise<void> {
    await writeBytes(cwd, path, Buffer.from(content, 'utf8'));
}

export async function writeBytes(
    cwd: string,
    path: string,
    content: Buffer,
): Promise<void> {
    const absolute = join(cwd, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
}

export async function commitAll(cwd: string, message: string): Promise<void> {
    await run(cwd, ['git', 'add', '-A']);
    await run(cwd, ['git', 'commit', '-q', '-m', message]);
}
