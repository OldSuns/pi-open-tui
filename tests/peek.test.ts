import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildPeekLabel,
	clipTail,
	collectPeekParts,
	createPeekState,
	peekTail,
	reducePeek,
} from "../extensions/open-tui/peek.ts";
import type { IconGlyphs } from "../extensions/open-tui/icons.ts";
import { sanitizeStatus } from "../extensions/open-tui/utils.ts";

const glyphs = { thinking: "~", done: "+" } as IconGlyphs;

test("collectPeekParts joins thinking and answer text, ignoring other parts", () => {
	const parts = collectPeekParts([
		{ type: "thinking", thinking: "alpha" },
		{ type: "text", text: "answer" },
		{ type: "toolCall", id: "x", name: "read", arguments: {} },
		{ type: "thinking", thinking: " beta" },
	]);
	assert.deepEqual(parts, { thinking: "alpha beta", text: "answer" });
});

test("collectPeekParts tolerates non-array content", () => {
	assert.deepEqual(collectPeekParts(undefined), { thinking: "", text: "" });
	assert.deepEqual(collectPeekParts("nope"), { thinking: "", text: "" });
});

test("collectPeekParts ignores non-string fields without coercing or throwing", () => {
	assert.deepEqual(
		collectPeekParts([
			{ type: "thinking", thinking: Symbol("invalid"), text: "fallback" },
			{ type: "thinking", thinking: { invalid: true }, text: " next" },
			{ type: "text", text: { invalid: true } },
			{ type: "text", text: Symbol("invalid") },
		]),
		{ thinking: "fallback next", text: "" },
	);
});

test("peekTail shows the last logical line only", () => {
	assert.equal(peekTail("first line\nsecond line here"), "second line here");
});

test("peekTail keeps the last two logical lines when requested", () => {
	assert.equal(peekTail("first\nsecond\n\nthird", 2), "second\nthird");
});

test("peekTail trims and collapses whitespace", () => {
	assert.equal(peekTail("  padded   text  \n"), "padded text");
	assert.equal(peekTail("   "), "");
	assert.equal(peekTail(""), "");
});

test("peekTail keeps the full tail; width bounding is clipTail's job", () => {
	assert.equal(peekTail("x".repeat(500)).length, 500);
});

test("clipTail keeps the end of long text within budget", () => {
	const tail = clipTail("x".repeat(500), 10);
	assert.equal(tail, "…" + "x".repeat(9));
});

test("clipTail truncates wide CJK text by visible width, not code points", () => {
	const tail = clipTail("思".repeat(100), 10);
	// budget 10 → 1 col for "…" + 4 wide chars (8 cols) = 9 visible columns
	assert.equal(tail, "…" + "思".repeat(4));
	assert.ok(visibleWidth(tail) <= 10);
});

test("clipTail returns text that already fits untouched", () => {
	assert.equal(clipTail("short", 10), "short");
	assert.equal(clipTail("思思", 4), "思思");
});

test("clipTail handles degenerate budgets", () => {
	assert.equal(clipTail("abc", 0), "");
	assert.equal(clipTail("abc", -5), "");
	assert.equal(clipTail("", 5), "");
	assert.equal(clipTail("abcdef", 1), "…");
});

test("clipTail never splits a surrogate pair", () => {
	const tail = clipTail("😀".repeat(50), 5);
	assert.ok(tail.startsWith("…"));
	assert.ok(!tail.includes("�"));
	assert.ok(visibleWidth(tail) <= 5);
});

test("buildPeekLabel renders each phase", () => {
	const state = createPeekState();
	assert.equal(buildPeekLabel(state, 0, glyphs, 80), "~ think ·");

	state.phase = "thinking";
	state.tail = "deriving";
	assert.equal(buildPeekLabel(state, 1, glyphs, 80), "~ think ⠙ deriving");

	state.phase = "done";
	assert.equal(buildPeekLabel(state, 2, glyphs, 80), "~ think +");
});

