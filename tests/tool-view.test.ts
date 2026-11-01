import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { resolveGlyphs } from "../extensions/open-tui/icons.ts";
import {
	callDetail,
	createCompactRenderers,
	displayPath,
	firstLine,
	registerToolView,
	stripNotice,
	summarizeError,
	summarizeResult,
	tailLines,
	textOutput,
} from "../extensions/open-tui/tool-view.ts";

test("home paths shorten only inside the home directory", () => {
	const home = resolve("/home/sam");
	const cwd = resolve("/work/repo");
	assert.equal(displayPath(join(home, "x", "a.ts"), cwd, home), "~/x/a.ts");
	assert.equal(displayPath(home, cwd, home), "~");
	const sibling = resolve("/home/sam-old/file.ts");
	assert.equal(displayPath(sibling, cwd, home), sibling);
});

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderContext = Parameters<RenderCall>[2];
type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const glyphs = () => resolveGlyphs("unicode");

const text = (value: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: value }], details });

function context(overrides: Partial<RenderContext> = {}): RenderContext {
	return {
		args: {},
		toolCallId: "call-1",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		...overrides,
	};
}

function fakeNative(renderShell?: "self") {
	const seen: Array<{ slot: string; state: unknown }> = [];
	const component = (label: string): Component => ({ render: () => [label], invalidate() {} });
	const renderers: ToolRenderers = {
		renderShell,
		renderCall(_args, _theme, ctx) {
			seen.push({ slot: "call", state: ctx.state });
			return component("NATIVE CALL");
		},
		renderResult(_result, _options, _theme, ctx) {
			seen.push({ slot: "result", state: ctx.state });
			return component("NATIVE RESULT");
		},
	};
	return { renderers, seen };
}

test("summaries describe each built-in tool in one line", () => {
	assert.equal(summarizeResult("read", text("a\nb\nc"), {}), "3 lines");
	assert.equal(
		summarizeResult("read", text("a\nb\n\n[Showing lines 1-2 of 9. Use offset=3 to continue.]", { truncation: { truncated: true } }), {}),
		"2 lines · truncated",
	);
	assert.equal(summarizeResult("read", { content: [{ type: "image", data: "", mimeType: "image/png" }], details: undefined }, {}), "image");
	assert.equal(
		summarizeResult("read", text("a\nb\n\n[40 more lines in file. Use offset=3 to continue.]"), { limit: 2 }),
		"2 lines · more",
	);
	assert.equal(summarizeResult("bash", text("one\ntwo\n"), {}), "Done · 2 lines");
	assert.equal(summarizeResult("bash", text("(no output)"), {}), "Done · no output");
	assert.equal(
		summarizeResult("bash", text("tail", { truncation: { truncated: true, totalLines: 131 } }), {}),
		"Done · 131 lines · truncated",
	);
	assert.equal(summarizeResult("edit", text("ok", { diff: " 1 a\n-2 b\n+2 c\n+3 d" }), {}), "+2 −1");
	assert.equal(summarizeResult("write", text("Successfully wrote"), { content: "x\ny\n" }), "2 lines written");
	assert.equal(
		summarizeResult("grep", text("a.ts:1: x\na.ts-2- ctx\nb.ts:9: y\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]", { matchLimitReached: 100 }), {}),
		"2 matches in 2 files · limit reached",
	);
	assert.equal(summarizeResult("grep", text("No matches found"), {}), "No matches");
	assert.equal(summarizeResult("find", text("a.ts\nb.ts"), {}), "2 files");
	assert.equal(
		summarizeResult("find", text("a.ts\nb.ts\n\n[2 results limit reached]", { resultLimitReached: 2 }), {}),
		"2 files · limit reached",
	);
	assert.equal(
		summarizeResult("ls", text("a/\n\n[50KB limit reached]", { truncation: { truncated: true } }), {}),
		"1 entry · truncated",
	);
	assert.equal(
		summarizeResult("ls", text("a/\nb/\n\n[2 entries limit reached. Use limit=4 for more]", { entryLimitReached: 2 }), {}),
		"2 entries · limit reached",
	);
	assert.equal(summarizeResult("ls", text("(empty directory)"), {}), "Empty");
	assert.equal(summarizeResult("ls", text("a/\nb.ts"), {}), "2 entries");
});

