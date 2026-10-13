# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-10-12

### Fixed

- Typing a complete action, such as `/diff accept`, no longer takes two Enters.
  The argument completion menu offered the word you had already finished, so the
  first Enter went to the menu and inserted the suggestion's trailing space.

## [0.2.0] - 2026-10-12

### Changed

- `accept` and `reject` moved to `/diff`, where the edits they act on are shown.
  `/diff-widget` now only controls the panel: `on`, `off`, or a bare toggle.
- `/diff` warns about an unrecognized argument instead of opening the viewer.
- Both commands complete their arguments on `Tab`.

### Removed

- `/diff-widget accept` and `/diff-widget reject`. Use `/diff accept` and
  `/diff reject`.

## [0.1.3] - 2026-10-12

### Added

- `pi.image` gallery preview: a screenshot of the live edits widget, shown on the
  pi.dev package page and in the README.

## [0.1.2] - 2026-10-12

### Changed

- README: document the `/diff-widget` actions (`on`, `off`, `accept`, `reject`)
  as a table, link them from the `/diff` usage section, and correct the
  local-checkout path in the install block.

## [0.1.1] - 2026-09-25

### Fixed

- A tracked file whose parent directory disappeared no longer reports as a
  whole-file deletion in the edits widget. Such baselines are dropped, so
  `/diff-widget reject` can no longer rebuild a directory that was moved or
  deleted. Files the agent actually deleted still count, and `reject` still
  recreates them.

## [0.1.0] - 2026-09-25

First release.

### Added

- `/diff` command: a scrollable overlay with uncommitted changes and per-turn
  edits. `Tab` toggles sources, `[` and `]` step turns, `n` and `p` jump files.
- Uncommitted view from git, including repos with no commits, with handling for
  binary, oversized, and unreadable files.
- Per-turn view reconstructed from session data. `edit` diffs come from
  `details.diff`; `write` diffs are synthesized from before/after snapshots and
  persisted so they survive a reload.
- Live edits widget above the editor showing net agent changes against a
  per-file session baseline. A file leaves the panel once it is committed.
- `/diff-widget` command: `on`, `off`, `accept` (alias `keep`) to keep the
  changes, and `reject` to restore files to their pre-agent content. Unknown
  actions warn instead of silently toggling.
