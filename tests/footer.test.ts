import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { installFooter, shortHostname } from "../extensions/open-tui/footer.ts";
import type { LiveTps } from "../extensions/open-tui/telemetry.ts";
import { emptyGitStatus, readGitStatus, type GitStatus } from "../extensions/open-tui/git.ts";
import { GitStatusRefresher } from "../extensions/open-tui/git-refresh.ts";
import { detectNerdFont, resolveGlyphs, resolveIconMode, runtimeSymbol } from "../extensions/open-tui/icons.ts";
import { clearRuntimeCache, readRuntimeInfo } from "../extensions/open-tui/runtime.ts";
import { getModelMeta, getUsageTotals, invalidateUsageCache, type FooterState } from "../extensions/open-tui/state.ts";
import {
	fitSegmentsByPriority,
	sanitizeStatusPreservingStyles,
	stripAnsi,
	truncateBranch,
	truncatePath,
} from "../extensions/open-tui/utils.ts";
import { preserveEnvironment, temporaryDirectory } from "./fixtures/test-helpers.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

// Git status: each scenario runs against its own real repository.
function gitRepository(t: TestContext, branch = "main") {
	const root = temporaryDirectory(t, "open-tui-git-");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	const commit = (message: string) => git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", message);
	git("init", "-b", branch);
	return { root, git, commit };
}

const gitRefreshOptions = { readCommit: true, readTag: true, readCounts: true };

function refreshRepository(t: TestContext, branch = "main") {
	const repo = gitRepository(t, branch);
	const commit = () => {
		repo.git("add", ".");
		repo.commit("snapshot");
	};
	commit();
	return { cwd: repo.root, git: repo.git, commit };
}

async function waitForGitRefresh(predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!predicate()) {
		assert.ok(performance.now() < deadline, "Git refresh did not reach the expected state");
		await delay(10);
	}
}

function observeGitRefresh(t: TestContext) {
	const updates: GitStatus[] = [];
	const refresher = new GitStatusRefresher((status) => updates.push(status));
	t.after(() => refresher.reset());
	return { refresher, updates };
}

test("a same-branch commit clears all cached counts without another refresh request", async (t) => {
	const { cwd, commit } = refreshRepository(t);
	for (let i = 0; i < 3; i++) writeFileSync(join(cwd, `tracked-${i}.txt`), "before\n");
	commit();
	for (let i = 0; i < 3; i++) writeFileSync(join(cwd, `tracked-${i}.txt`), "after\n");
	for (let i = 0; i < 2; i++) writeFileSync(join(cwd, `untracked-${i}.txt`), "new\n");
	const { refresher, updates } = observeGitRefresh(t);
	refresher.request(cwd, gitRefreshOptions);
	await waitForGitRefresh(() => updates.length === 1);
	assert.equal(updates[0]!.modified, 3);
	assert.equal(updates[0]!.untracked, 2);
	commit();
	refresher.request(cwd, gitRefreshOptions);
	await waitForGitRefresh(() => updates.length === 2);
	assert.deepEqual(updates[1], { ...emptyGitStatus(), branch: "main" });
	await delay(600);
	assert.equal(updates.length, 2, "no polling should continue after the final refresh");
});

test("requests during a real Git read coalesce and never overlap Git queries", async (t) => {
	const { cwd } = refreshRepository(t);
	const tracePath = join(temporaryDirectory(t, "open-tui-git-trace-"), "events.jsonl");
	preserveEnvironment(t, ["GIT_TRACE2_EVENT"]);
	process.env.GIT_TRACE2_EVENT = tracePath;
	const { refresher, updates } = observeGitRefresh(t);
	refresher.request(cwd, gitRefreshOptions);
	writeFileSync(join(cwd, "created-during-read.txt"), "new\n");
	for (let i = 0; i < 20; i++) refresher.request(cwd, gitRefreshOptions, true);
	await waitForGitRefresh(() => updates.length >= 2);
	await delay(600);
	assert.equal(updates.length, 2);
	assert.equal(updates.at(-1)!.untracked, 1);

	const trace = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
		event: string; sid: string; argv?: string[];
	});
	const queries = new Set(trace.filter((entry) => entry.event === "start"
		&& (entry.argv?.[1] === "status" || entry.argv?.[1] === "stash")).map((entry) => entry.sid));
	assert.equal(queries.size, 4, "two refreshes each run status and stash");
	let running = 0;
	for (const entry of trace) {
		if (!queries.has(entry.sid)) continue;
		if (entry.event === "start") {
			running++;
			assert.equal(running, 1, "Git queries overlapped");
		} else if (entry.event === "exit") {
			running--;
		}
	}
	assert.equal(running, 0);
});

test("continuous tool activity still publishes updates and retains the final change", async (t) => {
	const { cwd } = refreshRepository(t);
	const { refresher, updates } = observeGitRefresh(t);
	let files = 0;
	const timer = setInterval(() => {
		writeFileSync(join(cwd, `file-${++files}.txt`), "new\n");
		refresher.request(cwd, gitRefreshOptions);
	}, 50);
	try {
		await waitForGitRefresh(() => updates.length >= 2);
	} finally {
		clearInterval(timer);
	}
	writeFileSync(join(cwd, `file-${++files}.txt`), "final\n");
	refresher.request(cwd, gitRefreshOptions);
	await waitForGitRefresh(() => updates.at(-1)?.untracked === files);
});

test("flushing an in-flight request retains the final read without starting a third", async (t) => {
	const { cwd } = refreshRepository(t);
	const { refresher, updates } = observeGitRefresh(t);
	refresher.request(cwd, gitRefreshOptions);
	writeFileSync(join(cwd, "last-tool.txt"), "new\n");
	refresher.request(cwd, gitRefreshOptions);
	refresher.flush();
	await waitForGitRefresh(() => updates.length === 2);
	assert.equal(updates[1]!.untracked, 1);
	refresher.flush();
	await delay(600);
	assert.equal(updates.length, 2, "an idle flush must not issue another Git read");
});