test("only the current tool's confirmed Pi notices are removed", () => {
	const notices: Array<[string, string]> = [
		["read", "Showing lines 1-2 of 9. Use offset=3 to continue."],
		["read", "Showing lines 1-2 of 9 (50.0KB limit). Use offset=3 to continue."],
		["read", "40 more lines in file. Use offset=3 to continue."],
		["bash", "Showing lines 2-3 of 3. Full output: /tmp/o"],
		["bash", "Showing lines 2-3 of 3 (50.0KB limit). Full output: /tmp/o"],
		["powershell", "Showing last 50.0KB of line 1 (line is 1.2MB). Full output: C:/tmp/o"],
		["grep", "100 matches limit reached. Use limit=200 for more, or refine pattern"],
		["grep", "Some lines truncated to 500 chars. Use read tool to see full lines"],
		["grep", "100 matches limit reached. Use limit=200 for more, or refine pattern. 50.0KB limit reached. Some lines truncated to 500 chars. Use read tool to see full lines"],
		["find", "2 results limit reached"],
		["find", "2 results limit reached. Use limit=4 for more, or refine pattern. 50.0KB limit reached"],
		["ls", "2 entries limit reached. Use limit=4 for more. 50.0KB limit reached"],
	];
	for (const [toolName, notice] of notices) {
		assert.equal(stripNotice(toolName, `body\n\n[${notice}]\n`), "body", `${toolName}: ${notice}`);
	}
	for (const toolName of ["read", "bash", "powershell", "grep", "find", "ls", "edit", "write"]) {
		assert.equal(stripNotice(toolName, "body\n\n[first]\n"), "body\n\n[first]");
		assert.equal(stripNotice(toolName, "body\n\n[Showing lines of real content]"), "body\n\n[Showing lines of real content]");
	}
	assert.equal(stripNotice("bash", "body\n\n[2 results limit reached]"), "body\n\n[2 results limit reached]");
	assert.equal(summarizeResult("read", text("body\n\n[first]"), {}), "3 lines");
	assert.equal(summarizeResult("find", text("body\n\n[first]"), {}), "3 files");
	assert.equal(summarizeResult("ls", text("body\n\n[first]"), {}), "3 entries");
	assert.equal(summarizeError("bash", text("body\n\n[first]\n\nCommand exited with code 1")),
		"Exited with code 1 · 3 lines · [first]");
	assert.equal(summarizeError("read", text("[first]\nmore")), "[first]");
});

test("grep long-line truncation is visible without byte truncation", () => {
	const output = text("a.ts:1: long\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]", {
		linesTruncated: true,
	});
	assert.equal(summarizeResult("grep", output, {}), "1 match in 1 file · truncated");
	assert.equal(summarizeResult("grep", text("a.ts:1: x", { linesTruncated: false }), {}), "1 match in 1 file");
	assert.equal(summarizeResult("grep", text("a.ts:1: x", {
		linesTruncated: true, truncation: { truncated: true },
	}), {}), "1 match in 1 file · truncated");
});

test("output cleaning preserves text between CSI sequences and the latest CR frame", () => {
	const output = "\x1b[2~first\x1b[31m red\x1b[0m\r\nold\r\x9b2~latest\x1b[0m\x1b]52;c;Y2xpcA==\x07";
	assert.equal(textOutput(text(output)), "first red\nlatest");
	assert.deepEqual(tailLines(output, 3), ["first red", "latest"]);
	assert.equal(summarizeError("read", text(output)), "first red");
});

test("call details are sanitized before coloring without changing native arguments", () => {
	const unsafe = "first\x1b]52;c;Y2xpcA==\x07\x1b]52;c;Y2xpcA==\x1b\\\nsecond";
	for (const [toolName, args] of [
		["read", { path: unsafe }], ["edit", { path: unsafe }], ["write", { path: unsafe }],
		["ls", { path: unsafe }], ["grep", { pattern: unsafe }], ["find", { pattern: unsafe }],
		["bash", { command: unsafe }], ["powershell", { command: unsafe }],
	] as const) {
		let nativeArgs: unknown;
		const native: ToolRenderers = { renderCall: (value) => { nativeArgs = value; return { render: () => [], invalidate() {} }; } };
		const compact = createCompactRenderers(toolName, native, glyphs);
		const checkedTheme = {
			...theme,
			fg: (_color: string, value: string) => {
				assert.doesNotMatch(value, /[\x00-\x1f\x7f-\x9f]/, toolName);
				return value;
			},
		} as unknown as Theme;
		const rendered = compact.renderCall!(args, checkedTheme, context()).render(200);
		assert.equal(nativeArgs, args);
		assert.equal(rendered.length, 1);
		assert.match(rendered[0]!, toolName === "bash" || toolName === "powershell" ? /first … \(\+1 lines\)/ : /first second/);
		assert.doesNotMatch(rendered[0]!, /52;c|Y2xpcA/);
	}
});

test("call details show the key argument", () => {
	assert.equal(callDetail("read", { path: "/repo/src/a.ts", offset: 10, limit: 5 }, "/repo"), "src/a.ts:10-14");
	assert.equal(callDetail("bash", { command: "npm test\nnpm run typecheck" }, "/repo"), "npm test … (+1 lines)");
	assert.equal(callDetail("grep", { pattern: "renderInline", path: "src" }, "/repo"), "/renderInline/ in src");
	assert.equal(firstLine("  echo hi  "), "echo hi");
	assert.deepEqual(tailLines("a\r\nb\r\n\r\nc\r\nd\r\n", 3), ["b", "c", "d"]);
});

