import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, getMarkdownTheme, initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, Container, ProcessTerminal, Spacer, TuiAltScreen, TuiMainScreen, visibleWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { getEditorTheme, theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createInteractiveTuiReference } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { decorateOpenTuiEditor } from "../../extensions/open-tui/editor.ts";
import { installCopyButtons, markCopyScope } from "../../extensions/open-tui/copy-buttons.ts";
import { stripAnsi } from "../../extensions/open-tui/utils.ts";
import { assertMarkdownCopy, copyMarkdown, blockA, blockB, textA, textB, nestedCode, nestedText, readMarkdownCopyState } from "./copy-test-helpers.ts";
import { mouseEvent } from "./test-helpers.ts";

process.env.PI_CODING_AGENT_DIR = join(tmpdir(), `open-tui-copy-${randomUUID()}`);
initTheme("dark", false);
const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
let renderer: TUI = tui;
const tuiReference = createInteractiveTuiReference(() => renderer);
assert.notEqual(tuiReference, tui);
assert.equal(tuiReference.children, tui.children);
let enabled = true;
let copy = installCopyButtons({ getTui: () => tuiReference, getTheme: () => theme, isEnabled: () => enabled });
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
	const event = mouseEvent("press", x, y, { width, height: lines.length });
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
	assert.equal(target.handleMouse(mouseEvent("press", x, y, { width, height: lines.length })), undefined);
	redraw();
	// This is Pi's actual release interception, which runs before component mouse dispatch.
	(tui as unknown as {
		handleMouseEvent(event: { button: number; x: number; y: number; release: boolean }): void;
	}).handleMouseEvent({ button: 0, x, y, release: true });
	if (expected !== undefined) expectedCopies.push(expected);
};

