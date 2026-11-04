import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Markdown, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installCopyButtons, markCopyScope } from "../extensions/open-tui/copy-buttons.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";
import {
	assertMarkdownCopy as check, copyMarkdown as markdown, installRealCopyButtons as setup,
	blockA, blockB, textA, textB, nestedCode, nestedText, readMarkdownCopyState,
} from "./fixtures/copy-test-helpers.ts";
import { mouseEvent } from "./fixtures/test-helpers.ts";

process.env.PI_CODING_AGENT_DIR = join(tmpdir(), `open-tui-copy-${randomUUID()}`);

function message(text: string): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "gpt-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 0,
	};
}

// Streaming transitions and native block reuse.
test("real assistant streaming completion updates Copy without resizing", () => {
	const { tui, copy } = setup();
	const assistant = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [markCopyScope]);
	tui.addChild(assistant);
	const owner = () => (assistant as unknown as { markdownSlots: { markdown: Markdown }[] }).markdownSlots[0]!.markdown;
	try {
		assistant.updateContent(message(blockA), true);
		assert.ok(assistant.render(60).every((line) => !line.includes("[Copy]")));
		check(owner(), []);
		const streamingOwner = owner();
		assistant.updateContent(message(blockA), false);
		assert.equal(owner(), streamingOwner, "exercise Pi's reuse of the same Markdown owner");
		assert.ok(assistant.render(60).some((line) => line.includes("[Copy]")), "completion must display Copy at unchanged width");
		const first = check(owner(), [textA]);
		const cached = check(owner(), [textA]);
		assert.equal(cached.lines, first.lines);
		assert.equal(cached.state.nextId, first.state.nextId, "a full-output hit must not redraw code");
		assistant.updateContent(message(blockA), false);
		assert.equal(check(owner(), [textA]).state.nextId, first.state.nextId, "native block reuse must not redraw code");
		assistant.updateContent(message(blockA + " more"), false);
		check(owner(), [textA]);
		assistant.updateContent(message(blockA + " more"), true);
		assert.ok(assistant.render(60).every((line) => !line.includes("[Copy]")));
		check(owner(), []);
	} finally { copy.cleanup(); }
});

test("real Markdown keeps each cached, new, and duplicate occurrence paired with its code", () => {
	const { copy } = setup();
	const { component } = markdown(blockA);
	try {
		check(component, [textA]);
		for (const [source, expected] of [
			[blockA + "\n\n" + blockB, [textA, textB]],
			[blockB + "\n\n" + blockA + "\n\n" + blockB, [textB, textA, textB]],
			[blockA + "\n\n" + blockA + "\n\n" + blockA, [textA, textA, textA]],
			[blockB, [textB]],
			["No code", []],
		] as const) {
			component.setText(source);
			check(component, expected);
			component.invalidate();
			check(component, expected);
		}
		component.setText(blockA);
		for (let update = 0; update < 30; update++) {
			component.setText(blockA + "\n" + "extra ".repeat(update));
			assert.equal(check(component, [textA]).state.descriptorCount, 1, "obsolete descriptions must be released");
		}
	} finally { copy.cleanup(); }
});

// Source fidelity, nesting, and label eligibility.
test("real Markdown restores duplicate source tabs and nested occurrences across reuse", () => {
	const { copy } = setup();
	const source = nestedCode;
	const { component } = markdown(source);
	try {
		check(component, nestedText);
		component.setText("- build\n\n  ```make\n  all:\n     echo hi\n  ```\n\n```make\nall:\n\techo hi\n```\n\nTail");
		check(component, ["all:\n\techo hi"], 18);
		check(component, ["all:\n   echo hi", "all:\n\techo hi"], 60);
		component.setText(source + " more");
		check(component, nestedText);
		for (const width of [12, 18, 24, 80, 60]) {
			const lines = component.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.every((line) => !line.includes("\x1b_open-tui:")));
		}
		check(component, nestedText);
	} finally { copy.cleanup(); }
});

test("real Markdown handles no-reuse paths, eligibility changes, and literal labels", () => {
	const { tui, copy, enable } = setup();
	const source = "[link][target]\n\n" + blockA + "\n\n[target]: https://example.com\n";
	const { component, state } = markdown(source);
	tui.addChild(component);
	try {
		check(component, [textA]);
		component.setText(source + "more");
		check(component, [textA]);
		state.messageType = "assistant-thinking";
		component.setText(source);
		assert.ok(check(component, []).lines.every((line) => !line.includes("[Copy]")));
		state.messageType = "assistant";
		component.setText(source);
		check(component, [textA]);
		enable(false);
		check(component, []);
		enable(true);
		check(component, [textA]);
		initTheme("light", false);
		tui.invalidate();
		check(component, [textA]);
		component.setText("```txt\n[Copy] ╭─ txt ─ [Copy] ╮\n\x1b_open-tui:cb:literal\x07\n```\n\nTail");
		const result = component.render(60);
		assert.deepEqual(readMarkdownCopyState(component).regions.map((region) => region.text), ["[Copy] ╭─ txt ─ [Copy] ╮\n\x1b_open-tui:cb:literal\x07"]);
		assert.ok(result.some((line) => stripAnsi(line).includes("│ [Copy]")), "literal labels are code, not buttons");
	} finally { copy.cleanup(); initTheme("dark", false); }
});