test("the resolver only takes over built-in tools in compact mode", () => {
	let resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
	let sourceInfo: ReturnType<ExtensionAPI["getAllTools"]>[number]["sourceInfo"] | undefined = {
		path: "builtin:bash",
		source: "builtin",
		scope: "temporary",
		origin: "top-level",
	};
	let configured = true;
	const pi = {
		registerToolRenderer: (fn: typeof resolver) => { resolver = fn; },
		getAllTools: () => configured ? [{ name: "bash", sourceInfo }] : [],
	} as unknown as ExtensionAPI;
	let mode: "native" | "compact" = "native";
	registerToolView(pi, () => mode, glyphs);
	const { renderers } = fakeNative();

	assert.equal(resolver!("bash", () => renderers), renderers, "native mode keeps Pi's renderers");
	mode = "compact";
	assert.equal(resolver!("mcp__search", () => renderers), renderers, "unowned tools are untouched");
	assert.equal(resolver!("bash", () => undefined), undefined);
	assert.equal(resolver!("bash", () => renderers)?.renderShell, "self");
	for (const source of ["local", "npm:third-party", "sdk", "unknown"]) {
		sourceInfo = { ...sourceInfo!, path: "/third-party/tool.ts", source };
		assert.equal(resolver!("bash", () => renderers), renderers, `same-name ${source} tool is untouched`);
	}
	sourceInfo = undefined;
	assert.equal(resolver!("bash", () => renderers), renderers, "missing source metadata is untouched");
	configured = false;
	assert.equal(resolver!("bash", () => renderers), renderers, "unregistered tools are untouched");
});

test("collapsed rows are compact while native renderers keep their own state", () => {
	const { renderers, seen } = fakeNative();
	const compact = createCompactRenderers("bash", renderers, glyphs);
	const ctx = context({ args: { command: "npm test" }, durationMs: 6400 });

	assert.deepEqual(compact.renderCall!({ command: "npm test" }, theme, ctx).render(80), [" ● Bash(npm test)"]);
	assert.deepEqual(compact.renderResult!(text("a\nb"), { expanded: false, isPartial: false }, theme, ctx).render(80), [
		"   └  Done · 2 lines · 6.4s",
	]);
	assert.equal(seen.length, 2);
	assert.notEqual(seen[0]!.state, ctx.state, "native renderers get their own state slot");
	assert.equal(seen[0]!.state, seen[1]!.state);
});

test("running shell rows show a bounded live tail", () => {
	const { renderers } = fakeNative();
	const compact = createCompactRenderers("bash", renderers, glyphs);
	const ctx = context({ isPartial: true });
	compact.renderCall!({ command: "npm test" }, theme, ctx);
	const rendered = compact.renderResult!(text("1\n2\n3\n4\n5"), { expanded: false, isPartial: true }, theme, ctx).render(80);

	assert.equal(rendered.length, 4);
	assert.deepEqual(rendered.slice(0, 3), ["   └  3", "      4", "      5"]);
	assert.match(rendered[3]!, /^ {6}Running… \d+ms$/);
});

test("failed rows stay compact with a red summary", () => {
	const tagged = { ...theme, fg: (color: string, value: string) => `<${color}>${value}` } as unknown as Theme;
	const { renderers } = fakeNative();
	const compact = createCompactRenderers("bash", renderers, glyphs);
	const ctx = context({ isError: true, durationMs: 1200 });
	assert.deepEqual(compact.renderCall!({ command: "npm test" }, tagged, ctx).render(80), [
		" <error>● <toolTitle>Bash<muted>(npm test)",
	]);
	assert.deepEqual(
		compact.renderResult!(text("a\nFAIL b.test.ts\n\nCommand exited with code 1"), { expanded: false, isPartial: false }, tagged, ctx).render(80),
		["   <dim>└  <error>Exited with code 1 · 2 lines · 1.2s · FAIL b.test.ts"],
	);

	assert.equal(summarizeError("bash", text("Command aborted")), "Aborted · no output");
	assert.equal(
		summarizeError("bash", text("x\n\n[Showing lines 2-3 of 3. Full output: /tmp/o]\n\nCommand timed out after 30 seconds", {
			truncation: { truncated: true, totalLines: 3 },
		})),
		"Timed out after 30 seconds · 3 lines · truncated · x",
	);
	assert.equal(summarizeError("edit", text("Could not edit file: a.ts. Not found.\nmore")), "Could not edit file: a.ts. Not found.");
	assert.equal(summarizeError("read", text("")), "Failed");
});

test("expanded rows hand off to Pi's native card", () => {
	{
		const { renderers } = fakeNative();
		const compact = createCompactRenderers("bash", renderers, glyphs);
		const ctx = context({ expanded: true, isError: true });
		const call = compact.renderCall!({ command: "npm test" }, theme, ctx);
		const result = compact.renderResult!(text("x"), { expanded: ctx.expanded, isPartial: false }, theme, ctx);
		// Default-shell tools are wrapped in a padded card: blank, call, result, blank.
		assert.deepEqual([...call.render(40), ...result.render(40)].map((line) => line.trim()), [
			"",
			"NATIVE CALL",
			"NATIVE RESULT",
			"",
		]);
	}

	const { renderers } = fakeNative("self");
	const compact = createCompactRenderers("edit", renderers, glyphs);
	const ctx = context({ expanded: true });
	assert.deepEqual(compact.renderCall!({ path: "a.ts" }, theme, ctx).render(40), ["NATIVE CALL"]);
});
