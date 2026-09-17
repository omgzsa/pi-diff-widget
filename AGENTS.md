# pi-diff

Interactive diff viewer extension for pi.

## Layout

- `src/index.ts` registers `/diff` and wires the viewer.
- `src/git.ts` reads uncommitted changes from git.
- `src/turns.ts` reconstructs per-turn diffs from session data, no git.
- `src/ui.ts` renders the scrollable overlay.
- `test/` behavior tests (`node:test`) for git collection and turn grouping.

## Dev

```bash
npm install          # optional, pi provides the peer deps at runtime
npm run typecheck
npm test
pi -e ./src/index.ts # then run /diff
```

## Constraints

- Keep `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and the other
  bundled pi packages in `peerDependencies` with `"*"`. Never bundle them.
- Reuse pi's `renderDiff` and `generateDiffString`. Do not add a diff library.
- Relative imports use the `.ts` extension.
- Per-turn diffs must not require git. Git is only for uncommitted changes.
