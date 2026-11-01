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
		press = undefined;
		if (event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
		const region = regions.find((r) => event.y === r.row && event.x >= r.col && event.x < r.col + r.width);
		if (!region) return undefined;
		press = { owner, region, x: event.x, y: event.y };
		return { handled: true, render: false };
	}
	if (press?.owner !== owner) return undefined;
	if (event.type === "drag") return { handled: true, render: false };
	if (event.type !== "release") return undefined;
	const { region, x, y } = press;
	press = undefined;
	if (event.y === y && Math.abs(event.x - x) <= RELEASE_TOLERANCE) onCopy(region.text);
	return { handled: true, render: false };
}

/**
 * Markdown.render normalizes tabs to three spaces before lexing, so token text loses them.
 * Re-lex the raw source and use its matching code block when the shapes agree.
 */
export function restoreTabs(source: string, ordinal: number, rendered: string): string {
	if (!source.includes("\t")) return rendered;
	let index = 0;
	let found: string | undefined;
	new Marked().walkTokens(new Marked().lexer(source), (token) => {
		if (token.type === "code" && index++ === ordinal) found = token.text;
	});
	return found !== undefined && found.replace(/\t/g, "   ") === rendered ? found : rendered;
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

	const refresh = () => {
		const tui = options.getTui();
		tui?.invalidate();
		tui?.requestRender();
	};
	if (markdownProto[PATCH_KEY] || markdownProto[PRETTY_TUI_KEY]) return { cleanup: () => {}, refresh };

	const active = () => options.isEnabled() && options.getTui()?.mode === "fullscreen";
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

	const restores = [
		patch(markdownProto, "renderToken", function (this: MarkdownInternals, token, width, nextTokenType, styleContext) {
			const scope = renderScope;
			if (!scope || token.type !== "code") return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
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
			const regions = active() ? markdownRegions.get(this)?.regions ?? [] : [];
			return handleCopyMouse(this, regions, event, copy) ?? originalMarkdownMouse?.call(this, event);
		}),
		patch(userProto, "render", function (this: UserMessageInternals, width) {
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
			const region = active() ? userRegions.get(this) : undefined;
			return handleCopyMouse(this, region ? [region] : [], event, copy) ?? originalUserMouse?.call(this, event);
		}),
	];
	markdownProto[PATCH_KEY] = true;
	refresh();

	return {
		cleanup: () => {
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
