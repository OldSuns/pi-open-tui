import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OpenTuiConfig } from "./config.ts";
import type { IconGlyphs } from "./icons.ts";
import { resolveGlyphs, resolveIconMode, runtimeSymbol } from "./icons.ts";
import type { GitStatus } from "./git.ts";
import type { RuntimeInfo } from "./runtime.ts";
import {
	alignRight,
	basenamePath,
	cacheHitColor,
	effortColor,
	fitSegmentsByPriority,
	fmtTokens,
	formatCwd,
	formatDuration,
	formatInputBreakdown,
	formatProviderLabel,
	providerColor,
	sanitizeStatus,
	stressColor,
	truncateBranch,
	truncatePath,
	type PrioritizedSegment,
} from "./utils.ts";
import type { FooterState, ModelMeta, UsageTotals } from "./state.ts";
import { getUsageTotals } from "./state.ts";

function renderBar(theme: Theme, pct: number, barWidth: number, ascii: boolean): string {
	const filled = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
	const empty = barWidth - filled;
	const color = stressColor(pct);
	const filledCell = ascii ? "#" : "█";
	const emptyCell = ascii ? "-" : "░";
	return (
		theme.fg("dim", "[") +
		theme.fg(color, filledCell.repeat(filled)) +
		theme.fg("dim", emptyCell.repeat(empty)) +
		theme.fg("dim", "]")
	);
}

/** Compact context form: icon + percentage, no bar or token counts. */
function renderContextCompact(theme: Theme, ctx: ExtensionContext, glyphs: IconGlyphs): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (contextWindow <= 0) return "";
	const contextPct = contextUsage?.percent ?? 0;
	return `${theme.fg(stressColor(contextPct), glyphs.context)} ${theme.fg(stressColor(contextPct), `${contextPct.toFixed(1)}%`)}`;
}

function renderGitSegment(
	theme: Theme,
	git: GitStatus,
	glyphs: IconGlyphs,
	segments: OpenTuiConfig["footerSegments"],
	maxBranchLen = 20,
): string {
	const parts: string[] = [];
	if (segments.gitBranch) {
		if (git.branch) {
			parts.push(theme.fg("mdLink", glyphs.git));
			parts.push(theme.fg("mdLink", truncateBranch(git.branch, maxBranchLen)));
		} else if (git.commit?.detached) {
			parts.push(theme.fg("warning", glyphs.git));
			parts.push(theme.fg("warning", "HEAD"));
			if (git.commit.oid) {
				const shortHash = git.commit.oid.slice(0, 7);
				const tag = git.commit.tag ? ` ${git.commit.tag}` : "";
				parts.push(theme.fg("dim", `${shortHash}${tag}`));
			}
		}
	}

	if (segments.gitStatus) {
		const statusIcons: string[] = [];
		// ponytail: always show count — `!1` not `!`, so 1 vs 100 is distinguishable.
		const addStatus = (count: number, glyph: string, color: ThemeColor) => {
			if (count > 0) statusIcons.push(theme.fg(color, `${glyph}${count}`));
		};
		addStatus(git.conflicted, glyphs.conflicted, "error");
		addStatus(git.deleted, glyphs.deleted, "error");
		addStatus(git.modified, glyphs.modified, "warning");
		addStatus(git.renamed, glyphs.renamed, "warning");
		addStatus(git.staged, glyphs.staged, "success");
		addStatus(git.untracked, glyphs.untracked, "muted");
		addStatus(git.stashed, glyphs.stashed, "muted");

		if (git.ahead > 0 && git.behind > 0) {
			statusIcons.push(theme.fg("warning", `${glyphs.diverged}${git.ahead}/${git.behind}`));
		} else if (git.ahead > 0) {
			statusIcons.push(theme.fg("success", `${glyphs.ahead}${git.ahead}`));
		} else if (git.behind > 0) {
			statusIcons.push(theme.fg("warning", `${glyphs.behind}${git.behind}`));
		}

		const statusBlock = statusIcons.join(" ");
		if (statusBlock) {
			parts.push(`${theme.fg("dim", "[")}${statusBlock}${theme.fg("dim", "]")}`);
		}
	}

	return parts.join(" ");
}

function renderRuntimeSegment(
	theme: Theme,
	runtime: RuntimeInfo | null,
	iconMode: OpenTuiConfig["icons"]["mode"],
): string {
	if (!runtime) return "";
	const symbol = theme.fg("success", runtimeSymbol(runtime.name, iconMode));
	const version = runtime.version ? theme.fg("muted", runtime.version) : "";
	const label = [symbol, version].filter(Boolean).join(" ");
	return label;
}