try {
	// User-message cache, settings, geometry, and stale releases.
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
	// Exercise native block reuse and copy the actual payload through Pi's clipboard transport.
	const { component: cachedMarkdown, state: streamingState } = copyMarkdown("", { isStreaming: true });
	tui.addChild(cachedMarkdown);
	const cachedTarget = cachedMarkdown as unknown as CopyTarget;
	const copyBlocks = (source: string, expected: readonly string[], width = 60) => {
		cachedMarkdown.setText(source);
		const { lines, state: { regions } } = assertMarkdownCopy(cachedMarkdown, expected, width);
		for (const [index, region] of regions.entries()) {
			const event = mouseEvent("press", region.col, region.row, { width, height: lines.length });
			assert.equal(cachedTarget.handleMouse(event), undefined);
			assert.equal(cachedTarget.handleMouse({ ...event, type: "release" })?.handled, true);
			expectedCopies.push(expected[index]!);
		}
		return { lines, regions };
	};
	copyBlocks(blockA, []);
	streamingState.isStreaming = false;
	for (const [source, expected] of [
		[blockA, [textA]],
		[blockA, [textA]],
		[blockA + "\n\n" + blockB, [textA, textB]],
		[blockB + "\n\n" + blockA + "\n\n" + blockB, [textB, textA, textB]],
		[blockA + "\n\n" + blockA, [textA, textA]],
		[nestedCode, nestedText],
		[nestedCode + " more", nestedText],
		["[link][target]\n\n" + blockA + "\n\n[target]: https://example.com\n", [textA]],
		[blockA + " extra", [textA]],
	] as const) copyBlocks(source, expected);
	const current = copyBlocks(blockA, [textA]);
	const button = current.regions[0]!;
	releaseAfterRender(cachedTarget, current.lines, 60, button.col, button.row, () => {
		cachedMarkdown.setText(blockB);
		cachedMarkdown.render(60);
	});
	copyBlocks(blockA, [textA]);
	releaseAfterRender(cachedTarget, current.lines, 60, button.col, button.row, () => {
		streamingState.isStreaming = true;
		cachedMarkdown.setText(blockA);
		cachedMarkdown.render(60);
		streamingState.isStreaming = false;
		cachedMarkdown.setText(blockA);
		cachedMarkdown.render(60);
	});
	copyBlocks(blockA, [textA]);
	copyBlocks("No code", []);
	// Start the actual terminal renderer in this captured child process; no fake terminal or render callback.
	cachedMarkdown.setText(blockA);
	tui.setLayoutRoot(cachedMarkdown);
	tui.start();
	const native = tui as unknown as {
		doRender(): void;
		handleMouseEvent(event: { button: number; x: number; y: number; release: boolean }): void;
	};
	native.doRender();
	const nativeButton = readMarkdownCopyState(cachedMarkdown).regions[0]!;
	assert.ok(nativeButton);
	const send = (button: number, x: number, y: number, release = false) => native.handleMouseEvent({ button, x, y, release });
	// A stationary click through the real Proxy must copy exactly once and show the native flash.
	send(0, nativeButton.col, nativeButton.row);
	send(0, nativeButton.col, nativeButton.row, true);
	expectedCopies.push(textA);
	await new Promise<void>((resolve) => setImmediate(resolve));
	tui.renderNow();
	assert.ok(tui.getScreenLines().some((line) => stripAnsi(line).includes("Copied!")));
	send(0, nativeButton.col, nativeButton.row);
	send(32, nativeButton.col + 1, nativeButton.row);
	send(0, nativeButton.col + 1, nativeButton.row, true);
	expectedCopies.push(textA);
	assert.equal(tui.hasActiveSelection(), false, "a Copy release clears the temporary selection");
	send(0, nativeButton.col, nativeButton.row);
	send(32, 0, nativeButton.row + 1);
	assert.equal(tui.hasActiveSelection(), true, "a long drag remains native selection");
	send(0, 0, nativeButton.row + 1, true);
	send(0, nativeButton.col, nativeButton.row);
	cachedMarkdown.setText(blockB);
	native.doRender();
	send(0, nativeButton.col, nativeButton.row, true);
	// Another renderer can share the terminal. Its release must not complete this renderer's press.
	const otherRenderer = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
	assert.equal(otherRenderer.terminal, tui.terminal);
	assert.notEqual(otherRenderer.children, tui.children);
	send(0, nativeButton.col, nativeButton.row);
	(otherRenderer as unknown as typeof native).handleMouseEvent({
		button: 0, x: nativeButton.col, y: nativeButton.row, release: true,
	});
	send(0, nativeButton.col, nativeButton.row, true);
	// The actual editor and shared fullscreen hook must copy expanded drafts, not paste markers.
	const draftEditor = decorateOpenTuiEditor(
		new CustomEditor(tuiReference, getEditorTheme(), new KeybindingsManager({})),
		tuiReference,
		{ copyButtons: () => copy.editor },
	);
	const draftLayout = new Container();
	let layoutSpacer = 0;
	const setDraftOffset = (height: number) => {
		layoutSpacer = height;
		draftLayout.clear();
		if (height > 0) draftLayout.addChild(new Spacer(height));
		draftLayout.addChild(draftEditor);
	};
	setDraftOffset(0);
	tui.setLayoutRoot(draftLayout);
	tui.setFocus(draftEditor);
	const pasted = Array.from({ length: 14 }, (_, index) => `  pasted 中文 ${index}  `).join("\n");
	const fullDraft = `  before  \n${pasted}\n after  `;
	draftEditor.setText("  before  \n");
	draftEditor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
	draftEditor.insertTextAtCursor("\n after  ");
	assert.match(draftEditor.getText(), /\[paste #/);
	assert.equal(draftEditor.getExpandedText(), fullDraft);
	const draftButton = () => {
		native.doRender();
		// Transient copy flashes can cover the editor's right border in the composited screen.
		const editorLines = draftEditor.render(terminal.columns);
		const editorRow = editorLines.findIndex((line) => stripAnsi(line).includes("[Copy]"));
		assert.ok(editorRow >= 0);
		return { x: column(editorLines, editorRow), y: layoutSpacer + editorRow };
	};
	// Moving the parent layout invalidates the old screen position even though the local region is unchanged.
	let point = draftButton();
	const layoutCursor = draftEditor.getCursor();
	send(0, point.x, point.y);
	setDraftOffset(2);
	const movedPoint = draftButton();
	assert.equal(movedPoint.y, point.y + 2);
	send(0, point.x, point.y, true);
	assert.deepEqual(draftEditor.getCursor(), layoutCursor);
	assert.equal(tui.hasActiveSelection(), false);
	// The moved button still works at its new screen position.
	send(0, movedPoint.x, movedPoint.y);
	send(0, movedPoint.x, movedPoint.y, true);
	expectedCopies.push(fullDraft);

	for (const jitter of [0, 2]) {
		const point = draftButton();
		const cursor = draftEditor.getCursor();
		send(0, point.x, point.y);
		if (jitter) send(32, point.x + jitter, point.y);
		send(0, point.x + jitter, point.y, true);
		expectedCopies.push(fullDraft);
		assert.deepEqual(draftEditor.getCursor(), cursor);
		assert.equal(draftEditor.focused, true);
		assert.equal(tui.hasActiveSelection(), false);
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
	tui.renderNow();
	assert.ok(tui.getScreenLines().some((line) => stripAnsi(line).includes("Copied!")));
	// Leaving the hit region must still cancel a press even when the pointer comes back.
	point = draftButton();
	send(0, point.x, point.y);
	send(32, point.x - 3, point.y);
	send(0, point.x, point.y, true);
	point = draftButton();
	send(0, point.x, point.y);
	draftEditor.insertTextAtCursor("changed before redraw");
	const changedCursor = draftEditor.getCursor();
	send(0, point.x, point.y, true);
	assert.deepEqual(draftEditor.getCursor(), changedCursor);
	assert.equal(tui.hasActiveSelection(), false);
	// Settings changes and theme-only redraws use the same pending-press rules as other targets.
	point = draftButton();
	send(0, point.x, point.y);
	enabled = false;
	copy.refresh();
	enabled = true;
	copy.refresh();
	send(0, point.x, point.y, true);
	point = draftButton();
	send(0, point.x, point.y);
	initTheme("light", false);
	native.doRender();
	send(0, point.x, point.y, true);
	expectedCopies.push(draftEditor.getExpandedText());
	// No captured component gesture or selection may survive a completed Copy click.
	send(35, point.x - 5, point.y);
	assert.equal(tui.hasActiveSelection(), false);
	draftEditor.setText("abcdef");
	native.doRender();
	send(0, 3, layoutSpacer + 1);
	send(0, 3, layoutSpacer + 1, true);
	assert.equal(draftEditor.getCursor().col, 1);
	draftEditor.setText("");
	native.doRender();
	assert.ok(tui.getScreenLines().every((line) => !line.includes("[Copy]")));
	draftEditor.setText("cleanup target");
	point = draftButton();
	send(0, point.x, point.y);
	copy.cleanup();
	send(0, point.x, point.y, true);
	copy = installCopyButtons({ getTui: () => tuiReference, getTheme: () => theme, isEnabled: () => enabled });
	point = draftButton();
	send(0, point.x, point.y);
	send(0, point.x, point.y, true);
	expectedCopies.push("cleanup target");
	await new Promise<void>((resolve) => setImmediate(resolve));
	tui.stop();
	// Match Pi's fullscreen -> regular -> fullscreen replacement behind the same Proxy.
	tui.setLayoutRoot(undefined);
	tui.clear();
	renderer = new TuiMainScreen(terminal, false);
	assert.ok(cachedMarkdown.render(60).every((line) => !line.includes("[Copy]")));
	assert.ok(draftEditor.render(60).every((line) => !line.includes("[Copy]")));
	renderer = otherRenderer;
	otherRenderer.setLayoutRoot(cachedMarkdown);
	otherRenderer.start();
	otherRenderer.renderNow();
	const replacementButton = readMarkdownCopyState(cachedMarkdown).regions[0]!;
	assert.ok(replacementButton);
	const replacementNative = otherRenderer as unknown as typeof native;
	const replacementClick = () => {
		replacementNative.handleMouseEvent({ button: 0, x: replacementButton.col, y: replacementButton.row, release: false });
		replacementNative.handleMouseEvent({ button: 0, x: replacementButton.col, y: replacementButton.row, release: true });
		expectedCopies.push(textB);
	};
	replacementClick();
	// Clearing a renderer replaces its own child array; ownership must be read live, not cached.
	otherRenderer.clear();
	otherRenderer.renderNow();
	replacementClick();
	await new Promise<void>((resolve) => setImmediate(resolve));
	otherRenderer.stop();
	renderer = tui;
	copy.cleanup();
	const cleaned = render(40);
	assert.ok(cleaned.every((line) => !line.includes("[Copy]")));
	click(message, cleaned, 40, column(restored), cleaned.length - 1);
	copy = installCopyButtons({ getTui: () => tuiReference, getTheme: () => theme, isEnabled: () => enabled });
	clickLabel(render(40), 40);
	await new Promise<void>((resolve) => setImmediate(resolve));
	console.log("expected-copies:" + JSON.stringify(expectedCopies));
} finally {
	copy.cleanup();
	renderer.stop();
}
