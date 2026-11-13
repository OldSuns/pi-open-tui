import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { trackHiddenThinkingLabel } from "../extensions/open-tui/editor.ts";
import { resolveGlyphs } from "../extensions/open-tui/icons.ts";
import { buildPeekLabel, type PeekState } from "../extensions/open-tui/peek.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

initTheme();
const glyphs = resolveGlyphs("ascii");
const done: PeekState = { phase: "done", tail: "" };
const label = (state: PeekState) => (width: number) => buildPeekLabel(state, 0, glyphs, width, 2);
const rendered = (component: AssistantMessageComponent, width = 80) => stripAnsi(component.render(width).join("\n")).trim();

function messageComponent(text: string, outputPad = 1): AssistantMessageComponent {
	return new AssistantMessageComponent({
		role: "assistant",
		content: [{ type: "thinking", thinking: text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4.1",
		timestamp: 0,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	}, true, undefined, "Thinking...", outputPad);
}

for (const renderBeforeCompletion of [true, false]) {
	test(`completed label survives handoff (previously rendered: ${renderBeforeCompletion})`, () => {
		const first = messageComponent("first thought");
		const originalRender = first.render;
		const firstLabel = trackHiddenThinkingLabel(first);
		firstLabel.update(label({ phase: "thinking", tail: "first thought" }));
		if (renderBeforeCompletion) assert.match(rendered(first), /first thought/);
		firstLabel.update(label(done));
		firstLabel.release(true);

		const second = messageComponent("second thought");
		const secondLabel = trackHiddenThinkingLabel(second);
		secondLabel.update(label({ phase: "thinking", tail: "second thought" }));
		assert.match(rendered(second), /second thought/);
		assert.equal(rendered(first), label(done)(78));
		assert.equal(first.render, originalRender);
		secondLabel.release();
	});
}

test("an unrendered final label uses the message width and padding", () => {
	const component = messageComponent("thought", 2);
	const tracked = trackHiddenThinkingLabel(component);
	tracked.update(label(done));
	tracked.release(true);
	assert.equal(rendered(component, 10), label(done)(6));
	assert.ok(component.render(10).every((line) => visibleWidth(line) <= 10));
});

test("restoring the native label cancels a pending final update", () => {
	const component = messageComponent("thought");
	const originalRender = component.render;
	const tracked = trackHiddenThinkingLabel(component);
	tracked.update(label(done));
	tracked.release(true);
	tracked.release();
	component.setHiddenThinkingLabel("Thinking...");
	assert.equal(rendered(component), "Thinking...");
	assert.equal(component.render, originalRender);
});
