import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TuiMouseEvent, TUI } from "@earendil-works/pi-tui";
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

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

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

// pi-tui's renderFakeCursor() markers (FAKE_CURSOR_START/END, not exported). Truncation can drop the end marker.
const FAKE_CURSOR = /\x1b_pi:fc\x07([\s\S]*?)(?:\x1b_pi:\/fc\x07|$)/g;

function removeSoftwareCursor(line: string, cursorMarker = ""): string {
	return line.replace(FAKE_CURSOR, (_match, cursor: string) => {
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

export interface OpenTuiEditorOptions {
	cursorStyle?: CursorStyle;
	inlineFooter?: InlineFooterRenderer;
}

/** Capabilities this decorator adds to the editor instance it wraps. */
export interface OpenTuiEditorDecoration {
	embedWorkingStatus?: boolean;
	setWorkingStatusIndicator(indicator: WorkingStatusIndicator | undefined): void;
	setCursorStyle(cursorStyle: CursorStyle, blockHardwareCursor?: boolean): void;
}

export type OpenTuiDecoratedEditor = CustomEditor & OpenTuiEditorDecoration;
/** Any editor instance this decorator touched: the Pi editor contract plus our additions. */
export type OpenTuiEditorCapability = EditorComponent & OpenTuiEditorDecoration;

interface EditorDecoration {
	tui: TUI;
	editor: EditorComponent;
	cursorStyle: CursorStyle;
	previewHardwareCursor: boolean;
	inlineFooter: InlineFooterRenderer | undefined;
	indicator: WorkingStatusIndicator | undefined;
	baseRender: (width: number) => string[];
	baseHandleMouse: ((event: TuiMouseEvent) => unknown) | undefined;
	baseSetPaddingX: ((padding: number) => void) | undefined;
}

// One decoration per instance: installing twice must not stack two frames.
const DECORATIONS = new WeakMap<object, EditorDecoration>();
// Factories registered by a previous install. Restoring one of those on cleanup
// would leave a stale frame behind instead of handing the slot back.
const OWN_FACTORIES = new WeakSet<object>();

function applyCursorStyle(
	decoration: EditorDecoration,
	cursorStyle: CursorStyle,
	blockHardwareCursor = false,
): void {
	const styleChanged = cursorStyle !== decoration.cursorStyle;
	decoration.previewHardwareCursor = cursorStyle !== "block";
	decoration.cursorStyle = cursorStyle;
	if (styleChanged) {
		const tui = decoration.tui;
		if (cursorStyle === "block") {
			tui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
			tui.setShowHardwareCursor(blockHardwareCursor);
		} else {
			configureCursor(tui, cursorStyle);
		}
	}
	decoration.tui.requestRender();
}

function renderWithCursor(decoration: EditorDecoration, width: number): string[] {
	const renderedLines = decoration.baseRender(width);
	if (decoration.cursorStyle === "block") return renderedLines;

	const tui = decoration.tui;
	// Pi re-applies settings.showHardwareCursor after session_start (/reload,
	// /new, session switches). Non-block styles have no software cursor left to
	// fall back on, so re-assert the hardware cursor instead of losing it.
	if (!tui.getShowHardwareCursor()) configureCursor(tui, decoration.cursorStyle);

	// A focused overlay suppresses the editor's cursor marker. Preserve its
	// position only for the live settings preview, then clear it on refocus.
	const focused = (decoration.editor as { focused?: boolean }).focused === true;
	let cursorMarker = decoration.previewHardwareCursor && !focused ? CURSOR_MARKER : "";
	if (focused) decoration.previewHardwareCursor = false;
	return renderedLines.map((line) => {
		const rendered = removeSoftwareCursor(line, cursorMarker);
		if (rendered !== line) cursorMarker = "";
		return rendered;
	});
}

/**
 * Route the frame through the instance's `borderColor` so Pi can recolor it via
 * `updateEditorBorderColor()`: bash mode ("! " prefix → green) and thinking-level
 * borders both flow through that one property.
 */
function paintBorder(editor: EditorComponent, text: string): string {
	const borderColor = (editor as { borderColor?: unknown }).borderColor;
	return typeof borderColor === "function" ? (borderColor as (value: string) => string)(text) : text;
}

/** Pi's own editor renders exactly one top border, content, then one bottom border. */
function isFrameable(lines: string[]): boolean {
	if (lines.length < 3) return false;
	if (!isEditorBorderLine(lines[0] ?? "")) return false;
	const bottom = findBottomBorderIndex(lines);
	return bottom >= 1 && bottom < lines.length && isEditorBorderLine(lines[bottom] ?? "");
}

function renderFrame(decoration: EditorDecoration, width: number): string[] {
	if (width < EDITOR_FRAME_HORIZONTAL_CHROME) return renderWithCursor(decoration, width);

	const innerWidth = Math.max(0, width - EDITOR_FRAME_HORIZONTAL_CHROME);
	const baseLines = renderWithCursor(decoration, innerWidth);
	if (!isFrameable(baseLines)) {
		// The inner editor does not use Pi's border layout (it draws its own chrome,
		// or an extension replaced it wholesale). Skip our frame rather than drawing a
		// second one, and hand the working indicator back to Pi's status container.
		(decoration.editor as { embedWorkingStatus?: boolean }).embedWorkingStatus = false;
		return renderWithCursor(decoration, width).map((line) => truncateToWidth(line, width, ""));
	}
	(decoration.editor as { embedWorkingStatus?: boolean }).embedWorkingStatus = true;

	const rail = paintBorder(decoration.editor, "│");
	const borderPaint = (text: string) => paintBorder(decoration.editor, text);
	const bottomIdx = findBottomBorderIndex(baseLines);

	const result: string[] = [];
	const inlineFooter = decoration.inlineFooter?.enabled() === true;
	const renderInlineLine = (kind: "top" | "bottom", budget: number): InlineFooterLine | undefined =>
		decoration.inlineFooter?.render(budget)?.[kind];
	result.push(inlineFooter
		? inlineBorder(width, "top", borderPaint, (budget) => renderInlineLine("top", budget), baseLines[0], decoration.indicator)
		: roundedBorder(width, "top", borderPaint, baseLines[0], decoration.indicator));

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

/**
 * Adds the open-tui frame to an existing editor **in place** and returns that same
 * instance. Patching (instead of wrapping) keeps `onSubmit` / `onChange` / `handleInput`
 * on one object, so Pi and every extension that wrapped the factory before us keep working.
 */
export function decorateOpenTuiEditor<T extends EditorComponent>(
	editor: T,
	tui: TUI,
	options: OpenTuiEditorOptions = {},
): T & OpenTuiEditorDecoration {
	const existing = DECORATIONS.get(editor);
	if (existing) {
		if (options.cursorStyle !== undefined && options.cursorStyle !== existing.cursorStyle) {
			applyCursorStyle(existing, options.cursorStyle);
		}
		existing.inlineFooter = options.inlineFooter ?? existing.inlineFooter;
		return editor as T & OpenTuiEditorDecoration;
	}

	const decoration: EditorDecoration = {
		tui,
		editor,
		cursorStyle: options.cursorStyle ?? "block",
		previewHardwareCursor: false,
		inlineFooter: options.inlineFooter,
		indicator: undefined,
		baseRender: editor.render.bind(editor),
		baseHandleMouse: typeof (editor as { handleMouse?: unknown }).handleMouse === "function"
			? (editor as unknown as { handleMouse(event: TuiMouseEvent): unknown }).handleMouse.bind(editor)
			: undefined,
		baseSetPaddingX: typeof (editor as { setPaddingX?: unknown }).setPaddingX === "function"
			? (editor as unknown as { setPaddingX(padding: number): void }).setPaddingX.bind(editor)
			: undefined,
	};
	DECORATIONS.set(editor, decoration);
	configureCursor(tui, decoration.cursorStyle);

	const decorated = editor as T & OpenTuiEditorDecoration;
	decorated.embedWorkingStatus = true;
	decorated.setWorkingStatusIndicator = (indicator) => {
		decoration.indicator = indicator;
		tui.requestRender();
	};
	decorated.setCursorStyle = (nextCursorStyle, blockHardwareCursor = false) => {
		applyCursorStyle(decoration, nextCursorStyle, blockHardwareCursor);
	};
	editor.render = (width: number) => renderFrame(decoration, width);
	if (decoration.baseHandleMouse) {
		(editor as unknown as { handleMouse(event: TuiMouseEvent): unknown }).handleMouse = (event: TuiMouseEvent) =>
			event.width < EDITOR_FRAME_HORIZONTAL_CHROME
				? decoration.baseHandleMouse?.(event)
				: decoration.baseHandleMouse?.({
					...event,
					x: event.x - EDITOR_FRAME_LEFT_INSET,
					width: event.width - EDITOR_FRAME_HORIZONTAL_CHROME,
				});
	}
	if (decoration.baseSetPaddingX) {
		// The custom rail owns the horizontal inset and keeps one stable text gap.
		(editor as unknown as { setPaddingX(padding: number): void }).setPaddingX = (_padding: number) =>
			decoration.baseSetPaddingX?.(0);
	}
	return decorated;
}

/** Standalone framed editor, used when no other extension installed one. */
export function createOpenTuiEditor(
	tui: TUI,
	editorTheme: EditorTheme,
	keybindings: KeybindingsManager,
	cursorStyle: CursorStyle = "block",
	inlineFooter?: InlineFooterRenderer,
): OpenTuiDecoratedEditor {
	return decorateOpenTuiEditor(
		new CustomEditor(tui, editorTheme, keybindings, { paddingX: 0 }),
		tui,
		{ cursorStyle, inlineFooter },
	);
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
	let activeEditor: OpenTuiEditorCapability | undefined;
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
		let active = true;
		const patched = function (this: HiddenThinkingLabelComponent, width: number): string[] {
			if (!active) return originalRender.call(this, width);
			const build = buildHiddenThinkingLabel;
			const textWidth = hiddenThinkingTextWidth(width, this.outputPad);
			if (build && (build !== lastBuild || textWidth !== lastWidth)) {
				lastBuild = build;
				lastWidth = textWidth;
				this.setHiddenThinkingLabel(build(textWidth));
			}
			return originalRender.call(this, width);
		};
		target.render = patched;
		restoreHiddenThinkingRender = () => {
			active = false;
			// Another copy of this extension may have wrapped us; unwinding then would drop its wrapper.
			if (target.render === patched) target.render = originalRender;
		};
	};
	// Only the fullscreen renderer clears and rewrites the whole screen on a forced render.
	const restoreStderr = repaintAfterStreamWrites(() => {
		if (activeTui?.mode === "fullscreen") activeTui.requestRender(true);
	});

	// Pi's setEditorComponent replaces, so a later install would silently drop an
	// editor another extension wrapped in. Capture that factory and decorate the
	// instance it returns instead of replacing it (CHANGELOG #3935).
	const previousFactory = typeof ctx.ui.getEditorComponent === "function"
		? ctx.ui.getEditorComponent()
		: undefined;
	// A factory left behind by an earlier install of this same extension must not
	// come back on cleanup, or the frame would survive an uninstall.
	const inheritedFactory = previousFactory && !OWN_FACTORIES.has(previousFactory)
		? previousFactory
		: undefined;

	const factory: EditorFactory = (tui, editorTheme, keybindings) => {
		activeTui = tui;
		resetHiddenThinkingTarget();
		previousHardwareCursor = tui.getShowHardwareCursor?.();
		let inner: EditorComponent | undefined;
		try {
			inner = inheritedFactory?.(tui, editorTheme, keybindings);
		} catch {
			// One broken editor extension must not take open-tui down with it.
			inner = undefined;
		}
		activeEditor = decorateOpenTuiEditor(
			inner ?? new CustomEditor(tui, editorTheme, keybindings, { paddingX: 0 }),
			tui,
			{ cursorStyle: currentCursorStyle, inlineFooter },
		);
		return activeEditor;
	};
	OWN_FACTORIES.add(factory);
	ctx.ui.setEditorComponent(factory);
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
		getTui: (): TUI | undefined => activeTui,
		setCursorStyle(nextCursorStyle: CursorStyle): void {
			currentCursorStyle = nextCursorStyle;
			activeEditor?.setCursorStyle(nextCursorStyle, previousHardwareCursor);
		},
		cleanup(): void {
			restoreStderr();
			resetHiddenThinkingTarget();
			if (activeTui) {
				if (currentCursorStyle !== "block") activeTui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
				if (previousHardwareCursor !== undefined) activeTui.setShowHardwareCursor(previousHardwareCursor);
			}
			// Hand the editor slot back instead of clearing it, so editors wrapped
			// before us stay installed after open-tui is disabled or unloaded.
			const currentFactory = typeof ctx.ui.getEditorComponent === "function"
				? ctx.ui.getEditorComponent()
				: undefined;
			// Another extension wrapped us after we installed; replacing the factory
			// now would silently drop its wrapper.
			if (currentFactory !== undefined && currentFactory !== factory) return;
			try {
				ctx.ui.setEditorComponent(inheritedFactory);
			} catch {
				// The inherited factory broke after we took over; fall back to Pi's editor
				// rather than leaving the slot empty.
				ctx.ui.setEditorComponent(undefined);
			}
		},
	};
}
