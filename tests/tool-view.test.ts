import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	createAgentSession,
	createEditTool,
	createEditToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
	DefaultResourceLoader,
	generateDiffString,
	initTheme,
	SessionManager,
	SettingsManager,
	type Theme,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { backgroundAnsi, rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import { codeLines, prepareToolPreview } from "../extensions/open-tui/tool-preview.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";
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
		if (toolName === "write") {
			assert.equal(nativeArgs, undefined, "collapsed writes defer native full-content highlighting");
			compact.renderCall!(args, checkedTheme, context({ expanded: true }));
		}
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

test("real extension registration preserves native and third-party tools and cleans up pulses", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-view-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory();
	let mode: "native" | "compact" = "native";
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager,
		noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [(pi) => {
			registerToolView(pi, () => mode, glyphs);
			pi.registerTool({ ...createWriteToolDefinition(cwd), name: "write" });
		}],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd),
	});
	t.after(() => session.dispose());
	const runner = session.extensionRunner;
	const native = createEditToolDefinition(cwd) as ToolRenderers;
	assert.equal(runner.resolveToolRenderers("edit", () => native), native);
	mode = "compact";
	const thirdParty = session.getToolDefinition("write")!;
	assert.equal(runner.resolveToolRenderers("write", () => thirdParty), thirdParty);
	assert.equal(runner.resolveToolRenderers("unregistered", () => native), native);
	assert.equal(runner.resolveToolRenderers("edit", () => undefined), undefined);
	const compact = runner.resolveToolRenderers("edit", () => native)!;
	assert.equal(compact.renderShell, "self");
	initTheme("dark");
	let redraws = 0;
	const ctx = context({ cwd, args: { path: "a.ts" }, isPartial: true, invalidate() { redraws++; } });
	const render = () => compact.renderCall!(ctx.args, piTheme, ctx).render(80)[0]!;
	const history = render();
	await new Promise((resolve) => setTimeout(resolve, 1050));
	assert.equal(redraws, 0, "export-like partial context has no execution event and no timer");
	await runner.emit({ type: "tool_execution_start", toolName: "edit", toolCallId: ctx.toolCallId, args: ctx.args });
	const bright = render();
	assert.equal(bright, history);
	await new Promise((resolve) => setTimeout(resolve, 1050));
	assert.ok(redraws >= 1);
	assert.notEqual(render(), bright, "only the dot switches to dim on the next tick");
	await runner.emit({ type: "tool_execution_end", toolName: "edit", toolCallId: ctx.toolCallId, result: {}, isError: false });
	const stopped = redraws;
	await new Promise((resolve) => setTimeout(resolve, 1050));
	assert.equal(redraws, stopped);
	await runner.emit({ type: "tool_execution_start", toolName: "edit", toolCallId: ctx.toolCallId, args: ctx.args });
	render();
	await runner.emit({ type: "session_shutdown", reason: "reload" });
	await new Promise((resolve) => setTimeout(resolve, 1050));
	assert.equal(redraws, stopped, "reload stops outstanding timers");
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

function plain(rows: string[]): string[] {
	return rows.map(stripAnsi);
}

function band(r: number, g: number, b: number): string {
	return backgroundAnsi(rgbColor(r, g, b), piTheme.getColorMode());
}

test("code previews keep blank lines, normalize CRLF and filter controls before coloring", () => {
	assert.deepEqual(codeLines(""), []);
	assert.deepEqual(codeLines("\n"), [""]);
	assert.deepEqual(codeLines("one\r\n\r\n\ttwo\r\n\r\n"), ["one", "", "   two", ""]);
	assert.deepEqual(codeLines("\x1b[2~const\x1b]52;c;Y2xpcA==\x07\t值 = 1;\x00\x7f\x9f\uFFF9"), ["const   值 = 1;"]);
});

