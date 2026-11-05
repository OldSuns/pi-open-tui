# Changelog

## [Unreleased]

### New Features

- Allow selected tools, such as `edit`, to keep their native rendering in compact mode through `toolView.exclude`.

### Breaking Changes

- Require Pi 1.5.0 or later.

### Changed

- Group `/open-tui` settings into sections in English and Simplified Chinese, with non-selectable headings and scrolling that includes heading rows.

### Fixed

- Show code-block Copy labels as soon as streaming ends, without requiring a terminal resize, and hide them when streaming resumes.
- Preserve each Copy button's code and click region across Markdown block reuse, repeated identical blocks, and mixed cached and new blocks; restore source tabs using the current block occurrence.
- Cancel pending Copy clicks when buttons are disabled or another code-block renderer takes ownership, and suppress clipboard notifications from cleaned-up installations.

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
