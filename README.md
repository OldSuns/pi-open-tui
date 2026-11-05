# pi-open-tui

[![omp status](https://omppackages.com/badge/pi-open-tui.svg)](https://omppackages.com/packages/pi-open-tui)

**English** | [简体中文](./README.zh-CN.md)

A polished terminal interface for the [Pi](https://pi.dev) coding agent.

![pi-open-tui preview](https://raw.githubusercontent.com/OldSuns/pi-open-tui/main/assets/preview_dashboard_1.png)

## Highlights

- **Pi header** with model, thinking level, working directory, and useful slash-command hints
- **Responsive footer** with Git state, detected runtime, context usage, token counts, cost, and extension status
- **Framed editor** with block, bar, and underline cursor styles; keeps compatible editors from other extensions
- **Project awareness** for 50+ runtimes and detailed Git state (ahead/behind, staged, modified, untracked, stash, detached HEAD)
- **Turn telemetry** for TPS, time to first token (TTFT), duration, stalls, tokens, and list-price rate
- **Thinking peek**: an inline ticker replaces Pi's hidden `Thinking...` label with the tail of the model's reasoning while it works
- **Interactive settings** through `/open-tui`, available in English and Simplified Chinese

## Requirements

- Pi 1.5.0 or later
- Node.js 22.19.0 or later (Pi's minimum)
- A terminal with UTF-8 and color support
- A [Nerd Font](https://www.nerdfonts.com/font-downloads) for the full icon set (optional; portable Unicode icons are built in)

## Install

Install the extension:

```bash
pi install npm:pi-open-tui
```

Or try it for one session:

```bash
pi -e npm:pi-open-tui
```

## Font and icons

Install any patched font from the [Nerd Fonts downloads page](https://www.nerdfonts.com/font-downloads) or the [latest release](https://github.com/ryanoasis/nerd-fonts/releases/latest), select it in your terminal profile, and restart the terminal. In VS Code, Windows Terminal, and similar apps, set the font in the terminal profile; installing it in the OS is not enough.

The default `auto` mode checks the terminal environment, not the installed font file:

| Mode | Behavior |
| --- | --- |
| `auto` | Nerd Font icons in interactive UTF-8 TTYs; portable Unicode for SSH sessions (the client terminal usually has no Nerd Font); ASCII for non-interactive output, `TERM=dumb`, or a non-UTF-8 locale |
| `nerd` | Force Nerd Font icons after configuring a Nerd Font in the terminal |
| `unicode` | Portable Unicode icons that render without a patched font; emoji use the terminal's emoji fallback |
| `ascii` | Plain-text icons |

If icons appear as boxes or wrong symbols, open `/open-tui` and change the mode under **Appearance → Icons**. If the font is installed but `auto` still picks ASCII, select `nerd`; select `nerd` over SSH too when the client terminal has a Nerd Font.

If wide Nerd Font icons eat the gap before their labels (for example in Kitty), enable `footerSegments.nerdIconSpacing` (**Footer → Other** in `/open-tui`) to reserve an extra blank cell after Nerd Font icons; Unicode/ASCII icons and compact Git flags are unaffected. `narrow_symbols U+E000-U+F8FF 1` in `kitty.conf` is an alternative.

## Configuration

Run `/open-tui` to open the settings dialog. It provides **General**, **Appearance**, **Footer**, and **Telemetry** tabs and adapts to the terminal size. Settings are stored in `open-tui.json` inside Pi's agent directory, which defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides that directory. If saving fails, a warning explains that the change applies only to the current session.

Each tab groups related settings under dim section headings:

| Tab | Sections |
| --- | --- |
| General | Extension, Interface, Messages & tools, Footer |
| Appearance | Icons, Editor |
| Footer | Location, Git, Runtime, Usage, Other |
| Telemetry | Enabled (standalone master switch), Measurements |

Use Tab/Shift+Tab or ←/→ to switch tabs, ↑/↓ or Page Up/Page Down to move between settings, Enter/Space to change a value, and Esc/q to close. Section headings occupy one row, are skipped by navigation, and cannot be selected or changed by clicking. The list scrolls within the available terminal height; its position indicator counts settings and headings. Existing configuration files need no migration.

In **General → Messages & tools**, selecting **Tool view: Compact** reveals **Compact extension tools** as an indented child setting. Switching back to **Native** hides the child setting and retains its value for the next time you select **Compact**. **Footer in editor border** is in **General → Footer**.

Example configuration:

```json
{
  "enabled": true,
  "header": true,
  "inlineFooter": false,
  "copyButtons": true,
  "settingsLanguage": "en",
  "cursorStyle": "block",
  "icons": {
    "mode": "auto"
  },
  "footerSegments": {
    "cwd": true,
    "hostname": false,
    "sessionName": false,
    "gitBranch": true,
    "gitStatus": true,
    "gitCommit": false,
    "runtime": true,
    "context": true,
    "tokens": true,
    "cost": true,
    "liveTps": true,
    "extensionStatuses": true,
    "extensionSegments": true,
    "capitalizeProviderName": true,
    "nerdIconSpacing": false
  },
  "telemetry": {
    "enabled": true,
    "tps": true,
    "ttft": true,
    "duration": true,
    "tokens": true,
    "stalls": true,
    "cost": true
  },
  "thinkingPeek": {
    "lines": 1
  },
  "toolView": {
    "mode": "native",
    "extensionTools": false,
    "exclude": []
  }
}
```

Key options:

| Option | Values | Notes |
| --- | --- | --- |
| `settingsLanguage` | `en`, `zh` | Changes the `/open-tui` interface language |
| `header` | `true`, `false` | Overrides Pi's header with the open-tui header; set it to `false` to leave the header slot to Pi or another extension |
| `inlineFooter` | `true`, `false` | Moves the two main Footer rows into the editor's top and bottom borders; defaults to `false`. Extension status rows remain below the editor |
| `copyButtons` | `true`, `false` | Frames code blocks and shows a clickable `[Copy]` label on code blocks and user messages in fullscreen mode; defaults to `true`. See [Copy buttons](#copy-buttons) |
| `cursorStyle` | `block`, `bar`, `underline` | `bar` and `underline` require terminal cursor-shape support |
| `icons.mode` | `auto`, `nerd`, `unicode`, `ascii` | Controls footer and telemetry icons |
| `footerSegments` | Boolean flags | Shows or hides individual footer data |
| `footerSegments.extensionSegments` | Boolean | Shows extension contributions within the two main footer rows; defaults to `true`. Independent of the separate `extensionStatuses` rows; see [Extension footer segments](#extension-footer-segments) |
| `footerSegments.capitalizeProviderName` | Boolean | Capitalizes the first character of the provider name in the footer; set it to `false` to keep the provider's original casing |
| `footerSegments.nerdIconSpacing` | Boolean | Adds an extra blank cell after Nerd Font icons in the footer; defaults to `false` |
| `telemetry` | Boolean flags | Enables telemetry and its individual measurements |
| `thinkingPeek.lines` | `0`, `1`, `2` | Off, one-line, or two-line hidden thinking preview |
| `toolView.mode` | `native`, `compact` | Pi's native cards (default) or compact call/summary rows with successful edit/write previews. Applies to rows created after the change |
| `toolView.extensionTools` | `true`, `false` | In compact mode, also collapses extension, MCP, and replacement tools into generic rows; defaults to `false`. See [Tool view](#tool-view) |
| `toolView.exclude` | Tool names | Tools that always keep their native rendering, for example `["subagent_wait"]`; defaults to `[]` |

`sessionName` appears only when the session has a name. `hostname` shows the short host name with a server icon. In detached HEAD state, `gitBranch` shows `HEAD` with the short commit hash, and `gitCommit` appends the tag pointing at that commit (only while `gitBranch` is on). Disabling `extensionStatuses` hides the whole extension status line, including MCP status; each status keeps the colour its extension applied with `ctx.ui.theme.fg()`.

Footer token and cost totals include assistant responses, tool-reported usage, compaction and branch summaries, and cache warming. The cache-hit percentage describes the most recent assistant response, not the cumulative session. When the first Footer row is too narrow, the runtime and context bar are hidden first, then Git, the session name, and the host name and timer; the CWD stays longest, shortened to its folder name.

With `inlineFooter`, the two main Footer rows are rendered inside the editor frame to save vertical space: the Git branch and session title on the left of the top border, the CWD first in the right-hand group. The Header and extension status rows remain separate, and narrow terminals truncate lower-priority Footer data first.

open-tui frames editors that keep Pi’s native editor layout and its cursor, mouse, and padding APIs, including `CustomEditor` extensions. It decorates the same instance, preserving ghost text, key handling, completion, and submit callbacks. Editors using the current `ctx.ui.setEditorComponent()` API can register before or after `pi-open-tui`, and runtime replacements are framed too; temporary dialogs are left alone. Before decorating, open-tui renders the editor once at the terminal width to check for native top and bottom borders, and every framed render is re-checked. Editors without those capabilities or borders remain unchanged, with the footer displayed separately even when `inlineFooter` is enabled. Disabling open-tui removes its decoration, restores the registration methods, and keeps the latest editor factory.

This ordering guarantee applies to editor registration, not header or footer replacements.

## Extension footer segments

Extensions can publish text into either main footer row through Pi's public `pi.events` interface. This works in the regular footer and with `inlineFooter`, without adding a status row. Existing `ctx.ui.setStatus()` content stays in the separate extension status rows. With no visible contributions, the existing footer layout is preserved.

The protocol uses these channels:

| Channel | Payload and behavior |
| --- | --- |
| `open-tui:footer:set` | `{ lifecycle, key, position, text, compactText?, order?, priority? }`; insert or fully replace the contribution with this key, including its position and optional fields |
| `open-tui:footer:remove` | `{ lifecycle, key }`; remove this contribution; removing an absent key has no effect |
| `open-tui:footer:query` | `undefined`; request a state announcement |
| `open-tui:footer:state` | `{ available: true, lifecycle: string }` or `{ available: false }`; announced on availability changes and in response to queries |

`key` must be a nonempty string; use an extension-specific prefix such as `system-memory:usage` to avoid collisions. `text` must be a string, and `compactText` may supply a shorter string. Both preserve supported ANSI colors while filtering terminal controls and line breaks. Empty or style-only text adds no visible segment.

Choose exactly one position form:

| Position | Placement |
| --- | --- |
| `{ row: 1, side: "left" }` | First row, left region |
| `{ row: 1, side: "right" }` | First row, right region |
| `{ row: 2, side: "left" }` | Second row, left region |
| `{ row: 2, side: "right" }` | Second row, right region |
| `{ before: "git" }` | Immediately before the named built-in segment |
| `{ after: "cost" }` | Immediately after the named built-in segment |

Explicit regions accept `edge: "start" | "end"`, defaulting to `"end"`. They keep their row and side in both footer modes; row 1/2 become the top/bottom editor borders in inline mode. Relative positions follow their anchor when it moves between modes. Anchors are `cwd`, `hostname`, `sessionName`, `git`, `runtime`, `timer`, `context`, `model`, `tokens`, and `cost`. Their positions remain available when the built-in content is disabled, absent, or hidden for lack of space. `tokens` covers the complete token statistics group.

Each region orders its content as: start contributions, then each anchor's before contributions, built-in content and after contributions, then end contributions. Within the same placement, `order` sorts ascending and defaults to `0`; ties sort by key using deterministic string comparison, independent of locale and extension load order.

`priority` controls shrinking rather than display order. It defaults to `-1`; larger values survive longer. Both `order` and `priority` must be finite numbers. The built-in priorities are:

| Row | Built-in priorities |
| --- | --- |
| 1 | `cwd: 4`; `hostname` and `timer: 3`; `sessionName: 2`; `git: 1`; `runtime` and `context: 0` |
| 2 | `tokens: 2`; `cost: 1`; `model: 0` |

The two sides share the row's width budget, including separators and terminal display widths. Compact forms are tried before truncating or dropping lower-priority content. Default-priority contributions yield to built-in content; an explicit higher priority can change that. Inline mode uses the width remaining after editor borders, the working indicator and scroll hints.

Availability means the open-tui footer is mounted in a TUI session. Each new mount receives a fresh opaque `lifecycle` string; unmounting, disabling open-tui or ending the session clears contributions and invalidates it. Contributors must republish after a new lifecycle announcement. Register the state listener during extension initialization, then query after your own `session_start`; ignore announcements until you have that session's context, and deduplicate repeated announcements for the same lifecycle. This supports either extension load order. Pi releases event subscriptions when it replaces the extension runtime.

`footerSegments.extensionSegments` is a display switch: disabling it hides contributions while continuing to accept updates, without changing availability or the lifecycle. `footerSegments.extensionStatuses` independently controls the existing separate status rows. An extension may fall back to `setStatus()` when open-tui is unavailable; the example below does so. Hiding contributions does not activate that fallback.

Malformed messages, unknown anchors and stale lifecycle identifiers are ignored without changing an existing contribution. Unknown additional fields are ignored. Channel names have no version suffix; future additions must preserve these payloads, defaults and meanings. Extensions should tolerate unknown fields in state announcements.

For asynchronous data, capture the lifecycle **before** starting the request and only publish if it is still current. Also capture the provider/model identity and a request sequence number when the data depends on them: lifecycle checks alone do not prevent a slow request for the previous provider from overwriting a newer result in the same session. Cancel pending work on shutdown and never emit through a captured Pi instance after its runtime has been replaced.

### System memory example

Save this complete extension as `system-memory.ts` and run `pi -e ./system-memory.ts` with pi-open-tui installed. It reads real operating-system memory data every five seconds and places it after cost, with a compact form and a separate status fallback. The timer starts only in a TUI session and is stopped on shutdown or reload.

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { freemem, totalmem } from "node:os";

export default function (pi: ExtensionAPI) {
	const key = "system-memory:usage";
	let ctx: ExtensionContext | undefined;
	let lifecycle: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const publish = () => {
		if (!ctx) return;
		const total = totalmem();
		const used = total - freemem();
		const text = `RAM ${(used / 2 ** 30).toFixed(1)}/${(total / 2 ** 30).toFixed(1)} GiB`;
		if (lifecycle === undefined) {
			ctx.ui.setStatus(key, text);
			return;
		}
		ctx.ui.setStatus(key, undefined);
		pi.events.emit("open-tui:footer:set", {
			lifecycle,
			key,
			position: { after: "cost" },
			text,
			compactText: `RAM ${Math.round(used / total * 100)}%`,
		});
	};

	pi.events.on("open-tui:footer:state", (data) => {
		if (!ctx || data === null || typeof data !== "object" || !("available" in data)) return;
		if (data.available === true && "lifecycle" in data
			&& typeof data.lifecycle === "string" && data.lifecycle.length > 0) {
			if (lifecycle === data.lifecycle) return;
			lifecycle = data.lifecycle;
		} else if (data.available === false) {
			if (lifecycle === undefined) return;
			lifecycle = undefined;
		} else {
			return;
		}
		publish();
	});

	pi.on("session_start", (_event, nextCtx) => {
		if (!nextCtx.hasUI || nextCtx.mode !== "tui") return;
		ctx = nextCtx;
		publish();
		pi.events.emit("open-tui:footer:query", undefined);
		timer = setInterval(publish, 5_000);
		timer.unref();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		const previousCtx = ctx;
		const previousLifecycle = lifecycle;
		ctx = undefined;
		lifecycle = undefined;
		if (previousLifecycle !== undefined) {
			pi.events.emit("open-tui:footer:remove", { key, lifecycle: previousLifecycle });
		}
		previousCtx?.ui.setStatus(key, undefined);
	});
}
```

## Turn telemetry

After each complete agent run, pi-open-tui shows one transient result. Tool-call turns are combined into it:

```text
> TPS 42.5 tok/s | ~ TTFT 1.2s | + 29.7s | ↑ 567 | ↓ 1.2k | ! stall 1x / 4.3s | $ $3.60/M
```

TPS is the provider-reported assistant output tokens divided by the total generation time from `turn_start` to the assistant `message_end`, so it includes TTFT, hidden reasoning, buffering, and stalls but excludes tool execution between turns. Runs without output tokens or measurable time show `TPS —`.

While a response streams, the working timer also shows the estimated speed, for example `working 12.3s · ~54 tok/s`. The `~` marks it as an estimate over the last 2 seconds of streamed text, thinking, and tool-call arguments; it drops toward zero during stalls and stays dimmed at its last value during tool execution. It is controlled by **Footer → Runtime → Live TPS** (`footerSegments.liveTps`) and disappears when the run ends, where the exact TPS above is authoritative.

The `$ / M` value is the model's list-price rate from `usage.cost.total`, not the cumulative session cost shown in the footer. Every telemetry field can be toggled from **Telemetry → Measurements**, with **Enabled** as the separate master switch.

## Thinking peek

With Pi's **Hide thinking** setting enabled, pi-open-tui shows a compact ticker in the native hidden thinking block's `Thinking...` position. The `/open-tui` setting offers **Off**, **1 line**, and **2 lines**:

- while the model reasons, the thinking tail streams by with a spinner (`~ think ⠋ …`);
- when the answer starts, it settles on a check mark (`~ think ✓`);
- in 2-line mode both rows follow the newest tail with the same indentation;
- after the task settles, the native `Thinking...` label is restored.

```text
~ think ⠋ previous thought
          latest thought
```

The ticker appears only once the model actually streams reasoning, so non-reasoning models never show it. Visibility follows Pi's own Hide thinking toggle and takes effect immediately, and each row is truncated by *visible* width, so CJK text cannot overflow. Configure it from **General → Messages & tools → Thinking peek**, or via `thinkingPeek.lines` in `open-tui.json`.

## Tool view

**Native** remains the default. With **General → Messages & tools → Tool view** set to **Compact** (`toolView.mode: "compact"`), Pi's built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) render as one call line and one summary line, with previews for successful edits and writes:

```text
● Read(extensions/open-tui/footer.ts:1-120)
  └  120 lines
● Edit(extensions/open-tui/footer.ts)
  └  +2 −1
● Bash(npm test)
  └  Done · 131 lines · 6.4s
```

- Successful calls have dim call/summary text and a green dot. Pending dots are dim; running dots alternate between accent and dim once per second. Errors keep the red dot and summary. Failed shell summaries keep the last output line; while running, shell commands show the newest 3 output lines and elapsed time.
- Successful `edit` previews parse Pi's actual diff and syntax-highlight old and new code separately, with red/green background bands for removed/added rows. No valid diff means no preview.
- Successful `write` previews show syntax-highlighted, line-numbered content on the normal background. New files and overwrites look the same; partial results and errors get no preview.
- Preview bodies show at most 16 rows, then a hidden-row count and `Ctrl+O` hint. In compact mode only, long lines truncate with `…` instead of wrapping.
- Clicking a row expands only that row into Pi's native card, and `Ctrl+O` expands all rows; native expanded output, diffs, and truncation notices are unchanged. Calls are never grouped.
- Only the display changes. Tools, arguments, results, and what the model sees are untouched. By default only tools confirmed by Pi as built-in are wrapped; third-party and MCP tools keep their own rendering.
- With **Compact extension tools** (`toolView.extensionTools: true`), every other tool collapses too, including MCP tools and replacements with built-in names. Their unknown output format means summaries show text/image counts, duration, and the first line, with no edit/write previews. Truncation is recognised from explicit markers such as `details.truncation.truncated: true`. Tools that depend on native progress displays belong in `toolView.exclude`, which also applies to built-ins.
- Recognized `@ff-labs/pi-fff` installations use search summaries: `ffgrep` and `fff-multi-grep` show this page's match count, `fffind` the total matching file count. Expansion keeps FFF's native output.
- Expanded rows use the renderers Pi resolves, and inline images stay visible while collapsed, since Pi draws them below the row.
- The mode is chosen when Pi creates a row, so switching it affects new rows; `/reload` or a new session applies it to the whole transcript.

## Copy buttons

In fullscreen mode (Pi's `tuiMode: "fullscreen"`), code blocks are drawn in rounded frames with their language. Completed code blocks show a `[Copy]` label in the top border when there is enough width, and every user message gets a `[Copy]` label too. Click it to put the source text on the clipboard; Pi flashes `Copied!`.

```text
╭─ sh ─────────────── [Copy] ╮
│ pi install npm:pi-open-tui │
╰────────────────────────────╯
```

- Code blocks: the frame replaces the two fence rows, so a block keeps its height; long lines wrap inside the frame. The label copies the code without the fences, preserving indentation and tabs. Applies to code in both user and assistant messages.
- User messages: the label sits on the bubble's last row and copies the message as you typed it.
- Whole assistant replies have no label; use Pi's `/copy` for that.
- While a reply streams, its code blocks are framed without a label, so unfinished code cannot be copied. The label is also dropped when the frame is too narrow; thinking blocks keep Pi's plain fences. Labels appear as soon as streaming ends, without a resize.
- Regular mode has no mouse capture, so code blocks keep Pi's plain fences there.

Toggle it from **General → Messages & tools → Copy buttons** in `/open-tui`, or via `copyButtons` in `open-tui.json`.

## Local development

```bash
npm install
npm test
npm run typecheck
pi -e .
```

CI checks Pi 1.5.0 and the latest release on Node.js 22.19.0 and 24, across Linux, Windows, and macOS. Keep Pi packages on the same version when checking compatibility. Automated tests do not replace checking terminal fonts, mouse interaction, and cursor support with `pi -e .`.

## Acknowledgements

This project builds on several Pi community packages:

- **[pi-haiku](https://github.com/nnocte/pi-haiku)** — two-line footer structure and working timer
- **[pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)** — Pi logo artwork and rounded editor border technique
- **[pi-zentui](https://github.com/lmilojevicc/pi-zentui)** — Starship-style footer segments, runtime detection, session lifecycle, and settings UI pattern
- **[pi-tps](https://github.com/monotykamary/pi-tps)** — turn timing, stall detection, and conservative TPS measurement
- **[pi-polish](https://github.com/Pringled/pi-extensions/blob/main/packages/pi-polish)** — compact tool-call rows and syntax-highlighted edit diffs

The logo artwork is derived from Pi's official install script (`pi.dev/install.sh`). Runtime detection and Git porcelain parsing borrow structure from `pi-zentui`.

Special thanks to the **[LINUX DO](https://linux.do)** community for its support.

## License

[MIT](./LICENSE)
