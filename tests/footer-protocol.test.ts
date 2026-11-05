import assert from "node:assert/strict";
import { hostname } from "node:os";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createFooterSegments, type FooterStateMessage } from "../extensions/open-tui/footer-segments.ts";
import { fitSegmentsByPriority } from "../extensions/open-tui/utils.ts";

test("invalid messages are atomic and valid updates copy fields and replace old overrides", () => {
	const events = createEventBus();
	let redraws = 0;
	const registry = createFooterSegments(events, () => redraws++);
	let lifecycle = "";
	events.on("open-tui:footer:state", (value) => {
		const state = value as FooterStateMessage;
		if (state.available) lifecycle = state.lifecycle;
	});
	registry.activate();
	const original = {
		lifecycle, key: "system:host", position: { row: 1, side: "right" },
		text: hostname(), compactText: "\x1b[32mhost\x1b]52;c;secret\x07\r", order: 3, priority: 7,
	};
	events.emit("open-tui:footer:set", original);
	original.position.side = "left";
	original.text = "changed after publication";
	const saved = registry.getSegments();
	assert.equal(saved[0]?.text, hostname());
	assert.equal(saved[0]?.compactText, "\x1b[32mhost");
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
	assert.equal(redraws, 1, "invalid updates do not request a redraw");
	events.emit("open-tui:footer:set", {
		lifecycle, key: original.key, position: { after: "cost" }, text: hostname(), futureField: true,
	});
	assert.deepEqual(registry.getSegments(), [{
		key: original.key, position: { after: "cost" }, text: hostname(), compactText: undefined, order: 0, priority: -1,
	}]);
	assert.equal(redraws, 2);
	for (let index = 0; index < 2; index++) events.emit("open-tui:footer:remove", { key: original.key, lifecycle });
	assert.deepEqual(registry.getSegments(), []);
	assert.equal(redraws, 3, "removing a missing entry does not request a redraw");
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
