import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TuiMouseEvent, TuiMouseEventResult, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CursorStyle } from "./config.ts";
import { findBottomBorderIndex, isEditorBorderLine, stripAnsi } from "./utils.ts";

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, Math.max(0, width), "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${pad}`;
}

const CURSOR_STYLE_SEQUENCES: Partial<Record<CursorStyle, string>> = {
	bar: "\x1b[6 q",
	underline: "\x1b[4 q",
};
const DEFAULT_CURSOR_STYLE_SEQUENCE = "\x1b[0 q";
const EDITOR_FRAME_LEFT_INSET = 2;
const EDITOR_FRAME_HORIZONTAL_CHROME = EDITOR_FRAME_LEFT_INSET * 2;

interface WorkingStatusIndicator {
	renderInBorder(width: number): string;
	renderSpinnerInBorder(width: number): string;
}

export interface InlineFooterLine {
	left: string;
	right: string;
}

export interface InlineFooterRenderer {
	enabled(): boolean;
	render(width: number): { top: InlineFooterLine; bottom: InlineFooterLine } | undefined;
}

interface HiddenThinkingLabelComponent {
	children: unknown[];
	outputPad?: unknown;
	render(width: number): string[];
	setHiddenThinkingLabel(label: string): void;
	setHideThinkingBlock(hide: boolean): void;
	updateContent(message: unknown, isStreaming?: boolean): void;
}

function isHiddenThinkingLabelComponent(value: object): value is HiddenThinkingLabelComponent {
	const component = value as unknown as Record<string, unknown>;
	return Array.isArray(component.children)
		&& typeof component.render === "function"
		&& typeof component.setHiddenThinkingLabel === "function"
		&& typeof component.setHideThinkingBlock === "function"
		&& typeof component.updateContent === "function";
}

/** Ponytail until Pi exposes a per-message hidden-thinking label API. */
function findLatestHiddenThinkingLabel(tui: TUI): HiddenThinkingLabelComponent {
	const pending: unknown[] = [tui];
	const visited = new Set<object>();
	let latest: HiddenThinkingLabelComponent | undefined;
	while (pending.length > 0) {
		const value = pending.pop();
		if (!value || typeof value !== "object" || visited.has(value)) continue;
		visited.add(value);
		if (isHiddenThinkingLabelComponent(value)) latest = value;
		const children = (value as { children?: unknown }).children;
		if (!Array.isArray(children)) continue;
		for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
	}
	if (!latest) throw new Error("Unable to find the active hidden-thinking component");
	return latest;
}

/** Width Pi's hidden-thinking `Text(label, outputPad, 0)` wraps at when its message renders at `width`. */
function hiddenThinkingTextWidth(width: number, outputPad: unknown): number {
	const pad = typeof outputPad === "number" && Number.isFinite(outputPad) ? Math.max(0, Math.floor(outputPad)) : 1;
	const paddingX = Math.min(pad, Math.max(0, Math.floor((width - 1) / 2)));
	return Math.max(1, width - paddingX * 2);
}

function removeSoftwareCursor(line: string, cursorMarker = ""): string {
	return line.replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/g, (_match, cursor: string) => {
		const replacement = `${cursorMarker}${cursor}`;
		cursorMarker = "";
		return replacement;
	});
}

function configureCursor(tui: TUI, cursorStyle: CursorStyle): void {
	if (cursorStyle === "block") return;
	tui.setShowHardwareCursor(true);
	const sequence = CURSOR_STYLE_SEQUENCES[cursorStyle];
	if (sequence) tui.terminal.write(sequence);
}

