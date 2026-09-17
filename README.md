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

Opens a scrollable overlay listing every uncommitted change in the current git
repo: tracked modifications, staged changes, deletions, and untracked files.
Diffs are rendered with pi's own renderer, so colors and intra-line highlighting
match the inline edit diffs.

Keys:

- `up` / `down`: scroll one line
- `pageUp` / `pageDown`: scroll one page
- `n` / `p`: next / previous file
- `g` / `G`: jump to top / bottom
- `q` / `Esc`: close

## Status

- [x] Uncommitted changes (`git diff HEAD` plus untracked files)
- [ ] Per-turn diffs reconstructed from session edit results (no git required)
- [ ] `write`-tool before/after snapshots
- [ ] Two-pane file list and diff layout
- [ ] Options: `--staged`, `--turn`, path filter

## How it works

- Uncommitted diffs shell out to git, then feed old and new content into pi's
  `generateDiffString` and `renderDiff`. No third-party diff library.
- Per-turn diffs will read pi's session data directly. The `edit` tool already
  persists `details.diff` per call, so per-turn reconstruction needs no git and
  works outside a repo. The `write` tool stores no diff, so a `tool_call`
  handler captures the previous content to synthesize one.