test("reset discards an in-flight result and pending work before switching repositories", async (t) => {
	const first = refreshRepository(t, "previous");
	const second = refreshRepository(t, "current");
	const { refresher, updates } = observeGitRefresh(t);
	refresher.request(first.cwd, gitRefreshOptions);
	refresher.request(first.cwd, gitRefreshOptions);
	refresher.reset();
	refresher.request(second.cwd, gitRefreshOptions, true);
	await waitForGitRefresh(() => updates.length >= 1);
	await delay(600);
	assert.deepEqual(updates, [{ ...emptyGitStatus(), branch: "current" }]);
});

test("reset cancels a trailing refresh and permits a fresh read when re-enabled", async (t) => {
	const { cwd } = refreshRepository(t);
	const { refresher, updates } = observeGitRefresh(t);
	refresher.request(cwd, gitRefreshOptions);
	await waitForGitRefresh(() => updates.length === 1);
	writeFileSync(join(cwd, "while-disabled.txt"), "new\n");
	refresher.request(cwd, gitRefreshOptions);
	refresher.reset();
	refresher.flush();
	await delay(650);
	assert.equal(updates.length, 1);
	refresher.request(cwd, gitRefreshOptions, true);
	await waitForGitRefresh(() => updates.length === 2);
	assert.equal(updates[1]!.untracked, 1);
});

test("new display options invalidate old results and are captured at request time", async (t) => {
	const { cwd } = refreshRepository(t);
	writeFileSync(join(cwd, "untracked.txt"), "new\n");
	const { refresher, updates } = observeGitRefresh(t);
	refresher.request(cwd, gitRefreshOptions);
	refresher.reset();
	const branchOnly = { readCounts: false };
	refresher.request(cwd, branchOnly, true);
	branchOnly.readCounts = true;
	await waitForGitRefresh(() => updates.length === 1);
	assert.deepEqual(updates[0], { ...emptyGitStatus(), branch: "main" });
	refresher.request(cwd, gitRefreshOptions, true);
	await waitForGitRefresh(() => updates.length === 2);
	assert.equal(updates[1]!.untracked, 1);
});

test("a failed status read does not prevent the next repository refresh", async (t) => {
	const { cwd } = refreshRepository(t);
	const nonRepository = temporaryDirectory(t, "open-tui-non-repository-");
	const { refresher, updates } = observeGitRefresh(t);
	refresher.request(nonRepository, gitRefreshOptions);
	await waitForGitRefresh(() => updates.length === 1);
	assert.deepEqual(updates[0], emptyGitStatus());
	refresher.request(cwd, gitRefreshOptions, true);
	await waitForGitRefresh(() => updates.length === 2);
	assert.equal(updates[1]!.branch, "main");
});

test("a detached HEAD commit refreshes its hash and exact tag", async (t) => {
	const { cwd, git, commit } = refreshRepository(t);
	git("tag", "before");
	git("checkout", "--detach");
	const { refresher, updates } = observeGitRefresh(t);
	refresher.request(cwd, gitRefreshOptions);
	await waitForGitRefresh(() => updates.length === 1);
	assert.equal(updates[0]!.commit?.tag, "before");
	writeFileSync(join(cwd, "after.txt"), "new\n");
	commit();
	refresher.request(cwd, gitRefreshOptions);
	await waitForGitRefresh(() => updates.length === 2);
	assert.equal(updates[1]!.commit?.detached, true);
	assert.equal(updates[1]!.commit?.oid, git("rev-parse", "HEAD").trim());
	assert.notEqual(updates[1]!.commit?.oid, updates[0]!.commit?.oid);
	assert.equal(updates[1]!.commit?.tag, null);
	assert.equal(updates[1]!.untracked, 0);
});

test("reads Git status from a nested repository directory", async (t) => {
	const { root, commit } = gitRepository(t, "nested-repo-test");
	const nested = join(root, "packages", "app");
	commit("init");
	mkdirSync(nested, { recursive: true });
	assert.equal((await readGitStatus(nested)).branch, "nested-repo-test");
});

test("reads both ahead and behind counts for a diverged Git branch", async (t) => {
	const { root, git, commit } = gitRepository(t);
	commit("init");
	git("checkout", "-b", "upstream");
	commit("upstream");
	git("checkout", "main");
	git("branch", "--set-upstream-to=upstream");
	commit("local");
	commit("local again");
	const status = await readGitStatus(root);
	assert.equal(status.branch, "main");
	assert.equal(status.ahead, 2);
	assert.equal(status.behind, 1);
});

test("keeps the Git branch when its upstream is gone", async (t) => {
	const { root, git, commit } = gitRepository(t);
	commit("init");
	git("branch", "upstream");
	git("branch", "--set-upstream-to=upstream");
	git("branch", "-D", "upstream");
	const status = await readGitStatus(root);
	assert.equal(status.branch, "main");
	assert.equal(status.ahead, 0);
	assert.equal(status.behind, 0);
});

test("counts Git MM entries as staged and modified, not conflicted", async (t) => {
	const { root, git, commit } = gitRepository(t);
	writeFileSync(join(root, "file.txt"), "initial\n");
	git("add", "file.txt");
	commit("init");
	writeFileSync(join(root, "file.txt"), "staged\n");
	git("add", "file.txt");
	writeFileSync(join(root, "file.txt"), "modified again\n");
	assert.equal(git("status", "--porcelain=v1"), "MM file.txt\n");
	const status = await readGitStatus(root);
	assert.equal(status.conflicted, 0);
	assert.equal(status.staged, 1);
	assert.equal(status.modified, 1);
});

for (const [code, stages] of [["AA", [2, 3]], ["DD", [1]], ["UU", [1, 2, 3]]] as const) {
	test(`counts Git ${code} entries as conflicted, not staged or deleted`, async (t) => {
		const { root, git, commit } = gitRepository(t);
		commit("init");
		const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "conflict\n", encoding: "utf8" }).trim();
		// Populate unmerged index stages directly to cover these porcelain codes.
		execFileSync("git", ["update-index", "--index-info"], {
			cwd: root,
			input: stages.map((stage) => `100644 ${oid} ${stage}\tconflict.txt\n`).join(""),
		});
		assert.equal(git("status", "--porcelain=v1"), `${code} conflict.txt\n`);
		const status = await readGitStatus(root);
		assert.equal(status.conflicted, 1);
		assert.equal(status.staged, 0);
		assert.equal(status.deleted, 0);
	});
}

