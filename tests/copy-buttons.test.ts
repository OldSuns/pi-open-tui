import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, UserMessageComponent, type MarkdownTransformContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, type Component, type MarkdownTheme, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	handleCopyMouse,
	installCopyButtons,
	markCopyScope,
	restoreTabs,
	type CopyRegion,
} from "../extensions/open-tui/copy-buttons.ts";

const identity = (text: string) => text;
const markdownTheme = new Proxy({}, {
	get: (_target, key) => (key === "highlightCode" || key === "codeBlockIndent" ? undefined : identity),
}) as MarkdownTheme;
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as Theme;

function setup(mode: "fullscreen" | "regular" = "fullscreen", enabled = true) {
	const tui = { mode, invalidate() {}, requestRender() {} } as unknown as TUI;
	return installCopyButtons({ getTui: () => tui, getTheme: () => theme, isEnabled: () => enabled });
}

function markdown(text: string, context: Partial<MarkdownTransformContext> = {}): Markdown {
	const ctx: MarkdownTransformContext = { messageType: "assistant", isStreaming: false, availableWidth: 0, ...context };
	return new Markdown(text, 0, 0, markdownTheme, undefined, { transform: (md) => markCopyScope(md, ctx) });
}

function mouse(type: TuiMouseEvent["type"], x: number, y: number, button: TuiMouseEvent["button"] = "left"): TuiMouseEvent {
	return { type, button, x, y, screenX: x, screenY: y, width: 40, height: 10, shift: false, alt: false, ctrl: false };
}

const md = "Intro\n\n```ts\nconst a = 1;\n```\n";

test("frames code blocks with [Copy] embedded in the top border", () => {
	const copy = setup();
	try {
		const lines = markdown(md).render(30);
		const top = lines.findIndex((line) => line.startsWith("╭─ ts "));
		assert.ok(top >= 0);
		assert.match(lines[top]!, /^╭─ ts ─+ \[Copy\] ╮/);
		assert.match(lines[top + 1]!, /^│ const a = 1;\s*│/);
		assert.match(lines[top + 2]!, /^╰─+╯/);
		// The frame replaces the fences, so the block keeps its height and width.
		assert.ok(lines.every((line) => !line.includes("```") && visibleWidth(line) === 30));
		assert.ok(lines.every((line) => !line.includes("\x1b_open-tui")), "marker must be stripped");
		// Long code wraps inside the frame instead of pushing the border out.
		const wide = markdown(`\`\`\`\n${"x".repeat(40)}\n\`\`\``).render(30);
		assert.ok(wide.every((line) => visibleWidth(line) === 30));
		assert.match(wide[0]!, /\[Copy\] ╮$/);
		assert.equal(wide.filter((line) => line.startsWith("│ x")).length, 2);
	} finally {
		copy.cleanup();
	}
});

test("keeps Pi's fences or drops the label where a copy would be wrong", () => {
	for (const [mode, enabled, context, width, framed] of [
		["fullscreen", true, { isStreaming: true }, 30, true],
		["fullscreen", true, {}, 12, true],
		["fullscreen", true, { messageType: "assistant-thinking" }, 30, false],
		["regular", true, {}, 30, false],
		["fullscreen", false, {}, 30, false],
		["fullscreen", true, {}, 7, false],
	] as const) {
		const copy = setup(mode, enabled);
		try {
			const lines = markdown(md, context).render(width);
			const label = `${mode} ${enabled} ${JSON.stringify(context)} ${width}`;
			assert.ok(lines.every((line) => !line.includes("Copy")), label);
			assert.equal(lines.some((line) => line.startsWith("╭─")), framed, label);
		} finally {
			copy.cleanup();
		}
	}
});

test("keeps regions across cached renders and restores prototypes on cleanup", () => {
	const originalRender = Markdown.prototype.render;
	const copy = setup();
	try {
		const component = markdown(md);
		const mouseTarget = component as unknown as Required<Pick<Component, "handleMouse">>;
		const first = component.render(30);
		assert.equal(component.render(30), first);
		const row = first.findIndex((line) => line.includes("Copy"));
		const col = first[row]!.indexOf("[Copy]");
		// Press is handled by the label; a press elsewhere is left to Pi's selection.
		assert.deepEqual(mouseTarget.handleMouse(mouse("press", col, row)), { handled: true, render: false });
		assert.equal(mouseTarget.handleMouse(mouse("press", 0, row)), undefined);
	} finally {
		copy.cleanup();
	}
	assert.equal(Markdown.prototype.render, originalRender);
	assert.equal(Object.prototype.hasOwnProperty.call(Markdown.prototype, "handleMouse"), false);
});

test("labels the last row of a user message inside the bubble", () => {
	initTheme();
	const copy = setup();
	try {
		const lines = new UserMessageComponent("hello\n\n```js\nx()\n```", undefined, 1, [markCopyScope]).render(40);
		const last = lines[lines.length - 1]!;
		assert.match(last, /Copy/);
		assert.equal(visibleWidth(last), 40);
		// One label on the fence row, one on the bubble's last row.
		assert.equal(lines.filter((line) => line.includes("Copy")).length, 2);
	} finally {
		copy.cleanup();
	}
});

test("copies on a left press and a release within tolerance only", () => {
	const owner = {};
	const regions: CopyRegion[] = [{ row: 2, col: 10, width: 4, text: "code" }];
	const copied: string[] = [];
	const onCopy = (text: string) => copied.push(text);

	assert.ok(handleCopyMouse(owner, regions, mouse("press", 11, 2), onCopy));
	assert.ok(handleCopyMouse(owner, regions, mouse("drag", 13, 2), onCopy));
	assert.ok(handleCopyMouse(owner, regions, mouse("release", 13, 2), onCopy));
	assert.deepEqual(copied, ["code"]);
	// The synthesized click after release must not copy twice.
	assert.equal(handleCopyMouse(owner, regions, mouse("click", 13, 2), onCopy), undefined);

	handleCopyMouse(owner, regions, mouse("press", 11, 2), onCopy);
	handleCopyMouse(owner, regions, mouse("release", 11, 3), onCopy);
	assert.deepEqual(copied, ["code"], "release on another row cancels");

	assert.equal(handleCopyMouse(owner, regions, mouse("press", 11, 2, "right"), onCopy), undefined);
	assert.equal(handleCopyMouse(owner, regions, mouse("wheel", 11, 2, "none"), onCopy), undefined);
	assert.equal(handleCopyMouse(owner, regions, mouse("press", 9, 2), onCopy), undefined);
});

test("restores tabs from the source code block when shapes match", () => {
	const source = "a\n\n```make\nall:\n\techo hi\n```\n\n```sh\nls\n```";
	assert.equal(restoreTabs(source, 0, "all:\n   echo hi"), "all:\n\techo hi");
	assert.equal(restoreTabs(source, 1, "ls"), "ls");
	assert.equal(restoreTabs(source, 0, "something else"), "something else");
	assert.equal(restoreTabs("no tabs", 0, "x"), "x");
});
