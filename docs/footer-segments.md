# Extension footer segments

[Project overview](../README.md) · [Configuration](./configuration.md#english) · [Implementation and compatibility](./implementation.md#english)

Extensions use `pi.events` to add text to either main footer row, including the editor borders when `inlineFooter` is enabled. No additional status row is created.

## Events

| Event | Payload | Purpose |
| --- | --- | --- |
| `open-tui:footer:set` | `{ lifecycle, key, position, text, compactText?, order?, priority? }` | Insert or completely replace the entry with this key |
| `open-tui:footer:remove` | `{ lifecycle, key }` | Remove an entry; a missing key has no effect |
| `open-tui:footer:query` | `undefined` | Request current availability |
| `open-tui:footer:state` | `{ available: true, lifecycle: string }` or `{ available: false }` | Announce availability changes and answer queries |

Use a nonempty, extension-prefixed `key`, such as `system-memory:usage`. `text` and optional `compactText` are strings; supported ANSI colors are preserved, while terminal commands and line breaks are filtered. Empty or style-only text is invisible. Malformed messages, unknown anchors and stale lifecycles are ignored; extra unknown fields are tolerated.

`set` replaces all fields, so omitted optional fields return to their defaults. Event names and payloads have no version number; future additions must remain compatible.

## Placement and width

Choose exactly one `position` form:

| Position | Meaning |
| --- | --- |
| `{ row: 1, side: "left", edge: "end" }` | Explicit region: row `1` or `2`, side `"left"` or `"right"`, optional edge `"start"` or `"end"` (default) |
| `{ before: "git" }` | Before a built-in anchor |
| `{ after: "cost" }` | After a built-in anchor |

In inline mode, rows 1 and 2 become the top and bottom editor borders. Explicit regions stay on their chosen side. Relative positions follow the anchor; all anchors remain usable when their built-in content is hidden or absent. Their order and location are:

| Mode | Row 1 left | Row 1 right | Row 2 left | Row 2 right |
| --- | --- | --- | --- | --- |
| Regular | cwd, hostname, sessionName, git, runtime, timer | context | model | tokens, cost |
| Inline | sessionName, git | cwd, hostname, runtime, timer, context | model | tokens, cost |

`tokens` represents the complete token statistics group. Region/start entries precede its anchors, and region/end entries follow them. At each anchor, entries appear before or after its text. Within each placement, `order` (default `0`) sorts ascending, then `key` uses ordinary string ordering, independent of load order or locale.

`priority` defaults to `-1`; higher values survive longer when space is limited. Both `order` and `priority` must be finite numbers. Built-in priorities are `cwd: 4`, `hostname/timer: 3`, `sessionName: 2`, `git: 1`, `runtime/context: 0` on row 1, and `tokens: 2`, `cost: 1`, `model: 0` on row 2.

Both sides share the available row width. Shorter, nonempty `compactText` forms are tried in ascending priority order before truncating or removing lower-priority content; ties follow display order. A row without visible contributions retains its existing layout.

## Lifecycle and visibility

1. Register the `state` listener in your extension factory. Save the context in `session_start`, then emit `query`. Ignore announcements before initialization and repeated announcements for the same lifecycle.
2. On a new available lifecycle, publish current content using that identifier. It identifies the current footer mount, not a protocol version. Disabling open-tui, replacing its footer or ending the session invalidates it and clears contributions.
3. For asynchronous data, capture the lifecycle before the request and discard obsolete results. If data depends on a provider/model, also compare that identity and a request sequence. Stop pending work on shutdown; never publish through a Pi instance whose runtime has been replaced.

`footerSegments.extensionSegments` defaults to `true` and controls visibility only: hidden entries still receive updates, and availability and lifecycle stay unchanged. `footerSegments.extensionStatuses` separately controls normal `ctx.ui.setStatus()` rows. A contributor can use those rows as fallback while unavailable, clearing its own fallback when publishing a footer segment.

## System memory example

Save as `system-memory.ts` and run `pi -e ./system-memory.ts` with pi-open-tui installed. This reads real system memory every five seconds, places it after cost and handles fallback and cleanup.

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
