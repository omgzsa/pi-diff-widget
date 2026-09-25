# Roadmap

Known gaps and planned work, roughly ordered. Nothing here blocks a release.

## Next

### Per-file accept and reject

`/diff-widget accept <path>` and `/diff-widget reject <path>`, matching a tracked
file by relative path, with argument completions from the tracked files. No path
keeps the current all-or-nothing behavior.

Where: `src/summary.ts` gains filtered `rebaselinePaths` and `revertPaths`; the
existing all-files versions become the no-filter case. `src/widget.ts` parses the
path argument. Later: `a` and `d` keys in the `/diff` overlay, which needs a
mapping from a section back to its baseline path, since in the turns view a
section is an edit rather than a file.

### `/diff` options

`/diff --staged` for staged-only changes, `--worktree` for unstaged-only, and a
path filter argument. Add argument completions so the flags are discoverable.

Where: `src/git.ts` already distinguishes staged and worktree content, and
`collectUncommitted` builds the file list. This is mostly plumbing through
`src/index.ts`. Add `getArgumentCompletions` to the `/diff` command.

### Horizontal scroll

Long diff lines are truncated to the viewport today.

Where: `DiffViewer` in `src/ui.ts`. Add a horizontal offset alongside `offset`,
bind `left` / `right` (or `h` / `l`), apply it in `render` with
`visibleWidth` / `sliceByColumn`, and show a small indicator in the footer.

## Later

### Two-pane layout

File list on the left, diff on the right, `Tab` to move focus between them.
Closest to Zed.

Where: `DiffViewer` in `src/ui.ts`. Needs a minimum width and a fallback to the
current single-document layout below it. Overlays expose `visible(termWidth,
termHeight)` and `minWidth`, which can drive the fallback.

### Split `ui.ts`

`DiffViewer` still owns state, input mapping, viewport math, and chrome. About
277 lines. Extract a viewport helper and a keymap so each is testable alone.
`buildDocument` is already extracted and pure; this is the rest of the class.

## Known warts

### `renderDiff` and the theme

`DiffViewer` receives an injected theme for headers and the footer, but the diff
body calls pi's `renderDiff`, which reads pi's module-global theme. It works and
matches inline edit diffs, but it is a hidden dependency. It is already
injectable (`renderDiffText`), so the options are to require the injection
everywhere or document the global reliance more loudly.

### Baseline storage

Baselines store file content in the session, capped at 256 KB per file. Fine for
source files, but a session that touches very large files pays for it. Consider
storing a hash and skipping the widget entry when the file exceeds the cap.

## Not planned

- Accept/reject of individual hunks. pi has no checkpoint model, and widgets are
  read-only. Whole-file operations exist (`/diff-widget accept` and `reject`), but
  there is no hunk-level model.

## Done

- Uncommitted view from git, including repos with no commits, plus binary,
  oversized, and unreadable handling.
- Per-turn view from session data, with `write` diffs persisted per turn.
- `Tab` source toggle and `[` / `]` turn stepping.
- Live net edits widget above the editor. Drops files once they are committed,
  with `/diff-widget on|off|accept|reject`.
