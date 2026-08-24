import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { GitStatus } from "./git.ts";
import { emptyGitStatus } from "./git.ts";
import type { RuntimeInfo } from "./runtime.ts";
import { finiteOrZero, fmtTokens, formatProviderLabel } from "./utils.ts";

export interface FooterState {
	git: GitStatus;
	runtime: RuntimeInfo | null;
	sessionStartEpoch: number;
	workingSince: number | undefined;
	lastDoneIn: number | undefined;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

let usageCache: { key: string; totals: UsageTotals } | undefined;

function entriesKey(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	const last = entries.at(-1);
	return `${entries.length}:${last?.id ?? ""}:${last?.timestamp ?? ""}`;
}

export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const key = entriesKey(ctx);
	if (usageCache && usageCache.key === key) return usageCache.totals;

	const totals: UsageTotals = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
		latestCacheHitRate: undefined,
	};
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const m = entry.message as AssistantMessage;
			const u = m.usage;
			if (!u) continue;
			const input = finiteOrZero(u.input);
			const cacheRead = finiteOrZero(u.cacheRead);
			const cacheWrite = finiteOrZero(u.cacheWrite);
			// input matches /session's "uncached" total: cacheWrite is billed near full
			// price (fresh content), only cacheRead is discounted repeat content.
			totals.input += input + cacheWrite;
			totals.output += finiteOrZero(u.output);
			totals.cacheRead += cacheRead;
			totals.cacheWrite += cacheWrite;
			totals.cost += finiteOrZero(u.cost?.total);
			const promptTokens = input + cacheRead + cacheWrite;
			if (promptTokens > 0) {
				totals.latestCacheHitRate = (cacheRead / promptTokens) * 100;
			}
		}
	}
	usageCache = { key, totals };
	return totals;
}

export function invalidateUsageCache(): void {
	usageCache = undefined;
}

export function createInitialState(): FooterState {
	return {
		git: emptyGitStatus(),
		runtime: null,
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
	};
}

export interface ModelMeta {
	provider: string;
	model: string;
	effort: string | undefined;
}

export function getModelMeta(
	ctx: ExtensionContext,
	getThinkingLevel: () => string,
): ModelMeta {
	const provider = formatProviderLabel(ctx.model?.provider);
	const model = ctx.model?.name ?? ctx.model?.id ?? "no-model";
	const reasoning = ctx.model?.reasoning ?? false;
	const effort = reasoning ? getThinkingLevel() : undefined;
	return { provider, model, effort };
}