test("preserves Git status for unborn branches and detached HEAD", async (t) => {
	const { root, git, commit } = gitRepository(t);
	assert.deepEqual(await readGitStatus(root), emptyGitStatus());
	commit("init");
	git("checkout", "--detach");
	assert.deepEqual(await readGitStatus(root), {
		...emptyGitStatus(),
		commit: { oid: null, detached: true, tag: null },
	});
});

test("counts Git stashes from explicit-format list entries", async (t) => {
	const { root, git, commit } = gitRepository(t);
	writeFileSync(join(root, "file.txt"), "initial\n");
	git("add", "file.txt");
	commit("init");
	assert.equal((await readGitStatus(root)).stashed, 0);
	for (const content of ["first\n", "second\n"]) {
		writeFileSync(join(root, "file.txt"), content);
		git("stash", "push", "-m", "123 is not the stash count");
	}
	assert.equal((await readGitStatus(root)).stashed, 2);
	assert.equal((await readGitStatus(root, { readCounts: false })).stashed, 0);
});

test("counts Git RM entries as renamed and modified while preserving deletions", async (t) => {
	const { root, git, commit } = gitRepository(t);
	for (const file of ["original.txt", "moved.txt", "staged-delete.txt", "worktree-delete.txt"]) {
		writeFileSync(join(root, file), "initial\n");
	}
	git("add", ".");
	commit("init");
	git("mv", "original.txt", "renamed.txt");
	writeFileSync(join(root, "renamed.txt"), "modified after rename\n");
	git("mv", "moved.txt", "moved-away.txt");
	rmSync(join(root, "moved-away.txt"));
	git("rm", "staged-delete.txt");
	rmSync(join(root, "worktree-delete.txt"));
	assert.match(git("status", "--porcelain=v1"), /^RM original.txt -> renamed.txt$/m);
	assert.match(git("status", "--porcelain=v1"), /^RD moved.txt -> moved-away.txt$/m);
	const status = await readGitStatus(root);
	assert.equal(status.renamed, 2);
	assert.equal(status.modified, 1);
	assert.equal(status.deleted, 3);
	assert.equal(status.staged, 0);
	assert.equal(status.conflicted, 0);
});

// Footer layout and width fitting.

test("branch truncation preserves the branch prefix", () => {
	assert.equal(truncateBranch("fix/cwd-footer-truncation", 20), "fix/cwd-footer-tr...");
	assert.equal(truncateBranch("main", 20), "main");
});

test("cwd path truncation keeps head and tail segments", () => {
	assert.equal(truncatePath("~/projects/pi-open-tui", 30), "~/projects/pi-open-tui");
	assert.equal(truncatePath("~/projects/pi-open-tui", 18), "~/.../pi-open-tui");
});

test("cwd path truncation measures display width, not code units", () => {
	const wide = "示例项目";
	assert.equal(visibleWidth(wide), 8);

	for (const budget of [5, 6, 7]) {
		const out = truncatePath(wide, budget);
		assert.ok(visibleWidth(out) <= budget, `width ${visibleWidth(out)} exceeds ${budget}`);
	}
});

type FitScenario = { maxW: number; segments: Array<{ text: string; priority: number; truncate?: "path" | "noop" }> };

function parseFitOutput(value: string): string[][] {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed) || !parsed.every((row) => Array.isArray(row) && row.every((item) => typeof item === "string"))) {
		throw new Error("footer child process returned invalid output");
	}
	return parsed as string[][];
}

// An unfixed fit loop does not fail fast: it spins on the main thread, so a plain
// in-process assertion would hang the whole suite instead of reporting a failure.
// Run each case in a child process with a timeout so the regression is loud.
function runFitInChild(scenarios: readonly FitScenario[]): string[][] {
	const script = `
		import { fitSegmentsByPriority, truncatePath } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "extensions", "open-tui", "utils.ts")).href)};
		const scenarios = ${JSON.stringify(scenarios)};
		const out = scenarios.map((s) => {
			const segs = s.segments.map((seg) => {
				if (seg.truncate === "path") return { ...seg, truncate: (text, maxWidth) => truncatePath(text, maxWidth) };
				if (seg.truncate === "noop") return { ...seg, truncate: (text) => text };
				return seg;
			});
			return fitSegmentsByPriority(segs, s.maxW);
		});
		console.log(JSON.stringify(out));
	`;
	try {
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			timeout: 15_000,
		});
		return parseFitOutput(output.trim());
	} catch (error) {
		const { code, signal } = error as { code?: string; signal?: string };
		if (code === "ETIMEDOUT" || signal === "SIGTERM") {
			throw new Error("footer layout did not terminate (timed out after 15s)");
		}
		throw error;
	}
}

test("footer layout terminates and drops unshrinkable segments", () => {
	const [fitted, dropped] = runFitInChild([
		{
			maxW: 10,
			segments: [
				{ text: "示例项目", priority: 0, truncate: "path" },
				{ text: "ctx", priority: 4 },
			],
		},
		{
			maxW: 12,
			segments: [
				{ text: "wide-----segment", priority: 0, truncate: "noop" },
				{ text: "keep", priority: 4 },
			],
		},
	]);
	assert.ok(visibleWidth(fitted!.join(" ")) <= 10);
	assert.deepEqual(dropped, ["", "keep"]);
});

test("footer compacts cwd before truncating lower-priority segments", () => {
	assert.deepEqual(
		fitSegmentsByPriority(
			[
				{ text: "@ ~/projects/pi-open-tui", compactText: "@ pi-open-tui", priority: 4 },
				{ text: "* fix/cwd-footer-truncation", priority: 1 },
				{ text: "node 24.6.0", priority: 0 },
			],
			53,
		),
		["@ pi-open-tui", "* fix/cwd-footer-truncation", "node 24.6.0"],
	);
});

