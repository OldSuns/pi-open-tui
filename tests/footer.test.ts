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

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

test("both icon modes provide every footer semantic", () => {
	const keys = [
		"cwd",
		"session",
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
			getSessionName: () => undefined,
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

function renderFooterWithSession(opts: {
	sessionName?: string | null;
	mode?: "nerd" | "ascii";
	sessionNameEnabled?: boolean;
	width?: number;
}): string {
	const {
		sessionName,
		mode = "ascii",
		sessionNameEnabled = true,
		width = 160,
	} = opts;
	const name = sessionName === undefined ? "test-session" : sessionName;
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => [],
			getSessionName: () => name,
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 1_000, percent: 0 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = mode;
	config.footerSegments.sessionName = sessionNameEnabled;
	const state: FooterState = {
		git: emptyGitStatus(),
		runtime: null,
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
	};
	installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;
	return component.render(width).join("\n");
}

test("footer shows session name next to cwd when set", () => {
	const out = renderFooterWithSession({ sessionName: "my-session" });
	assert.ok(out.includes("my-session"), `missing session name\n${out}`);
});

test("footer hides session name when getSessionName returns empty", () => {
	const out = renderFooterWithSession({ sessionName: null });
	assert.ok(!out.includes("test-session"), `should not render name\n${out}`);
});

test("footer hides session name when footerSegments.sessionName is false", () => {
	const out = renderFooterWithSession({ sessionName: "my-session", sessionNameEnabled: false });
	assert.ok(!out.includes("my-session"), `should be hidden when disabled\n${out}`);
});

test("footer truncates long session names to 24 width units", () => {
	const longName = "x".repeat(60);
	const out = renderFooterWithSession({ sessionName: longName, width: 200 });
	const clean = out.replace(/\x1b\[[0-9;]*m/g, "");
	assert.ok(!clean.includes(longName), "full name must not appear\n" + clean);
	assert.match(clean, /x{10,}\.\.\./, "truncated name should keep a prefix and ellipsis\n" + clean);
});

test("session name uses matching glyph in nerd and ascii modes", () => {
	const asciiOut = renderFooterWithSession({ mode: "ascii", sessionName: "sess" });
	assert.ok(asciiOut.includes(resolveGlyphs("ascii").session), `ascii glyph missing\n${asciiOut}`);
	const nerdOut = renderFooterWithSession({ mode: "nerd", sessionName: "sess" });
	assert.ok(nerdOut.includes(resolveGlyphs("nerd").session), `nerd glyph missing\n${nerdOut}`);
});
