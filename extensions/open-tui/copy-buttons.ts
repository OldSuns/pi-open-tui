import { copyToClipboard, UserMessageComponent, type MarkdownTransformContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	compositeTuiLine,
	Markdown,
	Marked,
	truncateToWidth,
	TuiAltScreen,
	visibleWidth,
	wrapTextWithAnsi,
	type MarkdownTheme,
	type Token,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const LABEL = "[Copy]";
// Below this width a frame plus label would crowd the code, so Pi's plain fences are kept.
const MIN_FRAME_WIDTH = 8;
// Zero-width APC sequence: survives wrapping and padding, and marks the label column before we strip it.
const MARKER = "\x1b_open-tui:cb\x07";
const PATCH_KEY = Symbol.for("pi-open-tui.copy-buttons");
// pi-pretty-tui draws its own code-block [Copy]; patching the same methods twice would fight.
const PRETTY_TUI_KEY = Symbol.for("pretty-tui.code-blocks");
// Pi only synthesizes `click` for a zero-movement release, so allow a little jitter.
const RELEASE_TOLERANCE = 2;

export interface CopyRegion {
	row: number;
	col: number;
	width: number;
	text: string;
}

interface Press {
	owner: object;
	region: CopyRegion;
	x: number;
	y: number;
	onCopy: (text: string) => void;
}

interface RawMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface AltScreenInternals {
	handleMouseEvent(event: RawMouseEvent): void;
	createMouseEvent(type: TuiMouseEvent["type"], button: number, x: number, y: number): TuiMouseEvent;
	resetTextSelection(): void;
	requestRender(): void;
}

// Pi's private fields; checked at runtime because they can change between releases.
interface MarkdownInternals {
	text?: unknown;
	theme: MarkdownTheme;
	render(width: number): string[];
	renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[];
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}
interface UserMessageInternals {
	text?: unknown;
	outputPad?: unknown;
	render(width: number): string[];
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

/** Set by our Markdown transformer while a transcript Markdown renders. */
let renderScope: { frame: boolean; label: boolean; ordinal: number; blocks: { text: string; ordinal: number }[] } | undefined;
let press: Press | undefined;
const markdownRegions = new WeakMap<object, { lines: readonly string[]; regions: CopyRegion[] }>();
const userRegions = new WeakMap<object, CopyRegion>();

/**
 * Markdown transformer that only records the message kind; Pi calls it during Markdown.render.
 * Thinking blocks keep Pi's fences. Streaming replies get the frame but no label: it would copy unfinished code.
 */
export function markCopyScope(markdown: string, context: MarkdownTransformContext): string {
	if (renderScope) {
		renderScope.frame = context.messageType !== "assistant-thinking";
		renderScope.label = renderScope.frame && !context.isStreaming;
	}
	return markdown;
}

/**
 * Rounded frame with the language and the label in the top border, like pi-pretty-tui:
 * `╭─ ts ───── [Copy] ╮`. It replaces the two fence rows, so the block keeps its height.
 */
export function renderFramedCode(
	theme: MarkdownTheme,
	code: string,
	lang: string | undefined,
	width: number,
	label: string | undefined,
	border: (text: string) => string = theme.codeBlockBorder,
): string[] {
	const inner = width - 4;
	const highlighted = theme.highlightCode?.(code, lang) ?? code.split("\n").map((line) => theme.codeBlock(line));
	const rows = highlighted.flatMap((line) => {
		const wrapped = wrapTextWithAnsi(line, inner);
		return wrapped.length > 0 ? wrapped : [""];
	});
	const suffix = label === undefined ? "" : ` ${LABEL} `;
	const name = truncateToWidth(lang?.trim().split(/\s+/, 1)[0] || "code", Math.max(1, width - 6 - visibleWidth(suffix)), "…");
	const prefix = `╭─ ${name} `;
	const widest = Math.max(0, ...rows.map((row) => visibleWidth(row)));
	const frameWidth = Math.min(width, Math.max(widest + 4, visibleWidth(prefix) + 3 + visibleWidth(suffix) + 1));
	const fill = Math.max(0, frameWidth - visibleWidth(prefix) - visibleWidth(suffix) - 1);
	const top = border("╭─ ") + theme.codeBlockBorder(`${name} `) + border("─".repeat(fill))
		+ (label === undefined ? "" : ` ${MARKER}${label} `) + border("╮");
	const body = rows.map((row) => border("│ ") + row + " ".repeat(Math.max(0, frameWidth - 4 - visibleWidth(row))) + border(" │"));
	return [top, ...body, border(`╰${"─".repeat(frameWidth - 2)}╯`)];
}

/** Hit-test press/drag/release on recorded regions. Anything else returns undefined so Pi keeps its selection. */
export function handleCopyMouse(
	owner: object,
	regions: readonly CopyRegion[],
	event: TuiMouseEvent,
	onCopy: (text: string) => void,
): TuiMouseEventResult | undefined {
	if (event.type === "press") {
		if (press?.owner === owner) press = undefined;
		if (event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
		const region = regions.find((r) => event.y === r.row && event.x >= r.col && event.x < r.col + r.width);
		if (region) press = { owner, region, x: event.screenX, y: event.screenY, onCopy };
		return undefined;
	}
	if (press?.owner !== owner || (event.type !== "drag" && event.type !== "release")) return undefined;
	const pending = press;
	const nearby = event.screenY === pending.y && Math.abs(event.screenX - pending.x) <= RELEASE_TOLERANCE;
	const primary = event.button === "left" || (event.type === "release" && event.button === "none");
	if (!nearby || !primary || event.shift || event.alt || event.ctrl) {
		press = undefined;
		return undefined;
	}
	if (event.type === "drag") return undefined;
	press = undefined;
	pending.onCopy(pending.region.text);
	return { handled: true, render: false };
}

/**
 * Markdown.render normalizes tabs to three spaces before lexing, so token text loses them.
 * Match the normalized tokens back to source lines: lexing raw lists would expand their tabs first.
 */
export function restoreTabs(source: string, ordinal: number, rendered: string): string {
	if (!source.includes("\t")) return rendered;
	const sourceLines = source.replace(/\r\n?/g, "\n").split("\n");
	const normalized = sourceLines.map((line) => line.replace(/\t/g, "   "));
	const blocks: { raw: string; text: string }[] = [];
	const parser = new Marked();
	parser.walkTokens(parser.lexer(normalized.join("\n")), (token) => {
		if (token.type === "code") blocks.push({ raw: token.raw, text: token.text });
	});
	const block = blocks[ordinal];
	if (!block || block.text !== rendered || rendered === "") return rendered;
	const rawLines = block.raw.replace(/\n+$/, "").split("\n");
	let marker = "\ue000";
	while (source.includes(marker)) marker += "\ue000";
	const expected = rendered.split("\n");
	expected[0] += marker;
	for (let start = 0; start < sourceLines.length; start++) {
		// List/quote parsing removes container prefixes, but leaves the code's raw line suffixes intact.
		if (!rawLines.every((raw, offset) => normalized[start + offset]?.endsWith(raw))) continue;
		const body = start + (/^ {0,3}(?:`{3,}|~{3,})/.test(block.raw) ? 1 : 0);
		const probe = normalized.slice();
		probe[body] += marker;
		let index = 0;
		let matched = false;
		// Confirm the source row belongs to this token, not identical code in HTML or an earlier block.
		parser.walkTokens(parser.lexer(probe.join("\n")), (token) => {
			if (token.type === "code" && index++ === ordinal) matched = token.text === expected.join("\n");
		});
		if (!matched) continue;
		const restored = rendered.split("\n").map((text, offset) => {
			const line = sourceLines[body + offset];
			const expanded = normalized[body + offset];
			if (line === undefined || !expanded?.endsWith(text)) return text;
			const skip = expanded.length - text.length;
			let column = 0;
			for (let char = 0; char < line.length; char++) {
				if (column === skip) return line.slice(char);
				column += line[char] === "\t" ? 3 : 1;
				if (column > skip) return " ".repeat(column - skip) + line.slice(char + 1);
			}
			return "";
		}).join("\n");
		return restored.replace(/\t/g, "   ") === rendered ? restored : rendered;
	}
	return rendered;
}

function patch<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): () => void {
	const had = Object.prototype.hasOwnProperty.call(target, key);
	const original = target[key];
	target[key] = value;
	return () => {
		// Another extension may have wrapped ours; leave its wrapper in place then.
		if (target[key] !== value) return;
		if (had) target[key] = original;
		else Reflect.deleteProperty(target, key);
	};
}

export function installCopyButtons(options: {
	getTui: () => TUI | undefined;
	getTheme: () => Theme;
	isEnabled: () => boolean;
}): { cleanup: () => void; refresh: () => void } {
	const markdownProto = Markdown.prototype as unknown as MarkdownInternals & Record<symbol, unknown>;
	const userProto = UserMessageComponent.prototype as unknown as UserMessageInternals;
	const altScreenProto = TuiAltScreen.prototype as unknown as AltScreenInternals;

	const refresh = () => {
		const tui = options.getTui();
		tui?.invalidate();
		tui?.requestRender();
	};
	if (markdownProto[PATCH_KEY] || markdownProto[PRETTY_TUI_KEY]) return { cleanup: () => {}, refresh };

	if (typeof altScreenProto.handleMouseEvent !== "function" || typeof altScreenProto.createMouseEvent !== "function") {
		return { cleanup: () => {}, refresh };
	}
	let installed = true;
	const active = () => installed && options.isEnabled() && options.getTui()?.mode === "fullscreen";
	const copy = (text: string) => {
		const tui = options.getTui();
		const flash = (message: string) => {
			if (tui instanceof TuiAltScreen) tui.flash(message);
		};
		copyToClipboard(text).then(() => flash("Copied!"), () => flash("Copy failed"));
	};
	const label = () => options.getTheme().fg("muted", LABEL);

	const originalRender = markdownProto.render;
	const originalRenderToken = markdownProto.renderToken;
	const originalMarkdownMouse = markdownProto.handleMouse;
	const originalUserRender = userProto.render;
	const originalUserMouse = userProto.handleMouse;
	const originalAltScreenMouse = altScreenProto.handleMouseEvent;

	const restores = [
		patch(altScreenProto, "handleMouseEvent", function (this: AltScreenInternals, raw) {
			if (!active() || this !== (options.getTui() as unknown)) return originalAltScreenMouse.call(this, raw);
			const motion = (raw.button & 32) !== 0;
			if (!raw.release && !motion) press = undefined;
			// Leave press/drag to Pi's selection; intercept only a qualifying release before copy-on-select runs.
			if (press && (raw.release || motion)) {
				const event = this.createMouseEvent(raw.release ? "release" : "drag", raw.button, raw.x, raw.y);
				if (handleCopyMouse(press.owner, [], event, press.onCopy)) {
					this.resetTextSelection();
					this.requestRender();
					return;
				}
			}
			return originalAltScreenMouse.call(this, raw);
		}),
		patch(markdownProto, "renderToken", function (this: MarkdownInternals, token, width, nextTokenType, styleContext) {
			const scope = renderScope;
			if (!installed || !scope || token.type !== "code") return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
			const ordinal = scope.ordinal++;
			if (!scope.frame || !active() || width < MIN_FRAME_WIDTH) {
				return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
			}
			const theme = options.getTheme();
			const showLabel = scope.label && width >= MIN_FRAME_WIDTH + LABEL.length + 2;
			const lines = renderFramedCode(
				this.theme,
				token.text,
				token.lang,
				width,
				showLabel ? label() : undefined,
				(text) => theme.fg("borderMuted", text),
			);
			if (showLabel) scope.blocks.push({ text: token.text, ordinal });
			// Same spacing rule as Pi's own code-block rendering.
			if (nextTokenType && nextTokenType !== "space") lines.push("");
			return lines;
		}),
		patch(markdownProto, "render", function (this: MarkdownInternals, width) {
			if (!installed) return originalRender.call(this, width);
			const outer = renderScope;
			const scope = { frame: false, label: false, ordinal: 0, blocks: [] as { text: string; ordinal: number }[] };
			renderScope = scope;
			let lines: string[];
			try {
				lines = originalRender.call(this, width);
			} finally {
				renderScope = outer;
			}
			// A cache hit returns the array we already processed and skips renderToken.
			if (markdownRegions.get(this)?.lines === lines) return lines;
			const source = typeof this.text === "string" ? this.text : "";
			const regions: CopyRegion[] = [];
			let next = 0;
			for (let row = 0; row < lines.length; row++) {
				const line = lines[row]!;
				const at = line.indexOf(MARKER);
				if (at < 0) continue;
				// The renderer caches this array, so stripping in place keeps the marker out of later frames.
				lines[row] = line.split(MARKER).join("");
				const block = scope.blocks[next++];
				if (!block) continue;
				regions.push({
					row,
					col: visibleWidth(line.slice(0, at)),
					width: LABEL.length,
					text: restoreTabs(source, block.ordinal, block.text),
				});
			}
			markdownRegions.set(this, { lines, regions });
			return lines;
		}),
		patch(markdownProto, "handleMouse", function (this: MarkdownInternals, event) {
			if (!active()) return originalMarkdownMouse?.call(this, event);
			const regions = markdownRegions.get(this)?.regions ?? [];
			return handleCopyMouse(this, regions, event, copy) ?? originalMarkdownMouse?.call(this, event);
		}),
		patch(userProto, "render", function (this: UserMessageInternals, width) {
			if (!installed) return originalUserRender.call(this, width);
			const lines = originalUserRender.call(this, width);
			userRegions.delete(this);
			const pad = typeof this.outputPad === "number" ? this.outputPad : 1;
			const col = width - pad - LABEL.length;
			if (!active() || lines.length < 2 || col < 1 || typeof this.text !== "string") return lines;
			// The last row is the bubble's bottom padding, so the label never shares a row with a code-block label.
			const row = lines.length - 1;
			const theme = options.getTheme();
			lines[row] = compositeTuiLine(lines[row]!, theme.bg("userMessageBg", label()), col, LABEL.length, width);
			userRegions.set(this, { row, col, width: LABEL.length, text: this.text });
			return lines;
		}),
		patch(userProto, "handleMouse", function (this: UserMessageInternals, event) {
			if (!active()) return originalUserMouse?.call(this, event);
			const region = userRegions.get(this);
			return handleCopyMouse(this, region ? [region] : [], event, copy) ?? originalUserMouse?.call(this, event);
		}),
	];
	markdownProto[PATCH_KEY] = true;
	refresh();

	return {
		cleanup: () => {
			if (!installed) return;
			installed = false;
			for (const restore of restores) restore();
			delete markdownProto[PATCH_KEY];
			press = undefined;
			try {
				refresh();
			} catch {
				// The TUI may already be stopping during shutdown.
			}
		},
		refresh,
	};
}