function footerFixture(options: {
	cwd?: () => string;
	sessionName?: string | null;
	mode?: "nerd" | "ascii";
	contextTokens?: number;
	entries?: Array<{ id: string }>;
	effort?: string;
	state?: Partial<FooterState>;
	theme?: Theme;
	statuses?: () => Map<string, string>;
	hooks?: Partial<Parameters<typeof installFooter>[4]>;
} = {}) {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: options.cwd ?? (() => "/work/project"),
			getLeafId: () => options.entries?.at(-1)?.id ?? null,
			getEntries: () => options.entries ?? [],
			getSessionName: () => options.sessionName,
		},
		getContextUsage: () => ({ tokens: options.contextTokens ?? 0, contextWindow: 1_000, percent: (options.contextTokens ?? 0) / 10 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = options.mode ?? "ascii";
	const state: FooterState = {
		git: emptyGitStatus(),
		runtime: null,
		workingSince: undefined,
		lastDoneIn: undefined,
		...options.state,
	};
	const handle = installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: options.effort ?? "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {}, ...options.hooks },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: options.statuses ?? (() => new Map()),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		options.theme ?? theme,
		footerData,
	) as Component;
	return { component, config, state, handle };
}

test("narrow plain and inline footers keep cwd before runtime and context", () => {
	let cwd = "/work/projects/pi-open-tui";
	const { component, handle } = footerFixture({
		cwd: () => cwd,
		state: { git: { ...emptyGitStatus(), branch: "main" }, runtime: { name: "nodejs", version: "24.6.0" } },
	});
	// Width 59: the full cwd does not fit alongside git+runtime+context bar.
	// The footer compacts the cwd to its basename before dropping segments.
	const out = component.render(59).join("\n");
	assert.ok(out.includes("pi-o"), `cwd basename prefix missing\n${out}`);
	assert.ok(!out.includes("~/work/projects"), `full cwd should be compacted\n${out}`);

	// A short basename fits intact even at the width where context is dropped.
	// Git must stay beside cwd rather than being popped into the context slot.
	cwd = "/work/projects/app";
	const narrow = component.render(16)[0]!;
	assert.match(narrow, /^@ app \* main +$/);
	assert.doesNotMatch(narrow, /node|%/);
	const inline = handle.renderInline(16)!;
	assert.equal(inline.top.left, "* main");
	assert.equal(inline.top.right, "@ app");
	for (let width = 0; width <= 120; width++) {
		for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
		const fitted = handle.renderInline(width)!;
		for (const line of [fitted.top, fitted.bottom]) {
			const gap = line.left && line.right ? 1 : 0;
			assert.ok(visibleWidth(line.left) + gap + visibleWidth(line.right) <= width, `inline exceeds ${width}`);
		}
	}
});

test("narrow footer sheds the context bar before left segments", () => {
	const { component } = footerFixture({
		contextTokens: 250,
		state: { git: { ...emptyGitStatus(), branch: "main" } },
	});

	// Roomy width: full bar with tokens is right-aligned on line 1.
	const wide = component.render(120).join("\n").split("\n")[0]!;
	assert.ok(wide.includes("250/1.0k"), `full context missing\n${wide}`);

	// Narrow: bar + tokens compact to just icon + pct, cwd survives.
	const narrow = component.render(40).join("\n").split("\n")[0]!;
	assert.ok(narrow.includes("25.0%"), `compact pct missing\n${narrow}`);
	assert.ok(!narrow.includes("250/1.0k"), `token counts should be compacted\n${narrow}`);
	assert.ok(narrow.includes("project"), `cwd should survive\n${narrow}`);

	// Extremely narrow: context and git yield before the cwd is truncated.
	const tiny = component.render(6).join("\n").split("\n")[0]!;
	assert.ok(!tiny.includes("25.0%"), `context should be dropped\n${tiny}`);
	assert.match(tiny, /^@ /);
});

test("hides the context bar while keeping percentage and token usage", () => {
	const { component, config } = footerFixture({ contextTokens: 250 });

	const wide = component.render(120)[0]!;
	assert.ok(wide.includes("["), `context bar missing\n${wide}`);
	assert.ok(wide.includes("25.0%"), wide);

	config.footerSegments.contextBar = false;
	const text = component.render(120)[0]!;
	assert.match(text, /25\.0% · 250\/1\.0k/);
	assert.ok(!text.includes("["), `bar should be hidden\n${text}`);
	assert.ok(!text.includes("#"), `icon should be hidden\n${text}`);

	// Narrow width still sheds the token counts first, without restoring the icon.
	const narrow = component.render(20)[0]!;
	assert.match(narrow, /25\.0%/);
	assert.ok(!narrow.includes("250/1.0k"), narrow);
	assert.ok(!narrow.includes("#"), `icon should stay hidden\n${narrow}`);
});

test("provides inline footer content without duplicating native rows", () => {
	let canEmbed = true;
	const { component, config, handle } = footerFixture({
		sessionName: "session-title",
		state: { git: { ...emptyGitStatus(), branch: "main" } },
		hooks: { canEmbedInEditor: () => canEmbed },
	});

	config.footerSegments.sessionName = true;
	const inline = handle.renderInline(100);
	assert.ok(inline);
	assert.match(inline.top.left, /session-title · .*main/);
	assert.match(inline.top.right, /project · .*0\.0%/);
	assert.ok(inline.top.right.indexOf("project") < inline.top.right.indexOf("%"));
	assert.match(inline.bottom.left, /gpt-5/);

	// The inline top border honors the same toggle as the plain footer.
	config.footerSegments.sessionName = false;
	assert.ok(!handle.renderInline(100)!.top.left.includes("session-title"));

	// Narrow: the model block is shed first, matching the plain row's alignRight.
	const narrow = handle.renderInline(30);
	assert.ok(narrow);
	assert.ok(visibleWidth(narrow.bottom.left) + visibleWidth(narrow.bottom.right) <= 30);
	assert.match(stripAnsi(narrow.bottom.right), /\$/);
	assert.match(stripAnsi(narrow.bottom.left), /\.\.\.$/);
	assert.equal(visibleWidth(handle.renderInline(visibleWidth(narrow.bottom.right) + 1)!.bottom.left), 0);

	config.inlineFooter = true;
	assert.deepEqual(component.render(40), []);
	canEmbed = false;
	const fallback = component.render(100).map(stripAnsi);
	assert.equal(fallback.length, 2);
	assert.match(fallback[0]!, /main/);
	assert.match(fallback[1]!, /gpt-5/);
	canEmbed = true;
	assert.deepEqual(component.render(100), []);
});

