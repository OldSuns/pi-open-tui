import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	initTheme,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionRuntime,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import openTui from "../extensions/open-tui/index.ts";
import { DEFAULT_CONFIG, type OpenTuiConfig } from "../extensions/open-tui/config.ts";
import type { FooterBuiltinSegment, FooterPosition, FooterSegment, FooterStateMessage } from "../extensions/open-tui/footer-segments.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";

interface Contributor {
	pi: ExtensionAPI;
	ctx?: ExtensionContext;
	state: FooterStateMessage;
	announcements: FooterStateMessage[];
	starts: string[];
	shutdowns: string[];
}

// These are actual extensions loaded by Pi. Their content describes this Node
// process and the operating system; no provider, quota service, context, UI,
// terminal, or event bus is substituted.
async function withHost(
	contributorFirst: boolean,
	run: (fixture: Awaited<ReturnType<typeof createHost>>) => Promise<void>,
	additionalExtensions: ExtensionFactory[] = [],
	tuiMode: "regular" | "fullscreen" = "regular",
): Promise<void> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const directory = await mkdtemp(join(tmpdir(), "pi-footer-segments-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	let fixture: Awaited<ReturnType<typeof createHost>> | undefined;
	try {
		fixture = await createHost(directory, contributorFirst, additionalExtensions, tuiMode);
		await run(fixture);
		assert.deepEqual(fixture.errors, [], "real Pi extension handlers must not fail");
	} finally {
		try {
			await fixture?.runtime.dispose();
		} finally {
			try {
				fixture?.host.stop();
				fixture?.host.ui.stop();
			} finally {
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				const absolute = resolve(directory);
				assert.ok(absolute.startsWith(resolve(tmpdir()) + sep));
				assert.ok(absolute.split(sep).at(-1)?.startsWith("pi-footer-segments-"));
				await rm(absolute, { recursive: true, force: true });
			}
		}
	}
}

async function createHost(
	directory: string,
	contributorFirst: boolean,
	additionalExtensions: ExtensionFactory[],
	tuiMode: "regular" | "fullscreen",
) {
	const { InteractiveMode } = await import(new URL(
		"./modes/interactive/interactive-mode.js",
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	).href);
	const config: OpenTuiConfig = structuredClone(DEFAULT_CONFIG);
	config.header = false;
	config.copyButtons = false;
	config.icons.mode = "ascii";
	config.thinkingPeek.lines = 0;
	config.footerSegments.gitBranch = false;
	config.footerSegments.gitStatus = false;
	config.footerSegments.runtime = false;
	await writeFile(join(directory, "open-tui.json"), JSON.stringify(config), "utf8");
	const contributors: Contributor[] = [];
	const errors: string[] = [];
	const contributorFactory = (pi: ExtensionAPI) => {
		const contributor: Contributor = {
			pi, state: { available: false }, announcements: [], starts: [], shutdowns: [],
		};
		contributors.push(contributor);
		pi.events.on("open-tui:footer:state", (data) => {
			assert.ok(typeof data === "object" && data !== null && "available" in data);
			const state = data as FooterStateMessage;
			if (state.available) assert.equal(typeof state.lifecycle, "string");
			contributor.state = state;
			contributor.announcements.push(state);
		});
		pi.on("session_start", (event, ctx) => {
			contributor.ctx = ctx;
			contributor.starts.push(event.reason);
			pi.events.emit("open-tui:footer:query", undefined);
		});
		pi.on("session_shutdown", (event) => {
			contributor.shutdowns.push(event.reason);
			contributor.ctx = undefined;
		});
	};
	const settingsManager = SettingsManager.inMemory({
		tuiMode, showHardwareCursor: false, theme: "dark",
	});
	settingsManager.setShowTerminalProgress(false);
	const runtime: AgentSessionRuntime = await createAgentSessionRuntime(async (options) => {
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
				extensionFactories: [
					...(contributorFirst
						? [contributorFactory, ...additionalExtensions, openTui]
						: [openTui, contributorFactory, ...additionalExtensions]),
				],
			},
		});
		assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
		const result = await createAgentSessionFromServices({
			services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent,
		});
		return { ...result, services, diagnostics: services.diagnostics };
	}, { cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory) });
	initTheme("dark");
	const host = new InteractiveMode(runtime, { tuiMode, initialThemeSetting: "dark" });
	// Follow Pi's real mounting/binding sequence without reading terminal input
	// or submitting a model prompt. Rendering still uses Pi's actual components.
	if (tuiMode === "fullscreen") {
		const { createChatViewport } = await import(new URL(
			"./modes/interactive/chat-viewport.js",
			import.meta.resolve("@earendil-works/pi-coding-agent"),
		).href);
		const viewport = createChatViewport({
			document: host.documentContainer,
			pendingMessages: host.pendingMessagesContainer,
			status: host.statusContainer,
			widgetsAbove: host.widgetContainerAbove,
			editor: host.editorContainer,
			widgetsBelow: host.widgetContainerBelow,
			footer: host.footerContainer,
		});
		host.transcriptScrollView = viewport.transcript;
		host.fullscreenLayoutRoot = viewport.root;
	}
	host.mountInteractiveTui(host.renderer, [
		host.documentContainer, host.pendingMessagesContainer, host.statusContainer,
		host.widgetContainerAbove, host.editorContainer, host.widgetContainerBelow, host.footerContainer,
	]);
	host.setupKeyHandlers();
	host.setupEditorSubmitHandler();
	const bind = async (session: AgentSession) => {
		await session.bindExtensions({
			uiContext: host.createExtensionUIContext(),
			mode: "tui",
			onError: (error) => errors.push(`${error.event}: ${error.error}`),
		});
	};
	runtime.setBeforeSessionInvalidate(() => host.resetExtensionUI());
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	const current = () => {
		const contributor = contributors.at(-1);
		assert.ok(contributor);
		return contributor;
	};
	const lifecycle = () => {
		const state = current().state;
		assert.equal(state.available, true);
		if (!state.available) throw new Error("Footer protocol is unavailable");
		return state.lifecycle;
	};
	const publish = (segment: FooterSegment, token = lifecycle()) => {
		current().pi.events.emit("open-tui:footer:set", { lifecycle: token, ...segment });
	};
	const remove = (key: string, token = lifecycle()) => {
		current().pi.events.emit("open-tui:footer:remove", { lifecycle: token, key });
	};
	const footer = (width = 240): string[] => host.footerContainer.render(width);
	const frame = (width = 240): string[] => host.editor.render(width);
	const readConfig = async (): Promise<OpenTuiConfig> => JSON.parse(await readFile(join(directory, "open-tui.json"), "utf8"));
	const toggle = async (tab: "General" | "Footer", label: string) => {
		const command = runtime.session.extensionRunner.getCommand("open-tui");
		assert.ok(command);
		const pending = command.handler("", runtime.session.extensionRunner.createCommandContext());
		await nextTurn();
		assert.equal(host.ui.hasOverlay(), true);
		const overlay = host.ui.getFocusedComponent();
		assert.ok(overlay?.handleInput);
		if (tab === "Footer") {
			overlay.handleInput("\t");
			overlay.handleInput("\t");
		}
		let found = false;
		for (let index = 0; index < 24; index++) {
			const selected = (overlay.render(120) as string[]).map(stripAnsi).find((line) => line.includes("→ "));
			if (selected?.includes(label)) {
				found = true;
				break;
			}
			overlay.handleInput("\x1b[B");
		}
		assert.equal(found, true, `setting must be reachable through real keyboard navigation: ${label}`);
		overlay.handleInput(" ");
		overlay.handleInput("\x1b");
		await pending;
		assert.equal(host.ui.hasOverlay(), false);
	};
	return { runtime, host, directory, errors, contributors, current, lifecycle, publish, remove, footer, frame, toggle, readConfig };
}

