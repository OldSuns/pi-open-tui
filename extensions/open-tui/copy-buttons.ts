import { randomUUID } from "node:crypto";
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
import { stripAnsi } from "./utils.ts";

const LABEL = "[Copy]";
// Below this width a frame plus label would crowd the code, so Pi's plain fences are kept.
const MIN_FRAME_WIDTH = 8;
// Zero-width APC sequence: survives wrapping and padding, and marks the label column before we strip it.
const MARKER_PREFIX = "\x1b_open-tui:cb:";
const PATCH_KEY = Symbol.for("pi-open-tui.copy-buttons");
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
	children: TUI["children"];
	handleMouseEvent(event: RawMouseEvent): void;
	createMouseEvent(type: TuiMouseEvent["type"], button: number, x: number, y: number): TuiMouseEvent;
	resetTextSelection(): void;
	requestRender(): void;
}

// Pi's private fields; checked at runtime because they can change between releases.
interface MarkdownInternals {
	text?: unknown;
	theme: MarkdownTheme;
	invalidate(): void;
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

interface MarkdownState {
	active: boolean;
	policy?: { frame: boolean; label: boolean };
	lines?: readonly string[];
	regions: CopyRegion[];
	descriptors: Map<number, { text: string; label: boolean }>;
	nextId: number;
}

/** Set by our Markdown transformer while a transcript Markdown renders. */
let renderScope: { owner: MarkdownInternals; state: MarkdownState; active: boolean; frame: boolean; label: boolean } | undefined;
let press: Press | undefined;
const regionTargets = new WeakMap<CopyRegion, string>();

/**
 * Pi calls the transform before consulting its native block cache, so policy changes can invalidate it in this pass.
 * Thinking blocks keep Pi's fences. Streaming replies get the frame but no label: it would copy unfinished code.
 */
export function markCopyScope(markdown: string, context: MarkdownTransformContext): string {
	if (renderScope) {
		renderScope.frame = renderScope.active && context.messageType !== "assistant-thinking";
		renderScope.label = renderScope.frame && !context.isStreaming;
		const previous = renderScope.state.policy;
		if (previous && (previous.frame !== renderScope.frame || previous.label !== renderScope.label)) {
			renderScope.owner.invalidate();
		}
		renderScope.state.policy = { frame: renderScope.frame, label: renderScope.label };
	}
	return markdown;
}

/**
 * Rounded frame with the language and the label in the top border:
 * `╭─ ts ───── [Copy] ╮`. It replaces the two fence rows, so the block keeps its height.
 */
export function renderFramedCode(
	theme: MarkdownTheme,
	code: string,
	lang: string | undefined,
	width: number,
	label: string | undefined,
	border: (text: string) => string = theme.codeBlockBorder,
	marker = "",
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
	const top = (label === undefined ? marker : "") + border("╭─ ") + theme.codeBlockBorder(`${name} `) + border("─".repeat(fill))
		+ (label === undefined ? "" : ` ${marker}${label} `) + border("╮");
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

/** Cancel a held click when rendering moves, removes, or changes its copy target. */
function cancelStalePress(owner: object, regions: readonly CopyRegion[]): void {
	if (press?.owner !== owner) return;
	const previous = press.region;
	if (!regions.some((region) => region.row === previous.row && region.col === previous.col
		&& region.width === previous.width && region.text === previous.text
		&& regionTargets.get(region) === regionTargets.get(previous))) {
		press = undefined;
	}
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
		press = undefined;
		const tui = options.getTui();
		tui?.invalidate();
		tui?.requestRender();
	};
	if (markdownProto[PATCH_KEY]) return { cleanup: () => {}, refresh };

	if (typeof markdownProto.render !== "function" || typeof markdownProto.renderToken !== "function"
		|| typeof markdownProto.invalidate !== "function" || typeof altScreenProto.handleMouseEvent !== "function"
		|| typeof altScreenProto.createMouseEvent !== "function") {
		return { cleanup: () => {}, refresh };
	}
	let installed = true;
	const active = () => installed && options.isEnabled() && options.getTui()?.mode === "fullscreen";
	let markdownRegions = new WeakMap<object, MarkdownState>();
	let userRegions = new WeakMap<object, { region: CopyRegion; source: string; label: string; width: number; line: string }>();
	const markerPrefix = `${MARKER_PREFIX}${randomUUID()}:`;
	const markerPattern = new RegExp(`${markerPrefix}(\\d+):([01])\x07`, "g");
	const copy = (text: string) => {
		const tui = options.getTui();
		const flash = (message: string) => {
			if (installed && tui === options.getTui() && tui instanceof TuiAltScreen) tui.flash(message);
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
			// Pi's stable TUI Proxy binds methods to the real renderer and forwards fields.
			// The child list identifies that renderer, even when mode switches reuse a terminal.
			if (!active() || this.children !== options.getTui()?.children) {
				press = undefined;
				return originalAltScreenMouse.call(this, raw);
			}
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
			if (!installed || !scope?.active || scope.owner !== this || token.type !== "code") {
				return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
			}
			const showLabel = scope.label && width >= MIN_FRAME_WIDTH + LABEL.length + 2;
			const id = scope.state.nextId++;
			const marker = `${markerPrefix}${id}:${showLabel ? 1 : 0}\x07`;
			let lines: string[];
			if (scope.frame && width >= MIN_FRAME_WIDTH) {
				const theme = options.getTheme();
				lines = renderFramedCode(this.theme, token.text, token.lang, width, showLabel ? label() : undefined,
					(text) => theme.fg("borderMuted", text), marker);
				// Same spacing rule as Pi's own code-block rendering.
				if (nextTokenType && nextTokenType !== "space") lines.push("");
			} else {
				lines = originalRenderToken.call(this, token, width, nextTokenType, styleContext);
				// Unlabeled occurrences still count toward the current source ordinal.
				lines[0] = marker + (lines[0] ?? "");
			}
			scope.state.descriptors.set(id, { text: token.text, label: showLabel });
			return lines;
		}),
		patch(markdownProto, "render", function (this: MarkdownInternals, width) {
			if (!installed) return originalRender.call(this, width);
			const enabled = active();
			const previous = markdownRegions.get(this);
			const state: MarkdownState = previous ?? { active: enabled, regions: [], descriptors: new Map(), nextId: 0 };
			if (!previous) {
				markdownRegions.set(this, state);
				// A component may already have cached native fences before this installation.
				this.invalidate();
			} else if (state.active !== enabled) {
				this.invalidate();
				cancelStalePress(this, []);
				state.active = enabled;
				state.policy = undefined;
			}
			const run = () => {
				const outer = renderScope;
				renderScope = { owner: this, state, active: enabled, frame: false, label: false };
				try { return originalRender.call(this, width); }
				finally { renderScope = outer; }
			};
			try {
				let lines = run();
				if (state.lines === lines) return lines;
				// A retained native block can outlive its description after a renderer change.
				const missing = lines.some((line) => [...line.matchAll(markerPattern)].some((match) => !state.descriptors.has(Number(match[1]))));
				if (missing) {
					this.invalidate();
					lines = run();
				}
				const source = typeof this.text === "string" ? this.text : "";
				const regions: CopyRegion[] = [];
				const live = new Set<number>();
				let ordinal = 0;
				for (let row = 0; row < lines.length; row++) {
					const line = lines[row]!;
					let clean = "";
					let from = 0;
					for (const match of line.matchAll(markerPattern)) {
						clean += line.slice(from, match.index);
						from = match.index + match[0].length;
						const id = Number(match[1]);
						const block = state.descriptors.get(id);
						const currentOrdinal = ordinal++;
						if (block) live.add(id);
						if (match[2] !== "1") continue;
						const suffix = line.slice(from);
						const labelAt = suffix.indexOf(LABEL);
						if (labelAt < 0 || stripAnsi(suffix.slice(0, labelAt)) !== "") continue;
						if (!block?.label || !enabled) {
							// Preserve styles and width while removing an unresolved extension label.
							clean += suffix.slice(0, labelAt) + " ".repeat(LABEL.length);
							from += labelAt + LABEL.length;
							continue;
						}
						const region = { row, col: visibleWidth(clean), width: LABEL.length,
							text: restoreTabs(source, currentOrdinal, block.text) };
						regionTargets.set(region, `${currentOrdinal}\0${source}`);
						regions.push(region);
					}
					// Only sanitize the final array; native block lines retain their descriptor IDs.
					lines[row] = clean + line.slice(from);
				}
				for (const id of state.descriptors.keys()) if (!live.has(id)) state.descriptors.delete(id);
				cancelStalePress(this, regions);
				state.lines = lines;
				state.regions = regions;
				return lines;
			} catch (error) {
				cancelStalePress(this, []);
				state.lines = undefined;
				state.regions = [];
				state.descriptors.clear();
				state.policy = undefined;
				this.invalidate();
				throw error;
			}
		}),
		patch(markdownProto, "handleMouse", function (this: MarkdownInternals, event) {
			if (!active()) {
				cancelStalePress(this, []);
				return originalMarkdownMouse?.call(this, event);
			}
			const regions = markdownRegions.get(this)?.regions ?? [];
			return handleCopyMouse(this, regions, event, copy) ?? originalMarkdownMouse?.call(this, event);
		}),
		patch(userProto, "render", function (this: UserMessageInternals, width) {
			if (!installed) return originalUserRender.call(this, width);
			const lines = originalUserRender.call(this, width);
			const pad = typeof this.outputPad === "number" ? this.outputPad : 1;
			const col = width - pad - LABEL.length;
			if (!active() || lines.length < 2 || col < 1 || typeof this.text !== "string") {
				cancelStalePress(this, []);
				userRegions.delete(this);
				return lines;
			}
			// The last row is the bubble's bottom padding, so the label never shares a row with a code-block label.
			const row = lines.length - 1;
			const theme = options.getTheme();
			const button = theme.bg("userMessageBg", label());
			const cached = userRegions.get(this);
			// UserMessage.render returns a fresh array, so compare its undecorated bottom row instead.
			if (cached && cached.source === lines[row] && cached.label === button && cached.width === width
				&& cached.region.row === row && cached.region.col === col && cached.region.text === this.text) {
				lines[row] = cached.line;
				return lines;
			}
			const source = lines[row]!;
			lines[row] = compositeTuiLine(source, button, col, LABEL.length, width);
			const region = { row, col, width: LABEL.length, text: this.text };
			cancelStalePress(this, [region]);
			userRegions.set(this, {
				region,
				source, label: button, width, line: lines[row]!,
			});
			return lines;
		}),
		patch(userProto, "handleMouse", function (this: UserMessageInternals, event) {
			if (!active()) {
				cancelStalePress(this, []);
				return originalUserMouse?.call(this, event);
			}
			const region = userRegions.get(this)?.region;
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
			markdownRegions = new WeakMap();
			userRegions = new WeakMap();
			try {
				refresh();
			} catch {
				// The TUI may already be stopping during shutdown.
			}
		},
		refresh,
	};
}
