import assert from "node:assert/strict";
import { getMarkdownTheme, initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, ProcessTerminal, TuiAltScreen, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installCopyButtons, markCopyScope } from "../../extensions/open-tui/copy-buttons.ts";
import { stripAnsi } from "../../extensions/open-tui/utils.ts";

initTheme("dark", false);
const tui = new TuiAltScreen(new ProcessTerminal(), false);
let enabled = true;
let copy = installCopyButtons({ getTui: () => tui, getTheme: () => theme, isEnabled: () => enabled });
const text = "长消息 🙂 " + "A real user message that wraps when the terminal gets narrower. ".repeat(3);
const message = new UserMessageComponent(text, undefined, 1, [markCopyScope]);
tui.addChild(message);
const expectedCopies: string[] = [];
const render = (width: number, padding = 1) => {
	const lines = message.render(width);
	const fresh = new UserMessageComponent(text, undefined, padding, [markCopyScope]);
	assert.deepEqual(lines, fresh.render(width), "cached output must match a fresh component");
	return lines;
};
const column = (lines: string[], row = lines.length - 1) => {
	const bottom = stripAnsi(lines[row]!);
	const index = bottom.indexOf("[Copy]");
	assert.ok(index >= 0);
	return visibleWidth(bottom.slice(0, index));
};
const click = (target: UserMessageComponent, lines: string[], width: number, x: number, y: number, expected?: string) => {
	const event: TuiMouseEvent = {
		type: "press", button: "left", x, y, screenX: x, screenY: y, width, height: lines.length,
		shift: false, alt: false, ctrl: false,
	};
	assert.equal(target.handleMouse(event), undefined);
	const released = target.handleMouse({ ...event, type: "release" });
	if (expected !== undefined) {
		assert.equal(released?.handled, true);
		assert.equal(released?.render, false);
		expectedCopies.push(expected);
	} else {
		assert.equal(released, undefined, "an absent or stale label must not copy");
	}
};
const clickLabel = (lines: string[], width: number) => click(message, lines, width, column(lines), lines.length - 1, text);
type CopyTarget = { handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined };
const releaseAfterRender = (
	target: CopyTarget, lines: string[], width: number, x: number, y: number, redraw: () => void, expected?: string,
) => {
	assert.equal(target.handleMouse({
		type: "press", button: "left", x, y, screenX: x, screenY: y,
		width, height: lines.length, shift: false, alt: false, ctrl: false,
	}), undefined);
	redraw();
	// This is Pi's actual release interception, which runs before component mouse dispatch.
	(tui as unknown as {
		handleMouseEvent(event: { button: number; x: number; y: number; release: boolean }): void;
	}).handleMouseEvent({ button: 0, x, y, release: true });
	if (expected !== undefined) expectedCopies.push(expected);
};

