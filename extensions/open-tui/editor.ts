import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
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

interface OpenTuiEditorOptions {
	cursorStyle?: CursorStyle;
	inlineFooter?: InlineFooterRenderer;
}

/** Capabilities this decorator adds to the editor instance it wraps. */
interface OpenTuiEditorDecoration {
	embedWorkingStatus?: boolean;
	setWorkingStatusIndicator(indicator: WorkingStatusIndicator | undefined): void;
	setCursorStyle(cursorStyle: CursorStyle, blockHardwareCursor?: boolean): void;
}

type FrameableEditor = EditorComponent & Pick<CustomEditor,
	"focused" | "borderColor" | "handleMouse" | "getPaddingX" | "setPaddingX"
>;

// 按能力识别，避免跨模块加载时 instanceof 失效；仅支持保留 Pi 原生布局的编辑器。
function isFrameableEditor(editor: EditorComponent): editor is FrameableEditor {
	return typeof editor.borderColor === "function"
		&& typeof editor.handleMouse === "function"
		&& "getPaddingX" in editor && typeof editor.getPaddingX === "function"
		&& typeof editor.setPaddingX === "function"
		&& "focused" in editor && typeof editor.focused === "boolean";
}

interface EditorDecoration {
	tui: TUI;
	editor: FrameableEditor;
	cursorStyle: CursorStyle;
	previewHardwareCursor: boolean;
	inlineFooter: InlineFooterRenderer | undefined;
	indicator: WorkingStatusIndicator | undefined;
	baseRender: (width: number) => string[];
	active: boolean;
	cleanup(): void;
}

// One decoration per instance: installing twice must not stack two frames.
const DECORATIONS = new WeakMap<object, EditorDecoration>();

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
	const focused = decoration.editor.focused;
	let cursorMarker = decoration.previewHardwareCursor && !focused ? CURSOR_MARKER : "";
	if (focused) decoration.previewHardwareCursor = false;
	return renderedLines.map((line) => {
		const rendered = removeSoftwareCursor(line, cursorMarker);
		if (rendered !== line) cursorMarker = "";
		return rendered;
	});
}

