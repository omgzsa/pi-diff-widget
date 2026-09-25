# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
