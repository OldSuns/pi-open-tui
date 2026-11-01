import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type OpenTuiConfig } from "../extensions/open-tui/config.ts";
import { installEditor } from "../extensions/open-tui/editor.ts";
import openTui, { getPendingUiChange } from "../extensions/open-tui/index.ts";
import { registerSettingsCommand } from "../extensions/open-tui/settings-command.ts";

interface SettingsComponent extends Component {
	handleInput(data: string): void;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

async function openSettings(
	initialConfig = structuredClone(DEFAULT_CONFIG),
	onChange?: (config: OpenTuiConfig) => void,
): Promise<{
	component: SettingsComponent;
	terminal: { columns: number; rows: number };
	getConfig: () => OpenTuiConfig;
	isClosed: () => boolean;
	isOverlayClosed: () => boolean;
	waitForClose: () => Promise<void>;
}> {
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let component: SettingsComponent | undefined;
	let config = initialConfig;
	let closed = false;
	let overlayClosed = false;

	const pi = {
		registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
			commandHandler = options.handler;
		},
	} as unknown as ExtensionAPI;

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (nextConfig) => {
			config = nextConfig;
			onChange?.(nextConfig);
		},
		onOverlayClosed: () => {
			overlayClosed = true;
		},
	});

	const terminal = { columns: 80, rows: 24 };
	const tui = { terminal, requestRender() {} } as TUI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: void) => void,
				) => Component,
			) => new Promise<void>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, (_value: void) => {
					closed = true;
					resolve();
				}) as SettingsComponent;
			}),
		},
	} as unknown as ExtensionContext;

	assert.ok(commandHandler);
	const closePromise = Promise.resolve(commandHandler("", ctx));
	assert.ok(component);

	return {
		component,
		terminal,
		getConfig: () => config,
		isClosed: () => closed,
		isOverlayClosed: () => overlayClosed,
		waitForClose: () => closePromise,
	};
}

function selectedLine(component: SettingsComponent, width = 80): string {
	return component.render(width).find((line) => line.includes("→ ")) ?? "";
}

test("reports whether configuration was saved", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "open-tui-save-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const config = structuredClone(DEFAULT_CONFIG);
		config.header = false;
		assert.equal(saveConfig(config), true);
		assert.equal(loadConfig().header, false);

		const configPath = join(agentDir, "open-tui.json");
		rmSync(configPath);
		mkdirSync(configPath);
		assert.equal(saveConfig(config), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("closes cleanly after enabling or disabling the UI", async () => {
	for (const enabled of [true, false]) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.enabled = enabled;
		const settings = await openSettings(config);

		settings.component.handleInput("\r");
		assert.equal(settings.getConfig().enabled, !enabled);
		assert.equal(settings.isClosed(), false);
		assert.equal(settings.isOverlayClosed(), false);

		settings.component.handleInput("q");
		assert.equal(settings.isClosed(), true);
		assert.equal(settings.isOverlayClosed(), false);
		await settings.waitForClose();
		assert.equal(settings.isOverlayClosed(), true);
	}
});

test("leaves fullscreen wheel speed to Pi settings", async () => {
	const settings = await openSettings();
	assert.doesNotMatch(settings.component.render(80).join("\n"), /wheel speed/i);
	assert.equal("fullscreen" in settings.getConfig(), false);
});

test("previews cursor styles from the Appearance tab", async () => {
	const writes: string[] = [];
	let editorInstalls = 0;
	let editorFactory: unknown;
	let hardwareCursor = false;
	const editorTui = {
		terminal: { columns: 80, rows: 24, write: (data: string) => writes.push(data) },
		requestRender() {},
		getShowHardwareCursor: () => hardwareCursor,
		setShowHardwareCursor: (enabled: boolean) => {
			hardwareCursor = enabled;
		},
	} as unknown as TUI;
	const editor = installEditor({} as ExtensionAPI, {
		ui: {
			getEditorComponent: () => editorFactory,
			setEditorComponent: (factory: unknown) => {
				editorFactory = factory;
				editorInstalls++;
				if (typeof factory === "function") {
					factory(editorTui, {
						borderColor: (text: string) => text,
						selectList: {},
					}, { matches: () => false });
				}
			},
		},
	} as unknown as ExtensionContext);
	const settings = await openSettings(undefined, (config) => editor.setCursorStyle(config.cursorStyle));

	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");

	assert.equal(settings.getConfig().cursorStyle, "bar");
	assert.equal(settings.isClosed(), false);
	assert.equal(editorInstalls, 1);
	assert.equal(hardwareCursor, true);
	assert.ok(writes.includes("\x1b[6 q"));

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().cursorStyle, "underline");
	assert.ok(writes.includes("\x1b[4 q"));

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().cursorStyle, "block");
	assert.equal(hardwareCursor, false);
	assert.ok(writes.includes("\x1b[0 q"));
	assert.equal(editorInstalls, 1);
	assert.match(selectedLine(settings.component), /Cursor style/);
	assert.match(settings.component.render(80).join("\n"), /\[Appearance\].*Icon mode.*Cursor style/s);

	settings.component.handleInput("q");
	await settings.waitForClose();
	assert.equal(settings.isOverlayClosed(), true);
	editor.cleanup();
});

