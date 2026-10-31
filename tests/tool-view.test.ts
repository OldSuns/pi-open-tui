import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { resolveGlyphs } from "../extensions/open-tui/icons.ts";
import {
	callDetail,
	createCompactRenderers,
	firstLine,
	registerToolView,
	summarizeResult,
	tailLines,
} from "../extensions/open-tui/tool-view.ts";

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
		summarizeResult("grep", text("a.ts:1: x\na.ts-2- ctx\nb.ts:9: y\n\n[100 matches limit reached]", { matchLimitReached: 100 }), {}),
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
		summarizeResult("ls", text("a/\nb/\n\n[2 entries limit reached]", { entryLimitReached: 2 }), {}),
		"2 entries · limit reached",
	);
	assert.equal(summarizeResult("ls", text("(empty directory)"), {}), "Empty");
	assert.equal(summarizeResult("ls", text("a/\nb.ts"), {}), "2 entries");
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
	const pi = { registerToolRenderer: (fn: typeof resolver) => { resolver = fn; } } as unknown as ExtensionAPI;
	let mode: "native" | "compact" = "native";
	registerToolView(pi, () => mode, glyphs);
	const { renderers } = fakeNative();

	assert.equal(resolver!("bash", () => renderers), renderers, "native mode keeps Pi's renderers");
	mode = "compact";
	assert.equal(resolver!("mcp__search", () => renderers), renderers, "unowned tools are untouched");
	assert.equal(resolver!("bash", () => undefined), undefined);
	assert.equal(resolver!("bash", () => renderers)?.renderShell, "self");
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

test("expanded and failed rows hand off to Pi's native card", () => {
	for (const overrides of [{ expanded: true }, { isError: true }]) {
		const { renderers } = fakeNative();
		const compact = createCompactRenderers("bash", renderers, glyphs);
		const ctx = context(overrides);
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
