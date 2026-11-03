# Changelog

## [0.4.2] - 2026-11-03

### Changed

- Cache completed compact tool rows and Copy button labels so scrolling reuses rendered lines instead of rebuilding them.

### Fixed

- Cancel an in-progress Copy click when rendering moves, removes, or changes its Copy target, so a stale press cannot copy different content.

## [0.4.1] - 2026-11-02

### New Features

- Add clickable Copy buttons to fenced code blocks and user messages in fullscreen mode, configurable through `/open-tui`.
- Add syntax-highlighted previews for successful edits and writes in compact tool view, limited to 16 rows with a hint to expand longer output.

### Changed

- Preserve compatible editors installed by other extensions, including runtime replacements, while applying open-tui framing and retaining their input behavior.
- Refine compact tool status indicators with dimmed completed rows, animated running dots, and clearer error and truncation summaries.

### Fixed

- Include tool-reported usage, compaction and branch summaries, and cache warming in footer token and cost totals; show the cache-hit percentage for the latest assistant response.
- Respect `PI_CODING_AGENT_DIR` for settings storage and warn when settings cannot be saved.
- Improve Scala project detection and Git status handling for renamed-then-deleted files.
