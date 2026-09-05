import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type OpenTuiConfig, DEFAULT_CONFIG, ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import { installEditor } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { installHeader } from "./header.ts";
import { emptyGitStatus, readGitStatus } from "./git.ts";
import { readRuntimeInfo } from "./runtime.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { registerSettingsCommand } from "./settings-command.ts";
import { formatTurnTelemetry, TurnTelemetryTracker } from "./telemetry.ts";
import {
	createInitialState,
	getModelMeta,
	invalidateUsageCache,
	type FooterState,
} from "./state.ts";
import { resolveGlyphs } from "./icons.ts";
import {
	buildPeekLabel,
	collectPeekParts,
	createPeekState,
	reducePeek,
	type PeekState,
} from "./peek.ts";

type PendingUiChange = "install" | "uninstall";
const HIDDEN_THINKING_HORIZONTAL_PADDING = 2;
// Pi's fullscreen transcript can reserve one more column for its scrollbar.
const HIDDEN_THINKING_SCROLLBAR_RESERVE = 1;

export function getPendingUiChange(enabled: boolean, active: boolean): PendingUiChange | undefined {
	if (enabled === active) return undefined;
	return enabled ? "install" : "uninstall";
}

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	const sessionLifecycle = new SessionLifecycle();
	const state: FooterState = createInitialState();
	const turnTelemetry = new TurnTelemetryTracker();

	let config: OpenTuiConfig = structuredClone(DEFAULT_CONFIG);
	let active = false;
	let lastCtx: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let cleanupHeader: (() => void) | undefined;
	let cleanupFooter: (() => void) | undefined;
	let editor: ReturnType<typeof installEditor> | undefined;
	let pendingUiChange: PendingUiChange | undefined;

	// thinking-peek state (rendered by Pi inside its hidden-thinking block)
	const peek: PeekState = createPeekState();
	let peekFrame = 0;
	let peekSettleTimer: ReturnType<typeof setTimeout> | undefined;
	let peekTaskEpoch = 0; // bumped at every agent task boundary
	let peekLabelActive = false;

	const getThinkingLevel = () => (sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : "off");

	/** True while the agent is running (false during session-restore replay). */
	const isAgentIdle = (ctx: ExtensionContext): boolean => {
		try {
			return (ctx as ExtensionContext & { isIdle?: () => boolean }).isIdle?.() === true;
		} catch {
			return false;
		}
	};

	/** Pi decides whether this label is visible; our toggle only controls updates. */
	const isPeekEnabled = () => sessionLifecycle.isCurrent() && config.enabled && config.thinkingPeek.lines > 0 && active;

	/** Keep each native hidden-thinking label row within Pi's narrowest transcript width. */
	const hiddenThinkingLabelWidth = (): number => {
		if (!editor) throw new Error("Open TUI editor is not installed");
		return Math.max(
			1,
			editor.getViewportWidth() - HIDDEN_THINKING_HORIZONTAL_PADDING - HIDDEN_THINKING_SCROLLBAR_RESERVE,
		);
	};

	const setPeekLabel = (ctx?: ExtensionContext): void => {
		if (!isPeekEnabled() || peek.phase === "idle") return;
		const target = ctx ?? lastCtx;
		if (!target || !isTuiContext(target)) return;
		if (!editor) throw new Error("Open TUI editor is not installed");
		editor.setLatestHiddenThinkingLabel(
			buildPeekLabel(
				peek,
				peekFrame,
				resolveGlyphs(config.icons.mode),
				hiddenThinkingLabelWidth(),
				config.thinkingPeek.lines,
			),
		);
		peekLabelActive = true;
	};

	const clearPeekLabel = (ctx?: ExtensionContext): void => {
		if (!peekLabelActive) return;
		const target = ctx ?? lastCtx;
		if (!target || !isTuiContext(target)) return;
		// The global reset is safe here: every completed message returns to Pi's native label.
		target.ui.setHiddenThinkingLabel();
		peekLabelActive = false;
	};

	/** Reset peek state to idle and cancel any scheduled cleanup. */
	const resetPeek = () => {
		peek.phase = "idle";
		peek.tail = "";
		editor?.resetHiddenThinkingLabelTarget();
		if (peekSettleTimer) {
			clearTimeout(peekSettleTimer);
			peekSettleTimer = undefined;
		}
	};
	const applyUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		if (!active) {
			cleanupHeader = installHeader(pi, ctx);
			cleanupFooter = installFooter(
				ctx,
				() => state,
				() => config,
				() => getModelMeta(ctx, getThinkingLevel),
				{
					setRequestRender: (fn) => {
						requestFooterRender = fn ?? undefined;
					},
					scheduleGitRefresh: () => {
						void scheduleGitRefresh(ctx);
					},
				},
			);
			editor = installEditor(pi, ctx, config.cursorStyle, config.fullscreen.wheelScrollLines);
			active = true;
		}
	};

	const uninstallUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (active) {
			cleanupHeader?.();
			cleanupFooter?.();
			editor?.cleanup();
			cleanupHeader = undefined;
			cleanupFooter = undefined;
			editor = undefined;
			requestFooterRender = undefined;
			resetPeek();
			clearPeekLabel(ctx);
			active = false;
		}
	};

	const scheduleGitRefresh = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const segs = config.footerSegments;
		if (!segs.gitBranch && !segs.gitStatus && !segs.gitCommit) {
			state.git = emptyGitStatus();
			requestFooterRender?.();
			return;
		}
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const git = await readGitStatus(cwd, {
			readCommit: true,
			readTag: segs.gitCommit,
			readCounts: segs.gitStatus,
		});
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.git = git;
		requestFooterRender?.();
	};

	const refreshRuntime = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const runtime = await readRuntimeInfo(cwd);
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.runtime = runtime;
		requestFooterRender?.();
	};

	const refreshInteractiveState = (ctx: ExtensionContext, project = false) => {
		if (!sessionLifecycle.isCurrent() || !ctx.hasUI) return;
		if (project) {
			void scheduleGitRefresh(ctx);
			void refreshRuntime(ctx);
		}
		requestFooterRender?.();
	};

	const startWorkingTimer = () => {
		stopWorkingTimer();
		const tick = () => {
			if (!sessionLifecycle.isCurrent() || !active) return;
			requestFooterRender?.();
		};
		tick();
		workingTimer = setInterval(tick, 250);
		workingTimer.unref?.();
	};

	const stopWorkingTimer = () => {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionLifecycle.start();
		lastCtx = ctx;
		state.sessionStartEpoch = Date.now();
		state.workingSince = undefined;
		state.lastDoneIn = undefined;
		invalidateUsageCache();

		ensureConfigExists();
		config = loadConfig((msg, level) => ctx.ui.notify(msg, level));
		clearPeekLabel(ctx);

		applyUi(ctx);

		refreshInteractiveState(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionLifecycle.shutdown();
		stopWorkingTimer();
		if (active) {
			uninstallUi(ctx);
		}
		lastCtx = undefined;
	});

	pi.on("agent_start", (event, _ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		// agent_start also covers custom-message and continuation-triggered tasks
		// that do not emit a user message_start event.
		peekTaskEpoch++;
		state.workingSince = Date.now();
		state.lastDoneIn = undefined;
		startWorkingTimer();
	});

	pi.on("agent_end", (_event, _ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		stopWorkingTimer();
		if (state.workingSince !== undefined) {
			state.lastDoneIn = Date.now() - state.workingSince;
			state.workingSince = undefined;
		}
		requestFooterRender?.();
	});

	pi.on("turn_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_start", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent() || isAgentIdle(ctx)) return;
		const role = event.message?.role;
		if (role === "user") {
			// Restore Pi's native label until real thinking arrives. The task epoch is
			// advanced by agent_start so custom/no-user tasks are covered too.
			resetPeek();
			clearPeekLabel(ctx);
		} else if (role === "assistant") {
			resetPeek();
			clearPeekLabel(ctx);
		}
	});

	pi.on("message_update", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent() || isAgentIdle(ctx)) return;
		if (!isPeekEnabled()) return;
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		if (peek.phase === "done") return;
		const parts = collectPeekParts(message.content);
		const next = reducePeek(peek, parts);
		const changed = next.phase !== peek.phase || next.tail !== peek.tail;
		peek.phase = next.phase;
		peek.tail = next.tail;
		if (!changed) return;
		if (peek.phase === "thinking") {
			peekFrame++;
			setPeekLabel(ctx);
		} else if (peek.phase === "done") {
			setPeekLabel(ctx);
		}
	});

	pi.on("tool_execution_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("turn_end", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("agent_settled", (event, ctx) => {
		const telemetry = turnTelemetry.handle(event);
		if (telemetry && config.enabled && config.telemetry.enabled && isTuiContext(ctx)) {
			const message = formatTurnTelemetry(telemetry, ctx.ui.theme, config.telemetry, config.icons.mode);
			if (message) ctx.ui.notify(message, "info");
		}
		// Only clear the peek label when this task is still the current one.
		const settleEpoch = peekTaskEpoch;
		if (peekSettleTimer) clearTimeout(peekSettleTimer);
		peekSettleTimer = setTimeout(() => {
			peekSettleTimer = undefined;
			if (!sessionLifecycle.isCurrent() || peekTaskEpoch !== settleEpoch) return;
			resetPeek();
			clearPeekLabel(ctx);
		}, 300);
	});

	pi.on("model_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		if (event.message?.role === "assistant" && peek.phase === "thinking") {
			// Sub-message finished (answer text or a tool call): freeze the peek line.
			peek.phase = "done";
			setPeekLabel(ctx);
		}
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (newConfig) => {
			const cursorStyleChanged = config.cursorStyle !== newConfig.cursorStyle;
			const wheelScrollLinesChanged = config.fullscreen.wheelScrollLines !== newConfig.fullscreen.wheelScrollLines;
			const thinkingPeekLinesChanged = config.thinkingPeek.lines !== newConfig.thinkingPeek.lines;
			saveConfig(newConfig);
			config = newConfig;
			if (newConfig.thinkingPeek.lines === 0 || !newConfig.enabled) {
				resetPeek();
				clearPeekLabel(lastCtx);
			} else if (thinkingPeekLinesChanged && peekLabelActive) {
				setPeekLabel(lastCtx);
			}
			if (cursorStyleChanged && active && editor) {
				editor.setCursorStyle(newConfig.cursorStyle);
			}
			if (wheelScrollLinesChanged && active && editor) {
				editor.setWheelScrollLines(newConfig.fullscreen.wheelScrollLines);
			}
			if (lastCtx) {
				pendingUiChange = getPendingUiChange(newConfig.enabled, active);
			}
			const gitNeeded = newConfig.footerSegments.gitBranch || newConfig.footerSegments.gitStatus || newConfig.footerSegments.gitCommit;
			if (lastCtx && gitNeeded) {
				void scheduleGitRefresh(lastCtx);
			} else {
				state.git = emptyGitStatus();
			}
			requestFooterRender?.();
		},
		onOverlayClosed: () => {
			if (!lastCtx || pendingUiChange === undefined) return;
			const change = pendingUiChange;
			pendingUiChange = undefined;
			if (!config.enabled || change === "uninstall") {
				uninstallUi(lastCtx);
			} else {
				applyUi(lastCtx);
			}
		},
	});
}