function roundedBorder(
	width: number,
	kind: "top" | "bottom",
	paint: (s: string) => string,
	sourceLine?: string,
	indicator?: WorkingStatusIndicator,
): string {
	if (width < 2) return paint(truncateToWidth(kind === "top" ? "╭╮" : "╰╯", width, ""));
	const corners = kind === "top" ? (["╭", "╮"] as const) : (["╰", "╯"] as const);

	if (kind === "top" && indicator) {
		const plain = sourceLine ? stripAnsi(sourceLine) : "";
		const scrollMatch = plain.match(/([↑↓]\s+\d+\s+more)/);
		const contentWidth = width - 2;
		let status = indicator.renderInBorder(Math.max(1, contentWidth - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth > 0) {
			const overflowLabel = scrollMatch ? ` ${scrollMatch[1]} ` : undefined;
			const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
			const overflowStart = Math.floor((contentWidth - overflowLabelWidth) / 2);
			const canFitOverflow = () => overflowLabel !== undefined
				&& overflowLabelWidth + 2 <= contentWidth
				&& overflowStart - (3 + statusWidth + 1) >= 1;
			if (overflowLabel && !canFitOverflow()) {
				status = indicator.renderSpinnerInBorder(contentWidth);
				statusWidth = visibleWidth(status);
			}
			if (canFitOverflow()) {
				const leftBlockWidth = 3 + statusWidth + 1;
				return `${paint(`${corners[0]}── `)}${status}${paint(` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(contentWidth - overflowStart - overflowLabelWidth)}${corners[1]}`)}`;
			}
			if (contentWidth >= statusWidth + 5) {
				return `${paint(`${corners[0]}── `)}${status}${paint(` ${"─".repeat(contentWidth - statusWidth - 4)}${corners[1]}`)}`;
			}
			status = indicator.renderSpinnerInBorder(contentWidth);
			statusWidth = visibleWidth(status);
			const prefixWidth = Math.min(3, Math.max(0, contentWidth - statusWidth));
			return `${paint(`${corners[0]}${"─".repeat(prefixWidth)}`)}${status}${paint(`${"─".repeat(Math.max(0, contentWidth - prefixWidth - statusWidth))}${corners[1]}`)}`;
		}
	}

	if (sourceLine) {
		const plain = stripAnsi(sourceLine);
		const scrollMatch = plain.match(/([↑↓]\s+\d+\s+more)/);
		if (scrollMatch) {
			const label = `─── ${scrollMatch[1]} `;
			const fill = Math.max(0, width - 2 - visibleWidth(label));
			return paint(`${corners[0]}${label}${"─".repeat(fill)}${corners[1]}`);
		}
	}

	return paint(`${corners[0]}${"─".repeat(Math.max(0, width - 2))}${corners[1]}`);
}

