import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageUpdateEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import openTui from "../extensions/open-tui/index.ts";
import { formatTurnTelemetry, TurnTelemetryTracker } from "../extensions/open-tui/telemetry.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

function makeMessage(output = 20, input = 50, cacheWrite = 0, cacheRead = 0): AssistantMessage {
	const totalTokens = input + output + cacheWrite + cacheRead;
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4",
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalTokens * 0.000004 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function update(
	message: AssistantMessage,
	assistantMessageEvent: MessageUpdateEvent["assistantMessageEvent"] = {
		type: "text_delta",
		contentIndex: 0,
		delta: "x",
		partial: message,
	},
): MessageUpdateEvent {
	return {
		type: "message_update",
		message,
		assistantMessageEvent,
	};
}

function startTurn(tracker: TurnTelemetryTracker, message: AssistantMessage, turnIndex = 0): void {
	tracker.handle({ type: "turn_start", turnIndex, timestamp: Date.now() });
	tracker.handle({ type: "message_start", message });
}

function endTurn(tracker: TurnTelemetryTracker, message: AssistantMessage, turnIndex = 0) {
	tracker.handle({ type: "message_end", message });
	return tracker.handle({ type: "turn_end", turnIndex, message, toolResults: [] });
}

test("uses total output over full generation time", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage();
	startTurn(tracker, message);
	for (const timestamp of [4_000, 4_100]) {
		now = timestamp;
		tracker.handle(update(message));
	}
	now = 5_000;
	const telemetry = endTurn(tracker, message);

	assert.deepEqual(telemetry, {
		tps: 4,
		ttftMs: 4_000,
		totalMs: 5_000,
		inputTokens: 50,
		outputTokens: 20,
		cacheReadTokens: 0,
		stallMs: 0,
		stallCount: 0,
		rateUsdPerMTokens: 4,
		generationMs: 5_000,
		totalTokens: 70,
		costUsd: 0.00028,
		measurementMs: 5_000,
	});
	assert.equal(
		formatTurnTelemetry(telemetry!, theme, DEFAULT_CONFIG.telemetry, "ascii"),
		"> TPS 4.0 tok/s | ~ TTFT 4.0s | + 5.0s | ↑ 50 | ↓ 20 | $ $4.00/M",
	);
});