test("reconciles enabled changes with the installed UI", () => {
	assert.equal(getPendingUiChange(true, false), "install");
	assert.equal(getPendingUiChange(false, true), "uninstall");
	assert.equal(getPendingUiChange(true, true), undefined);
	assert.equal(getPendingUiChange(false, false), undefined);
});

test("keeps the changed setting selected", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Git branch/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().footerSegments.gitBranch, false);
	assert.match(selectedLine(settings.component), /Git branch/);
});

test("remembers the selection for each tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");

	assert.match(selectedLine(settings.component), /Git branch/);
});

test("toggles live TPS from the Footer tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	for (let i = 0; i < 10; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Live TPS/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().footerSegments.liveTps, false);
	assert.equal(settings.getConfig().telemetry.tps, true);
});

test("configures telemetry from its own tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	assert.match(selectedLine(settings.component), /Enabled/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().telemetry.enabled, false);
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().telemetry.tps, false);
});

test("supports localized settings and keyboard shortcuts", async () => {
	const settings = await openSettings();
	assert.match(settings.component.render(80).join("\n"), /Open TUI Settings.*General.*Language/s);

	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().settingsLanguage, "zh");
	assert.match(settings.component.render(80).join("\n"), /Open TUI 设置.*常规.*语言.*简体中文/s);
	assert.match(selectedLine(settings.component), /语言/);

	const reopened = await openSettings(structuredClone(settings.getConfig()));
	assert.match(reopened.component.render(80).join("\n"), /Open TUI 设置.*简体中文/s);

	reopened.component.handleInput("\x1b[B");
	reopened.component.handleInput("\x1b[B");
	reopened.component.handleInput("\x1b[C");
	assert.match(reopened.component.render(80).join("\n"), /\[外观\].*图标模式.*光标样式/s);
	reopened.component.handleInput("\x1b[D");
	assert.match(selectedLine(reopened.component), /语言/);
	reopened.component.handleInput("q");
	assert.equal(reopened.isClosed(), true);
});

test("configures inline footer from General settings", async () => {
	const settings = await openSettings();
	// Enabled → Header → Language → Thinking peek → Footer in editor border
	for (let i = 0; i < 4; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Footer in editor border/);
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().inlineFooter, true);
});

test("toggles copy buttons from General settings", async () => {
	const settings = await openSettings();
	assert.equal(settings.getConfig().copyButtons, true);
	// Enabled → Header → Language → Thinking peek → Footer in editor border → Copy buttons
	for (let i = 0; i < 5; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Copy buttons/);
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().copyButtons, false);
});

test("toggles the header without resetting a disabled slot and warns when persistence fails", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ ...DEFAULT_CONFIG, header: false }));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		let command: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
		let settings: SettingsComponent | undefined;
		const headers: unknown[] = [];
		let editorFactory: unknown;
		const notifications: Array<{ message: string; level: string }> = [];
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
			registerCommand: (_name: string, options: { handler: typeof command }) => (command = options.handler),
			registerToolRenderer() {},
			registerMarkdownTransformer() {},
		} as unknown as ExtensionAPI;
		const ctx = {
			hasUI: true,
			mode: "tui",
			// Git/runtime probes spawn in cwd; keeping them out of agentDir lets Windows delete it.
			cwd: process.cwd(),
			ui: {
				setFooter() {},
				getEditorComponent: () => editorFactory,
				setEditorComponent(factory: unknown) { editorFactory = factory; },
				setHeader: (factory: unknown) => headers.push(factory),
				notify: (message: string, level: string) => notifications.push({ message, level }),
				custom: (factory: (tui: TUI, theme: Theme) => SettingsComponent) =>
					void (settings = factory({ terminal: { columns: 80, rows: 24 }, requestRender() {} } as TUI, theme)),
			},
		} as unknown as ExtensionContext;

		openTui(pi);
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		assert.deepEqual(headers, [], "a disabled header must not reset another extension's header");

		void command?.("", ctx);
		assert.ok(settings);
		settings.handleInput("\x1b[B");
		assert.match(selectedLine(settings), /Override header/);
		settings.handleInput(" ");
		assert.equal(notifications.length, 0);
		rmSync(join(agentDir, "open-tui.json"));
		mkdirSync(join(agentDir, "open-tui.json"));
		settings.handleInput(" ");
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.level, "warning");
		assert.match(notifications[0]?.message ?? "", /apply for this session but could not be saved/);
		assert.equal(typeof headers[0], "function");
		assert.deepEqual(headers.slice(1), [undefined], "disabling restores Pi's built-in header once");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("configures the hostname footer segment", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Hostname/);

	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footerSegments.hostname, true);
	assert.match(selectedLine(settings.component), /Hostname/);
});