function trimTrailingSpaces(text: string): string {
	const ansiSuffix = text.match(/(?:\x1b\[[0-?]*[ -/]*[@-~])+$/)?.[0] ?? "";
	const content = ansiSuffix ? text.slice(0, -ansiSuffix.length) : text;
	return `${content.replace(/ +$/, "")}${ansiSuffix}`;
}

function inlineBorder(
	width: number,
	kind: "top" | "bottom",
	paint: (s: string) => string,
	renderLine: (width: number) => InlineFooterLine | undefined,
	sourceLine?: string,
	indicator?: WorkingStatusIndicator,
): string {
	if (width < 2) return paint(truncateToWidth(kind === "top" ? "╭╮" : "╰╯", width, ""));

	const corners = kind === "top" ? (["╭", "╮"] as const) : (["╰", "╯"] as const);
	const contentWidth = width - 2;
	const plain = sourceLine ? stripAnsi(sourceLine) : "";
	const scrollMatch = plain.match(/([↑↓]\s+\d+\s+more)/);
	const right = scrollMatch ? paint(` ${scrollMatch[1]} `) : "";
	let left = paint("─");

	if (kind === "top" && indicator) {
		const statusBudget = Math.max(1, contentWidth - visibleWidth(right) - 7);
		let status = indicator.renderInBorder(statusBudget);
		if (visibleWidth(status) > statusBudget) status = indicator.renderSpinnerInBorder(statusBudget);
		const leftBudget = Math.max(0, contentWidth - visibleWidth(right) - 1);
		status = truncateToWidth(status, Math.max(0, leftBudget - 4), "");
		if (visibleWidth(status) > 0) left = `${paint("── ")}${status}${paint(" ")}`;
	}

	const lineBudget = Math.max(0, contentWidth - visibleWidth(left) - visibleWidth(right) - 6);
	const line = renderLine(lineBudget);
	if (!line) return roundedBorder(width, kind, paint, sourceLine, indicator);
	const leftContent = trimTrailingSpaces(line.left);
	const rightContent = trimTrailingSpaces(line.right);
	if (visibleWidth(leftContent) === 0 && visibleWidth(rightContent) === 0) {
		return roundedBorder(width, kind, paint, sourceLine, indicator);
	}

	const leftCell = leftContent ? ` ${leftContent} ` : "";
	const rightCell = rightContent ? ` ${rightContent} ` : "";
	const fill = Math.max(1, contentWidth - visibleWidth(left) - visibleWidth(leftCell) - visibleWidth(rightCell) - visibleWidth(right) - 1);
	return `${paint(corners[0])}${left}${leftCell}${paint("─".repeat(fill))}${rightCell}${right}${paint("─")}${paint(corners[1])}`;
}

export class OpenTuiEditor extends CustomEditor {
	readonly embedWorkingStatus = true;
	private readonly getRail: () => string;
	private readonly getBorder: (s: string) => string;
	private embeddedWorkingStatusIndicator: WorkingStatusIndicator | undefined;
	private readonly inlineFooter: InlineFooterRenderer | undefined;
	private cursorStyle: CursorStyle;
	private previewHardwareCursor = false;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		cursorStyle: CursorStyle = "block",
		inlineFooter?: InlineFooterRenderer,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.cursorStyle = cursorStyle;
		this.inlineFooter = inlineFooter;
		configureCursor(tui, cursorStyle);
		// ponytail: route the frame through this.borderColor so Pi can recolor it
		// via updateEditorBorderColor() — bash mode ("! " prefix → green) and
		// thinking-level borders both flow through this one property.
		this.getRail = () => this.borderColor("│");
		this.getBorder = (s: string) => this.borderColor(s);
	}

	override setPaddingX(_padding: number): void {
		// The custom rail owns the horizontal inset and keeps one stable text gap.
		super.setPaddingX(0);
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.width < EDITOR_FRAME_HORIZONTAL_CHROME) return super.handleMouse(event);

		return super.handleMouse({
			...event,
			x: event.x - EDITOR_FRAME_LEFT_INSET,
			width: event.width - EDITOR_FRAME_HORIZONTAL_CHROME,
		});
	}

	setWorkingStatusIndicator(indicator: WorkingStatusIndicator | undefined): void {
		this.embeddedWorkingStatusIndicator = indicator;
		this.tui.requestRender();
	}

	setCursorStyle(cursorStyle: CursorStyle, blockHardwareCursor = false): void {
		const styleChanged = cursorStyle !== this.cursorStyle;
		this.previewHardwareCursor = cursorStyle !== "block";
		this.cursorStyle = cursorStyle;
		if (styleChanged) {
			if (cursorStyle === "block") {
				this.tui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
				this.tui.setShowHardwareCursor(blockHardwareCursor);
			} else {
				configureCursor(this.tui, cursorStyle);
			}
		}
		this.tui.requestRender();
	}

	private renderBase(width: number): string[] {
		const renderedLines = super.render(width);
		if (this.cursorStyle === "block") return renderedLines;

		// Pi re-applies settings.showHardwareCursor after session_start (/reload,
		// /new, session switches). Non-block styles have no software cursor left to
		// fall back on, so re-assert the hardware cursor instead of losing it.
		if (!this.tui.getShowHardwareCursor()) configureCursor(this.tui, this.cursorStyle);

		// A focused overlay suppresses the editor's cursor marker. Preserve its
		// position only for the live settings preview, then clear it on refocus.
		let cursorMarker = this.previewHardwareCursor && !this.focused ? CURSOR_MARKER : "";
		if (this.focused) this.previewHardwareCursor = false;
		return renderedLines.map((line) => {
			const rendered = removeSoftwareCursor(line, cursorMarker);
			if (rendered !== line) cursorMarker = "";
			return rendered;
		});
	}

	render(width: number): string[] {
		if (width < EDITOR_FRAME_HORIZONTAL_CHROME) return this.renderBase(width);

		const rail = this.getRail();
		const borderPaint = this.getBorder;
		// ponytail: 1-char rail + 1-char gap on each side = 4 chars of chrome.
		const innerWidth = Math.max(0, width - EDITOR_FRAME_HORIZONTAL_CHROME);
		const baseLines = this.renderBase(innerWidth);
		const bottomIdx = findBottomBorderIndex(baseLines);

		const result: string[] = [];
		const inlineFooter = this.inlineFooter?.enabled() === true;
		const renderInlineLine = (kind: "top" | "bottom", budget: number): InlineFooterLine | undefined =>
			this.inlineFooter?.render(budget)?.[kind];
		result.push(inlineFooter
			? inlineBorder(width, "top", borderPaint, (budget) => renderInlineLine("top", budget), baseLines[0], this.embeddedWorkingStatusIndicator)
			: roundedBorder(width, "top", borderPaint, baseLines[0], this.embeddedWorkingStatusIndicator));

		for (let i = 1; i < bottomIdx; i++) {
			const line = baseLines[i] ?? "";
			if (isEditorBorderLine(line)) {
				result.push(`${rail} ${fillLine("", innerWidth)} ${rail}`);
			} else {
				result.push(`${rail} ${fillLine(line, innerWidth)} ${rail}`);
			}
		}

		result.push(inlineFooter
			? inlineBorder(width, "bottom", borderPaint, (budget) => renderInlineLine("bottom", budget), baseLines[bottomIdx])
			: roundedBorder(width, "bottom", borderPaint, baseLines[bottomIdx]));

		for (let i = bottomIdx + 1; i < baseLines.length; i++) {
			result.push(baseLines[i]!);
		}

		return result.map((line) => truncateToWidth(line, width, ""));
	}
}

type StreamWrite = (...args: unknown[]) => boolean;

