import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	TuiAltScreen,
	type EditorTheme,
	type KeybindingsManager,
	type Terminal,
	type TUI,
} from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig } from "../extensions/open-tui/config.ts";
import { installEditor } from "../extensions/open-tui/editor.ts";
import {
	applyFullscreenWheelScrollLines,
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	MAX_FULLSCREEN_WHEEL_SCROLL_LINES,
	MIN_FULLSCREEN_WHEEL_SCROLL_LINES,
	normalizeFullscreenWheelScrollLines,
} from "../extensions/open-tui/fullscreen-scroll.ts";

const editorTheme = {
	borderColor: (text: string) => text,
	selectList: {},
} as EditorTheme;

test("defaults and normalizes fullscreen mouse wheel speed", () => {
	assert.equal(DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES, 4);
	assert.equal(DEFAULT_CONFIG.fullscreen.wheelScrollLines, 4);
	assert.equal(normalizeFullscreenWheelScrollLines(0), MIN_FULLSCREEN_WHEEL_SCROLL_LINES);
	assert.equal(normalizeFullscreenWheelScrollLines(3.9), 3);
	assert.equal(normalizeFullscreenWheelScrollLines(100), MAX_FULLSCREEN_WHEEL_SCROLL_LINES);
	assert.equal(normalizeFullscreenWheelScrollLines("fast"), DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES);
	assert.equal(normalizeFullscreenWheelScrollLines(Number.NaN), DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES);
});

test("loads old configs and normalizes persisted fullscreen values", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-fullscreen-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const configPath = join(agentDir, "open-tui.json");
		writeFileSync(configPath, JSON.stringify({ enabled: false }), "utf8");
		assert.equal(loadConfig().fullscreen.wheelScrollLines, 4);

		writeFileSync(configPath, JSON.stringify({ fullscreen: { wheelScrollLines: 12.8 } }), "utf8");
		assert.equal(loadConfig().fullscreen.wheelScrollLines, 10);

		writeFileSync(configPath, JSON.stringify({ fullscreen: { wheelScrollLines: "fast" } }), "utf8");
		assert.equal(loadConfig().fullscreen.wheelScrollLines, 4);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("applies speed only to compatible fullscreen TUI instances", () => {
	const fullscreen = new TuiAltScreen({} as unknown as Terminal);
	assert.equal(applyFullscreenWheelScrollLines(fullscreen, 6), true);
	assert.equal((fullscreen as unknown as { wheelScrollLines: number }).wheelScrollLines, 6);

	const regular = { mode: "regular", wheelScrollLines: 1 } as unknown as TUI;
	assert.equal(applyFullscreenWheelScrollLines(regular, 6), false);
	assert.equal((regular as unknown as { wheelScrollLines: number }).wheelScrollLines, 1);

	const missingField = { mode: "fullscreen" } as unknown as TUI;
	assert.equal(applyFullscreenWheelScrollLines(missingField, 6), false);
	assert.equal("wheelScrollLines" in missingField, false);
});

test("silently ignores a fullscreen speed field that becomes read-only", () => {
	const tui = { mode: "fullscreen" };
	Object.defineProperty(tui, "wheelScrollLines", { value: 1, writable: false });

	assert.doesNotThrow(() => applyFullscreenWheelScrollLines(tui as unknown as TUI, 6));
	assert.equal(applyFullscreenWheelScrollLines(tui as unknown as TUI, 6), false);
	assert.equal((tui as unknown as { wheelScrollLines: number }).wheelScrollLines, 1);
});

test("applies fullscreen speed on editor mount and updates it without reinstalling", () => {
	let editorInstalls = 0;
	let hardwareCursor = false;
	const tui = {
		mode: "fullscreen",
		wheelScrollLines: 1,
		terminal: { rows: 24, write() {} },
		requestRender() {},
		getShowHardwareCursor: () => hardwareCursor,
		setShowHardwareCursor: (enabled: boolean) => {
			hardwareCursor = enabled;
		},
	} as unknown as TUI;
	const ctx = {
		ui: {
			setEditorComponent: (factory: unknown) => {
				if (typeof factory !== "function") return;
				editorInstalls++;
				factory(tui, editorTheme, { matches: () => false } as unknown as KeybindingsManager);
			},
		},
	} as unknown as ExtensionContext;

	const editor = installEditor({} as ExtensionAPI, ctx, "block", 6);
	assert.equal((tui as unknown as { wheelScrollLines: number }).wheelScrollLines, 6);

	editor.setWheelScrollLines(9);
	assert.equal((tui as unknown as { wheelScrollLines: number }).wheelScrollLines, 9);
	assert.equal(editorInstalls, 1);
	editor.cleanup();
});