function renderTimerSegment(theme: Theme, state: FooterState, glyphs: IconGlyphs): string {
	if (state.workingSince !== undefined) {
		return `${theme.fg("accent", glyphs.working)} ${theme.fg("dim", "working")} ${theme.fg("accent", formatDuration(Date.now() - state.workingSince))}`;
	}
	if (state.lastDoneIn !== undefined) {
		return `${theme.fg("success", glyphs.done)} ${theme.fg("success", "done")} ${theme.fg("text", formatDuration(state.lastDoneIn))}`;
	}
	return "";
}

function renderContextBar(
	theme: Theme,
	ctx: ExtensionContext,
	width: number,
	glyphs: IconGlyphs,
	iconMode: OpenTuiConfig["icons"]["mode"],
): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextTokens = contextUsage?.tokens ?? 0;
	const contextPct = contextUsage?.percent ?? 0;

	// ponytail: render 0% bar once we know the window — keeps the right side
	// populated instead of collapsing everything left in an empty session.
	if (contextWindow <= 0) return "";

	const pctText = theme.fg(stressColor(contextPct), `${contextPct.toFixed(1)}%`);
	const ctxText = `${theme.fg("text", fmtTokens(contextTokens))}${theme.fg("dim", "/")}${theme.fg("text", fmtTokens(contextWindow))}`;
	const contextIcon = theme.fg(stressColor(contextPct), glyphs.context);
	// Cap the bar at `width - reserved` (with a floor of 4) so the full form
	// never forces the left segments out before compact/drop logic kicks in.
	const reserved = visibleWidth(contextIcon) + visibleWidth(pctText) + visibleWidth(ctxText) + 5 + 2;
	const barWidth = Math.max(4, Math.min(12, width - reserved));
	return `${contextIcon} ${renderBar(theme, contextPct, barWidth, resolveIconMode(iconMode) === "ascii")} ${pctText} ${theme.fg("dim", "·")} ${ctxText}`;
}

function renderStatsBlock(
	theme: Theme,
	totals: UsageTotals,
	glyphs: IconGlyphs,
	segments: OpenTuiConfig["footerSegments"],
): string {
	const stats: string[] = [];
	if (segments.tokens) {
		stats.push(theme.fg("accent", `${glyphs.input} ${formatInputBreakdown(totals.input, totals.cacheRead)}`));
		stats.push(theme.fg("success", `${glyphs.output} ${fmtTokens(totals.output)}`));
		// ponytail: hide cache-hit rate when the provider never reported cache
		// tokens — avoids a misleading "0%" on providers without prompt caching.
		const hasCacheTokens = totals.cacheRead > 0 || totals.cacheWrite > 0;
		if (hasCacheTokens && totals.latestCacheHitRate !== undefined) {
			stats.push(theme.fg(cacheHitColor(totals.latestCacheHitRate), `${glyphs.cacheHit} ${totals.latestCacheHitRate.toFixed(1)}%`));
		}
	}
	if (segments.cost) {
		stats.push(theme.fg("warning", `${glyphs.cost} $${totals.cost.toFixed(3)}`));
	}

	return stats.join(` ${theme.fg("dim", "|")} `);
}

function renderExtensionStatusLines(
	theme: Theme,
	extensionStatuses: ReadonlyMap<string, string>,
	glyphs: IconGlyphs,
	width: number,
): string[] {
	const statuses = Array.from(extensionStatuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatus(text))
		.filter((text) => text.length > 0);
	if (statuses.length === 0) return [];

	const separator = ` ${theme.fg("dim", "|")} `;
	const statusText = statuses.map((status) => theme.fg("muted", status)).join(separator);
	const line = `${theme.fg("mdLink", glyphs.extensions)} ${statusText}`;
	return wrapTextWithAnsi(line, width);
}

export interface FooterHooks {
	setRequestRender: (fn: (() => void) | undefined) => void;
	scheduleGitRefresh: () => void;
}