function renderFrame(decoration: EditorDecoration, width: number): string[] {
	if (width < EDITOR_FRAME_HORIZONTAL_CHROME) return renderWithCursor(decoration, width);

	const innerWidth = Math.max(0, width - EDITOR_FRAME_HORIZONTAL_CHROME);
	const baseLines = renderWithCursor(decoration, innerWidth);
	const borderPaint = (text: string) => decoration.editor.borderColor(text);
	const rail = borderPaint("│");
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
		result.push(`${rail} ${fillLine(line, innerWidth)} ${rail}`);
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
export function decorateOpenTuiEditor<T extends FrameableEditor>(
	editor: T,
	tui: TUI,
	options: OpenTuiEditorOptions = {},
): T & OpenTuiEditorDecoration {
	const existing = DECORATIONS.get(editor);
	if (existing) return editor as T & OpenTuiEditorDecoration;

	const decorated = editor as FrameableEditor & OpenTuiEditorDecoration;
	const restore: (() => void)[] = [];
	const baseHandleMouse = editor.handleMouse.bind(editor);
	const baseSetPaddingX = editor.setPaddingX.bind(editor);
	const baseSetWorkingStatus = decorated.setWorkingStatusIndicator?.bind(editor);
	const baseSetCursorStyle = decorated.setCursorStyle?.bind(editor);
	let padding = editor.getPaddingX();
	const decoration: EditorDecoration = {
		tui,
		editor,
		cursorStyle: options.cursorStyle ?? "block",
		previewHardwareCursor: false,
		inlineFooter: options.inlineFooter,
		indicator: undefined,
		baseRender: editor.render.bind(editor),
		active: true,
		cleanup() {
			if (!decoration.active) return;
			decoration.active = false;
			for (const undo of restore) undo();
			baseSetPaddingX(padding);
			DECORATIONS.delete(editor);
		},
	};
	// 只撤销仍属于自己的属性；后来包装的方法会通过 active=false 调用原实现。
	const patch = <K extends keyof OpenTuiEditorDecoration | "render" | "handleMouse" | "setPaddingX">(
		key: K,
		value: (FrameableEditor & OpenTuiEditorDecoration)[K],
	): void => {
		const descriptor = Object.getOwnPropertyDescriptor(editor, key);
		decorated[key] = value;
		restore.push(() => {
			if (decorated[key] !== value) return;
			if (descriptor) Object.defineProperty(editor, key, descriptor);
			else Reflect.deleteProperty(editor, key);
		});
	};
	DECORATIONS.set(editor, decoration);
	configureCursor(tui, decoration.cursorStyle);
	patch("embedWorkingStatus", true);
	patch("setWorkingStatusIndicator", (indicator) => {
		if (!decoration.active) return baseSetWorkingStatus?.(indicator);
		decoration.indicator = indicator;
		tui.requestRender();
	});
	patch("setCursorStyle", (style, hardware = false) => {
		if (decoration.active) applyCursorStyle(decoration, style, hardware);
		else baseSetCursorStyle?.(style, hardware);
	});
	patch("render", (width) => decoration.active
		? renderFrame(decoration, width)
		: decoration.baseRender(width));
	patch("handleMouse", (event) => baseHandleMouse(
		decoration.active && event.width >= EDITOR_FRAME_HORIZONTAL_CHROME
			? { ...event, x: event.x - EDITOR_FRAME_LEFT_INSET, width: event.width - EDITOR_FRAME_HORIZONTAL_CHROME }
			: event,
	));
	patch("setPaddingX", (nextPadding) => {
		padding = nextPadding;
		baseSetPaddingX(decoration.active ? 0 : nextPadding);
	});
	baseSetPaddingX(0);
	return editor as T & OpenTuiEditorDecoration;
}

/** Standalone framed editor, used when no other extension installed one. */
export function createOpenTuiEditor(
	tui: TUI,
	editorTheme: EditorTheme,
	keybindings: KeybindingsManager,
	cursorStyle: CursorStyle = "block",
	inlineFooter?: InlineFooterRenderer,
) {
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
	let activeEditor: (FrameableEditor & OpenTuiEditorDecoration) | undefined;
	let enabled = true;
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

	const ui = ctx.ui;
	const originalSetEditor = ui.setEditorComponent;
	const originalGetEditor = ui.getEditorComponent;
	let inheritedFactory = originalGetEditor.call(ui);
	let mountedEditor: EditorComponent | undefined;
	let mountedFactory: EditorFactory | undefined;
	let mountedRender: EditorComponent["render"] | undefined;
	let restoreEditorMount: (() => void) | undefined;
	const releaseEditor = (): void => {
		if (activeEditor) DECORATIONS.get(activeEditor)?.cleanup();
		activeEditor = undefined;
		if (activeTui && previousHardwareCursor !== undefined) {
			if (currentCursorStyle !== "block") activeTui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
			activeTui.setShowHardwareCursor(previousHardwareCursor);
		}
		previousHardwareCursor = undefined;
	};
	const mountEditor = (tui: TUI, editor: EditorComponent): void => {
		releaseEditor();
		activeTui = tui;
		mountedEditor = editor;
		mountedFactory = originalGetEditor.call(ui);
		resetHiddenThinkingTarget();
		if (isFrameableEditor(editor)) {
			let lines: string[] = [];
			try {
				lines = editor.render(tui.terminal.columns);
			} catch {
				// A failed layout probe must not prevent Pi from mounting the editor.
			}
			const bottom = findBottomBorderIndex(lines);
			// Capabilities alone do not guarantee that the first and bottom rows are replaceable borders.
			if (bottom > 1 && isEditorBorderLine(lines[0] ?? "") && isEditorBorderLine(lines[bottom] ?? "")) {
				previousHardwareCursor = tui.getShowHardwareCursor?.();
				activeEditor = decorateOpenTuiEditor(editor, tui, { cursorStyle: currentCursorStyle, inlineFooter });
			}
		}
		mountedRender = editor.render;
	};
	const wrapFactory = (delegate: EditorFactory | undefined): EditorFactory => {
		const wrapped: EditorFactory = (tui, editorTheme, keybindings) => {
			let inner: EditorComponent | undefined;
			try {
				inner = delegate?.(tui, editorTheme, keybindings);
			} catch {
				// 上游工厂不可用时保留默认编辑器。
			}
			inner ??= new CustomEditor(tui, editorTheme, keybindings, { paddingX: 0 });
			// A factory captured by another context must keep its original delegate.
			if (enabled && originalGetEditor.call(ui) === wrapped) mountEditor(tui, inner);
			return inner;
		};
		return wrapped;
	};
	let factory = wrapFactory(inheritedFactory);
	const getEditor: typeof ui.getEditorComponent = () => {
		const current = originalGetEditor.call(ui);
		return enabled && current === factory ? inheritedFactory : current;
	};
	const setEditor: typeof ui.setEditorComponent = (next) => {
		if (!enabled) return originalSetEditor.call(ui, next);
		inheritedFactory = next;
		factory = wrapFactory(next);
		originalSetEditor.call(ui, factory);
	};
	ui.getEditorComponent = getEditor;
	ui.setEditorComponent = setEditor;
	originalSetEditor.call(ui, factory);

	// Shortcut contexts have a fresh ui object; intercept their shared mount before status routing.
	const pending: Component[] = activeTui ? [activeTui] : [];
	const visited = new Set<Component>();
	while (pending.length > 0) {
		const component = pending.pop()!;
		if (visited.has(component)) continue;
		visited.add(component);
		const container = component as Partial<Container>;
		if (!Array.isArray(container.children)) continue;
		if (!mountedEditor || !container.children.includes(mountedEditor) || typeof container.addChild !== "function") {
			pending.push(...container.children);
			continue;
		}
		const target = container as Container;
		const original = target.addChild;
		const descriptor = Object.getOwnPropertyDescriptor(target, "addChild");
		const patched: typeof original = function (this: Container, child) {
			const candidate = child as Partial<EditorComponent>;
			// Reused instances can have a new factory or render; unchanged dialog returns need no remount.
			if (enabled && activeTui
				&& (child !== mountedEditor || originalGetEditor.call(ui) !== mountedFactory || child.render !== mountedRender)
				&& typeof candidate.getText === "function" && typeof candidate.setText === "function"
				&& typeof candidate.handleInput === "function"
				&& typeof candidate.onSubmit === "function" && candidate.onSubmit === mountedEditor?.onSubmit
				&& typeof candidate.onChange === "function" && candidate.onChange === mountedEditor?.onChange) {
				mountEditor(activeTui, candidate as EditorComponent);
			}
			original.call(this, child);
		};
		target.addChild = patched;
		restoreEditorMount = () => {
			if (target.addChild !== patched) return;
			if (descriptor) Object.defineProperty(target, "addChild", descriptor);
			else Reflect.deleteProperty(target, "addChild");
		};
		break;
	}
	return {
		isFramed: () => enabled && activeEditor !== undefined,
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
			if (!enabled) return;
			enabled = false;
			restoreEditorMount?.();
			releaseEditor();
			restoreStderr();
			resetHiddenThinkingTarget();
			// 只恢复自己的代理；后来捕获的代理会在停用后透传到原接口。
			if (ui.setEditorComponent === setEditor) ui.setEditorComponent = originalSetEditor;
			if (ui.getEditorComponent === getEditor) ui.getEditorComponent = originalGetEditor;
			const current = originalGetEditor.call(ui);
			if (current === factory || current === mountedFactory) {
				try {
					originalSetEditor.call(ui, current === factory ? inheritedFactory : current);
				} catch {
					originalSetEditor.call(ui, undefined);
				}
			}
		},
	};
}
