import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { IconMode } from "./icons.ts";

export type SettingsLanguage = "en" | "zh";
export type CursorStyle = "block" | "bar" | "underline";
export type ThinkingPeekLines = 0 | 1 | 2;
export type ToolViewMode = "native" | "compact";

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
	liveTps: boolean;
	extensionStatuses: boolean;
	capitalizeProviderName: boolean;
	nerdIconSpacing: boolean;
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
	/** Override Pi's header with the open-tui header. When false, the header slot is left to Pi or another extension. */
	header: boolean;
	inlineFooter: boolean;
	/** Clickable `Copy` labels on code blocks and user messages (fullscreen mode only). */
	copyButtons: boolean;
	settingsLanguage: SettingsLanguage;
	cursorStyle: CursorStyle;
	icons: {
		mode: IconMode;
	};
	footerSegments: FooterSegments;
	telemetry: TelemetryConfig;
	thinkingPeek: ThinkingPeekConfig;
	toolView: {
		mode: ToolViewMode;
	};
}

export const DEFAULT_CONFIG: OpenTuiConfig = {
	enabled: true,
	header: true,
	inlineFooter: false,
	copyButtons: true,
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
		liveTps: true,
		extensionStatuses: true,
		capitalizeProviderName: true,
		nerdIconSpacing: false,
	},
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
	toolView: {
		mode: "native",
	},
};

export function getConfigPath(): string {
	const agentDir = getAgentDir();
	return join(agentDir, "open-tui.json");
}

function normalizeThinkingPeekLines(value: unknown): ThinkingPeekLines {
	return value === 0 || value === 1 || value === 2 ? value : DEFAULT_CONFIG.thinkingPeek.lines;
}

const ICON_MODES: IconMode[] = ["auto", "nerd", "unicode", "ascii"];

// Non-boolean flags (e.g. "false" strings) fall back to defaults instead of reading as truthy.
function normalizeFlags<T extends object>(value: unknown, defaults: T): T {
	const source = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
	const result: Record<string, unknown> = { ...source };
	for (const [key, fallback] of Object.entries(defaults)) {
		if (typeof result[key] !== "boolean") result[key] = fallback;
	}
	return result as T;
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
		if (typeof config.enabled !== "boolean") {
			config.enabled = DEFAULT_CONFIG.enabled;
		}
		if (typeof config.header !== "boolean") {
			config.header = DEFAULT_CONFIG.header;
		}
		if (typeof config.inlineFooter !== "boolean") {
			config.inlineFooter = DEFAULT_CONFIG.inlineFooter;
		}
		if (typeof config.copyButtons !== "boolean") {
			config.copyButtons = DEFAULT_CONFIG.copyButtons;
		}
		config.footerSegments = normalizeFlags(config.footerSegments, DEFAULT_CONFIG.footerSegments);
		config.telemetry = normalizeFlags(config.telemetry, DEFAULT_CONFIG.telemetry);
		if (typeof config.icons !== "object" || config.icons === null || !ICON_MODES.includes(config.icons.mode)) {
			config.icons = structuredClone(DEFAULT_CONFIG.icons);
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
		if (typeof config.toolView !== "object" || config.toolView === null
			|| (config.toolView.mode !== "native" && config.toolView.mode !== "compact")) {
			config.toolView = structuredClone(DEFAULT_CONFIG.toolView);
		}
		return config;
	} catch (err) {
		notify?.(`open-tui config parse error: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: OpenTuiConfig): boolean {
	const path = getConfigPath();
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}
