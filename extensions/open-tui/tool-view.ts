import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionAPI, SourceInfo, Theme, ThemeColor, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, type Component, getCapabilities, getImageDimensions, imageFallback, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolViewConfig } from "./config.ts";
import type { IconGlyphs } from "./icons.ts";
import { codeLines, prepareToolPreview } from "./tool-preview.ts";
import { sanitizeStatus, stripAnsi } from "./utils.ts";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];
type ToolResult = Parameters<RenderResult>[0];
type Args = Record<string, unknown>;

const TOOL_LABELS: Record<string, string> = {
	read: "Read",
	bash: "Bash",
	powershell: "PowerShell",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Find",
	ls: "LS",
	codemode: "Codemode",
	tool_search: "Tool Search",
};
const LIVE_TAIL_LINES = 3;
/** Arguments that best identify a call to a tool this view knows nothing else about. */
const GENERIC_DETAIL_KEYS = ["command", "query", "sql", "pattern", "prompt", "task", "url", "path", "file_path"];
const GENERIC_DETAIL_ARGS = 3;
const GENERIC_DETAIL_VALUE_CHARS = 80;
const FFF_TOOLS = new Map<string, "grep" | "find">([
	["ffgrep", "grep"], ["grep", "grep"],
	["fffind", "find"], ["find", "find"],
	["fff-multi-grep", "grep"], ["multi_grep", "grep"],
]);

/** Per-row slots: Pi's native renderers keep their own state and components here. */
interface RowState {
	nativeState: Record<string, unknown>;
	nativeCall?: Component;
	nativeResult?: Component;
	callCard?: Box;
	callCardBottom?: Spacer;
	resultCard?: Box;
	hasResult?: boolean;
	startedAt?: number;
	pulse?: ReturnType<typeof setInterval>;
	pulseBright?: boolean;
	preview?: {
		source: string;
		path: string;
		colors: Theme["colors"];
		render: ReturnType<typeof prepareToolPreview>;
	};
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * Streaming shell output arrives raw: drop escape sequences and control characters as Pi does,
 * and keep only the text after a lone `\r` so progress bars show their latest frame.
 */
function cleanOutput(text: string): string {
	return stripAnsi(text)
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			const frames = line.replace(/\r+$/, "");
			return frames.slice(frames.lastIndexOf("\r") + 1);
		})
		.join("\n")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