/**
 * Calls `requestRepaint` after each raw write to a TTY stream. Pi's fullscreen renderer only
 * rewrites changed rows, so text other extensions print straight to the terminal would
 * otherwise stay over the editor and footer until a resize.
 */
export function repaintAfterStreamWrites(
	requestRepaint: () => void,
	stream: NodeJS.WriteStream = process.stderr,
): () => void {
	if (!stream.isTTY) return () => {};
	const original = stream.write as unknown as StreamWrite;
	let enabled = true;
	const patched = ((...args: unknown[]) => {
		const callback = typeof args[args.length - 1] === "function"
			? (args.pop() as (error?: Error | null) => void)
			: undefined;
		// Repaint from the write callback so the redraw lands after the stray text.
		return original.call(stream, ...args, (error?: Error | null) => {
			try {
				if (enabled) requestRepaint();
			} catch {
				// A failed repaint must not break the caller's write; logging it here would recurse.
			}
			callback?.(error);
		});
	}) as typeof stream.write;
	stream.write = patched;
	return () => {
		enabled = false;
		// A later wrapper may still delegate to ours; leave it as a passthrough then.
		if (stream.write === patched) stream.write = original as unknown as typeof stream.write;
	};
}

export function installEditor(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	cursorStyle: CursorStyle = "block",
	inlineFooter?: InlineFooterRenderer,
) {
	let activeTui: TUI | undefined;
	let activeEditor: OpenTuiEditor | undefined;
	let previousHardwareCursor: boolean | undefined;
	let currentCursorStyle = cursorStyle;
	let hiddenThinkingTarget: HiddenThinkingLabelComponent | undefined;
	let restoreHiddenThinkingRender: (() => void) | undefined;
	let buildHiddenThinkingLabel: ((width: number) => string) | undefined;
	const getActiveTui = (): TUI => {
		if (!activeTui) throw new Error("Open TUI editor is not mounted");
		return activeTui;
	};
	const resetHiddenThinkingTarget = (): void => {
		restoreHiddenThinkingRender?.();
		restoreHiddenThinkingRender = undefined;
		hiddenThinkingTarget = undefined;
		buildHiddenThinkingLabel = undefined;
	};
	// Build the label at the width Pi actually renders the message with; layout
	// extensions (e.g. pi-sidebar) can make it much narrower than the terminal.
	const patchHiddenThinkingRender = (target: HiddenThinkingLabelComponent): void => {
		const originalRender = target.render;
		let lastWidth: number | undefined;
		let lastBuild: ((width: number) => string) | undefined;
		target.render = function (this: HiddenThinkingLabelComponent, width: number): string[] {
			const build = buildHiddenThinkingLabel;
			const textWidth = hiddenThinkingTextWidth(width, this.outputPad);
			if (build && (build !== lastBuild || textWidth !== lastWidth)) {
				lastBuild = build;
				lastWidth = textWidth;
				this.setHiddenThinkingLabel(build(textWidth));
			}
			return originalRender.call(this, width);
		};
		restoreHiddenThinkingRender = () => {
			target.render = originalRender;
		};
	};
	// Only the fullscreen renderer clears and rewrites the whole screen on a forced render.
	const restoreStderr = repaintAfterStreamWrites(() => {
		if (activeTui?.mode === "fullscreen") activeTui.requestRender(true);
	});

	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
		activeTui = tui;
		resetHiddenThinkingTarget();
		previousHardwareCursor = tui.getShowHardwareCursor();
		activeEditor = new OpenTuiEditor(tui, editorTheme, keybindings, currentCursorStyle, inlineFooter);
		return activeEditor;
	});
	return {
		/** `build` receives the hidden-thinking text width and runs again whenever that width changes. */
		setLatestHiddenThinkingLabel(build: (width: number) => string): void {
			const tui = getActiveTui();
			if (!hiddenThinkingTarget) {
				hiddenThinkingTarget = findLatestHiddenThinkingLabel(tui);
				patchHiddenThinkingRender(hiddenThinkingTarget);
			}
			buildHiddenThinkingLabel = build;
			tui.requestRender();
		},
		resetHiddenThinkingLabelTarget: resetHiddenThinkingTarget,
		setCursorStyle(nextCursorStyle: CursorStyle): void {
			currentCursorStyle = nextCursorStyle;
			activeEditor?.setCursorStyle(nextCursorStyle, previousHardwareCursor);
		},
		cleanup(): void {
			restoreStderr();
			resetHiddenThinkingTarget();
			ctx.ui.setEditorComponent(undefined);
			if (activeTui) {
				if (currentCursorStyle !== "block") activeTui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
				if (previousHardwareCursor !== undefined) activeTui.setShowHardwareCursor(previousHardwareCursor);
			}
		},
	};
}