try {
	const dark = render(40);
	assert.deepEqual(render(40), dark);
	clickLabel(dark, 40);
	const wide = render(80);
	assert.ok(wide.length < dark.length, "resize must move the bottom row");
	clickLabel(wide, 80);
	click(message, wide, 80, column(wide), dark.length - 1);
	clickLabel(render(40), 40);
	message.setOutputPad(3);
	const padded = render(40, 3);
	clickLabel(padded, 40);
	for (const x of [37, 38]) click(message, padded, 40, x, padded.length - 1);
	click(message, padded, 40, 33, padded.length - 1, text); // Overlap with the old label remains clickable.
	message.setOutputPad(1);
	clickLabel(render(40), 40);
	initTheme("light", false);
	tui.invalidate();
	const light = render(40);
	assert.notDeepEqual(light, dark);
	clickLabel(light, 40);
	enabled = false;
	copy.refresh();
	const disabled = render(40);
	assert.ok(disabled.every((line) => !line.includes("[Copy]")));
	click(message, disabled, 40, column(light), disabled.length - 1);
	enabled = true;
	copy.refresh();
	clickLabel(render(40), 40);
	const narrow = render(6);
	assert.ok(narrow.every((line) => !line.includes("[Copy]")));
	click(message, narrow, 6, 3, narrow.length - 1);
	clickLabel(render(40), 40);
	const code = 'const second = "another value";';
	const otherText = "A different user message\n\n```ts\n" + code + "\n```";
	const other = new UserMessageComponent(otherText, undefined, 1, [markCopyScope]);
	tui.addChild(other);
	const otherLines = other.render(40);
	click(other, otherLines, 40, column(otherLines), otherLines.length - 1, otherText);
	const codeRow = otherLines.findIndex((line) => line.includes("[Copy]"));
	assert.ok(codeRow >= 0 && codeRow < otherLines.length - 1);
	click(other, otherLines, 40, column(otherLines, codeRow), codeRow, code);
	assert.deepEqual(other.render(40), otherLines);
	click(other, otherLines, 40, column(otherLines, codeRow), codeRow, code);
	const shortCode = other.render(24);
	const shortRow = shortCode.findIndex((line) => line.includes("[Copy]"));
	assert.notEqual(column(shortCode, shortRow), column(otherLines, codeRow));
	click(other, shortCode, 24, column(shortCode, shortRow), shortRow, code);
	click(other, shortCode, 24, column(otherLines, codeRow), shortRow);
	enabled = false;
	copy.refresh();
	const disabledCode = other.render(40);
	assert.ok(disabledCode.every((line) => !line.includes("[Copy]")));
	click(other, disabledCode, 40, column(otherLines, codeRow), codeRow);
	enabled = true;
	copy.refresh();
	const enabledCode = other.render(40);
	click(other, enabledCode, 40, column(enabledCode, codeRow), codeRow, code);
	const restored = render(40);
	clickLabel(restored, 40);
	const pendingX = column(restored) + "[Copy]".length - 1;
	const pendingY = restored.length - 1;
	releaseAfterRender(message, restored, 40, pendingX, pendingY, () => {
		message.setOutputPad(3);
		render(40, 3);
	});
	message.setOutputPad(1);
	render(40);
	releaseAfterRender(message, restored, 40, pendingX, pendingY, () => render(40), text);
	releaseAfterRender(message, restored, 40, pendingX, pendingY, () => {
		initTheme("dark", false);
		tui.invalidate();
		render(40);
	}, text);
	releaseAfterRender(message, restored, 40, pendingX, pendingY, () => render(80));
	render(40);
	releaseAfterRender(message, restored, 40, pendingX, pendingY, () => render(6));
	render(40);
	releaseAfterRender(message, restored, 40, pendingX, pendingY, () => {
		enabled = false;
		copy.refresh();
		render(40);
		enabled = true;
		copy.refresh();
		render(40);
	});
	const currentCode = other.render(40);
	releaseAfterRender(other, currentCode, 40, column(currentCode, codeRow), codeRow, () => other.render(24));
	other.render(40);
	releaseAfterRender(other, currentCode, 40, column(currentCode, codeRow), codeRow, () => {
		enabled = false;
		copy.refresh();
		other.render(40);
		enabled = true;
		copy.refresh();
		other.render(40);
	});
	const sourceCode = "const value = 1;";
	const markdown = new Markdown("```ts\n" + sourceCode + "\n```", 0, 0, getMarkdownTheme(), undefined, {
		transform: (source) => markCopyScope(source, { messageType: "assistant", isStreaming: false, availableWidth: 40 }),
	});
	tui.addChild(markdown);
	const codeLines = markdown.render(40);
	const target = markdown as unknown as CopyTarget;
	releaseAfterRender(target, codeLines, 40, column(codeLines, 0), 0, () => markdown.render(40), sourceCode);
	// Same shape and label position, different text: do not copy the old content on release.
	releaseAfterRender(target, codeLines, 40, column(codeLines, 0), 0, () => {
		markdown.setText("```ts\nconst value = 2;\n```");
		markdown.render(40);
	});
	copy.cleanup();
	const cleaned = render(40);
	assert.ok(cleaned.every((line) => !line.includes("[Copy]")));
	click(message, cleaned, 40, column(restored), cleaned.length - 1);
	copy = installCopyButtons({ getTui: () => tui, getTheme: () => theme, isEnabled: () => enabled });
	clickLabel(render(40), 40);
	await new Promise<void>((resolve) => setImmediate(resolve));
	console.log("expected-copies:" + JSON.stringify(expectedCopies));
} finally {
	copy.cleanup();
	tui.stop();
}