test("normalizes invalid usage without breaking turn telemetry", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const messages = [makeMessage(), makeMessage()];
	Object.assign(messages[0]!.usage, { input: Number.POSITIVE_INFINITY, totalTokens: null, cost: { total: Number.NaN } });
	Object.assign(messages[1]!.usage, { output: undefined, cost: undefined });

	tracker.handle({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	for (const message of messages) {
		tracker.handle({ type: "message_start", message });
		now += 100;
		tracker.handle(update(message));
		now += 100;
		tracker.handle({ type: "message_end", message });
	}
	const telemetry = tracker.handle({ type: "turn_end", turnIndex: 0, message: messages[1]!, toolResults: [] })!;

	assert.equal(telemetry.inputTokens, 50);
	assert.equal(telemetry.outputTokens, 20);
	assert.equal(telemetry.totalTokens, 70);
	assert.equal(telemetry.costUsd, 0);
	assert.equal(telemetry.rateUsdPerMTokens, null);
});

test("measures non-streamed responses from turn start", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage();

	tracker.handle({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	now = 5_000;
	tracker.handle({ type: "message_start", message });
	tracker.handle({ type: "message_end", message });
	const telemetry = tracker.handle({ type: "turn_end", turnIndex: 0, message, toolResults: [] })!;

	assert.equal(telemetry.tps, 4);
	assert.equal(telemetry.ttftMs, 5_000);
	assert.equal(telemetry.generationMs, 5_000);
	assert.equal(telemetry.measurementMs, 5_000);
});

test("uses footer semantics and respects telemetry segment settings", () => {
	const colors: string[] = [];
	const styledTheme = {
		fg: (color: string, text: string) => {
			colors.push(color);
			return text;
		},
	} as Theme;
	const telemetry = {
		tps: 50,
		ttftMs: 200,
		totalMs: 900,
		inputTokens: 50,
		outputTokens: 20,
		cacheReadTokens: 5_000,
		stallMs: 800,
		stallCount: 1,
		rateUsdPerMTokens: 4,
		generationMs: 700,
		totalTokens: 70,
		costUsd: 0.00028,
		measurementMs: 400,
	};

	assert.match(
		formatTurnTelemetry(telemetry, styledTheme, DEFAULT_CONFIG.telemetry, "ascii"),
		/^> TPS 50\.0 tok\/s \| ~ TTFT 0\.2s.*↑ 5\.0k \(U 50 \+ R 5\.0k\) \| ↓ 20.*! stall 1x \/ 0\.8s \| \$ \$4\.00\/M$/,
	);
	assert.deepEqual(colors, ["accent", "text", "success", "accent", "success", "warning", "warning", "dim"]);

	const hidden: typeof DEFAULT_CONFIG.telemetry = {
		enabled: false,
		tps: false,
		ttft: false,
		duration: false,
		tokens: false,
		stalls: false,
		cost: false,
	};
	assert.equal(formatTurnTelemetry(telemetry, theme, hidden, "ascii"), "");
});

test("returns no TPS without output or generation time", () => {
	const scenarios = [
		{ name: "zero duration", updates: [0, 0], endMs: 0, output: 20 },
		{ name: "zero output", updates: [100, 200], endMs: 800, output: 0 },
	];

	for (const scenario of scenarios) {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const message = makeMessage(scenario.output);
		startTurn(tracker, message);
		for (const timestamp of scenario.updates) {
			now = timestamp;
			tracker.handle(update(message));
		}
		now = scenario.endMs;
		const telemetry = endTurn(tracker, message);
		assert.equal(telemetry?.tps, null, scenario.name);
		assert.equal(telemetry?.outputTokens, scenario.output, scenario.name);
	}
});

test("keeps stalls in delivery time so they lower TPS", () => {
	function measure(updates: number[], endMs: number) {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const message = makeMessage();
		startTurn(tracker, message);
		for (const timestamp of updates) {
			now = timestamp;
			tracker.handle(update(message));
		}
		now = endMs;
		return endTurn(tracker, message)!;
	}

	const uninterrupted = measure([100, 200, 300], 800);
	const stalled = measure([100, 1200, 2300, 2400, 3500], 3600);

	assert.equal(uninterrupted.tps, 25);
	assert.equal(stalled.tps, 5.6);
	assert.ok(stalled.tps! < uninterrupted.tps!);
	assert.equal(stalled.stallMs, 3300);
	assert.equal(stalled.stallCount, 2);
	assert.match(formatTurnTelemetry(stalled, theme, DEFAULT_CONFIG.telemetry, "ascii"), /! stall 2x \/ 3\.3s/);
});

test("only meaningful stream deltas define TTFT and stalls", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage();
	startTurn(tracker, message);

	now = 100;
	tracker.handle(update(message, { type: "start", partial: message }));
	now = 200;
	tracker.handle(update(message, { type: "text_start", contentIndex: 0, partial: message }));
	now = 700;
	tracker.handle(update(message));
	now = 800;
	tracker.handle(update(message));
	now = 900;
	tracker.handle(update(message));
	now = 10_000;
	tracker.handle(update(message, { type: "done", reason: "stop", message }));
	now = 10_100;
	const telemetry = endTurn(tracker, message)!;

	assert.equal(telemetry.ttftMs, 700);
	assert.equal(telemetry.stallMs, 0);
	assert.equal(telemetry.stallCount, 0);
});

test("is stable across chunk counts", () => {
	function measure(updateTimes: number[]) {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const message = makeMessage();
		startTurn(tracker, message);
		for (const timestamp of updateTimes) {
			now = timestamp;
			tracker.handle(update(message));
		}
		now = 800;
		return endTurn(tracker, message)!;
	}

	assert.equal(measure([100, 700]).tps, 25);
	assert.equal(measure([100, 200, 300, 400, 500, 700]).tps, 25);
});

test("uses full generation time for high rates", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage(3_000);
	startTurn(tracker, message);
	now = 100;
	tracker.handle(update(message));
	now = 200;
	tracker.handle(update(message));
	now = 300;

	assert.equal(endTurn(tracker, message)?.tps, 10_000);
});