test("real Markdown preserves empty, indented, Unicode, and completed partial-fence code", () => {
	const { copy } = setup();
	try {
		for (const [source, expected] of [
			["```txt\n\n```\n\nTail", ""],
			["```sh\r\n\techo hi\r\n```\r\n\r\nTail", "\techo hi"],
			["```txt\n中🙂 e\u0301\tvalue\n```\n\nTail", "中🙂 e\u0301\tvalue"],
			["```[Copy]\nx\n```\n\nTail", "x"],
			["```" + "long-language".repeat(10) + "\n" + "long ".repeat(60) + "\n```\n\nTail", "long ".repeat(60)],
			["    x\n    y\n\nTail", "x\ny"],
			["```js\nx\n``", "x"],
		] as const) {
			const { component } = markdown(source);
			check(component, [expected]);
			component.setText(source);
			check(component, [expected]);
			check(component, [expected], 80);
		}
	} finally { copy.cleanup(); }
});

// Mouse target identity and installation lifecycle.
test("real mouse presses survive cached redraws and cancel when their target changes", () => {
	const { tui, copy, enable } = setup();
	const { component, state } = markdown(blockA);
	tui.addChild(component);
	const target = component as Markdown & Required<Pick<Component, "handleMouse">>;
	try {
		const { regions } = check(component, [textA]).state;
		const region = regions[0]!;
		const event = mouseEvent("press", region.col, region.row, { width: 60 });
		const press = () => {
			target.handleMouse(event);
			assert.equal(readMarkdownCopyState(component).pressed, true);
		};
		press();
		check(component, [textA]);
		assert.equal(readMarkdownCopyState(component).pressed, true);
		initTheme("light", false);
		tui.invalidate();
		check(component, [textA]);
		assert.equal(readMarkdownCopyState(component).pressed, true, "color changes do not change the target");
		component.setText(blockB);
		check(component, [textB]);
		assert.equal(readMarkdownCopyState(component).pressed, false);
		assert.equal(target.handleMouse({ ...event, type: "release" }), undefined);
		component.setText(blockA);
		check(component, [textA]);
		press();
		enable(false);
		enable(true);
		check(component, [textA]);
		assert.equal(readMarkdownCopyState(component).pressed, false);
		press();
		state.isStreaming = true;
		component.setText(blockA);
		check(component, []);
		state.isStreaming = false;
		component.setText(blockA);
		check(component, [textA]);
		assert.equal(readMarkdownCopyState(component).pressed, false);
		press();
		target.handleMouse({ ...event, type: "drag", screenX: event.screenX + 10 });
		assert.equal(readMarkdownCopyState(component).pressed, false);
		assert.equal(target.handleMouse({ ...event, type: "release" }), undefined);
		press();
		component.render(7);
		check(component, [textA]);
		assert.equal(readMarkdownCopyState(component).pressed, false);
	} finally { copy.cleanup(); initTheme("dark", false); }
});

test("cleanup leaves a later render wrapper intact and a new installation owns fresh state", () => {
	const originalRender = Markdown.prototype.render;
	const { tui, copy } = setup();
	const { component } = markdown(blockA + "\n\n" + blockA);
	tui.addChild(component);
	const installedRender = Markdown.prototype.render;
	const outerRender = function (this: Markdown, width: number) { return installedRender.call(this, width); };
	Markdown.prototype.render = outerRender;
	try {
		check(component, [textA, textA]);
		copy.cleanup();
		assert.equal(Markdown.prototype.render, outerRender);
		assert.ok(component.render(60).every((line) => !line.includes("[Copy]") && !line.includes("\x1b_open-tui:")));
		const next = installCopyButtons({ getTui: () => tui, getTheme: () => theme, isEnabled: () => true });
		try {
			check(component, [textA, textA]);
			copy.cleanup();
			check(component, [textA, textA]);
		} finally { next.cleanup(); }
	} finally {
		copy.cleanup();
		Markdown.prototype.render = originalRender;
	}
});
