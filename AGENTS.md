# Repository Guidelines

## Project Layout

- `extensions/open-tui/` contains the TypeScript extension source.
- `tests/` contains the `node:test` test files.
- `assets/` contains repository and package images.
- `README.md` and `README.zh-CN.md` document user-facing behavior in English and Simplified Chinese.

## Development Commands

```bash
npm install
npm test
npm run typecheck
pi -e .
```

Use `npm test` for the full test suite and `npm run typecheck` for the strict TypeScript check. Use `pi -e .` to exercise the extension interactively.

## Compatibility

- Support Pi 1.2.0 and later, with Node.js 22.19.0 as the minimum.
- Use public extension APIs available in Pi 1.2.0; do not add fallbacks for older, unsupported releases.
- CI checks Pi 1.2.0 and latest on Node.js 22.19.0/24 across Linux, Windows, and macOS. Keep all Pi packages on the same version when reproducing either endpoint.

## Code Conventions

- Keep changes focused and reuse existing modules before adding new abstractions or dependencies.
- Follow the existing TypeScript style: tabs for indentation, double quotes, trailing commas, and explicit `.ts` extensions in relative imports.
- Preserve strict typing and validate data at external boundaries. Keep terminal control-sequence filtering, persistence error reporting, and session-lifecycle cleanup intact.
- Do not reformat or refactor unrelated code.

## Tests and Documentation

- Add or update focused `node:test` coverage for behavior changes.
- Run the relevant tests and `npm run typecheck` before finishing. For a full check, run `npm test && npm run typecheck`.
- When settings, configuration, or other user-visible behavior changes, update both README files where applicable.
- Use temporary directories for config and Git checks; do not write to the developer's real agent directory.
- Do not edit `package-lock.json` unless dependency metadata changes.