test("excludes tool gaps between assistant messages", () => {
	function measure(toolGapMs: number) {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const first = makeMessage(20, 10);
		const second = makeMessage(20, 10);

		tracker.handle({ type: "agent_start" });
		startTurn(tracker, first);
		for (const timestamp of [100, 200]) {
			now = timestamp;
			tracker.handle(update(first));
		}
		now = 400;
		endTurn(tracker, first);

		now += toolGapMs;
		const secondStartMs = now;
		startTurn(tracker, second, 1);
		for (const offset of [100, 200]) {
			now = secondStartMs + offset;
			tracker.handle(update(second));
		}
		now = secondStartMs + 400;
		endTurn(tracker, second, 1);
		return tracker.handle({ type: "agent_settled" })!;
	}

	assert.equal(measure(0).tps, 50);
	assert.equal(measure(10_000).tps, 50);
});

test("includes every message's tokens and generation time", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const short = makeMessage(5, 20);
	const measured = makeMessage(20, 50);

	tracker.handle({ type: "agent_start" });
	startTurn(tracker, short);
	now = 100;
	tracker.handle(update(short));
	now = 150;
	endTurn(tracker, short);

	startTurn(tracker, measured, 1);
	for (const timestamp of [200, 300]) {
		now = timestamp;
		tracker.handle(update(measured));
	}
	now = 700;
	endTurn(tracker, measured, 1);
	const telemetry = tracker.handle({ type: "agent_settled" })!;

	assert.equal(telemetry.tps, 35.7);
	assert.equal(telemetry.measurementMs, 700);
	assert.equal(telemetry.inputTokens, 70);
	assert.equal(telemetry.outputTokens, 25);
});

test("counts cache-write tokens as input, matching /session's uncached figure", () => {
	// cacheWrite is fresh, near-full-price content; cacheRead is discounted repeat
	// content and stays out of inputTokens.
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage(12, 90, 27009, 5000);

	tracker.handle({ type: "agent_start" });
	startTurn(tracker, message);
	now = 100;
	tracker.handle(update(message));
	now = 150;
	endTurn(tracker, message);
	const telemetry = tracker.handle({ type: "agent_settled" })!;

	assert.equal(telemetry.inputTokens, 27099);
	assert.equal(telemetry.cacheReadTokens, 5000);
	assert.match(
		formatTurnTelemetry(telemetry, theme, DEFAULT_CONFIG.telemetry, "ascii"),
		/\| ↑ 32k \(U 27k \+ R 5\.0k\) \| ↓ 12 \|/,
	);
});

test("aggregates all output and generation time across an agent run", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const short = makeMessage(5, 20);
	const first = makeMessage(20, 50);
	const second = makeMessage(30, 100);

	tracker.handle({ type: "agent_start" });
	startTurn(tracker, short);
	now = 100;
	tracker.handle(update(short));
	now = 150;
	endTurn(tracker, short);

	now = 200;
	startTurn(tracker, first, 1);
	for (const timestamp of [300, 400]) {
		now = timestamp;
		tracker.handle(update(first));
	}
	now = 800;
	endTurn(tracker, first, 1);

	now = 900;
	startTurn(tracker, second, 2);
	for (const timestamp of [1_000, 1_100]) {
		now = timestamp;
		tracker.handle(update(second));
	}
	now = 1_600;
	endTurn(tracker, second, 2);
	now = 1_700;
	const telemetry = tracker.handle({ type: "agent_settled" })!;

	assert.equal(telemetry.tps, 37.9);
	assert.equal(telemetry.measurementMs, 1_450);
	assert.equal(telemetry.inputTokens, 170);
	assert.equal(telemetry.outputTokens, 55);
	assert.equal(telemetry.totalTokens, 225);
	assert.equal(telemetry.rateUsdPerMTokens, 4);
});

test("open-tui notifies once after a complete agent run", () => {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => void>>();
	const notifications: string[] = [];
	const pi = {
		on(event: string, handler: (event: any, ctx: ExtensionContext) => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { theme, notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
	const emit = (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const message = makeMessage();

	openTui(pi);
	emit("agent_start", { type: "agent_start" });
	emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	emit("message_start", { type: "message_start", message });
	emit("message_update", update(message));
	emit("message_end", { type: "message_end", message });
	emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });

	assert.equal(notifications.length, 0);
	emit("agent_settled", { type: "agent_settled" });
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!, /TPS .*TTFT/);
});