export function installFooter(
	ctx: ExtensionContext,
	getState: () => FooterState,
	getConfig: () => OpenTuiConfig,
	getModelMeta: () => ModelMeta,
	hooks: FooterHooks,
): () => void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		hooks.setRequestRender(() => tui.requestRender());
		const unsubBranch = footerData.onBranchChange(() => {
			hooks.scheduleGitRefresh();
			tui.requestRender();
		});

		return {
			dispose() {
				unsubBranch();
				hooks.setRequestRender(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [""];
				const state = getState();
				const config = getConfig();
				const glyphs = resolveGlyphs(config.icons.mode);
				const segments = config.footerSegments;
				const meta = getModelMeta();

				const totals = getUsageTotals(ctx);

				const leftParts: PrioritizedSegment[] = [];
				if (segments.cwd) {
					const maxCwd = Math.min(30, Math.max(10, Math.floor(width * 0.4)));
					const cwd = formatCwd(ctx.sessionManager.getCwd());
					const cwdPrefix = `${theme.fg("mdLink", glyphs.cwd)} `;
					const accent = (text: string) => theme.fg("accent", text);
					leftParts.push({
						text: `${cwdPrefix}${accent(truncatePath(cwd, maxCwd))}`,
						compactText: `${cwdPrefix}${accent(truncatePath(basenamePath(cwd), maxCwd))}`,
						priority: 0,
						truncate: (_text, maxWidth, ellipsis) => {
							const pathWidth = maxWidth - visibleWidth(cwdPrefix);
							if (pathWidth <= visibleWidth(ellipsis)) {
								return truncateToWidth(`${cwdPrefix}${accent(basenamePath(cwd))}`, maxWidth, ellipsis);
							}
							return `${cwdPrefix}${accent(truncatePath(basenamePath(cwd), pathWidth))}`;
						},
					});
				}
				if (segments.sessionName) {
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) {
						leftParts.push({
							text: `${theme.fg("dim", glyphs.session)} ${theme.fg("text", truncateToWidth(sessionName, 24, theme.fg("dim", "...")))}`,
							priority: 2,
						});
					}
				}
				const gitSeg = renderGitSegment(theme, state.git, glyphs, segments);
				if (gitSeg) leftParts.push({ text: gitSeg, priority: 3 });
				if (segments.runtime) {
					const runtimeSeg = renderRuntimeSegment(theme, state.runtime, config.icons.mode);
					if (runtimeSeg) leftParts.push({ text: runtimeSeg, priority: 4 });
				}
				const timerSeg = renderTimerSegment(theme, state, glyphs);
				if (timerSeg) leftParts.push({ text: timerSeg, priority: 1 });

				// The context bar competes with the left segments for the same row:
				// full bar first, then the compact icon+pct form, then dropped.
				let contextText = "";
				let contextCompact: string | undefined;
				if (segments.context) {
					contextText = renderContextBar(theme, ctx, width, glyphs, config.icons.mode);
					const compact = renderContextCompact(theme, ctx, glyphs);
					if (compact && visibleWidth(compact) < visibleWidth(contextText)) {
						contextCompact = compact;
					}
				}
				const allParts: PrioritizedSegment[] = [...leftParts];
				if (contextText) {
					// ponytail: priority 4 = sheds with runtime, before git/timer/cwd.
					allParts.push({ text: contextText, compactText: contextCompact, priority: 4 });
				}

				const fitted = fitSegmentsByPriority(allParts, width, theme.fg("dim", "..."));
				const fittedContext = contextText ? fitted.pop() ?? "" : "";
				const line1 = alignRight(fitted.join(" "), fittedContext, width, theme);

				const modelParts: string[] = [];
				modelParts.push(theme.fg("mdLink", glyphs.model));
				if (meta.provider && meta.provider !== "Unknown") {
					modelParts.push(theme.fg(providerColor(ctx.model?.provider ?? "none"), meta.provider));
				}
				modelParts.push(theme.fg("text", meta.model));
				if (meta.effort && meta.effort !== "off") {
					modelParts.push(theme.fg(effortColor(meta.effort), `${glyphs.thinking} ${meta.effort}`));
				}
				const modelBlock = modelParts.join(theme.fg("dim", " · "));

				const statsBlock = renderStatsBlock(
					theme,
					totals,
					glyphs,
					segments,
				);

				const line2 = alignRight(modelBlock, statsBlock, width, theme);

				const mainLines = [line1, line2]
					.map((line) => truncateToWidth(line, width, theme.fg("dim", "...")));
				return segments.extensionStatuses
					? [
						...mainLines,
						...renderExtensionStatusLines(
							theme,
							footerData.getExtensionStatuses(),
							glyphs,
							width,
						),
					]
					: mainLines;
			},
		};
	});

	return () => {
		ctx.ui.setFooter(undefined);
	};
}