function assertOrder(text: string, labels: readonly string[]): void {
	let previous = -1;
	for (const label of labels) {
		const index = text.indexOf(label);
		assert.ok(index > previous, `${label} must appear after the preceding item in ${text}`);
		previous = index;
	}
}

const anchors: readonly FooterBuiltinSegment[] = [
	"cwd", "hostname", "sessionName", "git", "runtime", "timer", "context", "model", "tokens", "cost",
];

for (const contributorFirst of [false, true]) {
	test(`real Pi footer protocol places, updates and fits segments with contributor ${contributorFirst ? "first" : "last"}`, async () => {
		await withHost(contributorFirst, async (fixture) => {
			const { current, lifecycle, publish, remove, footer, frame, toggle } = fixture;
			assert.deepEqual(current().starts, ["startup"]);
			const token = lifecycle();
			const baseline = footer(600);
			const keys: string[] = [];
			const contribute = (key: string, position: FooterPosition, text = `[${key}] pid=${process.pid}`) => {
				keys.push(key);
				publish({ key, position, text });
			};
			for (const row of [1, 2] as const) {
				for (const side of ["left", "right"] as const) {
					for (const edge of ["start", "end"] as const) {
						contribute(`${row}${side[0]}${edge[0]}`, { row, side, edge });
					}
				}
			}
			for (const anchor of anchors) {
				contribute(`b:${anchor}`, { before: anchor });
				contribute(`a:${anchor}`, { after: anchor });
			}
			const pair = (anchor: FooterBuiltinSegment) => [`[b:${anchor}]`, `[a:${anchor}]`];
			const plain = footer(1200).map(stripAnsi);
			assert.equal(plain.length, 2, "contributions must not create another status row");
			assertOrder(plain[0]!, [
				"[1ls]", ...pair("cwd"), ...pair("hostname"), ...pair("sessionName"), ...pair("git"),
				...pair("runtime"), ...pair("timer"), "[1le]", "[1rs]", ...pair("context"), "[1re]",
			]);
			assertOrder(plain[1]!, ["[2ls]", ...pair("model"), "[2le]", "[2rs]", ...pair("tokens"), ...pair("cost"), "[2re]"]);
			await toggle("General", "Footer in editor border");
			assert.equal(lifecycle(), token, "changing presentation must not replace the lifecycle");
			const embedded = frame(1200).map(stripAnsi);
			assertOrder(embedded[0]!, [
				"[1ls]", ...pair("sessionName"), ...pair("git"), "[1le]", "[1rs]", ...pair("cwd"),
				...pair("hostname"), ...pair("runtime"), ...pair("timer"), ...pair("context"), "[1re]",
			]);
			const bottom = embedded.find((line) => line.startsWith("╰"));
			assert.ok(bottom);
			assertOrder(bottom, ["[2ls]", ...pair("model"), "[2le]", "[2rs]", ...pair("tokens"), ...pair("cost"), "[2re]"]);
			assert.equal(footer(1200).length, 0, "inline segments must not leave duplicate main rows");
			for (const width of [1, 2, 8, 20, 40, 80, 120]) {
				for (const line of frame(width)) assert.ok(visibleWidth(line) <= width, `inline width ${width}`);
			}
			for (const key of keys) remove(key);
			await toggle("General", "Footer in editor border");
			assert.deepEqual(footer(600), baseline, "removing all contributions restores the exact existing rows");

			const status = `host=${hostname()}`;
			current().ctx!.ui.setStatus("process:separate", status);
			publish({ key: "process:identity", position: { after: "cost" }, text: `pid=${process.pid}` });
			assert.equal(footer(240).length, 3);
			assert.ok(stripAnsi(footer(240)[1]!).includes(`pid=${process.pid}`));
			assert.ok(stripAnsi(footer(240)[2]!).includes(status));
			publish({ key: "process:identity", position: { row: 1, side: "left", edge: "start" }, text: `platform=${process.platform}` });
			assert.ok(stripAnsi(footer(240)[0]!).includes(`platform=${process.platform}`));
			assert.ok(!stripAnsi(footer(240)[1]!).includes(`pid=${process.pid}`));
			const valid = footer(240);
			current().pi.events.emit("open-tui:footer:set", {
				lifecycle: token, key: "process:identity", text: "invalid", position: { after: "missing" },
			});
			assert.deepEqual(footer(240), valid, "invalid updates leave existing content intact");
			remove("process:identity");
			current().ctx!.ui.setStatus("process:separate", undefined);
			publish({ key: "process:z", position: { after: "cost" }, text: `Z=${process.pid}` });
			publish({ key: "process:a", position: { after: "cost" }, text: `A=${process.pid}` });
			publish({ key: "process:A", position: { after: "cost" }, text: `upper=${process.pid}` });
			assertOrder(stripAnsi(footer(240)[1]!), [`upper=${process.pid}`, `A=${process.pid}`, `Z=${process.pid}`]);
			publish({ key: "process:z", position: { after: "cost" }, text: `Z=${process.pid}`, order: -1 });
			assertOrder(stripAnsi(footer(240)[1]!), [`Z=${process.pid}`, `upper=${process.pid}`, `A=${process.pid}`]);
			remove("process:z");
			remove("process:a");
			remove("process:A");
			publish({
				key: "process:styled", position: { after: "cost" },
				text: `\x1b[31m进程=${process.pid}\x1b[0m\n${hostname()}\x1b[2J\x1b]0;title\x07`,
				compactText: `进程=${process.pid}`, priority: 100,
			});
			assert.ok(footer(240)[1]!.includes("\x1b[31m"), "supported foreground colors survive");
			assert.ok(!footer(240).join("").includes("\x1b[2J"), "terminal screen commands are removed");
			assert.ok(!footer(240).join("").includes("\x1b]"), "terminal title commands are removed");
			for (const width of [1, 2, 8, 20, 40, 80, 120]) {
				for (const line of footer(width)) {
					assert.ok(visibleWidth(line) <= width, `plain width ${width}`);
					assert.ok(!line.includes("\n"));
				}
			}
			remove("process:styled");
			assert.deepEqual(footer(600), baseline);
			const bottomBefore = stripAnsi(footer(600)[1]!).trim();
			const usedWidth = visibleWidth(bottomBefore.replace(/ {2,}/, " "));
			publish({
				key: "process:compact", position: { after: "cost" },
				text: `process=${process.pid} host=${hostname()} ${process.execPath}`, compactText: "PID", priority: -1,
			});
			const compactLine = stripAnsi(footer(usedWidth + 6)[1]!);
			assert.ok(compactLine.endsWith("PID"), "compact text fits without sacrificing built-in content");
			assert.ok(compactLine.includes("unknown"));
			assert.ok(compactLine.includes("$0.000"));
			const narrowWidth = usedWidth;
			assert.ok(!stripAnsi(footer(narrowWidth)[1]!).includes("PID"), "default priority yields to model and statistics");
			publish({ key: "process:compact", position: { after: "cost" }, text: "PID", priority: 100 });
			assert.ok(stripAnsi(footer(6)[1]!).includes("PID"), "explicit high priority survives built-in content");
			remove("process:compact");
			for (const row of [1, 2] as const) {
				const exactText = `pid=${process.pid}`;
				publish({ key: "process:exact", position: { row, side: "left", edge: "start" }, text: exactText, priority: 100 });
				assert.equal(stripAnsi(footer(visibleWidth(exactText))[row - 1]!), exactText,
					"a left-only contribution uses the whole row without reserving an empty right-side gap");
				remove("process:exact");
			}
			publish({ key: "process:empty", position: { after: "cwd" }, text: "\x1b[31m\x1b[0m" });
			assert.deepEqual(footer(600), baseline, "style-only contributions keep the original layout");
		});
	});
}