test("write preview is neutral, numbered, and capped at 16 body rows", () => {
	initTheme("dark");
	for (const count of [0, 1, 15, 16, 17, 24, 25, 80]) {
		const source = Array.from({ length: count }, (_, i) => `const value${i + 1} = ${i + 1};`).join("\r\n");
		const render = prepareToolPreview("write", source, "new.ts", piTheme);
		const rows = render(80, "      ");
		const shown = Math.min(count, 16);
		assert.equal(rows.length, shown + (count > 16 ? 1 : 0));
		if (count > 0) {
			assert.match(plain(rows)[0]!, /^ +1 const value1 = 1;/);
			assert.doesNotMatch(rows.join("\n"), /\x1b\[48[;:]/, "write never adds a background");
		}
		if (count > 16) assert.match(plain(rows).at(-1)!, new RegExp(`\\+${count - 16} lines \\(ctrl\\+o to expand\\)`));
	}
	const unknown = prepareToolPreview("write", "ordinary prose", "file.unknown", piTheme)(80, "")[0]!;
	assert.ok(unknown.includes(piTheme.fg("toolOutput", "ordinary prose")));
	assert.equal(summarizeResult("write", text("ok"), { content: "a\r\n\r\n" }), "2 lines written");
});

test("edit preview uses real Pi diffs, separate syntax contexts, and light/dark bands", () => {
	const diff = generateDiffString("const label = 1;\nreturn label;", "const label = 2;\nreturn label;").diff;
	for (const appearance of ["dark", "light"]) {
		initTheme(appearance);
		assert.equal(piTheme.appearance, appearance);
		const rows = prepareToolPreview("edit", diff, "a.ts", piTheme)(80, "      ");
		assert.equal(rows.length, 3);
		assert.match(plain(rows)[0]!, /-1 const label = 1;/);
		assert.match(plain(rows)[1]!, /\+1 const label = 2;/);
		assert.match(plain(rows)[2]!, / 2 return label;/);
		const removed = appearance === "dark" ? band(70, 30, 32) : band(255, 230, 230);
		const added = appearance === "dark" ? band(26, 55, 40) : band(229, 245, 232);
		const removedWord = appearance === "dark" ? band(124, 42, 48) : band(255, 188, 188);
		const addedWord = appearance === "dark" ? band(32, 96, 59) : band(174, 226, 185);
		assert.ok(rows[0]!.includes(removed));
		assert.ok(rows[0]!.includes(removedWord));
		assert.ok(rows[1]!.includes(added));
		assert.ok(rows[1]!.includes(addedWord));
		assert.equal(visibleWidth(rows[0]!), 78, "band ends two columns before right edge");
		assert.doesNotMatch(rows[2]!, /\x1b\[48[;:]/);
	}
	initTheme("dark");
	const syntax = prepareToolPreview("edit", "-1 /* old comment\n+1 const answer = 42;\n 2 unchanged", "a.ts", piTheme)(80, "");
	assert.ok(syntax[1]!.includes(piTheme.fg("syntaxKeyword", "const")), "deleted comment does not color the new file");
});

test("word pairing stays in adjacent runs and falls back for unrelated or oversized lines", () => {
	initTheme("dark");
	const strong = band(32, 96, 59);
	const unicode = prepareToolPreview("edit", "-1 const 标签 = '👩‍💻 old';\n+1 const 标签 = '👩‍💻 new';", "a.ts", piTheme)(100, "");
	assert.match(stripAnsi(unicode[1]!), /👩‍💻 new/);
	assert.ok(unicode[1]!.includes(`${strong}n`), "word offsets follow source units, not CJK/emoji display columns");
	for (const count of [16, 17, 24, 25]) {
		const rows = prepareToolPreview("edit", Array.from({ length: count }, (_, i) => `+${i + 1} value`).join("\n"), "a.txt", piTheme)(80, "");
		assert.equal(rows.length, count === 16 ? 16 : 17);
		if (count > 16) assert.match(plain(rows).at(-1)!, new RegExp(`\\+${count - 16} lines`));
	}
	for (const diff of [
		"-1 abc\n+1 xyz",
		"-1 const label = 1;\n    ...\n+1 const label = 2;",
		`-1 ${"a".repeat(5000)}1\n+1 ${"a".repeat(5000)}2`,
		"+1 only added",
		"-1 only removed",
	]) {
		const rows = prepareToolPreview("edit", diff, "plain.unknown", piTheme)(80, "");
		assert.ok(rows.length > 0);
		assert.ok(!rows.join("").includes(strong));
	}
	const diff = [
		...Array.from({ length: 20 }, (_, i) => `-${i + 1} const label${i} = 1;`),
		...Array.from({ length: 20 }, (_, i) => `+${i + 1} const label${i} = 2;`),
	].join("\n");
	const rows = prepareToolPreview("edit", diff, "a.ts", piTheme)(80, "");
	assert.equal(rows.length, 17);
	assert.ok(rows[0]!.includes(band(124, 42, 48)), "pairing reaches additions beyond the visible cutoff");
	assert.match(plain(rows).at(-1)!, /\+24 lines/);
	for (const invalid of ["", "not a diff", "+no number", " 1 only context", "-1 valid\nmalformed"]) {
		assert.deepEqual(prepareToolPreview("edit", invalid, "a.ts", piTheme)(80, ""), []);
	}
});

test("code rows truncate without wrapping, including ANSI, tabs, wide and combining characters", () => {
	initTheme("dark");
	for (const kind of ["write", "edit"] as const) {
		const code = "\tconst 消息 = '👩‍💻 é 中文 " + "x".repeat(200) + "';";
		const render = prepareToolPreview(kind, kind === "edit" ? `+1 ${code}` : code, "a.ts", piTheme);
		for (const width of [0, 1, 2, 6, 8, 12, 24, 48, 80]) {
			const rows = render(width, "      ");
			assert.equal(rows.length, 1);
			assert.doesNotMatch(rows[0]!, /\n|\t/);
			assert.ok(visibleWidth(rows[0]!) <= width);
			if (width >= 12) assert.match(stripAnsi(rows[0]!), /…/);
		}
	}
});

test("real write/edit execution supplies previews while native expansion remains intact", async (t) => {
	initTheme("dark");
	const cwd = await mkdtemp(join(tmpdir(), "pi-code-preview-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const write = createWriteToolDefinition(cwd) as ToolRenderers;
	const args = { path: "demo.ts", content: "const label = 1;\nreturn label;\n" };
	const result = await createWriteTool(cwd).execute("write-1", args, undefined);
	assert.equal(await readFile(join(cwd, args.path), "utf8"), args.content);
	const compactWrite = createCompactRenderers("write", write, glyphs);
	const ctx = context({ cwd, args, executionStarted: false });
	compactWrite.renderCall!(args, piTheme, ctx);
	const collapsed = compactWrite.renderResult!(result, { expanded: false, isPartial: false }, piTheme, ctx).render(80);
	assert.equal(collapsed.length, 3);
	assert.match(plain(collapsed)[0]!, /2 lines written/);
	assert.doesNotMatch(collapsed.join(""), /\x1b\[48[;:]/);
	const expanded = compactWrite.renderCall!(args, piTheme, { ...ctx, expanded: true }).render(80);
	assert.match(plain(expanded).join("\n"), /const label = 1;/);
	assert.notDeepEqual(plain(expanded), plain(collapsed));
	const hugeArgs = { path: "long.ts", content: `const value = '${"x".repeat(100_000)}';` };
	const hugeCtx = context({ cwd, args: hugeArgs, executionStarted: false });
	assert.equal(compactWrite.renderCall!(hugeArgs, piTheme, hugeCtx).render(40).length, 1);
	const huge = compactWrite.renderResult!(result, { expanded: false, isPartial: false }, piTheme, hugeCtx).render(40);
	assert.equal(huge.length, 2);
	assert.ok(huge.every((line) => visibleWidth(line) <= 40));
	assert.match(stripAnsi(huge[1]!), /…$/);
	const overwrittenArgs = { ...args, content: "replacement\n" };
	const overwritten = await createWriteTool(cwd).execute("write-2", overwrittenArgs, undefined);
	const overwriteCtx = context({ cwd, args: overwrittenArgs, executionStarted: false });
	const overwriteRows = compactWrite.renderResult!(overwritten, { expanded: false, isPartial: false }, piTheme, overwriteCtx).render(80);
	assert.doesNotMatch(overwriteRows.join(""), /\x1b\[48[;:]/);
	assert.match(plain(overwriteRows)[1]!, /1 replacement/);
	await createWriteTool(cwd).execute("write-3", args, undefined);

	const edit = createEditToolDefinition(cwd) as ToolRenderers;
	const editArgs = { path: args.path, edits: [{ oldText: "const label = 1;", newText: "const label = 2;" }] };
	const edited = await createEditTool(cwd).execute("edit-1", editArgs, undefined);
	assert.match(await readFile(join(cwd, args.path), "utf8"), /const label = 2;/);
	const compactEdit = createCompactRenderers("edit", edit, glyphs);
	const editCtx = context({ cwd, args: editArgs, executionStarted: false });
	compactEdit.renderCall!(editArgs, piTheme, editCtx);
	const rows = compactEdit.renderResult!(edited, { expanded: false, isPartial: false }, piTheme, editCtx).render(80);
	assert.match(plain(rows)[0]!, /\+1 −1/);
	assert.ok(rows.some((line) => line.includes(band(32, 96, 59))));
	const failed = compactEdit.renderResult!(text("Cannot edit"), { expanded: false, isPartial: false }, piTheme, { ...editCtx, isError: true }).render(80);
	assert.equal(failed.length, 1);
	assert.match(stripAnsi(failed[0]!), /Cannot edit/);
	const partial = compactEdit.renderResult!(edited, { expanded: false, isPartial: true }, piTheme, { ...editCtx, isPartial: true }).render(80);
	assert.equal(partial.length, 1);
	assert.match(stripAnsi(partial[0]!), /Running…/);
});
