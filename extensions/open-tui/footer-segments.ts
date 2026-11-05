import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { sanitizeStatusPreservingStyles } from "./utils.ts";

const BUILTIN_SEGMENTS = [
	"cwd", "hostname", "sessionName", "git", "runtime", "timer", "context", "model", "tokens", "cost",
] as const;

export type FooterBuiltinSegment = typeof BUILTIN_SEGMENTS[number];

export type FooterPosition =
	| { row: 1 | 2; side: "left" | "right"; edge?: "start" | "end" }
	| { before: FooterBuiltinSegment }
	| { after: FooterBuiltinSegment };

export interface FooterSegment {
	key: string;
	position: FooterPosition;
	text: string;
	compactText?: string;
	order?: number;
	priority?: number;
}

export interface RegisteredFooterSegment extends FooterSegment {
	order: number;
	priority: number;
}

export type FooterSetMessage = FooterSegment & { lifecycle: string };
export type FooterRemoveMessage = { key: string; lifecycle: string };
export type FooterStateMessage = { available: true; lifecycle: string } | { available: false };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnchor(value: unknown): value is FooterBuiltinSegment {
	return typeof value === "string" && BUILTIN_SEGMENTS.some((anchor) => anchor === value);
}

function readPosition(value: unknown): FooterPosition | undefined {
	if (!isRecord(value)) return undefined;
	if ("before" in value) {
		if ("after" in value || "row" in value || "side" in value || "edge" in value) return undefined;
		return isAnchor(value.before) ? { before: value.before } : undefined;
	}
	if ("after" in value) {
		if ("row" in value || "side" in value || "edge" in value) return undefined;
		return isAnchor(value.after) ? { after: value.after } : undefined;
	}
	if (value.row !== 1 && value.row !== 2) return undefined;
	if (value.side !== "left" && value.side !== "right") return undefined;
	if (value.edge !== undefined && value.edge !== "start" && value.edge !== "end") return undefined;
	return { row: value.row, side: value.side, edge: value.edge ?? "end" };
}

function readSegment(value: Record<string, unknown>): RegisteredFooterSegment | undefined {
	if (typeof value.key !== "string" || value.key.trim().length === 0 || typeof value.text !== "string") return undefined;
	if (value.compactText !== undefined && typeof value.compactText !== "string") return undefined;
	if (value.order !== undefined && (typeof value.order !== "number" || !Number.isFinite(value.order))) return undefined;
	if (value.priority !== undefined && (typeof value.priority !== "number" || !Number.isFinite(value.priority))) return undefined;
	const position = readPosition(value.position);
	if (!position) return undefined;
	return {
		key: value.key,
		position,
		text: sanitizeStatusPreservingStyles(value.text),
		compactText: value.compactText === undefined ? undefined : sanitizeStatusPreservingStyles(value.compactText),
		order: value.order ?? 0,
		priority: value.priority ?? -1,
	};
}

/** Session-local storage for the public footer protocol. Pi owns subscription cleanup. */
export function createFooterSegments(events: ExtensionAPI["events"], requestRender: () => void) {
	let lifecycle: string | undefined;
	const segments = new Map<string, RegisteredFooterSegment>();
	let ordered: readonly RegisteredFooterSegment[] = [];
	const announce = () => {
		const state: FooterStateMessage = lifecycle === undefined
			? { available: false }
			: { available: true, lifecycle };
		events.emit("open-tui:footer:state", state);
	};
	const changed = () => {
		ordered = [...segments.values()].sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		requestRender();
	};

	events.on("open-tui:footer:query", announce);
	events.on("open-tui:footer:set", (data) => {
		if (!lifecycle || !isRecord(data) || data.lifecycle !== lifecycle) return;
		const segment = readSegment(data);
		if (!segment) return;
		segments.set(segment.key, segment);
		changed();
	});
	events.on("open-tui:footer:remove", (data) => {
		if (!lifecycle || !isRecord(data) || data.lifecycle !== lifecycle || typeof data.key !== "string") return;
		if (segments.delete(data.key)) changed();
	});

	return {
		getSegments: (): readonly RegisteredFooterSegment[] => ordered,
		activate(): void {
			if (lifecycle !== undefined) return;
			lifecycle = randomUUID();
			announce();
		},
		deactivate(): void {
			if (lifecycle === undefined) return;
			lifecycle = undefined;
			segments.clear();
			ordered = [];
			announce();
		},
	};
}
