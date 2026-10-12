# pi-diff-widget

Interactive diff viewer and live edits widget for [pi](https://pi.dev).

![Live edits widget showing 4 files, +17 -2](https://cdn.jsdelivr.net/gh/omgzsa/pi-diff-widget@v0.1.3/docs/widget.png)

## Install

```bash
pi install npm:pi-diff-widget
# straight from the repo, no npm required
pi install git:github.com/omgzsa/pi-diff-widget
# or from a local checkout
pi install /absolute/path/to/pi-diff-widget
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

See [Live edits widget](#live-edits-widget) for the `/diff-widget` actions
(`on`, `off`, `accept`, `reject`).

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
churn. Committing a file drops it from the panel automatically, so what remains
is the agent's work that is not yet committed. Paths are shown relative to the
working directory. Baselines live in the session, capped at 256 KB per file. A
baseline whose parent directory no longer exists is dropped, so a checkout you
move or delete stops counting as a whole-file deletion.

It hides itself when nothing differs.

### `/diff-widget` actions

| Command | Effect |
|---|---|
| `/diff-widget` | Toggle the panel. With no argument it shows a hidden panel and hides a visible one |
| `/diff-widget on` | Show it |
| `/diff-widget off` | Hide it |
| `/diff-widget accept` | Keep the agent's edits: the current content becomes the baseline and the panel clears. Alias: `keep` |
| `/diff-widget reject` | Undo the agent's edits: restore every tracked file to its pre-agent content, delete the files the agent created, and recreate the ones it deleted |

`accept` is Zed's Keep All. `reject` asks for confirmation first, naming up to
five affected paths, and cannot be undone. Whole files only: there is no
hunk-level accept or reject. With nothing to reject it reports `Nothing to
reject`, and any unrecognized argument warns instead of toggling the panel, so a
typo never hides the widget by accident.

```
/diff-widget
/diff-widget on
/diff-widget accept
/diff-widget reject
```

## Status

- [x] Uncommitted changes (`git diff HEAD` plus untracked files)
- [x] Per-turn diffs grouped by prompt, reconstructed from session edit results
- [x] `write`-tool before/after snapshots, persisted per turn
- [x] Live net edits widget above the editor, with `/diff-widget on|off|accept|reject`

See [ROADMAP.md](./ROADMAP.md) for planned work and known gaps.

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
