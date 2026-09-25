# pi-diff-view

Interactive diff viewer and live edits widget for [pi](https://pi.dev).

## Install

```bash
pi install npm:pi-diff-view
# or from a checkout
pi install /absolute/path/to/pi-diff
```

## Usage

```
/diff
```

Opens a scrollable overlay with two sources:

- **Uncommitted**: tracked modifications, staged changes, deletions, and
  untracked files from `git diff HEAD`.
- **Turns**: the files the agent edited, grouped by the prompt that caused them.
  Read straight from the session, so it needs no git and works anywhere.

Diffs render with pi's own renderer, so colors and intra-line highlighting match
the inline edit diffs.

Keys:

- `Tab`: switch between uncommitted and turns
- `[` / `]`: previous / next turn (turns view)
- `up` / `down`: scroll one line
- `pageUp` / `pageDown`: scroll one page
- `n` / `p`: next / previous file or section
- `g` / `G`: jump to top / bottom
- `q` / `Esc`: close

## Live edits widget

Above the editor, pi-diff shows the net effect of the agent's edits this
session, refreshed at each turn boundary:

```
edits · 3 files · +3 -0
src/git.ts      +1 -0
src/index.ts    +1 -0
src/ui.ts       +1 -0
```

For each file the agent touches, pi-diff records the content before the first
touch and diffs it against the current content. Reverted files drop out and the
counts are net, so it shows what the agent has actually changed, not cumulative
churn. It is independent of git: committing does not reset it. Paths are shown
relative to the working directory. Baselines live in the session, capped at
256 KB per file.

It hides itself when nothing differs. Toggle it with `/diff-widget`.

## Status

- [x] Uncommitted changes (`git diff HEAD` plus untracked files)
- [x] Per-turn diffs grouped by prompt, reconstructed from session edit results
- [x] `write`-tool before/after snapshots, persisted per turn
- [x] Live edits widget above the editor (net agent changes, session baseline)
- [ ] Two-pane file list and diff layout
- [ ] Options: `--staged`, `--turn`, path filter

## How it works

- Uncommitted diffs shell out to git, then feed old and new content into pi's
  `generateDiffString` and `renderDiff`. No third-party diff library.
- Per-turn diffs read pi's session data. The `edit` tool persists `details.diff`
  per call, so reconstruction needs no git and works outside a repo. The `write`
  tool stores no diff, so a `tool_call` handler snapshots the old content,
  synthesizes one on `tool_result`, and appends it to the session at `turn_end`.
  Write diffs therefore survive reload, same as edit diffs.

## Development

```bash
npm install
npm run typecheck
npm test
pi -e ./src/index.ts   # then run /diff
```

Tests use the built-in `node:test` runner with no extra dependencies. Git tests
build throwaway repos under the system temp directory.
