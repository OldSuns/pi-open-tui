import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor, VERSION, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Container, TuiMainScreen, type EditorComponent, type EditorTheme, type Terminal, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { decorateOpenTuiEditor, installEditor, createOpenTuiEditor, repaintAfterStreamWrites } from "../extensions/open-tui/editor.ts";
import { OpenTuiHeader } from "../extensions/open-tui/header.ts";
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
	const editor = createOpenTuiEditor(
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

test("preserves legal editor text that resembles a border or scroll indicator", () => {
	for (const [width, text] of [
		[40, "↑ 3 more"],
		[40, "↓ 2 more"],
		[40, "─── ↑ 3 more ───"],
		[5, "─"],
	] as const) {
		const editor = createOpenTuiEditor(
			tui,
			editorTheme,
			{ matches: () => false } as unknown as KeybindingsManager,
		);
		editor.setText(`${text}\nx`);

		assert.equal(stripAnsi(editor.render(width)[1] ?? ""), `│ ${text.padEnd(width - 4)} │`);
	}
});

test("maps framed editor clicks to the Pi editor coordinate space", () => {
	const editor = createOpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("abcdef");
	editor.render(40);

	const click = (x: number): void => {
		editor.handleMouse({
			type: "click",
			button: "left",
			x,
			y: 1,
			screenX: x,
			screenY: 1,
			width: 40,
			height: 8,
			shift: false,
			alt: false,
			ctrl: false,
		});
	};

	click(2);
	assert.equal(editor.getCursor().col, 0);
	click(3);
	assert.equal(editor.getCursor().col, 1);
	click(39);
	assert.equal(editor.getCursor().col, 6);
});

test("leaves narrow unframed editor mouse coordinates unchanged", () => {
	const editor = createOpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("abc");
	editor.render(3);

	editor.handleMouse({
		type: "click",
		button: "left",
		x: 0,
		y: 1,
		screenX: 0,
		screenY: 1,
		width: 3,
		height: 8,
		shift: false,
		alt: false,
		ctrl: false,
	});

	assert.equal(editor.getCursor().col, 0);
});
test("embeds the working indicator in the editor top border", () => {
	const editor = createOpenTuiEditor(
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

test("renders inline footer lines in the editor frame", () => {
	const editor = createOpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		"block",
		{
			enabled: () => true,
			render: () => ({
				top: { left: "cwd", right: "context" },
				bottom: { left: "model", right: "stats" },
			}),
		},
	);

	const lines = editor.render(40).map(stripAnsi);
	assert.match(lines[0] ?? "", /^╭─ cwd ─+ context ─╮$/);
	assert.match(lines.at(-1) ?? "", /^╰─ model ─+ stats ─╯$/);
	assert.equal(visibleWidth(lines[0] ?? ""), 40);
	assert.equal(visibleWidth(lines.at(-1) ?? ""), 40);
});

test("keeps a narrow scrolled working border intact", () => {
	const editor = createOpenTuiEditor(
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
		const editor = createOpenTuiEditor(
			hardwareTui,
			editorTheme,
			{ matches: () => false } as unknown as KeybindingsManager,
			cursorStyle,
		);

		const lines = editor.render(40);

		assert.equal(hardwareCursor, true);
		assert.ok(writes.includes(sequence), `${cursorStyle} cursor sequence was sent`);
		assert.ok(lines.every((line) => !line.includes("\x1b_pi:fc")), "software block cursor was removed");
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
	const editor = createOpenTuiEditor(
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

	createOpenTuiEditor(
		hardwareTui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		"block",
	);

	assert.equal(changes, 0);
});

test("does not override Pi's native fullscreen wheel setting", () => {
	let wheelSettingChanges = 0;
	const fullscreenTui = {
		...tui,
		mode: "fullscreen",
		terminal: { rows: 24, write() {} },
		getShowHardwareCursor: () => false,
		setShowHardwareCursor() {},
		setWheelScrollLines: () => wheelSettingChanges++,
	} as unknown as TUI;
	const host = createEditorHost(undefined, fullscreenTui);
	const editor = installEditor({} as ExtensionAPI, host.ctx);
	assert.equal(wheelSettingChanges, 0);
	assert.equal(editor.getTui(), fullscreenTui);
	editor.cleanup();
	assert.equal(wheelSettingChanges, 0);
});

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

function createEditorHost(initialFactory?: EditorFactory, hostTui: TUI = tui) {
	let factory: EditorFactory | undefined = initialFactory;
	let editor: EditorComponent | undefined;
	const ctx = {
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent(next: EditorFactory | undefined) {
				factory = next;
				editor = next?.(hostTui, editorTheme, { matches: () => false } as unknown as KeybindingsManager)
					?? new CustomEditor(hostTui, editorTheme, { matches: () => false } as unknown as KeybindingsManager);
				editor?.setPaddingX?.(2);
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, get registeredFactory() { return factory; }, get editor() { assert.ok(editor); return editor; } };
}

function createInnerEditor() {
	return new CustomEditor(tui, editorTheme, { matches: () => false } as unknown as KeybindingsManager);
}

const mouseClick: TuiMouseEvent = {
	type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 1,
	width: 40, height: 8, shift: false, alt: false, ctrl: false,
};

test("decorates an existing editor and restores its reused instance on cleanup", () => {
	const inner = createInnerEditor();
	let innerTabPresses = 0;
	const innerHandleInput = inner.handleInput.bind(inner);
	inner.handleInput = (data: string) => {
		if (data === "\t") innerTabPresses++;
		innerHandleInput(data);
	};
	const originalRender = inner.render;
	const originalMouse = inner.handleMouse;
	const originalPadding = inner.setPaddingX;
	const originalStatus = inner.setWorkingStatusIndicator;
	const originalEmbedStatus = inner.embedWorkingStatus;
	const innerFactory = () => inner;
	const host = createEditorHost(innerFactory);
	const handle = installEditor({} as ExtensionAPI, host.ctx);

	assert.equal(host.editor, inner);
	host.editor.handleInput("\t");
	assert.equal(innerTabPresses, 1);
	assert.match(stripAnsi(host.editor.render(40)[0] ?? ""), /^╭/);
	assert.equal(inner.getPaddingX(), 0);

	handle.cleanup();
	assert.equal(host.ctx.ui.getEditorComponent(), innerFactory);
	assert.equal(host.editor, inner);
	assert.equal(inner.render, originalRender);
	assert.equal(inner.handleMouse, originalMouse);
	assert.equal(inner.setPaddingX, originalPadding);
	assert.equal(inner.setWorkingStatusIndicator, originalStatus);
	assert.equal(inner.embedWorkingStatus, originalEmbedStatus);
	assert.equal(inner.getPaddingX(), 2);
	assert.ok(!Object.hasOwn(inner, "setCursorStyle"));
	assert.doesNotMatch(stripAnsi(inner.render(40)[0] ?? ""), /^╭/);

	const reinstalled = installEditor({} as ExtensionAPI, host.ctx);
	assert.match(stripAnsi(inner.render(40)[0] ?? ""), /^╭/);
	reinstalled.cleanup();
	assert.equal(inner.render, originalRender);
});

test("frames direct editor registrations in either extension order", () => {
	for (const openTuiFirst of [false, true]) {
		const host = createEditorHost();
		const ui = host.ctx.ui;
		const originalGet = ui.getEditorComponent;
		const originalSet = ui.setEditorComponent;
		const inner = createInnerEditor();
		const upstream = () => inner;
		let handle: ReturnType<typeof installEditor>;
		if (openTuiFirst) {
			handle = installEditor({} as ExtensionAPI, host.ctx);
			// 独立扩展上下文共享同一个 ui 对象。
			const otherCtx = { ui };
			otherCtx.ui.setEditorComponent(upstream);
		} else {
			ui.setEditorComponent(upstream);
			handle = installEditor({} as ExtensionAPI, host.ctx);
		}
		assert.equal(ui.getEditorComponent(), upstream);
		assert.equal(host.editor, inner);
		assert.equal(stripAnsi(inner.render(40).join("\n")).match(/╭/g)?.length, 1);
		const mounted = host.registeredFactory!;
		handle.cleanup();
		assert.equal(ui.getEditorComponent, originalGet);
		assert.equal(ui.setEditorComponent, originalSet);
		assert.equal(ui.getEditorComponent(), upstream);
		assert.doesNotMatch(stripAnsi(host.editor.render(40)[0]!), /^╭/);
		assert.doesNotMatch(stripAnsi(mounted(tui, editorTheme, {} as KeybindingsManager).render(40)[0]!), /^╭/);
	}
});

test("frames replacements from Pi shortcut contexts without rebuilding the editor", async () => {
	const { InteractiveMode } = await import(new URL(
		"./modes/interactive/interactive-mode.js",
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	).href);
	let hardware = false;
	const editorContainer = new Container();
	const hostTui = {
		...tui,
		children: [editorContainer],
		terminal: { rows: 24, write() {} },
		getShowHardwareCursor: () => hardware,
		setShowHardwareCursor: (value: boolean) => { hardware = value; },
		setFocus(component: CustomEditor) { component.focused = true; },
	} as unknown as TUI;
	const keybindings = { matches: () => false, getEffectiveConfig: () => ({}) } as unknown as KeybindingsManager;
	const defaultEditor = new CustomEditor(hostTui, editorTheme, keybindings);
	defaultEditor.onSubmit = () => {};
	defaultEditor.onChange = () => {};
	const indicator = { renderInBorder: () => "working", renderSpinnerInBorder: () => "*" };
	const host = Object.create(InteractiveMode.prototype, Object.fromEntries(Object.entries({
		ui: hostTui,
		keybindings,
		defaultEditor,
		editor: defaultEditor,
		editorContainer,
		statusContainer: new Container(),
		activeStatusIndicator: indicator,
		disposeActiveSelector() {},
		sessionManager: { getCwd: () => process.cwd() },
		session: { agent: { signal: undefined }, scopedModels: [] },
		settingsManager: { isProjectTrusted: () => true },
		showError(error: unknown) { throw error; },
	}).map(([key, value]) => [key, { value, writable: true, configurable: true }])));
	const ui = host.createExtensionUIContext();
	const originalAddChild = editorContainer.addChild;
	const handle = installEditor({} as ExtensionAPI, { ui } as ExtensionContext, "bar", {
		enabled: () => true,
		render: () => ({ top: { left: "branch", right: "" }, bottom: { left: "model", right: "" } }),
	});
	try {
		let factoryCalls = 0;
		let shortcutUi: ExtensionContext["ui"] | undefined;
		const upstream: EditorFactory = (...args) => { factoryCalls++; return new CustomEditor(...args); };
		host.setupExtensionShortcuts({
			getShortcuts: () => new Map([["ctrl+a", { handler(ctx: ExtensionContext) {
				shortcutUi = ctx.ui;
				ctx.ui.setEditorComponent(upstream);
			} }]]),
			getModelRegistry() {},
		});
		host.defaultEditor.onExtensionShortcut("\x01");
		assert.notEqual(shortcutUi, ui);
		assert.equal(factoryCalls, 1);
		assert.equal(handle.isFramed(), true);
		assert.equal(ui.getEditorComponent(), upstream);
		assert.match(stripAnsi(host.editor.render(60).join("\n")), /╭.*working.*branch/);
		assert.match(stripAnsi(host.editor.render(60).join("\n")), /model/);
		assert.equal(host.editor.getPaddingX(), 0);
		assert.equal(host.editor.onSubmit, defaultEditor.onSubmit);
		assert.equal(host.statusContainer.children.length, 0);

		// The same factory can be registered repeatedly from fresh contexts.
		host.defaultEditor.onExtensionShortcut("\x01");
		assert.equal(factoryCalls, 2);
		assert.match(stripAnsi(host.editor.render(60)[0]), /^╭/);
		const latest = host.editor;
		const dialog = new CustomEditor(hostTui, editorTheme, keybindings);
		editorContainer.clear();
		editorContainer.addChild(dialog);
		assert.doesNotMatch(stripAnsi(dialog.render(60)[0]!), /^╭/);
		editorContainer.clear();
		editorContainer.addChild(latest);
		assert.equal(handle.isFramed(), true);

		// A fresh getter can capture our factory; later registration must not recurse.
		ui.setEditorComponent(upstream);
		const previous = shortcutUi!.getEditorComponent()!;
		const wrapped: EditorFactory = (...args) => {
			const editor = previous(...args);
			const render = editor.render.bind(editor);
			editor.render = (width) => [...render(width), "shortcut wrapper"];
			return editor;
		};
		shortcutUi!.setEditorComponent(wrapped);
		ui.setEditorComponent(wrapped);
		assert.equal(factoryCalls, 5);
		assert.equal(stripAnsi(host.editor.render(60).join("\n")).match(/╭/g)?.length, 1);
		assert.equal(host.editor.render(60).at(-1), "shortcut wrapper");

		const custom: EditorComponent = { render: () => ["custom"], invalidate() {}, getText: () => "", setText() {}, handleInput() {} };
		shortcutUi!.setEditorComponent(() => custom);
		assert.equal(handle.isFramed(), false);
		assert.equal(hardware, false);
		assert.deepEqual(custom.render(60), ["custom"]);
		assert.equal(host.statusContainer.children.length, 1);
		host.defaultEditor.onExtensionShortcut("\x01");
		assert.equal(handle.isFramed(), true);
		assert.match(stripAnsi(host.editor.render(60)[0]), /^╭.*working/);
		assert.equal(hardware, true);
		const mounted = host.editor;
		handle.cleanup();
		assert.equal(factoryCalls, 7);
		assert.equal(ui.getEditorComponent(), upstream);
		assert.equal(editorContainer.addChild, originalAddChild);
		assert.doesNotMatch(stripAnsi(mounted.render(60)[0]!), /^╭/);
		assert.doesNotMatch(stripAnsi(host.editor.render(60)[0]!), /^╭/);
		assert.equal(host.statusContainer.children.length, 1);
		assert.equal(hardware, false);
		shortcutUi!.setEditorComponent(upstream);
		assert.doesNotMatch(stripAnsi(host.editor.render(60)[0]!), /^╭/);
	} finally {
		handle.cleanup();
	}
});

test("keeps reused editors framed and restores working status after fresh-context registrations", async () => {
	const { InteractiveMode } = await import(new URL(
		"./modes/interactive/interactive-mode.js",
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	).href);
	for (const resetRender of [false, true]) {
		const editorContainer = new Container();
		const hostTui = {
			...tui,
			children: [editorContainer],
			getShowHardwareCursor: () => false,
			setShowHardwareCursor() {},
			setFocus(component: CustomEditor) { component.focused = true; },
		} as unknown as TUI;
		const keybindings = { matches: () => false } as unknown as KeybindingsManager;
		const defaultEditor = new CustomEditor(hostTui, editorTheme, keybindings);
		defaultEditor.onSubmit = () => {};
		defaultEditor.onChange = () => {};
		const indicator = { renderInBorder: () => "working", renderSpinnerInBorder: () => "*" };
		const host = Object.create(InteractiveMode.prototype, Object.fromEntries(Object.entries({
			ui: hostTui, keybindings, defaultEditor, editor: defaultEditor, editorContainer,
			statusContainer: new Container(), activeStatusIndicator: indicator,
			disposeActiveSelector() {},
		}).map(([key, value]) => [key, { value, writable: true, configurable: true }])));
		const ui = host.createExtensionUIContext();
		const handle = installEditor({} as ExtensionAPI, { ui } as ExtensionContext, "block", {
			enabled: () => true,
			render: () => ({ top: { left: "branch", right: "" }, bottom: { left: "model", right: "" } }),
		});
		try {
			const inner = new CustomEditor(hostTui, editorTheme, keybindings);
			const render = inner.render.bind(inner);
			let calls = 0;
			const upstream: EditorFactory = () => {
				calls++;
				if (resetRender) inner.render = (width) => render(width);
				return inner;
			};
			ui.setEditorComponent(upstream);
			const freshUi = host.createExtensionUIContext();
			const latest: EditorFactory = (...args) => upstream(...args);
			for (const next of [upstream, upstream, latest]) {
				const before = calls;
				freshUi.setEditorComponent(next);
				assert.equal(calls, before + 1, "mounting must not call the factory again");
				assert.equal(host.editor, inner);
				assert.equal(handle.isFramed(), true);
				const lines = stripAnsi(inner.render(60).join("\n"));
				assert.equal(lines.match(/╭/g)?.length, 1);
				assert.match(lines, /╭.*working.*branch/);
				assert.match(lines, /model/);
			}

			const dialog = new CustomEditor(hostTui, editorTheme, keybindings);
			editorContainer.clear();
			editorContainer.addChild(dialog);
			assert.doesNotMatch(stripAnsi(dialog.render(60)[0]!), /^╭/);
			editorContainer.clear();
			editorContainer.addChild(inner);
			assert.match(stripAnsi(inner.render(60)[0]!), /^╭.*working/);

			handle.cleanup();
			assert.equal(freshUi.getEditorComponent(), latest);
			assert.equal(host.editor, inner);
			assert.equal(inner.embedWorkingStatus, false);
			assert.equal(host.activeWorkingIndicatorEmbedded, false);
			assert.deepEqual(host.statusContainer.children, [indicator]);
			assert.doesNotMatch(stripAnsi(inner.render(60)[0]!), /^╭/);
		} finally {
			handle.cleanup();
		}
	}
});

test("keeps factory composition outside the frame without recursion or duplicated borders", () => {
	const host = createEditorHost();
	const handle = installEditor({} as ExtensionAPI, host.ctx);
	let calls = 0;
	const upstream: EditorFactory = () => { calls++; return createInnerEditor(); };
	host.ctx.ui.setEditorComponent(upstream);
	const previous = host.ctx.ui.getEditorComponent()!;
	assert.equal(previous, upstream);
	let widthSeen = 0;
	const wrapped: EditorFactory = (...args) => {
		const editor = previous(...args);
		const render = editor.render.bind(editor);
		editor.render = (width) => { widthSeen = width; return render(width); };
		return editor;
	};
	calls = 0;
	host.ctx.ui.setEditorComponent(wrapped);
	assert.equal(calls, 1);
	assert.equal(host.ctx.ui.getEditorComponent(), wrapped);
	const lines = stripAnsi(host.editor.render(40).join("\n"));
	assert.equal(lines.match(/╭/g)?.length, 1);
	assert.equal(widthSeen, 36);
	handle.cleanup();
	assert.equal(host.ctx.ui.getEditorComponent(), wrapped);
	host.editor.render(40);
	assert.equal(widthSeen, 40);
});

test("tracks runtime replacement, clearing and unframed editors", () => {
	let hardware = false;
	const hostTui = {
		...tui, terminal: { rows: 24, write() {} },
		getShowHardwareCursor: () => hardware,
		setShowHardwareCursor: (value: boolean) => { hardware = value; },
	} as unknown as TUI;
	const host = createEditorHost(undefined, hostTui);
	const handle = installEditor({} as ExtensionAPI, host.ctx, "bar");
	assert.equal(hardware, true);
	const first = createInnerEditor();
	host.ctx.ui.setEditorComponent(() => first);
	assert.equal(handle.isFramed(), true);
	const custom: EditorComponent = { render: () => ["custom"], invalidate() {}, getText: () => "", setText() {}, handleInput() {} };
	host.ctx.ui.setEditorComponent(() => custom);
	assert.equal(handle.isFramed(), false);
	assert.equal(host.editor, custom);
	assert.equal(hardware, false);
	assert.doesNotMatch(stripAnsi(first.render(40)[0]!), /^╭/);

	host.ctx.ui.setEditorComponent(undefined);
	assert.equal(host.ctx.ui.getEditorComponent(), undefined);
	assert.equal(handle.isFramed(), true);
	assert.equal(hardware, true);
	assert.match(stripAnsi(host.editor.render(40)[0]!), /^╭/);
	const latest = () => createInnerEditor();
	host.ctx.ui.setEditorComponent(latest);
	handle.cleanup();
	assert.equal(host.ctx.ui.getEditorComponent(), latest);
	assert.equal(hardware, false);
});

test("saved registration proxies pass through after cleanup and later API wrappers survive", () => {
	const host = createEditorHost(createInnerEditor);
	const handle = installEditor({} as ExtensionAPI, host.ctx);
	const get = host.ctx.ui.getEditorComponent;
	const set = host.ctx.ui.setEditorComponent;
	const laterGet = () => get();
	const laterSet: typeof set = (next) => set(next);
	host.ctx.ui.getEditorComponent = laterGet;
	host.ctx.ui.setEditorComponent = laterSet;
	handle.cleanup();
	assert.equal(host.ctx.ui.getEditorComponent, laterGet);
	assert.equal(host.ctx.ui.setEditorComponent, laterSet);
	const next = createInnerEditor;
	laterSet(next);
	assert.equal(laterGet(), next);
	assert.doesNotMatch(stripAnsi(host.editor.render(40)[0]!), /^╭/);

	const reinstalled = installEditor({} as ExtensionAPI, host.ctx);
	assert.match(stripAnsi(host.editor.render(40)[0]!), /^╭/);
	reinstalled.cleanup();
	assert.equal(host.ctx.ui.getEditorComponent, laterGet);
	assert.equal(host.ctx.ui.setEditorComponent, laterSet);
	assert.doesNotMatch(stripAnsi(host.editor.render(40)[0]!), /^╭/);
});

test("falls back to the default editor when the previous factory throws", () => {
	const host = createEditorHost(() => { throw new Error("broken editor"); });
	const handle = installEditor({} as ExtensionAPI, host.ctx);
	assert.match(stripAnsi(host.editor.render(40)[0] ?? ""), /^╭/);
	handle.cleanup();
	assert.equal(host.ctx.ui.getEditorComponent(), undefined);
});

test("cleanup preserves later method and factory wrappers as passthroughs", () => {
	const inner = createInnerEditor();
	let received: TuiMouseEvent | undefined;
	inner.handleMouse = (event) => { received = event; return undefined; };
	const host = createEditorHost(() => inner);
	const handle = installEditor({} as ExtensionAPI, host.ctx);
	const inherited = host.ctx.ui.getEditorComponent()!;
	const render = CustomEditor.prototype.render.bind(inner);
	const laterFactory: EditorFactory = (...args) => {
		const editor = inherited(...args);
		editor.render = (width) => [...render(width), "later wrapper"];
		return editor;
	};
	host.ctx.ui.setEditorComponent(laterFactory);
	const mouse = inner.handleMouse.bind(inner);
	const padding = inner.setPaddingX.bind(inner);
	inner.handleMouse = (event) => mouse(event);
	inner.setPaddingX = (value) => padding(value);

	handle.cleanup();
	handle.cleanup();
	assert.equal(host.ctx.ui.getEditorComponent(), laterFactory);
	assert.doesNotMatch(stripAnsi(inner.render(40)[0] ?? ""), /^╭/);
	assert.equal(inner.render(40).at(-1), "later wrapper");
	inner.handleMouse(mouseClick);
	assert.deepEqual(received, mouseClick);
	inner.setPaddingX(3);
	assert.equal(inner.getPaddingX(), 3);

	// 后续扩展再次调用已卸载的工厂，也不会重新启用边框。
	host.ctx.ui.setEditorComponent(laterFactory);
	assert.doesNotMatch(stripAnsi(host.editor.render(40)[0] ?? ""), /^╭/);
});

test("cleanup forwards captured cursor-style wrappers to the original editor method", () => {
	const calls: Array<[string, boolean | undefined]> = [];
	const inner = Object.assign(createInnerEditor(), {
		setCursorStyle(style: string, hardware?: boolean) { calls.push([style, hardware]); },
	});
	const host = createEditorHost(() => inner);
	const handle = installEditor({} as ExtensionAPI, host.ctx);
	try {
		const cursor = inner.setCursorStyle.bind(inner);
		inner.setCursorStyle = (style, hardware) => cursor(style, hardware);
		inner.setCursorStyle("block", true);
		assert.deepEqual(calls, [], "open-tui owns cursor styling while active");
		handle.cleanup();
		inner.setCursorStyle("underline", true);
		assert.deepEqual(calls, [["underline", true]]);
	} finally {
		handle.cleanup();
	}
});

test("cleanup does not reinstall an editor after another extension resets the slot", () => {
	const host = createEditorHost(createInnerEditor);
	const handle = installEditor({} as ExtensionAPI, host.ctx);
	host.ctx.ui.setEditorComponent(undefined);
	handle.cleanup();
	assert.equal(host.ctx.ui.getEditorComponent(), undefined);
});

test("leaves custom layouts, mouse coordinates, padding and status capabilities intact", () => {
	const widths: number[] = [];
	let received: TuiMouseEvent | undefined;
	let padding = 0;
	const custom = {
		render: (width: number) => { widths.push(width); return [`custom ${width}`]; },
		invalidate() {}, getText: () => "", setText() {}, handleInput() {},
		handleMouse(event: TuiMouseEvent) { received = event; return undefined; },
		setPaddingX(value: number) { padding = value; },
	};
	const render = custom.render;
	const host = createEditorHost(() => custom);
	const handle = installEditor({} as ExtensionAPI, host.ctx, "bar");
	assert.equal(host.editor, custom);
	assert.equal(handle.isFramed(), false);
	assert.equal(custom.render, render);
	assert.equal("embedWorkingStatus" in custom, false);
	assert.deepEqual(custom.render(40), ["custom 40"]);
	assert.deepEqual(widths, [40]);
	custom.handleMouse(mouseClick);
	assert.deepEqual(received, mouseClick);
	assert.equal(padding, 2);
	handle.cleanup();
});

test("keeps ghost text rendered by an inner editor wrapper", () => {
	const inner = new CustomEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		{ paddingX: 0 },
	);
	// next-prompt-style wrapper: patch the render output, keep the instance.
	const innerRender = inner.render.bind(inner);
	inner.render = (width: number) => {
		const lines = innerRender(width);
		const line = lines[1] ?? "";
		lines[1] = line.replace(/ {3,}$/, " try this next");
		return lines;
	};

	const decorated = decorateOpenTuiEditor(inner, tui);
	const body = stripAnsi(decorated.render(60)[1] ?? "");

	assert.match(body, /try this next/);
	assert.ok(body.startsWith("│ ") && body.endsWith(" │"), `ghost line keeps its rails: ${body}`);
	assert.equal(visibleWidth(body), 60);
});

test("decorating the same instance twice keeps one frame", () => {
	const editor = createOpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);

	const decorated = decorateOpenTuiEditor(editor, tui);
	const lines = stripAnsi(decorated.render(40).join("\n"));

	assert.equal(decorated, editor);
	assert.equal(lines.match(/╭/g)?.length, 1);
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
	const host = createEditorHost(undefined, hardwareTui);
	const editor = installEditor({} as ExtensionAPI, host.ctx, "bar");
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
	const editor = createOpenTuiEditor(
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
	const editor = createOpenTuiEditor(
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
		editor.render(40).every((line) => !line.includes("\x1b_pi:fc")),
		"software cursor stays stripped",
	);
	hostTui.stop();
});

function createHeader(accent = "\x1b[35m"): OpenTuiHeader {
	return new OpenTuiHeader(
		{
			getCommands: () => [],
			getThinkingLevel: () => "off",
		} as unknown as ExtensionAPI,
		{
			cwd: process.cwd(),
			ui: {
				theme: {
					fg: (color: string, text: string) => color === "accent" ? `${accent}${text}\x1b[39m` : text,
					bold: (text: string) => text,
				},
			},
		} as unknown as ExtensionContext,
		tui,
	);
}

test("clips the compact header to every narrow viewport width", () => {
	const header = createHeader();
	for (let width = 0; width < 24; width++) {
		const lines = header.render(width);
		assert.equal(lines.length, 1);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `header width ${width}`);
		assert.equal(stripAnsi(lines[0] ?? ""), `Pi v${VERSION}`.slice(0, width));
	}
});

test("keeps the static seven-row logo shape, spacing, and per-cell theme coloring", () => {
	const logo = [
		"            ",
		"            ",
		"█████████   ",
		"███   ███   ",
		"██████   ███",
		"███      ███",
		"            ",
	];
	for (const accent of ["\x1b[35m", "\x1b[36m"]) {
		const header = createHeader(accent);
		const paint = (text: string) => `${accent}${text}\x1b[39m`;
		const expected = logo.map((line) =>
			`${paint("│")}${" ".repeat(13)}${line.replace(/███/g, paint)}${" ".repeat(13)}${paint("│")}`,
		);
		assert.deepEqual(header.render(40).slice(1, 8), expected);
		header.invalidate();
		assert.deepEqual(header.render(40).slice(1, 8), expected);
	}
});

function fakeTtyStream(written: string[], isTTY = true) {
	const write = (chunk: string, ...rest: unknown[]) => {
		written.push(chunk);
		const callback = rest.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
		setImmediate(() => callback?.(chunk === "fail" ? new Error("closed") : null));
		return false;
	};
	return { stream: { isTTY, write } as unknown as NodeJS.WriteStream, write };
}

const flushImmediates = () => new Promise((resolve) => setImmediate(resolve));

test("repaints after each raw TTY write without changing the write contract", async () => {
	const written: string[] = [];
	const { stream } = fakeTtyStream(written);
	let repaints = 0;
	repaintAfterStreamWrites(() => repaints++, stream);

	const errors: (Error | null | undefined)[] = [];
	assert.equal(stream.write("plain\n"), false, "return value passes through");
	stream.write("encoded\n", "utf8", (error) => errors.push(error));
	stream.write("fail", (error) => errors.push(error));
	assert.equal(repaints, 0, "repaint waits for the write to finish");
	await flushImmediates();

	assert.deepEqual(written, ["plain\n", "encoded\n", "fail"]);
	assert.equal(repaints, 3);
	assert.equal(errors[0], null);
	assert.equal(errors[1]?.message, "closed");

	const throwing = fakeTtyStream([]).stream;
	repaintAfterStreamWrites(() => {
		throw new Error("render failed");
	}, throwing);
	let called = false;
	throwing.write("x", () => {
		called = true;
	});
	await flushImmediates();
	assert.equal(called, true, "a failed repaint still runs the caller callback");
});

test("stream restore stops repaints and keeps later wrappers", async () => {
	const written: string[] = [];
	const { stream, write: originalWrite } = fakeTtyStream(written);
	let repaints = 0;

	const restore = repaintAfterStreamWrites(() => repaints++, stream);
	stream.write("pending");
	restore();
	assert.equal(stream.write, originalWrite as unknown, "restores the original write");
	await flushImmediates();
	assert.equal(repaints, 0, "a write pending at cleanup does not repaint");

	const restoreAgain = repaintAfterStreamWrites(() => repaints++, stream);
	const ours = stream.write as unknown as (...args: unknown[]) => boolean;
	const outer = ((...args: unknown[]) => ours(...args)) as typeof stream.write;
	stream.write = outer;
	restoreAgain();
	assert.equal(stream.write, outer, "keeps a later wrapper in place");
	stream.write("through outer");
	await flushImmediates();
	assert.equal(written.at(-1), "through outer");
	assert.equal(repaints, 0, "the disabled wrapper only passes writes through");

	const pipe = fakeTtyStream([], false);
	repaintAfterStreamWrites(() => repaints++, pipe.stream);
	assert.equal(pipe.stream.write, pipe.write as unknown, "non-TTY streams are left alone");
});
