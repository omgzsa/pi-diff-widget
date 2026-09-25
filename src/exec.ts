import type { ExecOptions, ExecResult } from '@earendil-works/pi-coding-agent';

/** The subset of `ExtensionAPI` used to shell out. */
export type ExecFn = (
    command: string,
    args: string[],
    options?: ExecOptions,
) => Promise<ExecResult>;