export function textOutput(result: ToolResult): string {
	return cleanOutput(result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"));
}

const NOTICE_SIZE = String.raw`\d+(?:\.\d+)?(?:B|KB|MB)`;
const BYTE_LIMIT_NOTICE = `${NOTICE_SIZE} limit reached`;
const GREP_LINES_NOTICE = String.raw`Some lines truncated to \d+ chars\. Use read tool to see full lines`;
const SHOWN_LINES_NOTICE = String.raw`Showing lines \d+-\d+ of \d+(?: \(${NOTICE_SIZE} limit\))?`;
// Pi 1.2–1.4 appends these tool-specific notices, not arbitrary bracketed output.
const TOOL_NOTICES: Record<string, RegExp> = {
	read: new RegExp(String.raw`^(?:${SHOWN_LINES_NOTICE}\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)$`),
	bash: new RegExp(String.raw`^(?:${SHOWN_LINES_NOTICE}|Showing last ${NOTICE_SIZE} of line \d+ \(line is ${NOTICE_SIZE}\))\. Full output: [^\n]+$`),
	grep: new RegExp(String.raw`^(?:\d+ matches limit reached\. Use limit=\d+ for more, or refine pattern(?:\. ${BYTE_LIMIT_NOTICE})?(?:\. ${GREP_LINES_NOTICE})?|${BYTE_LIMIT_NOTICE}(?:\. ${GREP_LINES_NOTICE})?|${GREP_LINES_NOTICE})$`),
	find: new RegExp(String.raw`^(?:\d+ results limit reached(?:\. Use limit=\d+ for more, or refine pattern)?(?:\. ${BYTE_LIMIT_NOTICE})?|${BYTE_LIMIT_NOTICE})$`),
	ls: new RegExp(String.raw`^(?:\d+ entries limit reached\. Use limit=\d+ for more(?:\. ${BYTE_LIMIT_NOTICE})?|${BYTE_LIMIT_NOTICE})$`),
};

/** Drop only a recognized notice for this tool, preserving bracketed content and errors. */
export function stripNotice(toolName: string, text: string): string {
	const notice = /\n\n\[([^\n]+)\]\s*$/.exec(text);
	if (notice && TOOL_NOTICES[toolName === "powershell" ? "bash" : toolName]?.test(notice[1]!)) {
		text = text.slice(0, notice.index);
	}
	return text.replace(/\n+$/, "");
}

function countLines(text: string): number {
	return text ? text.split("\n").length : 0;
}

export function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** First command line, with a `… (+N lines)` hint for multi-line commands. */
export function firstLine(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
	const head = lines[0] ?? "";
	return lines.length > 1 ? `${head} … (+${lines.length - 1} lines)` : head;
}

export function tailLines(text: string, count: number): string[] {
	const lines = cleanOutput(text).split("\n").filter((line) => line.trim() !== "");
	return lines.slice(-count);
}

/** `rel` when `path` is `base` or inside it; undefined for siblings such as `/home/sam-old`. */
function inside(base: string, path: string): string | undefined {
	const rel = relative(base, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join("/") : undefined;
}

export function displayPath(path: string, cwd: string, home = homedir()): string {
	if (!path || !isAbsolute(path)) return path;
	const inCwd = inside(cwd, path);
	if (inCwd) return inCwd;
	const inHome = inside(home, path);
	return inHome === undefined ? path : inHome ? `~/${inHome}` : "~";
}

function lineRange(offset: unknown, limit: unknown): string {
	if (typeof offset !== "number" && typeof limit !== "number") return "";
	const start = typeof offset === "number" ? offset : 1;
	return typeof limit === "number" ? `:${start}-${start + limit - 1}` : `:${start}`;
}

/** The single key argument shown inside `Tool(...)`. */
export function callDetail(toolName: string, args: Args, cwd: string): string {
	const path = displayPath(str(args.file_path ?? args.path), cwd);
	switch (toolName) {
		case "read":
			return path + lineRange(args.offset, args.limit);
		case "edit":
		case "write":
			return path;
		case "bash":
		case "powershell":
			return firstLine(str(args.command));
		case "tool_search":
			return firstLine(str(args.query));
		case "codemode":
			return firstLine(str(args.code).replace(/^\/\/ @options:[^\n]*\n/, ""));
		case "grep": {
			const pattern = str(args.pattern);
			return pattern ? `/${pattern}/${path ? ` in ${path}` : ""}` : path;
		}
		case "find": {
			const pattern = str(args.pattern);
			return pattern && path ? `${pattern} in ${path}` : pattern || path;
		}
		case "ls":
			return path || ".";
		default:
			return "";
	}
}

/** `Tool(...)` for tools with unknown arguments: the most identifying one, else the first few as `key=value`. */
export function genericDetail(args: Args, cwd: string): string {
	for (const key of GENERIC_DETAIL_KEYS) {
		const value = args[key];
		if (typeof value !== "string" || !value.trim()) continue;
		return key === "path" || key === "file_path" ? displayPath(value, cwd) : firstLine(value);
	}
	return Object.entries(args)
		.filter(([, value]) => value !== undefined && value !== null)
		.slice(0, GENERIC_DETAIL_ARGS)
		.map(([key, value]) => {
			const shown = typeof value === "string" ? firstLine(value) : JSON.stringify(value) ?? String(value);
			return `${key}=${shown.slice(0, GENERIC_DETAIL_VALUE_CHARS)}`;
		})
		.join(", ");
}

function details(result: ToolResult): Record<string, unknown> {
	const value: unknown = result.details;
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function truncation(result: ToolResult): { truncated: boolean; totalLines?: number } {
	const value = details(result).truncation;
	if (typeof value !== "object" || value === null) return { truncated: false };
	const { truncated, totalLines } = value as { truncated?: unknown; totalLines?: unknown };
	return { truncated: truncated === true, totalLines: typeof totalLines === "number" ? totalLines : undefined };
}

/** Keeps the hint that a result is incomplete, which stripNotice drops from the text. */
function incomplete(result: ToolResult): string {
	const info = details(result);
	const limit = ["matchLimitReached", "resultLimitReached", "entryLimitReached"].some((key) => info[key] !== undefined);
	return (limit ? " · limit reached" : "")
		+ (truncation(result).truncated || info.linesTruncated === true ? " · truncated" : "");
}

/** Line count of shell output plus any incomplete-result hint. */
function shellLines(output: string, result: ToolResult): string {
	const text = output.trim();
	const lines = text === "(no output)" ? 0 : truncation(result).totalLines ?? countLines(text);
	return (lines === 0 ? "no output" : plural(lines, "line")) + incomplete(result);
}

/** Pi emits the script status as a separate block; keep it out of output counts and previews. */
function codemodeOutput(result: ToolResult): ToolResult {
	const [first, ...rest] = result.content;
	return first?.type === "text" && /^Script (?:completed|failed)\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n$/.test(first.text)
		? { ...result, content: rest } : result;
}

interface NestedCall {
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
}

function codemodeCalls(result: ToolResult): NestedCall[] {
	const calls = details(result).calls;
	if (!Array.isArray(calls)) return [];
	return calls.flatMap((call: unknown): NestedCall[] => {
		if (typeof call !== "object" || call === null) return [];
		const { name, args, status, durationMs } = call as Record<string, unknown>;
		if (typeof name !== "string" || typeof args !== "string"
			|| (status !== "running" && status !== "ok" && status !== "error" && status !== "cancelled")) return [];
		return [{ name, args, status, durationMs: typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined }];
	});
}

function codemodeCounts(calls: NestedCall[]): string {
	if (!calls.length) return "";
	return [plural(calls.length, "call"), ...(["running", "error", "cancelled"] as const).flatMap((status) => {
		const count = calls.filter((call) => call.status === status).length;
		return count ? [`${count} ${status === "error" ? "failed" : status}`] : [];
	})].join(" · ");
}

function codemodeBody(result: ToolResult): string[] {
	let output = textOutput(codemodeOutput(result));
	// Keep the warning visible when Pi could not save the full output.
	if (typeof details(result).fullOutputPath === "string") {
		output = output.replace(/^Warning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n/, "");
	}
	return output.split("\n")
		.filter((line) => line.trim() && !/^(?:==> text \d+\/\d+ <==|<\/?console_output>)$/.test(line.trim()));
}

function codemodeError(result: ToolResult): string {
	const output = textOutput(codemodeOutput(result)).trim();
	const marker = "Script error:\n";
	const index = output.lastIndexOf(marker);
	return (index >= 0 ? output.slice(index + marker.length) : output).split("\n").find((line) => line.trim())?.trim() ?? "Failed";
}

function summarizeCodemode(result: ToolResult, duration = "", status = "Done"): string {
	const counts = codemodeCounts(codemodeCalls(result));
	const images = result.content.filter((block) => block.type === "image").length;
	return status + (counts ? ` · ${counts}` : "") + duration
		+ (images ? ` · ${plural(images, "image")}` : "")
		+ (typeof details(result).fullOutputPath === "string" ? " · truncated" : "");
}

function loadedTools(result: ToolResult): string[] | undefined {
	const loaded = details(result).loaded;
	return Array.isArray(loaded) && loaded.every((name: unknown) => typeof name === "string" && name.trim()) ? loaded : undefined;
}

function nestedCallRows(calls: NestedCall[], theme: Theme, cwd: string, icons: IconGlyphs): string[] {
	const ascii = icons.toolResult === "`-";
	const rows = calls.slice(-3).map((call) => {
		let detail = firstLine(call.args);
		try {
			const args: unknown = JSON.parse(call.args);
			if (typeof args === "object" && args !== null && !Array.isArray(args)) {
				detail = callDetail(call.name, args as Args, cwd) || genericDetail(args as Args, cwd);
			}
		} catch { /* Pi truncates long argument JSON for display. */ }
		const label = Object.hasOwn(TOOL_LABELS, call.name) ? TOOL_LABELS[call.name]! : call.name;
		const color: ThemeColor = call.status === "error" ? "error" : call.status === "running" ? "warning" : "dim";
		const icon = call.status === "ok" ? icons.done : call.status === "error" ? icons.deleted
			: call.status === "cancelled" ? ascii ? "-" : "⊘" : ascii ? "..." : "…";
		const duration = call.durationMs === undefined ? "" : ` · ${formatElapsed(call.durationMs)}`;
		return theme.fg("dim", ascii ? "|-  " : "├  ") + theme.fg(color, `${icon} ${sanitizeStatus(label)}${detail ? `(${sanitizeStatus(detail)})` : ""}${duration}`);
	});
	if (calls.length > 3) rows.unshift(theme.fg("dim", `${ascii ? "|-" : "├"}  … ${plural(calls.length - 3, "earlier call")} (ctrl+o to expand)`));
	return rows;
}

/** One-line result summary for a finished, successful call. */
export function summarizeResult(toolName: string, result: ToolResult, args: Args): string {
	const raw = textOutput(result);
	const text = stripNotice(toolName, raw);
	switch (toolName) {
		case "read": {
			if (result.content.some((block) => block.type === "image")) return "image";
			// An explicit `limit` that stops early adds this notice without setting details.truncation.
			const more = /\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]\s*$/.test(raw) ? " · more" : "";
			return plural(countLines(text), "line") + incomplete(result) + more;
		}
		case "tool_search": {
			const loaded = loadedTools(result);
			return loaded ? loaded.length ? `Loaded ${plural(loaded.length, "tool")}` : "No matching tools" : summarizeGeneric(result);
		}
		case "codemode":
			return summarizeCodemode(result);
		case "bash":
		case "powershell":
			return `Done · ${shellLines(text, result)}`;
		case "edit": {
			const diff = details(result).diff;
			if (typeof diff !== "string") return "Edited";
			const { added, removed } = diffStats(diff);
			return `+${added} −${removed}`;
		}
		case "write":
			return `${plural(codeLines(str(args.content)).length, "line")} written`;
		case "grep": {
			if (text === "No matches found") return "No matches";
			const files = new Set<string>();
			let matches = 0;
			for (const line of text.split("\n")) {
				const match = /^(.+?):\d+: /.exec(line);
				if (!match) continue;
				matches++;
				files.add(match[1]!);
			}
			return `${plural(matches, "match", "matches")} in ${plural(files.size, "file")}${incomplete(result)}`;
		}
		case "find":
			return text === "No files found matching pattern" ? "No files" : plural(countLines(text), "file") + incomplete(result);
		case "ls":
			return text === "(empty directory)" ? "Empty" : plural(countLines(text), "entry", "entries") + incomplete(result);
		default:
			return "";
	}
}

/**
 * One-line summary for a tool whose output format is unknown, so nothing is parsed out of it.
 * The first line goes last so narrow rows cut it before the counts and duration.
 */
export function summarizeGeneric(result: ToolResult, duration = ""): string {
	const body = textOutput(result).split("\n").filter((line) => line.trim());
	const images = result.content.filter((block) => block.type === "image").length;
	const head = sanitizeStatus((body[0] ?? "").replace(/^#+\s+/, ""));
	const info = truncation(result);
	const totalLines = info.truncated && typeof info.totalLines === "number"
		&& Number.isSafeInteger(info.totalLines) && info.totalLines >= body.length
		? info.totalLines : body.length;
	const counts = [
		...(totalLines ? [plural(totalLines, "line")] : []),
		...(images ? [plural(images, "image")] : []),
	].join(" · ");
	return (counts || "Done") + (info.truncated ? " · truncated" : "") + duration + (head ? ` · ${head}` : "");
}

/** FFF's grep count belongs to this page; find's count covers all matching files. */
function summarizeFff(kind: "grep" | "find", result: ToolResult, duration = ""): string {
	const info = details(result);
	const matched = info.totalMatched;
	if (typeof matched !== "number" || !Number.isSafeInteger(matched) || matched < 0
		|| result.content.some((block) => block.type === "image")) return summarizeGeneric(result, duration);
	const output = textOutput(result).trim();
	const footer = /\n\n\[(Invalid regex: [\s\S]+, used literal match(?:\. Continue with cursor="fff_c\d+")?|[^\n]+)\]$/.exec(output);
	const body = footer ? output.slice(0, footer.index) : output;
	// FFF also returns zero counts for its wildcard guard; keep that explanation first.
	if (matched === 0 && body !== (kind === "grep" ? "No matches found" : "No files found matching pattern")) {
		return summarizeGeneric(result, duration);
	}
	const notice = footer?.[1] ?? "";
	const fuzzy = kind === "grep" && output.startsWith("[0 exact matches. Maybe you meant this?]\n");
	const literal = kind === "grep" && /^Invalid regex: [\s\S]+, used literal match(?:\. Continue with cursor="fff_c\d+")?$/.test(notice);
	let more: boolean;
	let weak: RegExpExecArray | null = null;
	if (kind === "find") {
		if (typeof info.hasMore !== "boolean" || typeof info.pageIndex !== "number"
			|| !Number.isSafeInteger(info.pageIndex) || info.pageIndex < 0) return summarizeGeneric(result, duration);
		// Weak fuzzy results can have hasMore=true while FFF intentionally provides no cursor.
		weak = /^Query "[^\n]*" produced only weak scattered fuzzy matches\. Output capped at (\d+)\/(\d+)\.$/.exec(notice);
		if (weak && (Number(weak[2]) !== matched || Number(weak[1]) > matched)) return summarizeGeneric(result, duration);
		more = info.hasMore && /^\d+ more match(?:es)? available\. cursor="\d+" to continue$/.test(notice);
		if (info.hasMore && !more && !weak) return summarizeGeneric(result, duration);
	} else {
		more = /(?:^|\. )(?:Continue with cursor="fff_c\d+"|More available\. cursor="fff_c\d+" to continue)$/.test(notice);
	}
	const matchType = fuzzy ? "fuzzy " : literal ? "literal " : "";
	const count = kind === "find" ? `${plural(matched, "file")} matched`
		: `${plural(matched, `${matchType}match`, `${matchType}matches`)} on this page`;
	const head = sanitizeStatus(output.split("\n")[fuzzy ? 1 : 0] ?? "");
	return count + (more ? " · more available" : "")
		+ (literal ? " · regex fallback" : "")
		+ (weak ? " · weak matches" + (Number(weak[1]) < matched ? " · capped" : "") : "")
		+ (truncation(result).truncated ? " · truncated" : "")
		+ duration + (head ? ` · ${head}` : "");
}

/** Match npm provenance, its installed entry point, or the official git source and entry point. */
export function fffKind(toolName: string, sourceInfo: SourceInfo | undefined): "grep" | "find" | undefined {
	const kind = FFF_TOOLS.get(toolName);
	if (!kind || !sourceInfo) return undefined;
	const source = sourceInfo.source;
	const path = sourceInfo.path.replace(/\\/g, "/");
	const git = /^(?:git:)?(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|github\.com\/)dmtrkovalenko\/fff(?:\.git)?(?:[@#][^\s]+)?$/i.test(source)
		&& /(?:^|\/)packages\/pi-fff\/src\/index\.ts$/.test(path);
	return source === "npm:@ff-labs/pi-fff" || source.startsWith("npm:@ff-labs/pi-fff@")
		|| /(?:^|\/)node_modules\/@ff-labs\/pi-fff\/src\/index\.ts$/.test(path) || git ? kind : undefined;
}

/**
 * One-line summary for a failed call: the shell's closing status plus its last output line,
 * otherwise the error's first line.
 */
export function summarizeError(toolName: string, result: ToolResult, duration = ""): string {
	if (toolName === "codemode") {
		return codemodeError(result) + summarizeCodemode(result, duration, "");
	}
	const text = textOutput(result).trim();
	// Pi ends failed shell output with "Command exited with code N", "Command aborted", etc.
	const status = toolName === "bash" || toolName === "powershell" ? /(?:^|\n\n)Command ([^\n]+)$/.exec(text) : null;
	if (status) {
		const reason = status[1]!;
		const output = stripNotice(toolName, text.slice(0, status.index));
		// The last output line usually names the failure; it goes last so narrow rows cut it first.
		const last = tailLines(output, 1)[0]?.trim();
		const tail = last && last !== "(no output)" ? ` · ${last}` : "";
		return `${reason[0]!.toUpperCase()}${reason.slice(1)} · ${shellLines(output, result)}${duration}${tail}`;
	}
	return text.split("\n").find((line) => line.trim())?.trim() ?? "Failed";
}

function formatElapsed(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Stable rows reuse their final lines until width, theme, icons, or invalidation changes them. */
function lines(
	build: (width: number, icons: IconGlyphs) => string[],
	theme: Theme,
	glyphs: () => IconGlyphs,
	cacheable = true,
): Component {
	let cache: { width: number; colors: Theme["colors"]; toolCall: string; toolResult: string; lines: string[] } | undefined;
	return {
		render(width) {
			const icons = glyphs();
			const colors = theme.colors;
			if (cacheable && cache && cache.width === width && cache.colors === colors
				&& cache.toolCall === icons.toolCall && cache.toolResult === icons.toolResult) return cache.lines;
			const rendered = build(width, icons).map((line) => truncateToWidth(line, Math.max(0, width), "…"));
			if (cacheable) cache = { width, colors, toolCall: icons.toolCall, toolResult: icons.toolResult, lines: rendered };
			return rendered;
		},
		invalidate() { cache = undefined; },
	};
}

function rowState(context: RenderContext): RowState {
	const state = context.state as Partial<RowState>;
	state.nativeState ??= {};
	return state as RowState;
}

function nativeContext(context: RenderContext, row: RowState, lastComponent: Component | undefined): RenderContext {
	return { ...context, state: row.nativeState, lastComponent };
}

function statusBg(theme: Theme, context: RenderContext): (text: string) => string {
	const bg = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
	return (text) => theme.bg(bg, text);
}

function stopPulse(row: RowState): void {
	if (row.pulse) clearInterval(row.pulse);
	row.pulse = undefined;
}

/** Pi's expanded card for a tool without its own call renderer. */
function genericCall(toolName: string, args: unknown, theme: Theme): Component {
	const entries = typeof args === "object" && args !== null ? Object.entries(args) : [];
	const rows = entries.map(([key, value]) => {
		const shown = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
		return `  ${sanitizeStatus(key)}: ${cleanOutput(shown).replace(/\t/g, "   ").split("\n").join("\n    ")}`;
	});
	const title = theme.fg("toolTitle", theme.bold(sanitizeStatus(toolName)));
	return new Text(rows.length ? `${title}\n${theme.fg("muted", rows.join("\n"))}` : title, 0, 0);
}

/** Pi's expanded card for a tool without its own result renderer. Pi still draws images it can show. */
function genericResult(result: ToolResult, theme: Theme, context: RenderContext): Component {
	const inline = getCapabilities().images && context.showImages;
	const missing = inline ? [] : result.content.flatMap((block) => (block.type === "image" ? [imageFallback(block.mimeType, getImageDimensions(block.data, block.mimeType) ?? undefined)] : []));
	const output = [textOutput(result).replace(/\t/g, "   "), ...missing].filter(Boolean).join("\n");
	return new Text(output ? theme.fg("toolOutput", output) : "", 0, 0);
}

/**
 * `generic` is for tools other than Pi's own built-ins: their output format and renderers are
 * unknown. A known extension can supply its own summary. Native renderers start on expansion;
 * after collapse they still receive completion and error updates, but skip hidden progress.
 */
export function createCompactRenderers(
	toolName: string,
	native: ToolRenderers | undefined,
	glyphs: () => IconGlyphs,
	running?: Map<string, RowState | undefined>,
	generic = false,
	summarizeExtension = summarizeGeneric,
): ToolRenderers {
	const label = Object.hasOwn(TOOL_LABELS, toolName) ? TOOL_LABELS[toolName]! : sanitizeStatus(toolName);
	const isShell = !generic && (toolName === "bash" || toolName === "powershell");
	const isCodemode = !generic && toolName === "codemode";
	const isToolSearch = !generic && toolName === "tool_search";
	const lazyNative = generic || isCodemode || isToolSearch;
	const nativeShell = native?.renderShell;
	const renderNativeCall: RenderCall | undefined = native?.renderCall
		?? (lazyNative ? (args, theme) => genericCall(toolName, args, theme) : undefined);
	const renderNativeResult: RenderResult | undefined = native?.renderResult
		?? (lazyNative ? (result, _options, theme, context) => genericResult(result, theme, context) : undefined);
	// Expanded rows hand off to Pi's own card so nothing is hidden.
	const showNative = (context: RenderContext) => context.expanded;
	// A generic row that was expanded skips hidden progress but still sees the call finish, for a renderer's own timers.
	const feedCollapsedNative = (row: RowState, isPartial: boolean, isError: boolean) =>
		row.nativeCall !== undefined && (!isPartial || isError);

	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const row = rowState(context);
			// Keep native timers/edit state current; write rebuilds its full highlight cache only on expansion.
			if (context.expanded || (lazyNative ? feedCollapsedNative(row, context.isPartial, context.isError) : toolName !== "write")) {
				row.nativeCall = renderNativeCall?.(args, theme, nativeContext(context, row, row.nativeCall));
			}
			if (context.executionStarted) row.startedAt ??= Date.now();
			const live = context.executionStarted && context.isPartial && !context.isError;
			// Actual execution events exclude history rebuilding and HTML export's partial call context.
			if (live && !context.expanded && running?.has(context.toolCallId)) {
				running.set(context.toolCallId, row);
				if (!row.pulse) {
					row.pulseBright = true;
					row.pulse = setInterval(() => {
						row.pulseBright = !row.pulseBright;
						context.invalidate();
					}, 1000);
					row.pulse.unref();
				}
			} else {
				stopPulse(row);
			}
			if (showNative(context) && row.nativeCall) {
				if (nativeShell === "self") return row.nativeCall;
				// Recreate Pi's default card: top padding, call, then result (or bottom padding while pending).
				row.callCard ??= new Box(context.outputPad, 0);
				row.callCardBottom ??= new Spacer(1);
				row.callCard.setBgFn(statusBg(theme, context));
				row.callCard.setPaddingX(context.outputPad);
				row.callCard.clear();
				row.callCard.addChild(new Spacer(1));
				row.callCard.addChild(row.nativeCall);
				row.callCard.addChild(row.callCardBottom);
				return row.callCard;
			}
			const color: ThemeColor = context.isError ? "error" : context.isPartial
				? live && row.pulseBright !== false ? "accent" : "dim"
				: "success";
			const titleColor = context.isPartial || context.isError ? "toolTitle" : "dim";
			const callArgs = (args ?? {}) as Args;
			const detail = sanitizeStatus(generic ? genericDetail(callArgs, context.cwd) : callDetail(toolName, callArgs, context.cwd));
			const pad = " ".repeat(context.outputPad);
			return lines((_width, icons) => {
				const call = pad + theme.fg(color, icons.toolCall) + " " + theme.fg(titleColor, titleColor === "dim" ? label : theme.bold(label))
					+ (detail ? theme.fg(context.isPartial || context.isError ? "muted" : "dim", `(${detail})`) : "");
				// Pi does not call renderResult until the tool provides its first result.
				// Read the shared flag during rendering, after both slots have been prepared.
				if (lazyNative && live && !row.hasResult) {
					const elapsed = row.startedAt === undefined ? "" : ` ${formatElapsed(Date.now() - row.startedAt)}`;
					const gutter = `${pad}  ${theme.fg("dim", icons.toolResult)}  `;
					return [call, gutter + theme.fg("warning", `Running…${elapsed}`)];
				}
				return [call];
			}, theme, glyphs, !context.isPartial);
		},

		renderResult(result, options, theme, context) {
			const row = rowState(context);
			row.hasResult = true;
			const partial = options.isPartial && !context.isError;
			if (!options.isPartial || context.isError) stopPulse(row);
			if (!lazyNative || context.expanded || feedCollapsedNative(row, options.isPartial, context.isError)) {
				row.nativeResult = renderNativeResult?.(result, options, theme, nativeContext(context, row, row.nativeResult));
			}
			if (showNative(context) && row.nativeResult) {
				if (nativeShell === "self") return row.nativeResult;
				// The result now closes the card, so the call card drops its pending bottom padding.
				if (row.callCard && row.callCardBottom) row.callCard.removeChild(row.callCardBottom);
				row.resultCard ??= new Box(context.outputPad, 0);
				row.resultCard.setBgFn(statusBg(theme, context));
				row.resultCard.setPaddingX(context.outputPad);
				row.resultCard.clear();
				row.resultCard.addChild(row.nativeResult);
				row.resultCard.addChild(new Spacer(1));
				return row.resultCard;
			}
			const pad = " ".repeat(context.outputPad);
			const args = (context.args ?? {}) as Args;
			if (!generic && !options.isPartial && !context.isError && (toolName === "edit" || toolName === "write")) {
				const source = toolName === "edit" ? str(details(result).diff) : str(args.content);
				const path = str(args.file_path ?? args.path);
				if (!row.preview || row.preview.source !== source || row.preview.path !== path || row.preview.colors !== theme.colors) {
					row.preview = { source, path, colors: theme.colors, render: prepareToolPreview(toolName, source, path, theme) };
				}
			}
			const timed = isShell || lazyNative;
			const duration = timed && context.durationMs !== undefined ? ` · ${formatElapsed(context.durationMs)}` : "";
			const summary = partial ? "" : context.isError
				? summarizeError(generic ? "" : toolName, result, duration)
				: generic ? summarizeExtension(result, duration) : isCodemode ? summarizeCodemode(result, duration)
					: summarizeResult(toolName, result, args) + duration;
			const tail = partial && isShell ? tailLines(textOutput(result), LIVE_TAIL_LINES) : [];
			const calls = isCodemode ? codemodeCalls(result) : [];
			const body = isCodemode && !partial ? context.isError
				? codemodeError(result) : codemodeBody(result)[0] : undefined;
			const loaded = isToolSearch && !partial && !context.isError ? loadedTools(result) : undefined;
			return lines((width, icons) => {
				const { toolResult } = icons;
				const gutter = `${pad}  ${theme.fg("dim", toolResult)}  `;
				const indent = `${pad}  ${" ".repeat(visibleWidth(toolResult))}  `;
				if (isCodemode) {
					const counts = codemodeCounts(calls);
					const elapsed = row.startedAt === undefined ? "" : ` ${formatElapsed(Date.now() - row.startedAt)}`;
					const status = partial ? `Running…${elapsed}${counts ? ` · ${counts}` : ""}`
						: context.isError ? summarizeCodemode(result, duration, "Failed") : summary;
					const color = context.isError ? "error" : partial || calls.some((call) => call.status === "error" || call.status === "cancelled") ? "warning" : "dim";
					return [
						...nestedCallRows(calls, theme, context.cwd, icons).map((line) => `${pad}  ${line}`),
						gutter + theme.fg(color, status),
						...(body ? [indent + theme.fg(context.isError ? "error" : "toolOutput", sanitizeStatus(body))] : []),
					];
				}
				if (partial) {
					if (!timed) return [gutter + theme.fg("warning", "Running…")];
					const elapsed = row.startedAt === undefined ? "" : ` ${formatElapsed(Date.now() - row.startedAt)}`;
					return [...tail.map((line) => theme.fg("toolOutput", line)), theme.fg("warning", `Running…${elapsed}`)]
						.map((line, index) => (index === 0 ? gutter : indent) + line);
				}
				if (context.isError) return [gutter + theme.fg("error", summary)];
				const names = loaded?.slice(0, 3).map(sanitizeStatus).join(" · ");
				const remaining = loaded ? Math.max(0, loaded.length - 3) : 0;
				return [gutter + theme.fg("dim", summary),
					...(names ? [indent + theme.fg("toolOutput", names + (remaining ? ` · +${remaining} more (ctrl+o to expand)` : ""))] : []),
					...(row.preview?.render(width, indent) ?? [])];
			}, theme, glyphs, !partial);
		},
	};
}

const OWNED_TOOLS = new Set(Object.keys(TOOL_LABELS));

/**
 * Display-only: Pi's tools, execution, arguments and results are untouched. The configuration is
 * read when Pi builds a row, so changing it affects new rows only.
 */
export function registerToolView(pi: ExtensionAPI, getView: () => ToolViewConfig, glyphs: () => IconGlyphs): void {
	const running = new Map<string, RowState | undefined>();
	pi.on("tool_execution_start", (event) => { running.set(event.toolCallId, undefined); });
	pi.on("tool_execution_end", (event) => {
		const row = running.get(event.toolCallId);
		if (row) stopPulse(row);
		running.delete(event.toolCallId);
	});
	pi.on("session_shutdown", () => {
		for (const row of running.values()) if (row) stopPulse(row);
		running.clear();
	});
	pi.registerToolRenderer((toolName, next) => {
		const native = next();
		const view = getView();
		if (view.mode !== "compact" || view.exclude.includes(toolName)) return native;
		const sourceInfo = OWNED_TOOLS.has(toolName) || view.extensionTools && FFF_TOOLS.has(toolName)
			? pi.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo : undefined;
		const builtin = OWNED_TOOLS.has(toolName) && sourceInfo?.source === "builtin";
		if (builtin) return native || toolName === "tool_search" ? createCompactRenderers(toolName, native, glyphs, running) : native;
		if (!view.extensionTools) return native;
		const fff = fffKind(toolName, sourceInfo);
		return createCompactRenderers(toolName, native, glyphs, running, true,
			fff ? (result, duration) => summarizeFff(fff, result, duration) : summarizeGeneric);
	});
}
