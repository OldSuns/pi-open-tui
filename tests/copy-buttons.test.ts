import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, UserMessageComponent, type MarkdownTransformContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, TuiAltScreen, visibleWidth, type Component, type MarkdownTheme, type Terminal, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
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
		// Press stays available to Pi's selection, even over a cached label.
		assert.equal(mouseTarget.handleMouse(mouse("press", col, row)), undefined);
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

	assert.equal(handleCopyMouse(owner, regions, mouse("press", 11, 2), onCopy), undefined);
	assert.equal(handleCopyMouse(owner, regions, mouse("drag", 13, 2), onCopy), undefined);
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

	handleCopyMouse(owner, regions, mouse("press", 11, 2), onCopy);
	assert.equal(handleCopyMouse(owner, regions, mouse("drag", 35, 2), onCopy), undefined);
	assert.equal(handleCopyMouse(owner, regions, mouse("release", 11, 2), onCopy), undefined);
	assert.deepEqual(copied, ["code"], "returning after a long drag must not copy");

	for (const modifier of ["shift", "alt", "ctrl"] as const) {
		handleCopyMouse(owner, regions, mouse("press", 11, 2), onCopy);
		assert.equal(handleCopyMouse(owner, regions, { ...mouse("release", 11, 2), [modifier]: true }, onCopy), undefined);
	}
	assert.deepEqual(copied, ["code"]);

	handleCopyMouse(owner, regions, mouse("press", 11, 2), onCopy);
	handleCopyMouse({}, [], mouse("press", 11, 2), onCopy);
	handleCopyMouse(owner, regions, mouse("release", 11, 2, "none"), onCopy);
	assert.deepEqual(copied, ["code", "code"], "child dispatch must not discard a parent's label press");
});

test("restores tabs from the source code block when shapes match", () => {
	const source = "a\n\n```make\nall:\n\techo hi\n```\n\n```sh\nls\n```";
	assert.equal(restoreTabs(source, 0, "all:\n   echo hi"), "all:\n\techo hi");
	assert.equal(restoreTabs(source, 1, "ls"), "ls");
	assert.equal(restoreTabs(source, 0, "something else"), "something else");
	assert.equal(restoreTabs("no tabs", 0, "x"), "x");
});

test("restores code tabs without copying list and quote indentation", () => {
	for (const source of [
		"- build\n\n  ```make\n  all:\n  \techo hi\n  ```",
		"- ```make\n  all:\n  \techo hi\n  ```",
		"> - build\n>\n>   ~~~make\n>   all:\n>   \techo hi\n>   ~~~",
		"- outer\n  - inner\n\n    ```make\n    all:\n    \techo hi\n    ```",
		"  ```make\n  all:\n  \techo hi\n  ```",
		"- build\n\n\t```make\n\tall:\n\t\techo hi\n\t```",
	]) {
		assert.equal(restoreTabs(source, 0, "all:\n   echo hi"), "all:\n\techo hi", source);
	}
	const repeated = "```make\nall:\n   echo hi\n```\n\n- build\n\n  ```make\n  all:\n  \techo hi\n  ```";
	assert.equal(restoreTabs(repeated, 0, "all:\n   echo hi"), "all:\n   echo hi");
	assert.equal(restoreTabs(repeated, 1, "all:\n   echo hi"), "all:\n\techo hi");
	assert.equal(restoreTabs("    indented\n\n" + repeated, 2, "all:\n   echo hi"), "all:\n\techo hi");
	assert.equal(restoreTabs("- build\n\n  ```\n  \t\n  x\ty\n  ```", 0, "   \nx   y"), "\t\nx\ty");
	const html = "<pre>\n```make\nall:\n   echo hi\n```\n</pre>\n\n";
	assert.equal(restoreTabs(html + repeated, 1, "all:\n   echo hi"), "all:\n\techo hi");
	assert.equal(restoreTabs("> ```\n> \n> \tx\n> ```", 0, "\n   x"), "\n\tx");
	assert.equal(restoreTabs("```\n\ue000\tx\n```", 0, "\ue000   x"), "\ue000\tx");
});

test("cleanup disables render wrappers retained by other extensions", () => {
	initTheme();
	const originalMarkdownRender = Markdown.prototype.render;
	const originalUserRender = UserMessageComponent.prototype.render;
	const copy = setup();
	const patchedMarkdownRender = Markdown.prototype.render;
	const patchedUserRender = UserMessageComponent.prototype.render;
	const markdownWrapper = function (this: Markdown, width: number) { return patchedMarkdownRender.call(this, width); };
	const userWrapper = function (this: UserMessageComponent, width: number) { return patchedUserRender.call(this, width); };
	Markdown.prototype.render = markdownWrapper;
	UserMessageComponent.prototype.render = userWrapper;
	try {
		copy.cleanup();
		assert.equal(Markdown.prototype.render, markdownWrapper, "keep the later extension's wrapper");
		assert.equal(UserMessageComponent.prototype.render, userWrapper);
		assert.ok(markdown(md).render(40).every((line) => !line.includes("[Copy]")));
		assert.ok(new UserMessageComponent("hello").render(40).every((line) => !line.includes("[Copy]")));
		const next = setup();
		try {
			copy.cleanup();
			assert.equal(new UserMessageComponent("hello").render(40).filter((line) => line.includes("[Copy]")).length, 1);
		} finally {
			next.cleanup();
		}
	} finally {
		copy.cleanup();
		Markdown.prototype.render = originalMarkdownRender;
		UserMessageComponent.prototype.render = originalUserRender;
	}
});

test("fullscreen mouse routing preserves selection and copies only clicks", () => {
	const terminal = { columns: 40, rows: 10, write() {} } as unknown as Terminal;
	const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
	tui.requestRender = () => {};
	const internals = tui as unknown as {
		stopped: boolean;
		altScreenActive: boolean;
		doRender(): void;
		handleMouseEvent(event: { button: number; x: number; y: number; release: boolean }): void;
	};
	internals.stopped = false;
	internals.altScreenActive = true;
	const copied: string[] = [];
	const regions: CopyRegion[] = [{ row: 0, col: 10, width: 6, text: "code" }];
	const component: Component = {
		render: () => ["          [Copy]", "code body"],
		invalidate() {},
		handleMouse: (event) => handleCopyMouse(component, regions, event, (text) => copied.push(text)),
	};
	const copy = installCopyButtons({ getTui: () => tui, getTheme: () => theme, isEnabled: () => true });
	const send = (button: number, x: number, y: number, release = false) => internals.handleMouseEvent({ button, x, y, release });
	try {
		tui.setLayoutRoot(component);
		internals.doRender();
		send(0, 11, 0);
		send(32, 2, 1);
		assert.equal(tui.hasActiveSelection(), true, "Pi must receive the drag");
		send(0, 2, 1, true);
		assert.deepEqual(copied, []);

		send(0, 11, 0);
		send(32, 35, 0);
		send(0, 11, 0, true);
		assert.deepEqual(copied, [], "a long drag returning to the label is not a click");

		send(0, 11, 0);
		send(32, 12, 0);
		send(0, 12, 0, true);
		assert.deepEqual(copied, ["code"]);
		assert.equal(tui.hasActiveSelection(), false, "a valid copy click clears its temporary selection");

		send(0, 11, 0);
		send(0, 0, 1);
		send(0, 11, 0, true);
		assert.deepEqual(copied, ["code"], "a new press outside the label cancels a pending copy");
	} finally {
		copy.cleanup();
		tui.resetTextSelection();
	}
});