for (const tuiMode of ["regular", "fullscreen"] as const) {
	test(`real Pi ${tuiMode} contributions survive visibility changes, reactivation, reload and new sessions`, async () => {
		const documentation = await readFile(new URL("../docs/footer-segments.md", import.meta.url), "utf8");
		const example = documentation.split("## System memory example")[1]?.match(/```typescript\r?\n([\s\S]*?)```/)?.[1];
		assert.ok(example, "the documentation must contain its complete executable example");
		const source = stripTypeScriptTypes(example);
		const { default: memoryExtension } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
		await withHost(tuiMode === "fullscreen", async ({ runtime, host, current, lifecycle, footer, frame, toggle, directory, publish, remove, readConfig }) => {
			const key = "process:directory";
			let text = "";
			const directoryContributionMarker = "[directory-files-contribution]";
			const refresh = async () => {
				text = `Files ${(await readdir(directory)).length} ${directoryContributionMarker}`;
				publish({ key, position: { after: "cost" }, text });
			};
			const assertContributions = () => {
				const rows = footer(320).map(stripAnsi);
				assert.equal(rows.length, 2, "two contributing extensions do not add status rows");
				assertOrder(rows[1]!, [text, "RAM "]);
				assert.match(rows[1]!, /RAM \d+\.\d\/\d+\.\d GiB/);
			};
			await refresh();
			assert.equal(host.renderer.mode, tuiMode);
			assertContributions();
			const queryUpdates: unknown[] = [];
			current().pi.events.on("open-tui:footer:set", (data) => queryUpdates.push(data));
			for (let index = 0; index < 3; index++) current().pi.events.emit("open-tui:footer:query", undefined);
			assert.deepEqual(queryUpdates, [], "the example extension deduplicates state announcements");
			const originalLifecycle = lifecycle();
			const originalText = text;
			await toggle("Footer", "Extension footer segments");
			assert.equal((await readConfig()).footerSegments.extensionSegments, false);
			assert.equal(lifecycle(), originalLifecycle);
			await writeFile(join(directory, "process-versions.json"), JSON.stringify(process.versions), "utf8");
			await refresh();
			assert.notEqual(text, originalText, "an actual new file changes the async contribution");
			assert.equal(footer(320).length, 2, "hidden live updates do not reactivate separate status fallbacks");
			assert.doesNotMatch(stripAnsi(footer(320).join("\n")), /\[directory-files-contribution\]/);
			await toggle("Footer", "Extension footer segments");
			assert.equal(lifecycle(), originalLifecycle);
			assertContributions();

			await toggle("General", "Footer in editor border");
			assert.equal(lifecycle(), originalLifecycle);
			assert.equal(footer(320).length, 0);
			current().ctx!.ui.setEditorText(await readFile(new URL("../README.md", import.meta.url), "utf8"));
			current().ctx!.ui.setWorkingMessage("Reading directory");
			host.showWorkingStatusIndicator();
			assert.equal(host.activeStatusIndicator.kind, "working");
			assert.equal(host.activeWorkingIndicatorEmbedded, true);
			publish({
				key: "process:wide", position: { row: 1, side: "left" },
				text: `\x1b[31m目录 ${hostname()} pid=${process.pid}\x1b[0m`, compactText: `进程 ${process.pid}`, priority: 5,
			});
			const top = stripAnsi(frame(240)[0]!);
			assert.match(top, /Reading directory/);
			assert.match(top, /↑ \d+ more/, "Pi's real editor contributes its scroll-overflow label");
			const bottom = frame(320).map(stripAnsi).find((line) => line.startsWith("╰"));
			assert.ok(bottom);
			assertOrder(bottom, [text, "RAM "]);
			// Pi 1.5.0's native wordWrapLine recurses on a wide grapheme when
			// the editor content budget is only one column. Empty-editor tiny
			// widths are covered above; this populated-editor scenario starts at 8.
			for (const width of [8, 20, 40, 80, 120, 240]) {
				for (const line of frame(width)) {
					assert.ok(visibleWidth(line) <= width, `working indicator and scroll label stay within ${width} columns`);
				}
				if (tuiMode === "fullscreen") {
					const { renderLayoutFrame } = await import(new URL(
						"./layout.js", import.meta.resolve("@earendil-works/pi-tui"),
					).href);
					const rendered = renderLayoutFrame(host.fullscreenLayoutRoot, width, 40, () => host.ui.requestRender());
					assert.equal(rendered.lines.length, 40);
					for (const line of rendered.lines) assert.ok(visibleWidth(line) <= width, `fullscreen layout width ${width}`);
				}
			}
			host.clearStatusIndicator();
			current().ctx!.ui.setEditorText("");
			await toggle("General", "Footer in editor border");
			assertContributions();
			const pendingDirectory = readdir(directory);
			await toggle("General", "Enabled");
			assert.equal(current().state.available, false);
			assert.match(stripAnsi(footer(320).join("\n")), /RAM /, "the example extension restores its status fallback");
			await toggle("General", "Enabled");
			assert.notEqual(lifecycle(), originalLifecycle);
			const staleText = `Files ${(await pendingDirectory).length} ${directoryContributionMarker}`;
			publish({ key, position: { after: "cost" }, text: staleText }, originalLifecycle);
			assert.doesNotMatch(stripAnsi(footer(320).join("\n")), /\[directory-files-contribution\]/, "old async data is rejected after reactivation");
			await refresh();
			remove(key, originalLifecycle);
			assertContributions();

			for (const reason of ["reload", "new"] as const) {
				const previous = current();
				const token = lifecycle();
				if (reason === "reload") await runtime.session.reload({ beforeSessionStart: async () => host.resetExtensionUI() });
				else assert.equal((await runtime.newSession()).cancelled, false);
				assert.deepEqual(previous.shutdowns, [reason]);
				assert.deepEqual(current().starts, [reason]);
				assert.notEqual(lifecycle(), token);
				assert.doesNotMatch(stripAnsi(footer(320).join("\n")), /Files /);
				assert.throws(() => previous.pi.events.emit("open-tui:footer:query", undefined), /stale/i);
				const announcements = previous.announcements.length;
				current().pi.events.emit("open-tui:footer:query", undefined);
				assert.equal(previous.announcements.length, announcements, "Pi releases the previous listener");
				await refresh();
				assertContributions();
			}
			const replacementText = `replacement pid=${process.pid}`;
			current().ctx!.ui.setFooter(() => new Text(replacementText, 0, 0));
			assert.equal(current().state.available, false);
			const statuses = [...host.footerDataProvider.getExtensionStatuses().values()].join("\n");
			assert.match(statuses, /RAM /, "the example extension restores fallback when another extension takes the footer");
			await toggle("General", "Enabled");
			assert.ok(stripAnsi(footer().join("\n")).includes(replacementText), "cleanup preserves the new footer owner");
		}, [memoryExtension], tuiMode);
	});
}
