# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