// Icon modes and runtime detection.
test("auto gates Nerd icons by TTY and UTF-8 support", (t) => {
	const envKeys = ["TERM_PROGRAM", "LC_TERMINAL", "WT_SESSION", "TERM", "LC_ALL", "LC_CTYPE", "LANG", "SSH_CONNECTION", "SSH_TTY"];
	preserveEnvironment(t, envKeys);
	const hadOwnIsTTY = Object.hasOwn(process.stdout, "isTTY");
	const originalIsTTY = process.stdout.isTTY;

	try {
		for (const key of envKeys) delete process.env[key];
		process.env.TERM = "xterm-256color";
		process.env.LANG = "C.UTF-8";
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		process.env.TERM_PROGRAM = "WezTerm";
		process.env.LANG = "C";
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
		assert.equal(resolveIconMode("auto"), "ascii");

		process.env.LANG = "C.UTF-8";
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		assert.equal(resolveIconMode("auto"), "nerd");

		process.env.TERM_PROGRAM = "unknown-runner";
		assert.equal(detectNerdFont(), true);

		process.env.LANG = "C";
		assert.equal(resolveIconMode("auto"), "ascii");

		process.env.LANG = "C.UTF-8";
		process.env.TERM = "dumb";
		assert.equal(resolveIconMode("auto"), "ascii");

		process.env.TERM = "xterm-256color";
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
		assert.equal(resolveIconMode("auto"), "ascii");
	} finally {
		if (hadOwnIsTTY) {
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
		} else {
			Reflect.deleteProperty(process.stdout, "isTTY");
		}
	}
});

