import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { resolveGlyphs } from "../extensions/open-tui/icons.ts";
import openTui from "../extensions/open-tui/index.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

const glyphs = resolveGlyphs("ascii");

const FIRST_THOUGHT = "first thought";
const SECOND_THOUGHT = "second thought";

function thinkingMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: text }],
	} as unknown as AssistantMessage;
}

/**
 * Pi applies the hidden-thinking label to every assistant message at once, so a global
 * reset also touches messages that already finished. The harness mirrors that behaviour.
 */
function createHarness() {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => void | Promise<void>>>();
	const globalLabelUpdates: Array<string | undefined> = [];
	const components: AssistantMessageComponent[] = [];
	const tui = {
		mode: "fullscreen",
		terminal: { columns: 120, rows: 24, write() {} },
		children: [{ children: components }],
		getShowHardwareCursor: () => false,
		setShowHardwareCursor() {},
		invalidate() {},
		requestRender() {},
	};
	const pi = {
		on(event: string, handler: (event: any, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		registerToolRenderer() {},
		registerMarkdownTransformer() {},
		events: createEventBus(),
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	let editorFactory: unknown;
	const ctx = {
		hasUI: true,
		mode: "tui",
		isIdle: () => false,
		cwd: process.cwd(),
		ui: {
			theme,
			notify() {},
			setHeader() {},
			setFooter() {},
			getEditorComponent: () => editorFactory,
			setEditorComponent(factory?: unknown) {
				editorFactory = factory;
				if (typeof factory === "function") {
					factory(tui, { borderColor: (text: string) => text }, { matches: () => false });
				}
			},
			setHiddenThinkingLabel(label?: string) {
				globalLabelUpdates.push(label);
				for (const component of components) component.setHiddenThinkingLabel(label ?? "Thinking...");
			},
		},
	} as unknown as ExtensionContext;
	const emit = async (event: string, payload: unknown) => {
		await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));
	};
	const labelOf = (component: AssistantMessageComponent) =>
		(component as unknown as { hiddenThinkingLabel: string }).hiddenThinkingLabel;
	const addMessage = (message: AssistantMessage) => {
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(message);
		components.push(component);
		return component;
	};
	const render = (width = 80) => {
		for (const component of components) component.render(width);
	};
	return { pi, emit, labelOf, addMessage, render, globalLabelUpdates };
}

test("a finished message keeps its peek label when the next message starts", async () => {
	const harness = createHarness();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(join(tmpdir(), "open-tui-peek-label-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(
		join(agentDir, "open-tui.json"),
		JSON.stringify({ ...DEFAULT_CONFIG, icons: { mode: "ascii" }, thinkingPeek: { lines: 2 } }),
		"utf8",
	);
	initTheme();

	try {
		const first = thinkingMessage(FIRST_THOUGHT);
		const firstComponent = harness.addMessage(first);
		openTui(harness.pi);
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("message_start", { type: "message_start", message: first });
		await harness.emit("message_update", {
			type: "message_update",
			message: first,
			assistantMessageEvent: { type: "thinking_delta", delta: FIRST_THOUGHT },
		});
		harness.render();
		assert.match(harness.labelOf(firstComponent), /think/, "the live message shows the peek label");

		await harness.emit("message_end", { type: "message_end", message: first });
		harness.render();
		const finishedLabel = harness.labelOf(firstComponent);
		assert.equal(finishedLabel, `${glyphs.thinking} think ${glyphs.done}`);

		// The next message takes over the peek; the finished one keeps its label.
		const second = thinkingMessage(SECOND_THOUGHT);
		const secondComponent = harness.addMessage(second);
		await harness.emit("message_start", { type: "message_start", message: second });
		harness.render();
		assert.equal(harness.labelOf(firstComponent), finishedLabel, "the finished message keeps its done label");
		assert.notEqual(harness.labelOf(firstComponent), "Thinking...");

		await harness.emit("message_update", {
			type: "message_update",
			message: second,
			assistantMessageEvent: { type: "thinking_delta", delta: SECOND_THOUGHT },
		});
		harness.render();
		assert.match(harness.labelOf(secondComponent), /think/, "the new message shows the live peek label");
		assert.equal(harness.labelOf(firstComponent), finishedLabel, "the finished message is untouched");
		assert.ok(
			harness.globalLabelUpdates.every((label) => label !== undefined),
			"the peek must not reset Pi's label globally while it is in use",
		);

		// Handing the label back to Pi restores the native label everywhere.
		await harness.emit("session_shutdown", { type: "session_shutdown" });
		assert.ok(
			harness.globalLabelUpdates.some((label) => label === undefined),
			"shutting down gives the label back to Pi",
		);
		assert.equal(harness.labelOf(firstComponent), "Thinking...");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});