test("configures the extension status line with Space", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[C");
	for (let i = 0; i < 11; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Extension status line/);

	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footerSegments.extensionStatuses, false);
	assert.match(selectedLine(settings.component), /Extension status line/);
});

test("keeps localized settings and values within narrow widths", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	config.settingsLanguage = "zh";
	const settings = await openSettings(config);

	for (const width of [24, 36, 48]) {
		const lines = settings.component.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
		}
		const output = lines.join("\n");
		assert.match(output, /开启/);
		assert.match(output, /简体中文/);
	}
});

test("keeps every Footer selection visible in short terminals", async () => {
	for (const language of ["en", "zh"] as const) {
		for (const width of [24, 36, 48, 80]) {
			const config = structuredClone(DEFAULT_CONFIG);
			config.settingsLanguage = language;
			const settings = await openSettings(config);
			settings.terminal.columns = width;
			settings.terminal.rows = 12;
			settings.component.handleInput("\t");
			settings.component.handleInput("\t");
			for (let i = 0; i < 14; i++) {
				const lines = settings.component.render(width);
				assert.ok(lines.length <= 12, `${language} ${width}x12: ${lines.length} rows`);
				assert.ok(lines.slice(0, 12).some((line) => line.includes("→ ")));
				for (const line of lines) assert.ok(visibleWidth(line) <= width);
				settings.component.handleInput("\x1b[B");
			}
		}
	}
});

test("relayouts on height and width changes without losing the selection", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	for (let i = 0; i < 12; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Capitalize provider name/);

	for (const [width, rows] of [[80, 12], [80, 24], [48, 12], [24, 12], [36, 12], [80, 24]] as const) {
		settings.terminal.columns = width;
		settings.terminal.rows = rows;
		const lines = settings.component.render(width);
		assert.ok(lines.length <= rows, `${width}x${rows}: ${lines.length} rows`);
		assert.match(lines.join("\n"), /→ .*On/);
	}
	assert.match(selectedLine(settings.component), /Capitalize provider name/);
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footerSegments.capitalizeProviderName, false);
});

test("preserves long Footer labels' current values at narrow widths", async () => {
	for (const language of ["en", "zh"] as const) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.settingsLanguage = language;
		const settings = await openSettings(config);
		settings.component.handleInput("\t");
		settings.component.handleInput("\t");
		for (let i = 0; i < 11; i++) settings.component.handleInput("\x1b[B");
		for (const id of ["extensionStatuses", "capitalizeProviderName", "nerdIconSpacing"] as const) {
			for (const toggle of [false, true]) {
				if (toggle) settings.component.handleInput(" ");
				const enabled = settings.getConfig().footerSegments[id];
				const value = language === "en" ? (enabled ? "On" : "Off") : (enabled ? "开启" : "关闭");
				for (const width of [24, 36, 48, 60]) {
					const line = selectedLine(settings.component, width);
					assert.ok(line.trimEnd().endsWith(`: ${value}`), line);
					assert.ok(visibleWidth(line) <= width);
				}
			}
			settings.component.handleInput("\x1b[B");
		}
	}
});

test("normalizes invalid settings values", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({
			settingsLanguage: "de",
			cursorStyle: "invalid",
			header: "no",
			inlineFooter: "yes",
			copyButtons: "no",
			thinkingPeek: { lines: 9 },
			toolView: { mode: "hidden" },
			fullscreen: { wheelScrollLines: 10 },
		}), "utf8");
		const loaded = loadConfig();
		assert.equal(loaded.settingsLanguage, "en");
		assert.equal(loaded.cursorStyle, "block");
		assert.equal(loaded.header, true);
		assert.equal(loaded.inlineFooter, false);
		assert.equal(loaded.copyButtons, true);
		assert.equal(loaded.thinkingPeek.lines, 1);
		assert.equal(loaded.toolView.mode, "native");
		assert.equal("fullscreen" in loaded, true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("cycles the thinking peek line count from General settings", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	const settings = await openSettings(config);
	// Enabled → Header → Language → Thinking peek
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Thinking peek/);
	assert.match(selectedLine(settings.component), /1 line/);
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().thinkingPeek.lines, 2);
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().thinkingPeek.lines, 0);
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().thinkingPeek.lines, 1);
	settings.component.handleInput("q");
});
