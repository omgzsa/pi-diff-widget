# pi-diff

Interactive diff viewer for [pi](https://pi.dev). Uncommitted changes now, per-turn diffs next.

## Install

```bash
pi install npm:pi-diff
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

## Status

- [x] Uncommitted changes (`git diff HEAD` plus untracked files)
- [x] Per-turn diffs grouped by prompt, reconstructed from session edit results
- [x] `write`-tool before/after snapshots
- [ ] Persist write snapshots so they survive session reload
- [ ] Two-pane file list and diff layout
- [ ] Options: `--staged`, `--turn`, path filter

## How it works

- Uncommitted diffs shell out to git, then feed old and new content into pi's
  `generateDiffString` and `renderDiff`. No third-party diff library.
- Per-turn diffs read pi's session data. The `edit` tool persists `details.diff`
  per call, so reconstruction needs no git and works outside a repo. The `write`
  tool stores no diff, so a `tool_call` handler snapshots the old content and
  synthesizes one. Write snapshots are in-memory for now.
