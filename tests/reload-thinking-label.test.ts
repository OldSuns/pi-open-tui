import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import openTui from "../extensions/open-tui/index.ts";
import { preserveEnvironment, temporaryDirectory } from "./fixtures/test-helpers.ts";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

/** Minimal stand-in for Pi's AssistantMessageComponent. */
function createAssistantComponent(isStreaming = false) {
	const labels: string[] = [];
	return {
		children: [] as unknown[],
		isStreaming,
		labels,
		render(width: number): string[] {
			return [`${width}`];
		},
		setHiddenThinkingLabel(label: string): void {
			labels.push(label);
		},
		setHideThinkingBlock(): void {},
		updateContent(): void {},
	};
}

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

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function createHarness(t: Parameters<typeof temporaryDirectory>[0]) {
	const agentDir = temporaryDirectory(t, "pi-open-tui-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ ...DEFAULT_CONFIG, icons: { mode: "unicode" } }));

	const finished = createAssistantComponent();
	const streaming = createAssistantComponent(true);
	const hostTui = {
		terminal: { columns: 80, rows: 24 },
		requestRender() {},
		invalidate() {},
		children: [finished, streaming],
	} as unknown as TUI;

	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		events: createEventBus(),
		registerCommand() {},
		registerToolRenderer() {},
		registerMarkdownTransformer() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;

	let editorFactory: EditorFactory | undefined;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		ui: {
			theme,
			setFooter() {},
			setHeader() {},
			notify() {},
			setHiddenThinkingLabel() {},
			getEditorComponent: () => editorFactory,
			// Pi builds the editor through the factory; the extension mounts on it.
			setEditorComponent(factory: EditorFactory | undefined) {
				editorFactory = factory;
				factory?.(hostTui, editorTheme, { matches: () => false } as unknown as KeybindingsManager);
			},
		},
	} as unknown as ExtensionContext;

	openTui(pi);
	return { handlers, ctx, finished, streaming };
}

test("re-applies the finished thinking label to the messages a reload rebuilt", async (t) => {
	const { handlers, ctx, finished, streaming } = createHarness(t);

	await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
	finished.render(40);
	streaming.render(40);

	assert.deepEqual(finished.labels, ["💡 think ✓"]);
	assert.deepEqual(streaming.labels, []);
});

test("keeps Pi's native label when the session did not reload", async (t) => {
	const { handlers, ctx, finished } = createHarness(t);

	await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	finished.render(40);

	assert.deepEqual(finished.labels, []);
});