test("buildPeekLabel aligns the latest thought with the previous thought", () => {
	const label = buildPeekLabel(
		{ phase: "thinking", tail: "previous thought\nlatest thought" },
		0,
		glyphs,
		80,
		2,
	);
	const [previous, latest] = label.split("\n");
	assert.ok(previous !== undefined && latest !== undefined);
	assert.equal(previous.indexOf("previous thought"), latest.indexOf("latest thought"));
});

test("buildPeekLabel wraps an overflowing latest thought instead of keeping the previous one", () => {
	const label = buildPeekLabel(
		{ phase: "thinking", tail: "previous thought\nabcdefghijklmnopqrstuvwxyz" },
		0,
		glyphs,
		30,
		2,
	);
	const [first, second] = label.split("\n");
	assert.ok(first !== undefined && second !== undefined);
	assert.ok(!label.includes("previous thought"));
	assert.match(first, /~ think ⠋ abcdefghijklmnopqrst/);
	assert.match(second, /uvwxyz$/);
	assert.equal(first.indexOf("abcdefghijklmnopqrst"), second.indexOf("uvwxyz"));
});

test("buildPeekLabel never exceeds the label width, even on narrow terminals", () => {
	const state = { phase: "thinking" as const, tail: "思".repeat(200) };
	for (const width of [80, 40, 8, 200]) {
		assert.ok(visibleWidth(buildPeekLabel(state, 0, glyphs, width)) <= width);
	}
	for (const line of buildPeekLabel({ phase: "thinking", tail: "前一行\n最新一行" }, 0, glyphs, 40, 2).split("\n")) {
		assert.ok(visibleWidth(line) <= 40);
	}
});

test("buildPeekLabel fills wide terminals instead of a fixed cap", () => {
	const state = { phase: "thinking" as const, tail: "x".repeat(500) };
	const line = buildPeekLabel(state, 0, glyphs, 200);
	assert.ok(visibleWidth(line) > 92, "wide terminals must see more than the old 92-col cap");
});

test("reducePeek: spinner starts on thinking, stops when answer text arrives", () => {
	const idle = createPeekState();
	const t = reducePeek(idle, { thinking: "reasoning", text: "" });
	assert.equal(t.phase, "thinking");
	assert.equal(t.tail, "reasoning");

	const done = reducePeek(t, { thinking: "reasoning more", text: "answer" });
	assert.equal(done.phase, "done");

	// Cumulative thinking keeps arriving after the answer starts: stay done.
	const after = reducePeek(done, { thinking: "reasoning more", text: "answer more" });
	assert.equal(after.phase, "done");
	assert.equal(after.tail, "reasoning more");
});

test("reducePeek keeps two thinking lines for the double-line label", () => {
	const next = reducePeek(createPeekState(), { thinking: "previous\nlatest", text: "" });
	assert.equal(next.phase, "thinking");
	assert.equal(next.tail, "previous\nlatest");
});

test("reducePeek: a mixed thinking+text first update never spins", () => {
	const next = reducePeek(createPeekState(), { thinking: "short", text: "hi" });
	assert.equal(next.phase, "done");
});

test("reducePeek: text-only updates stay idle", () => {
	const next = reducePeek(createPeekState(), { thinking: "", text: "plain answer" });
	assert.equal(next.phase, "idle");
});

test("buildPeekLabel neutralizes terminal control sequences in thinking text", () => {
	const dirty = "\x1b]0;pwned\x07\x1b[31mred\x1b[0m\x1b[2J\x1b[?25l tail";
	const line = buildPeekLabel({ phase: "thinking", tail: dirty }, 0, glyphs, 80);
	assert.equal(line, "~ think ⠋ red tail");
	assert.ok(!line.includes("\x1b[31m"), "injected SGR must be removed");
	assert.ok(!line.includes("\x1b]"), "injected OSC must be removed");
	assert.ok(!line.includes("\x1b"), "no raw control sequences may remain");
});

test("sanitizeStatus preserves text around unsupported CSI sequences", () => {
	assert.equal(sanitizeStatus("\x1b[?25lvisible\x1b[31m text"), "visible text");
});
