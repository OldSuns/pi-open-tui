import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
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
): string {
	if (width < 2) return paint(truncateToWidth(kind === "top" ? "╭╮" : "╰╯", width, ""));
	const corners = kind === "top" ? (["╭", "╮"] as const) : (["╰", "╯"] as const);

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

export class OpenTuiEditor extends CustomEditor {
	private readonly getRail: () => string;
	private readonly getBorder: (s: string) => string;
	private cursorStyle: CursorStyle;
	private previewHardwareCursor = false;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		cursorStyle: CursorStyle = "block",
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.cursorStyle = cursorStyle;
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
		if (width < 4) return this.renderBase(width);

		const rail = this.getRail();
		const borderPaint = this.getBorder;
		// ponytail: 1-char rail + 1-char gap on each side = 4 chars of chrome.
		const innerWidth = Math.max(0, width - 4);
		const baseLines = this.renderBase(innerWidth);
		const bottomIdx = findBottomBorderIndex(baseLines);

		const result: string[] = [];
		result.push(roundedBorder(width, "top", borderPaint, baseLines[0]));

		for (let i = 1; i < bottomIdx; i++) {
			const line = baseLines[i] ?? "";
			if (isEditorBorderLine(line)) {
				result.push(`${rail} ${fillLine("", innerWidth)} ${rail}`);
			} else {
				result.push(`${rail} ${fillLine(line, innerWidth)} ${rail}`);
			}
		}

		result.push(roundedBorder(width, "bottom", borderPaint, baseLines[bottomIdx]));

		for (let i = bottomIdx + 1; i < baseLines.length; i++) {
			result.push(baseLines[i]!);
		}

		return result.map((line) => truncateToWidth(line, width, ""));
	}
}

export function installEditor(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	cursorStyle: CursorStyle = "block",
) {
	let activeTui: TUI | undefined;
	let activeEditor: OpenTuiEditor | undefined;
	let previousHardwareCursor: boolean | undefined;
	let currentCursorStyle = cursorStyle;

	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
		activeTui = tui;
		previousHardwareCursor = tui.getShowHardwareCursor();
		activeEditor = new OpenTuiEditor(tui, editorTheme, keybindings, currentCursorStyle);
		return activeEditor;
	});
	return {
		setCursorStyle(nextCursorStyle: CursorStyle): void {
			currentCursorStyle = nextCursorStyle;
			activeEditor?.setCursorStyle(nextCursorStyle, previousHardwareCursor);
		},
		cleanup(): void {
			ctx.ui.setEditorComponent(undefined);
			if (activeTui) {
				if (currentCursorStyle !== "block") activeTui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
				if (previousHardwareCursor !== undefined) activeTui.setShowHardwareCursor(previousHardwareCursor);
			}
		},
	};
}
