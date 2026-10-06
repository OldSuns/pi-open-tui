import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { IconMode } from "./icons.ts";

export type SettingsLanguage = "en" | "zh";
export type CursorStyle = "block" | "bar" | "underline";
export type ThinkingPeekLines = 0 | 1 | 2;

const PROVIDER_COLOR_TOKENS = [
	"accent", "success", "warning", "error", "text", "muted", "dim", "mdLink",
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium",
	"thinkingHigh", "thinkingXhigh", "thinkingMax",
] as const satisfies readonly ThemeColor[];

export type ProviderColor = typeof PROVIDER_COLOR_TOKENS[number];
export type ProviderColors = Partial<Record<string, ProviderColor>>;

export type { IconMode } from "./icons.ts";

export interface FooterSegments {
	cwd: boolean;
	hostname: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCommit: boolean;
	runtime: boolean;
	context: boolean;
	tokens: boolean;
	cost: boolean;
	extensionStatuses: boolean;
	capitalizeProviderName: boolean;
}

export interface TelemetryConfig {
	enabled: boolean;
	tps: boolean;
	ttft: boolean;
	duration: boolean;
	tokens: boolean;
	stalls: boolean;
	cost: boolean;
}

export interface ThinkingPeekConfig {
	lines: ThinkingPeekLines;
}

export interface OpenTuiConfig {
	enabled: boolean;
	inlineFooter: boolean;
	settingsLanguage: SettingsLanguage;
	cursorStyle: CursorStyle;
	icons: {
		mode: IconMode;
	};
	footerSegments: FooterSegments;
	providerColors: ProviderColors;
	telemetry: TelemetryConfig;
	thinkingPeek: ThinkingPeekConfig;
}

export const DEFAULT_CONFIG: OpenTuiConfig = {
	enabled: true,
	inlineFooter: false,
	settingsLanguage: "en",
	cursorStyle: "block",
	icons: {
		mode: "auto",
	},
	footerSegments: {
		cwd: true,
		hostname: false,
		sessionName: false,
		gitBranch: true,
		gitStatus: true,
		gitCommit: false,
		runtime: true,
		context: true,
		tokens: true,
		cost: true,
		extensionStatuses: true,
		capitalizeProviderName: true,
	},
	providerColors: {},
	telemetry: {
		enabled: true,
		tps: true,
		ttft: true,
		duration: true,
		tokens: true,
		stalls: true,
		cost: true,
	},
	thinkingPeek: {
		lines: 1,
	},
};

export function getConfigPath(): string {
	const agentDir = getAgentDir();
	return join(agentDir, "open-tui.json");
}

function normalizeThinkingPeekLines(value: unknown): ThinkingPeekLines {
	return value === 0 || value === 1 || value === 2 ? value : DEFAULT_CONFIG.thinkingPeek.lines;
}

function isProviderColor(value: unknown): value is ProviderColor {
	return typeof value === "string" && PROVIDER_COLOR_TOKENS.some((token) => token === value);
}

function normalizeProviderColors(value: unknown): ProviderColors {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).flatMap(([provider, color]) =>
		provider && isProviderColor(color) ? [[provider.toLowerCase(), color]] : [],
	));
}

function deepMerge<T>(base: T, override: unknown): T {
	if (typeof base !== "object" || base === null || Array.isArray(base)) {
		return (override as T) ?? base;
	}
	if (typeof override !== "object" || override === null || Array.isArray(override)) {
		return base;
	}
	const result = { ...(base as Record<string, unknown>) };
	const overrideRec = override as Record<string, unknown>;
	for (const key of Object.keys(overrideRec)) {
		const baseVal = (base as Record<string, unknown>)[key];
		const overVal = overrideRec[key];
		if (typeof baseVal === "object" && baseVal !== null && !Array.isArray(baseVal)
			&& typeof overVal === "object" && overVal !== null && !Array.isArray(overVal)) {
			result[key] = deepMerge(baseVal, overVal);
		} else if (overVal !== undefined) {
			result[key] = overVal;
		}
	}
	return result as T;
}

export function ensureConfigExists(): void {
	const path = getConfigPath();
	if (existsSync(path)) return;
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
	} catch {
		// ponytail: silent fallback — config creation is best-effort
	}
}

export function loadConfig(notify?: (msg: string, level: "warning" | "info") => void): OpenTuiConfig {
	const path = getConfigPath();
	if (!existsSync(path)) {
		ensureConfigExists();
		return structuredClone(DEFAULT_CONFIG);
	}

	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const config = deepMerge(DEFAULT_CONFIG, parsed);
		config.providerColors = normalizeProviderColors(config.providerColors);
		if (typeof config.inlineFooter !== "boolean") {
			config.inlineFooter = DEFAULT_CONFIG.inlineFooter;
		}
		if (config.settingsLanguage !== "en" && config.settingsLanguage !== "zh") {
			config.settingsLanguage = DEFAULT_CONFIG.settingsLanguage;
		}
		if (config.cursorStyle !== "block" && config.cursorStyle !== "bar" && config.cursorStyle !== "underline") {
			config.cursorStyle = DEFAULT_CONFIG.cursorStyle;
		}
		if (typeof config.thinkingPeek !== "object" || config.thinkingPeek === null || Array.isArray(config.thinkingPeek)) {
			config.thinkingPeek = structuredClone(DEFAULT_CONFIG.thinkingPeek);
		} else {
			config.thinkingPeek.lines = normalizeThinkingPeekLines(config.thinkingPeek.lines);
		}
		return config;
	} catch (err) {
		notify?.(`open-tui config parse error: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: OpenTuiConfig): void {
	const path = getConfigPath();
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
	} catch {
		// ponytail: silent fallback — config save is best-effort
	}
}
