import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { IconGlyphs } from "./icons.ts";
import { sanitizeStatus } from "./utils.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_PEEK_LINES = 2;

export type PeekPhase = "idle" | "thinking" | "done";

export interface PeekState {
	phase: PeekPhase;
	tail: string;
}

export interface PeekMessageParts {
	thinking: string;
	text: string;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

const normalizePeekLineCount = (lineCount: number): number => Math.max(1, Math.min(MAX_PEEK_LINES, Math.floor(lineCount)));

/**
 * Pure phase machine for one assistant-message update.
 *
 * Thinking text is cumulative: once the answer starts, later updates still
 * carry the full thinking block alongside new text. To keep the spinner honest:
 * - idle + thinking        -> thinking (spinner starts)
 * - idle + thinking + text -> done    (already answered, never spin)
 * - thinking + text        -> done    (answer started: stop spinner)
 * - done + thinking        -> done    (never restart the spinner)
 * - any + text only        -> idle stays idle (plain answer, nothing to peek)
 */
export function reducePeek(prev: PeekState, parts: PeekMessageParts): PeekState {
	const tail = parts.thinking ? peekTail(parts.thinking, MAX_PEEK_LINES) : prev.tail;
	let phase = prev.phase;
	if (parts.thinking && phase === "idle") phase = "thinking";
	if (parts.text && phase === "thinking") phase = "done";
	return { phase, tail };
}

/** Fresh peek state (no task running yet). */
export function createPeekState(): PeekState {
	return { phase: "idle", tail: "" };
}

/**
 * Collect the running thinking text and answer text from an assistant
 * message's content parts. Thinking arrives token-by-token, so re-calling
 * this on every `message_update` yields the cumulative text.
 */
export function collectPeekParts(content: unknown): PeekMessageParts {
	let thinking = "";
	let text = "";
	if (!Array.isArray(content)) return { thinking, text };
	for (const rawPart of content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as { type?: unknown; thinking?: unknown; text?: unknown };
		if (part.type === "thinking") {
			thinking += stringValue(part.thinking) ?? stringValue(part.text) ?? "";
		} else if (part.type === "text") {
			text += stringValue(part.text) ?? "";
		}
	}
	return { thinking, text };
}

/**
 * Extract the last non-empty logical lines of the thinking text, whitespace-
 * normalized. NOT width-bounded: clipping to the terminal happens at render
 * time in buildPeekLabel/clipTail, so wide terminals get to see more of it.
 */
export function peekTail(fullThinking: string, lineCount = 1): string {
	if (!fullThinking) return "";
	const count = normalizePeekLineCount(lineCount);
	const lines = fullThinking
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	return lines.slice(-count).join("\n");
}

/**
 * Clip a tail string to `budget` visible columns, keeping the END (it is a
 * tail view) and prefixing "…" when clipped. Walks code points so wide CJK
 * chars count as 2 columns and surrogate pairs are never split.
 */
export function clipTail(text: string, budget: number): string {
	if (!text || budget <= 0) return "";
	if (visibleWidth(text) <= budget) return text;
	if (budget === 1) return "…";
	const limit = budget - 1; // reserve one column for the ellipsis
	let w = 0;
	const codePoints = Array.from(text);
	let i = codePoints.length;
	while (i > 0) {
		const start = i - 1;
		const codePoint = codePoints[start] ?? "";
		const cw = visibleWidth(codePoint);
		if (w + cw > limit) break;
		w += cw;
		i = start;
	}
	return "…" + codePoints.slice(i).join("");
}

/**
 * Build the label Pi renders in its hidden-thinking block. `width` is a
 * conservative budget that keeps each native Text row within the terminal.
 * In two-line mode, an overflowing latest logical line uses both rows for
 * its continuation instead of retaining the previous logical line.
 */
export function buildPeekLabel(
	state: PeekState,
	frame: number,
	glyphs: IconGlyphs,
	width: number,
	lineCount = 1,
): string {
	const w = Math.max(1, Math.floor(width));
	const prefix = `${glyphs.thinking} think`;
	const count = normalizePeekLineCount(lineCount);
	const fit = (line: string): string => truncateToWidth(line, w, "…");
	switch (state.phase) {
		case "thinking": {
			const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
			// Thinking text is model output (untrusted): strip terminal control
			// sequences before placing it in Pi's native label.
			const marker = `${prefix} ${spin}`;
			const markerWidth = visibleWidth(`${marker} `);
			const contentWidth = Math.max(0, w - markerWidth);
			const thoughtIndent = " ".repeat(markerWidth);
			const safeLines = state.tail
				.split("\n")
				.map((tail) => sanitizeStatus(tail))
				.filter(Boolean)
				.slice(-count);
			const latest = safeLines.at(-1) ?? "";
			const lineWithMarker = (tail: string): string => fit(tail ? `${marker} ${tail}` : marker);
			if (count >= 2) {
				const latestWrapped = wrapTextWithAnsi(latest, Math.max(1, contentWidth));
				if (latestWrapped.length > 1) {
					// Spend both rows on an overflowing latest thought; stale context must
					// not displace its continuation.
					const first = latestWrapped[0] ?? "";
					const second = latestWrapped[1] ?? "";
					return `${lineWithMarker(first)}\n${fit(`${thoughtIndent}${second}`)}`;
				}
			}
			const firstTail = clipTail(count >= 2 ? safeLines[0] ?? "" : latest, contentWidth);
			if (count < 2 || safeLines.length < 2) return lineWithMarker(firstTail);
			// Align the latest line with the first line's thinking text, not with
			// the status marker.
			const secondTail = clipTail(latest, contentWidth);
			return `${lineWithMarker(firstTail)}\n${fit(secondTail ? `${thoughtIndent}${secondTail}` : thoughtIndent)}`;
		}
		case "done":
			return fit(`${prefix} ${glyphs.done}`);
		default:
			return fit(`${prefix} ·`);
	}
}
