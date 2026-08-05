import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { installFooter } from "../extensions/open-tui/footer.ts";
import { emptyGitStatus } from "../extensions/open-tui/git.ts";
import { resolveGlyphs } from "../extensions/open-tui/icons.ts";
import type { FooterState } from "../extensions/open-tui/state.ts";
import { truncatePath } from "../extensions/open-tui/utils.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

test("cwd truncation preserves the basename", () => {
	assert.equal(truncatePath("~/projects/pi-open-tui", 14), ".../pi-open-tui");
	assert.equal(truncatePath("~/projects/pi-open-tui", 9), "...en-tui");
	assert.equal(truncatePath("C:\\work\\project", 11), "...\\project");
});

test("both icon modes provide every footer semantic", () => {
	const keys = [
		"cwd",
		"git",
		"working",
		"done",
		"context",
		"model",
		"thinking",
		"input",
		"output",
		"cacheHit",
		"cost",
		"speed",
		"latency",
		"stall",
		"extensions",
	] as const;

	for (const mode of ["nerd", "ascii"] as const) {
		const glyphs = resolveGlyphs(mode);
		for (const key of keys) assert.notEqual(glyphs[key], "", `${mode}.${key}`);
	}
});

test("ASCII footer renders icons as semantic labels", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const entries = [{
		id: "usage-1",
		timestamp: Date.now(),
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 100,
				output: 40,
				cacheRead: 100,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
		},
	}];
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "C:\\work\\project",
			getEntries: () => entries,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main", modified: 2 },
		runtime: { name: "nodejs", version: "24.6.0" },
		sessionStartEpoch: Date.now(),
		workingSince: Date.now() - 2_000,
		lastDoneIn: undefined,
	};

	installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "high" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);

	let extensionStatusReads = 0;
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => {
			extensionStatusReads++;
			return new Map([["goal", "goal active"]]);
		},
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;
	const output = component.render(160).join("\n");

	for (const expected of [
		"@",
		"* main",
		"!2",
		"node 24.6.0",
		"o working",
		"%",
		"M",
		"~ high",
		"↑ 100",
		"↓ 40",
		"c 50.0%",
		"$ $0.125",
		"& goal active",
	]) {
		assert.ok(output.includes(expected), `missing ${expected}\n${output}`);
	}
	assert.equal(extensionStatusReads, 1);

	config.footerSegments.extensionStatuses = false;
	const hiddenOutput = component.render(160);
	assert.equal(hiddenOutput.length, 2);
	assert.doesNotMatch(hiddenOutput.join("\n"), /goal active/);
	assert.equal(extensionStatusReads, 1);
});