test("every icon mode provides every footer semantic", () => {
	const keys = [
		"cwd",
		"host",
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

	for (const mode of ["nerd", "unicode", "ascii"] as const) {
		const glyphs = resolveGlyphs(mode);
		for (const key of keys) assert.notEqual(glyphs[key], "", `${mode}.${key}`);
	}
});

test("auto falls back to unicode icons for SSH sessions", (t) => {
	const envKeys = ["SSH_CONNECTION", "SSH_TTY", "TERM", "LC_ALL", "LC_CTYPE", "LANG"];
	preserveEnvironment(t, envKeys);
	const hadOwnIsTTY = Object.hasOwn(process.stdout, "isTTY");
	const originalIsTTY = process.stdout.isTTY;

	try {
		for (const key of envKeys) delete process.env[key];
		process.env.TERM = "xterm-256color";
		process.env.LANG = "C.UTF-8";
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

		assert.equal(resolveIconMode("auto"), "nerd");

		process.env.SSH_CONNECTION = "10.0.0.2 51234 10.0.0.1 22";
		process.env.SSH_TTY = "/dev/pts/4";
		assert.equal(resolveIconMode("auto"), "unicode");

		// Explicit modes win over the SSH heuristic.
		assert.equal(resolveIconMode("nerd"), "nerd");
		assert.equal(resolveIconMode("unicode"), "unicode");
		assert.equal(resolveIconMode("ascii"), "ascii");
	} finally {
		if (hadOwnIsTTY) Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
		else Reflect.deleteProperty(process.stdout, "isTTY");
	}
});

test("can preserve provider name casing", () => {
	const ctx = {
		model: { provider: "openAI", id: "gpt-5", reasoning: false },
	} as unknown as ExtensionContext;
	const thinkingLevel = () => "off";

	assert.equal(getModelMeta(ctx, thinkingLevel, true).provider, "OpenAI");
	assert.equal(getModelMeta(ctx, thinkingLevel, false).provider, "openAI");
});

test("uses the official Nerd Font runtime symbols", () => {
	assert.equal(runtimeSymbol("nodejs", "nerd"), "\uE718");
	assert.equal(runtimeSymbol("bun", "nerd"), "\uE76F");
	assert.equal(runtimeSymbol("bun", "ascii"), "bun");
	assert.equal(runtimeSymbol("bun", "unicode"), "bun");
});

test("unicode glyphs avoid private-use codepoints", () => {
	const glyphs = resolveGlyphs("unicode");
	for (const [key, glyph] of Object.entries(glyphs)) {
		for (const ch of glyph) {
			const cp = ch.codePointAt(0)!;
			const isPrivateUse = (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;
			assert.ok(!isPrivateUse, `${key} contains private-use U+${cp.toString(16).toUpperCase()}`);
		}
	}
	assert.equal(resolveGlyphs("unicode").cwd, "\u{1F4C1}");
});

test("prefers Bun lockfiles while preserving the Node fallback", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "open-tui-runtime-"));
	try {
		writeFileSync(join(cwd, "package.json"), "{}");
		assert.equal((await readRuntimeInfo(cwd))?.name, "nodejs");

		writeFileSync(join(cwd, "package-lock.json"), "{}");
		assert.equal((await readRuntimeInfo(cwd))?.name, "nodejs");

		writeFileSync(join(cwd, "bun.lock"), "");
		assert.equal((await readRuntimeInfo(cwd))?.name, "bun");

		rmSync(join(cwd, "bun.lock"));
		writeFileSync(join(cwd, "bun.lockb"), "");
		assert.equal((await readRuntimeInfo(cwd))?.name, "bun");

		rmSync(join(cwd, "bun.lockb"));
		assert.equal((await readRuntimeInfo(cwd))?.name, "nodejs");
	} finally {
		clearRuntimeCache();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("detects runtime project suffixes and Java versions on either output stream", () => {
	const root = mkdtempSync(join(tmpdir(), "open-tui-runtime-"));
	try {
		const script = `
			import assert from "node:assert/strict";
			import childProcess from "node:child_process";
			import { syncBuiltinESMExports } from "node:module";
			import { mkdirSync, writeFileSync } from "node:fs";
			import { join } from "node:path";
			import { promisify } from "node:util";
			let stdout = "";
			let stderr = "";
			let fail = false;
			childProcess.execFile = Object.assign(() => {}, {
				[promisify.custom]: async () => {
					if (fail) throw new Error("version command failed");
					return { stdout, stderr };
				},
			});
			syncBuiltinESMExports();
			const { readRuntimeInfo, clearRuntimeCache } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "extensions", "open-tui", "runtime.ts")).href)});
			const root = ${JSON.stringify(root)};
			for (const key of ["MESON_DEVENV", "IN_NIX_SHELL", "GUIX_ENVIRONMENT", "CONDA_DEFAULT_ENV", "PIXI_ENVIRONMENT_NAME", "SPACK_ENV"]) delete process.env[key];
			for (const [marker, name] of [
				["app.csproj", "dotnet"], ["app.fsproj", "dotnet"],
				["app.nimble", "nim"], ["app.Rproj", "r"],
				["app.cabal", "haskell"], ["app.opam", "ocaml"], ["main.scala", "scala"],
				["CMakeLists.txt", "cpp"], ["Makefile", "cpp"],
			]) {
				const cwd = join(root, marker);
				mkdirSync(cwd);
				writeFileSync(join(cwd, marker), "", "utf8");
				assert.equal((await readRuntimeInfo(cwd))?.name, name, marker);
			}
			const cwd = join(root, "java");
			mkdirSync(cwd);
			writeFileSync(join(cwd, "pom.xml"), "", "utf8");
			for (const stream of ["stdout", "stderr"]) {
				stdout = stream === "stdout" ? 'openjdk version "21.0.2"' : "launcher notice\\n";
				stderr = stream === "stderr" ? 'openjdk version "21.0.2"' : "";
				clearRuntimeCache();
				assert.deepEqual(await readRuntimeInfo(cwd), { name: "java", version: "21.0.2" });
			}
			fail = true;
			clearRuntimeCache();
			assert.deepEqual(await readRuntimeInfo(cwd), { name: "java", version: undefined });
		`;
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			timeout: 15_000,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Session usage and footer labels.
test("normalizes invalid usage totals", () => {
	const usage = {
		input: Number.POSITIVE_INFINITY,
		output: undefined,
		cacheRead: 100,
		cacheWrite: null,
		cost: { total: Number.NaN },
	};
	const ctx = {
		sessionManager: {
			getLeafId: () => "invalid-usage",
			getEntries: () => [{ id: "invalid-usage", timestamp: 1, type: "message", message: { role: "assistant", usage } }],
		},
	} as unknown as ExtensionContext;

	invalidateUsageCache();
	assert.deepEqual(getUsageTotals(ctx), {
		input: 0, output: 0, cacheRead: 100, cacheWrite: 0, cost: 0, latestCacheHitRate: 100,
	});
	invalidateUsageCache();
});

test("usage totals count cache-write tokens as input, matching /session's uncached figure", () => {
	// cacheWrite is fresh, near-full-price content; cacheRead is discounted repeat
	// content and stays out of "input".
	const usage = {
		input: 90,
		output: 12,
		cacheRead: 5000,
		cacheWrite: 27009,
		cost: { total: 0.01 },
	};
	const ctx = {
		sessionManager: {
			getLeafId: () => "cache-write",
			getEntries: () => [{ id: "cache-write", timestamp: 1, type: "message", message: { role: "assistant", usage } }],
		},
	} as unknown as ExtensionContext;

	invalidateUsageCache();
	const totals = getUsageTotals(ctx);
	assert.equal(totals.input, 27099);
	assert.equal(totals.cacheRead, 5000);
	invalidateUsageCache();
});

test("usage totals include tool result and summary usage", () => {
	const entries = [
		{
			id: "assistant-usage",
			timestamp: 1,
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 90, output: 12, cacheRead: 5000, cacheWrite: 27009, cost: { total: 0.01 } },
			},
		},
		{
			id: "tool-usage",
			timestamp: 2,
			type: "message",
			message: {
				role: "toolResult",
				usage: { input: 40, output: 8, cacheRead: 100, cacheWrite: 20, cost: { total: 0.02 } },
			},
		},
		{
			id: "compaction-usage",
			timestamp: 3,
			type: "compaction",
			usage: { input: 7, output: 3, cacheRead: 200, cacheWrite: 5, cost: { total: 0.03 } },
		},
		{
			id: "branch-summary-usage",
			timestamp: 4,
			type: "branch_summary",
			usage: { input: 11, output: 4, cacheRead: 300, cacheWrite: 9, cost: { total: 0.04 } },
		},
	];
	const ctx = { sessionManager: { getLeafId: () => entries.at(-1)?.id ?? null, getEntries: () => entries } } as unknown as ExtensionContext;

	invalidateUsageCache();
	assert.deepEqual(getUsageTotals(ctx), {
		input: 27_191, output: 27, cacheRead: 5_600, cacheWrite: 27_043, cost: 0.1,
		latestCacheHitRate: (5000 / 32_099) * 100,
	});
	invalidateUsageCache();
});

test("usage prewarming is accumulated without changing assistant cache-hit rate or copying entries on cache hits", () => {
	const warm = {
		id: "warm-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
		type: "usage", kind: "cache_warm", provider: "openai", model: "gpt-5",
		usage: { input: 2, output: 0, cacheRead: 100, cacheWrite: 8, cost: { total: 0.125 } },
	};
	const entries: unknown[] = [warm];
	let leafId: string | null = warm.id;
	let reads = 0;
	const ctx = {
		sessionManager: {
			getLeafId: () => leafId,
			getEntries: () => {
				reads++;
				return entries.slice();
			},
		},
	} as unknown as ExtensionContext;
	invalidateUsageCache();
	try {
		const initial = getUsageTotals(ctx);
		assert.deepEqual(initial, {
			input: 10, output: 0, cacheRead: 100, cacheWrite: 8, cost: 0.125,
			latestCacheHitRate: undefined,
		});
		assert.strictEqual(getUsageTotals(ctx), initial);
		assert.equal(reads, 1);
		// Branch navigation invalidates the leaf cache, not accumulated usage.
		leafId = null;
		assert.deepEqual(getUsageTotals(ctx), initial);
		assert.equal(reads, 2);

		entries.push({
			id: "assistant", type: "message", message: {
				role: "assistant",
				usage: { input: 10, output: 3, cacheRead: 40, cacheWrite: 30, cost: { total: 0.25 } },
			},
		});
		leafId = "assistant";
		assert.equal(getUsageTotals(ctx).latestCacheHitRate, 50);
		assert.equal(reads, 3);
		entries.push({ ...warm, id: "warm-2", parentId: "assistant" });
		leafId = "warm-2";
		const total = getUsageTotals(ctx);
		assert.deepEqual(total, {
			input: 60, output: 3, cacheRead: 240, cacheWrite: 46, cost: 0.5,
			latestCacheHitRate: 50,
		});
		assert.strictEqual(getUsageTotals(ctx), total);
		assert.equal(reads, 4);
	} finally {
		invalidateUsageCache();
	}
});

test("ASCII footer renders icons as semantic labels", () => {
	const entries = [{
		id: "usage-1",
		timestamp: Date.now(),
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 90,
				output: 12,
				cacheRead: 5000,
				cacheWrite: 27009,
				cost: { total: 0.01 },
			},
		},
	}];
	let extensionStatusReads = 0;
	const { component, config } = footerFixture({
		cwd: () => "C:\\work\\project", entries, contextTokens: 250, effort: "high",
		state: {
			git: { ...emptyGitStatus(), branch: "main", modified: 2 },
			runtime: { name: "nodejs", version: "24.6.0" },
			workingSince: Date.now() - 2_000,
		},
		statuses: () => {
			extensionStatusReads++;
			return new Map([["goal", "goal active"]]);
		},
	});
	const output = component.render(160).join("\n");

	for (const expected of [
		"@",
		"* main",
		"!2",
		"node 24.6.0",
		"o working",
		"#",
		"M",
		"~ high",
		"↑ 32k (U 27k + R 5.0k)",
		"↓ 12",
		"c 15.6%",
		"$ $0.010",
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
	nerdIconSpacing?: boolean;
	width?: number;
}): string {
	const {
		sessionName,
		mode = "ascii",
		sessionNameEnabled = true,
		nerdIconSpacing = false,
		width = 160,
	} = opts;
	const { component, config } = footerFixture({ sessionName: sessionName === undefined ? "test-session" : sessionName, mode });
	config.footerSegments.sessionName = sessionNameEnabled;
	config.footerSegments.nerdIconSpacing = nerdIconSpacing;
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

test("nerdIconSpacing adds one blank after Nerd icons only", () => {
	const nerd = resolveGlyphs("nerd").session;
	// On first, so a mutated shared glyph table would fail the later checks.
	assert.ok(renderFooterWithSession({ mode: "nerd", sessionName: "s", nerdIconSpacing: true }).includes(`${nerd}  s`));
	assert.ok(renderFooterWithSession({ mode: "nerd", sessionName: "s" }).includes(`${nerd} s`));
	assert.ok(renderFooterWithSession({ sessionName: "s", nerdIconSpacing: true }).includes(`${resolveGlyphs("ascii").session} s`));
});

test("session name uses matching glyph in nerd and ascii modes", () => {
	const asciiOut = renderFooterWithSession({ mode: "ascii", sessionName: "sess" });
	assert.ok(asciiOut.includes(resolveGlyphs("ascii").session), `ascii glyph missing\n${asciiOut}`);
	const nerdOut = renderFooterWithSession({ mode: "nerd", sessionName: "sess" });
	assert.ok(nerdOut.includes(resolveGlyphs("nerd").session), `nerd glyph missing\n${nerdOut}`);
});

function renderFooterWithHost(opts: {
	mode?: "nerd" | "ascii";
	hostnameEnabled?: boolean;
	width?: number;
} = {}): string {
	const { mode = "ascii", hostnameEnabled = true, width = 160 } = opts;
	const { component, config } = footerFixture({ mode });
	config.footerSegments.hostname = hostnameEnabled;
	return component.render(width).join("\n");
}

test("short hostname keeps the first label across host name formats", () => {
	assert.equal(shortHostname("mba.example.com"), "mba");
	assert.equal(shortHostname("OldSun_Laptop"), "OldSun_Laptop");
	assert.equal(shortHostname(""), "");
});

test("footer shows the short host name next to cwd when enabled", () => {
	const expectedHost = shortHostname(hostname());
	const out = renderFooterWithHost();
	assert.ok(out.includes(`${resolveGlyphs("ascii").host} ${expectedHost}`), `missing short host name\n${out}`);
});

test("footer hides host name when footerSegments.hostname is false", () => {
	const expectedHost = shortHostname(hostname());
	const out = renderFooterWithHost({ hostnameEnabled: false });
	assert.ok(!out.includes(`${resolveGlyphs("ascii").host} ${expectedHost}`), `should be hidden when disabled\n${out}`);
});

test("host name uses matching glyph in nerd and ascii modes", () => {
	const asciiOut = renderFooterWithHost({ mode: "ascii" });
	assert.ok(asciiOut.includes(resolveGlyphs("ascii").host), `ascii glyph missing\n${asciiOut}`);
	const nerdOut = renderFooterWithHost({ mode: "nerd" });
	assert.ok(nerdOut.includes(resolveGlyphs("nerd").host), `nerd glyph missing\n${nerdOut}`);
});

// Real SGR codes keep the width maths honest: visibleWidth() must ignore them.
const styledTheme = {
	fg: (color: string, text: string) => {
		const codes: Record<string, string> = { mdLink: "36", dim: "90", muted: "37" };
		return `\x1b[${codes[color] ?? "39"}m${text}\x1b[39m`;
	},
} as Theme;

// Extension status rows and working telemetry.
function renderStatusLines(statuses: Map<string, string>, width = 160): string[] {
	const { component } = footerFixture({ statuses: () => statuses, theme: styledTheme });
	// The two main footer rows come first, status rows follow them.
	return component.render(width).slice(2);
}

test("status sanitising keeps supported SGR colors and rejects other controls", () => {
	assert.equal(sanitizeStatusPreservingStyles("\x1b[32mok\x1b[39m"), "\x1b[32mok\x1b[39m");
	assert.equal(sanitizeStatusPreservingStyles("\x1b[38;5;123mcolor\x1b[0m"), "\x1b[38;5;123mcolor\x1b[0m");
	assert.equal(sanitizeStatusPreservingStyles("\x1b[>4;2mprivate"), "private");
	assert.equal(sanitizeStatusPreservingStyles("\x1b]0;title\x9b31m\x07visible"), "visible");
});

test("status sanitising flattens whitespace and drops cursor sequences", () => {
	assert.equal(sanitizeStatusPreservingStyles("a\tb\nc"), "a b c");
	assert.equal(sanitizeStatusPreservingStyles("a   b"), "a b");
	assert.equal(sanitizeStatusPreservingStyles("\x1b[?25lhidden"), "hidden");
	assert.equal(sanitizeStatusPreservingStyles("\x1b]0;title\x07visible"), "visible");
});

test("status sanitising removes complete string control sequences", () => {
	const controls = [
		"\x1bPpayload\x1b\\",
		"\x90payload\x9c",
		"\x1bXpayload\x1b\\",
		"\x98payload\x9c",
		"\x1b^payload\x1b\\",
		"\x9epayload\x9c",
		"\x1b_payload\x1b\\",
		"\x9fpayload\x9c",
		"\x1b]0;title\x07",
		"\x1b]0;title\x1b\\",
		"\x9d0;title\x07",
		"\x9d0;title\x9c",
	];
	for (const control of controls) {
		assert.equal(sanitizeStatusPreservingStyles(`before${control}after`), "before after");
	}
	assert.equal(sanitizeStatusPreservingStyles("before\x1bPunterminated"), "before");
});

test("status line keeps the colours set by extensions", () => {
	const lines = renderStatusLines(new Map([
		["memory", "\x1b[35mMemory\x1b[39m"],
		["plain", "goal active"],
	]));
	const out = lines.join("\n");

	// The extension's own magenta survives, plain text falls back to muted.
	assert.ok(out.includes("\x1b[35mMemory\x1b[39m"), `extension colour dropped\n${out}`);
	assert.ok(out.includes("\x1b[37mgoal active\x1b[39m"), `muted fallback missing\n${out}`);
	assert.ok(!out.includes("\x1b[37mMemory"), `status must not be repainted muted\n${out}`);
});

test("status line closes an unclosed style before the separator", () => {
	const lines = renderStatusLines(new Map([
		["bold", "\x1b[1mworking"],
		["next", "idle"],
	]));
	const out = lines.join("\n");

	assert.ok(
		out.includes("\x1b[1mworking\x1b[0m \x1b[90m|"),
		`separator inherits the unclosed style\n${out}`,
	);
});

test("status line drops sequences that could rewrite the terminal", () => {
	const lines = renderStatusLines(new Map([
		["mcp", "\x1b[?25lconn\x1b]0;evil\x07ected \x1b[32mdone\x1b[39m"],
	]));
	const out = lines.join("\n");

	assert.equal(stripAnsi(out).includes("conn ected done"), true, `text damaged\n${out}`);
	assert.ok(!out.includes("\x1b[?25l"), `cursor sequence leaked\n${out}`);
	assert.ok(!out.includes("\x1b]0;"), `OSC sequence leaked\n${out}`);
});

test("status line wraps coloured text inside the given width", () => {
	const long = `\x1b[31m${"x".repeat(120)}\x1b[39m`;
	const lines = renderStatusLines(new Map([["long", long]]), 40);

	assert.ok(lines.length > 1, "long status should wrap");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 40, `width ${visibleWidth(line)} exceeds 40`);
	}
});

test("working timer shows live TPS gated by its footer setting and sheds it first", () => {
	let liveTps: LiveTps | null = { tps: 53.5, stale: false };
	// Tag the color of the TPS part so the stale (dim) state is visible.
	const tpsTheme = { fg: (color: string, text: string) => text.includes("tok/s") ? `<${color}>${text}` : text } as Theme;
	const { component, config, state } = footerFixture({
		state: { workingSince: Date.now() }, theme: tpsTheme, hooks: { getLiveTps: () => liveTps },
	});
	config.footerSegments.hostname = false;
	const line = (width = 120) => component.render(width)[0]!;

	assert.match(line(), /o working \S+ · <accent>> ~54 tok\/s/);
	liveTps = { tps: 53.5, stale: true };
	assert.match(line(), /o working \S+ · <dim>> ~54 tok\/s/);
	liveTps = { tps: 53.5, stale: false };
	const narrow = line(60);
	assert.match(narrow, /working/);
	assert.doesNotMatch(narrow, /tok\/s/);

	config.footerSegments.liveTps = false;
	assert.doesNotMatch(line(), /tok\/s/);
	config.footerSegments.liveTps = true;
	// The footer switch is independent of the telemetry notification settings.
	config.telemetry.enabled = false;
	assert.match(line(), /~54 tok\/s/);
	config.telemetry.enabled = true;
	liveTps = null;
	assert.doesNotMatch(line(), /tok\/s/);
	liveTps = { tps: 53.5, stale: false };
	state.workingSince = undefined;
	state.lastDoneIn = 1_000;
	assert.doesNotMatch(line(), /tok\/s/);
});
