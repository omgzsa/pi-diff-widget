# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.5] - 2026-09-25

### Added

- `/diff-widget reject` restores tracked files to their pre-agent content,
  deleting files the agent created and recreating ones it deleted. It confirms
  first, since it cannot be undone.

### Fixed

- Unknown `/diff-widget` actions now report a warning instead of silently
  toggling the widget. Previously a typo such as `reset` turned it off.

## [0.0.4] - 2026-09-25

### Fixed

- The live edits widget now drops a file once it has no uncommitted changes, so
  committing clears the panel automatically. Previously, committed files kept
  showing until `/diff-widget accept`.

## [0.0.3] - 2026-09-25

### Changed

- Renamed the accept action from `/diff-widget reset` to `/diff-widget accept`,
  with `keep` as an alias. `reset` implied discarding the changes, but the action
  keeps them by making the current content the new baseline.

## [0.0.2] - 2026-09-25

### Added

- `/diff-widget reset` accepts the current state as the new baseline, clearing
  the live edits panel until the agent edits again. This is the equivalent of
  Zed's Keep All.

## [0.0.1] - 2026-09-25

### Added

- `/diff` command: a scrollable overlay with uncommitted changes and per-turn
  edits, toggled with `Tab`, stepped per turn with `[` and `]`.
- Uncommitted view from git, including repos with no commits, and handling for
  binary, oversized, and unreadable files.
- Per-turn view reconstructed from session data. `edit` diffs come from
  `details.diff`; `write` diffs are synthesized from before/after snapshots and
  persisted so they survive a reload.
- Live edits widget above the editor showing net agent changes against a
  per-file session baseline, with a `/diff-widget` toggle.
