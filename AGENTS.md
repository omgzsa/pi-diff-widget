# pi-diff-view

Interactive diff viewer extension for pi.

## Layout

- `src/index.ts` registers `/diff` and wires the viewer.
- `src/git.ts` reads uncommitted changes from git.
- `src/turns.ts` reconstructs per-turn diffs from session data, no git.
- `src/ui.ts` renders the scrollable overlay.
- `src/view.ts` defines view models and maps collected data into them.
- `src/baseline.ts` captures pre-agent file content for the net edits widget.
- `src/widget.ts` renders the live edits summary above the editor.
- `test/` behavior tests (`node:test`) for git collection, turns, view models, and the viewer.

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
- Tests run with Node strip-only mode, so avoid non-erasable syntax (parameter
  properties, enums, namespaces). `erasableSyntaxOnly` in tsconfig enforces this.
- Per-turn diffs must not require git. Git is only for uncommitted changes.
