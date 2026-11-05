import assert from "node:assert/strict";
import { hostname } from "node:os";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createFooterSegments, type FooterStateMessage } from "../extensions/open-tui/footer-segments.ts";
import { fitSegmentsByPriority, stripAnsi } from "../extensions/open-tui/utils.ts";

test("the public event bus publishes only within the active footer lifecycle", () => {
	const events = createEventBus();
	let redraws = 0;
	const registry = createFooterSegments(events, () => redraws++);
	const states: FooterStateMessage[] = [];
	events.on("open-tui:footer:state", (value) => states.push(value as FooterStateMessage));
	events.emit("open-tui:footer:query", undefined);
	assert.deepEqual(states, [{ available: false }]);
	registry.activate();
	const first = states.at(-1)!;
	assert.ok(first.available);
	registry.activate();
	assert.equal(states.length, 2, "activating a mounted footer is idempotent");
	const message = { lifecycle: first.lifecycle, key: "system:host", position: { after: "cost" }, text: hostname() };
	events.emit("open-tui:footer:set", message);
	assert.equal(registry.getSegments()[0]?.text, hostname());
	assert.equal(redraws, 1);
	registry.deactivate();
	assert.deepEqual(registry.getSegments(), []);
	assert.deepEqual(states.at(-1), { available: false });
	events.emit("open-tui:footer:set", message);
	assert.deepEqual(registry.getSegments(), []);
	registry.activate();
	const second = states.at(-1)!;
	assert.ok(second.available);
	assert.notEqual(second.lifecycle, first.lifecycle);
	events.emit("open-tui:footer:set", { ...message, lifecycle: second.lifecycle });
	events.emit("open-tui:footer:remove", { key: message.key, lifecycle: first.lifecycle });
	assert.equal(registry.getSegments().length, 1);
	events.emit("open-tui:footer:remove", { key: message.key, lifecycle: second.lifecycle });
	events.emit("open-tui:footer:remove", { key: message.key, lifecycle: second.lifecycle });
	assert.equal(registry.getSegments().length, 0);
	assert.equal(redraws, 3);
	registry.deactivate();
	registry.deactivate();
	assert.equal(states.length, 5);
});

test("availability is committed before a contributor immediately publishes from its state handler", () => {
	const events = createEventBus();
	const registry = createFooterSegments(events, () => {});
	events.on("open-tui:footer:state", (value) => {
		const state = value as FooterStateMessage;
		if (state.available) {
			events.emit("open-tui:footer:set", {
				lifecycle: state.lifecycle, key: "system:host", position: { after: "cwd" }, text: hostname(),
			});
		} else {
			assert.equal(registry.getSegments().length, 0);
		}
	});
	registry.activate();
	assert.equal(registry.getSegments()[0]?.text, hostname());
	registry.deactivate();
});

test("invalid messages are atomic and valid updates copy fields and replace old overrides", () => {
	const events = createEventBus();
	const registry = createFooterSegments(events, () => {});
	let lifecycle = "";
	events.on("open-tui:footer:state", (value) => {
		const state = value as FooterStateMessage;
		if (state.available) lifecycle = state.lifecycle;
	});
	registry.activate();
	const original = {
		lifecycle, key: "system:host", position: { row: 1, side: "right" },
		text: hostname(), compactText: "host", order: 3, priority: 7,
	};
	events.emit("open-tui:footer:set", original);
	original.position.side = "left";
	original.text = "changed after publication";
	const saved = registry.getSegments();
	assert.equal(saved[0]?.text, hostname());
	assert.deepEqual(saved[0]?.position, { row: 1, side: "right", edge: "end" });
	for (const invalid of [
		null, [], "text", {},
		{ ...original, lifecycle: "obsolete" },
		{ ...original, key: " " },
		{ ...original, text: 42 },
		{ ...original, compactText: null },
		{ ...original, order: NaN },
		{ ...original, priority: Infinity },
		{ ...original, priority: "4" },
		{ ...original, position: { row: 3, side: "left" } },
		{ ...original, position: { row: 1, side: "center" } },
		{ ...original, position: { row: 1, side: "left", edge: "middle" } },
		{ ...original, position: { before: "cost", after: "tokens" } },
		{ ...original, position: { before: "cost", row: 1 } },
		{ ...original, position: { after: "cost", side: "right" } },
		{ ...original, position: { before: "missing" } },
	]) {
		events.emit("open-tui:footer:set", invalid);
		assert.equal(registry.getSegments(), saved, `invalid message changed the registry: ${JSON.stringify(invalid)}`);
	}
	events.emit("open-tui:footer:set", {
		lifecycle, key: original.key, position: { after: "cost" }, text: hostname(), futureField: true,
	});
	assert.deepEqual(registry.getSegments(), [{
		key: original.key, position: { after: "cost" }, text: hostname(), compactText: undefined, order: 0, priority: -1,
	}]);
});

test("ordering is independent of arrival order and both text forms filter terminal commands", () => {
	const events = createEventBus();
	const registry = createFooterSegments(events, () => {});
	let lifecycle = "";
	events.on("open-tui:footer:state", (value) => {
		const state = value as FooterStateMessage;
		if (state.available) lifecycle = state.lifecycle;
	});
	registry.activate();
	for (const key of ["z", "a", "A"]) {
		events.emit("open-tui:footer:set", {
			lifecycle, key, position: { after: "cost" }, text: `\x1b[31m${hostname()}\n\x1b[2J ready`,
			compactText: "\x1b[32mhost\x1b]52;c;secret\x07\r",
		});
	}
	assert.deepEqual(registry.getSegments().map((segment) => segment.key), ["A", "a", "z"]);
	for (const segment of registry.getSegments()) {
		assert.match(segment.text, /\x1b\[31m/);
		assert.equal(stripAnsi(segment.text), `${hostname()} ready`);
		assert.equal(segment.compactText, "\x1b[32mhost");
	}
});

test("fitting counts actual surviving separators and compacts by priority across both sides", () => {
	const compacted = fitSegmentsByPriority([
		{ text: "important model", compactText: "model", priority: 3 },
		{ text: "system memory usage", compactText: "mem", priority: -1 },
	], 19, "...", { compactOrder: "priority" });
	assert.deepEqual(compacted, ["important model", "mem"]);
	const parts = [
		{ text: "left", priority: 4 },
		{ text: "low priority contribution", priority: -1 },
		{ text: "统计", priority: 2 },
		{ text: "费用", priority: 1 },
	];
	for (let width = 0; width <= 60; width++) {
		const fitted = fitSegmentsByPriority(parts, width, "...", {
			gapWidth: (previous, next) => previous < 1 && next >= 1 ? 1 : 3,
		});
		const left = fitted[0]!;
		const right = fitted.slice(1).filter(Boolean).join(" | ");
		assert.ok(visibleWidth(left) + visibleWidth(right) + (left && right ? 1 : 0) <= width);
	}
	assert.deepEqual(fitSegmentsByPriority(parts, 16, "...", {
		gapWidth: (previous, next) => previous < 1 && next >= 1 ? 1 : 3,
	}), ["left", "", "统计", "费用"]);
});
