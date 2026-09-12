import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, type EditorTheme, type Terminal, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { installEditor, OpenTuiEditor } from "../extensions/open-tui/editor.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

const tui = {
	terminal: { rows: 24 },
	requestRender() {},
} as TUI;

const editorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
} as EditorTheme;

test("compensates Pi editor padding for the custom left rail", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("x");

	// Pi copies editorPaddingX after constructing a custom editor.
	editor.setPaddingX(2);
	const contentLine = stripAnsi(editor.render(40)[1] ?? "");

	assert.equal(contentLine.indexOf("x"), 2);
});

test("embeds the working indicator in the editor top border", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setWorkingStatusIndicator({
		renderInBorder: () => "◐ working",
		renderSpinnerInBorder: () => "◐",
	});

	assert.match(stripAnsi(editor.render(40)[0] ?? ""), /^╭── ◐ working ─+╮$/);
});

test("keeps a narrow scrolled working border intact", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText(Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n"));
	let spinnerRenders = 0;
	editor.setWorkingStatusIndicator({
		renderInBorder: () => "◐ working status that ignores width",
		renderSpinnerInBorder: () => {
			spinnerRenders++;
			return "◐";
		},
	});

	const topBorder = stripAnsi(editor.render(30)[0] ?? "");

	assert.equal(spinnerRenders, 1);
	assert.equal(visibleWidth(topBorder), 30);
	assert.match(topBorder, /↑ 3 more/);
	assert.ok(topBorder.endsWith("╮"));
});


test("uses the terminal hardware cursor for non-block styles", () => {
	for (const [cursorStyle, sequence] of [
		["bar", "\x1b[6 q"],
		["underline", "\x1b[4 q"],
	] as const) {
		const writes: string[] = [];
		let hardwareCursor: boolean | undefined;
		const hardwareTui = {
			...tui,
			terminal: {
				rows: 24,
				write: (data: string) => writes.push(data),
			},
			getShowHardwareCursor: () => hardwareCursor === true,
			setShowHardwareCursor: (enabled: boolean) => {
				hardwareCursor = enabled;
			},
		} as unknown as TUI;
		const editor = new OpenTuiEditor(
			hardwareTui,
			editorTheme,
			{ matches: () => false } as unknown as KeybindingsManager,
			cursorStyle,
		);

		const lines = editor.render(40);

		assert.equal(hardwareCursor, true);
		assert.ok(writes.includes(sequence), `${cursorStyle} cursor sequence was sent`);
		assert.ok(lines.every((line) => !line.includes("\x1b[7m")), "software block cursor was removed");
	}
});

test("shows a hardware cursor while previewing a non-block style under an overlay", () => {
	const cursorEvents: string[] = [];
	const terminal = {
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		write() {},
		hideCursor: () => cursorEvents.push("hide"),
		showCursor: () => cursorEvents.push("show"),
	} as unknown as Terminal;
	const overlayTui = new TuiMainScreen(terminal, false);
	const editor = new OpenTuiEditor(
		overlayTui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	overlayTui.addChild(editor);
	overlayTui.setFocus(editor);
	overlayTui.showOverlay({ render: () => ["settings"], invalidate() {} });
	cursorEvents.length = 0;

	editor.setCursorStyle("bar");
	(overlayTui as unknown as { doRender(): void }).doRender();

	assert.equal(cursorEvents.at(-1), "show");

	overlayTui.hideOverlay();
	(overlayTui as unknown as { doRender(): void }).doRender();
	overlayTui.showOverlay({ render: () => ["other overlay"], invalidate() {} });
	cursorEvents.length = 0;
	(overlayTui as unknown as { doRender(): void }).doRender();
	assert.equal(cursorEvents.at(-1), "hide");
	overlayTui.stop();
});

test("preserves block hardware cursor settings", () => {
	let changes = 0;
	const hardwareTui = {
		...tui,
		getShowHardwareCursor: () => true,
		setShowHardwareCursor: () => changes++,
	} as unknown as TUI;

	new OpenTuiEditor(
		hardwareTui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		"block",
	);

	assert.equal(changes, 0);
});

test("restores cursor shape and visibility when the editor is removed", () => {
	const writes: string[] = [];
	const visibility: boolean[] = [];
	const hardwareTui = {
		...tui,
		terminal: {
			rows: 24,
			write: (data: string) => writes.push(data),
		},
		getShowHardwareCursor: () => false,
		setShowHardwareCursor: (enabled: boolean) => visibility.push(enabled),
	} as unknown as TUI;
	const ctx = {
		ui: {
			setEditorComponent: (factory: unknown) => {
				if (typeof factory === "function") {
					factory(hardwareTui, editorTheme, { matches: () => false });
				}
			},
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;

	const editor = installEditor({} as import("@earendil-works/pi-coding-agent").ExtensionAPI, ctx, "bar");
	editor.cleanup();

	assert.ok(writes.includes("\x1b[0 q"), "cursor shape was reset");
	assert.deepEqual(visibility, [true, false]);
});

test("frame recolors via borderColor (bash mode / thinking level hook)", () => {
	const painted: string[] = [];
	const theme = {
		...editorTheme,
		borderColor: (text: string) => {
			painted.push(text);
			return text;
		},
	} as EditorTheme;
	const editor = new OpenTuiEditor(
		tui,
		theme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("hi");
	editor.setWorkingStatusIndicator({
		renderInBorder: () => "◐ working",
		renderSpinnerInBorder: () => "◐",
	});

	const lines = editor.render(40);
	const top = stripAnsi(lines[0] ?? "");
	const body = stripAnsi(lines[1] ?? "");

	// Frame shape stays intact and working corners route through borderColor.
	assert.ok(top.startsWith("╭") && top.endsWith("╮"), `top border shape: ${top!}`);
	assert.ok(body.startsWith("│") && body.endsWith("│"), `body rails: ${body!}`);
	assert.ok(painted.some((text) => text.startsWith("╭")), "left top corner bypassed borderColor");
	assert.ok(painted.some((text) => text.endsWith("╮")), "right top corner bypassed borderColor");
});

test("keeps a hardware cursor after Pi re-applies its runtime settings", () => {
	const cursorEvents: string[] = [];
	const terminal = {
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		write() {},
		hideCursor: () => cursorEvents.push("hide"),
		showCursor: () => cursorEvents.push("show"),
	} as unknown as Terminal;
	const hostTui = new TuiMainScreen(terminal, false);
	const editor = new OpenTuiEditor(
		hostTui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		"bar",
	);
	hostTui.addChild(editor);
	hostTui.setFocus(editor);

	// Pi re-applies settings.showHardwareCursor after session_start on /reload,
	// which would leave no cursor at all: the software cursor is stripped for
	// non-block styles.
	hostTui.setShowHardwareCursor(false);
	cursorEvents.length = 0;
	(hostTui as unknown as { doRender(): void }).doRender();
	assert.equal(cursorEvents.at(-1), "show");

	assert.ok(
		editor.render(40).every((line) => !line.includes("\x1b[7m")),
		"software cursor stays stripped",
	);
	hostTui.stop();
});
