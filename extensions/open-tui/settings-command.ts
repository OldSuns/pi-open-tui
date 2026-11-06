import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	getKeybindings,
	getSelectPageIndex,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { applyAppearancePreset, type CursorStyle, type IconMode, type OpenTuiConfig, type SettingsLanguage, type ThinkingPeekLines } from "./config.ts";

interface SettingItem {
	id: string;
	label: string;
	currentValue: string;
}

interface SettingGroup {
	label?: string;
	items: SettingItem[];
}

type SettingRow =
	| { kind: "header"; label: string }
	| { kind: "setting"; item: SettingItem };

type Tab = "features" | "icons" | "segments" | "telemetry";

const TABS: Tab[] = ["features", "icons", "segments", "telemetry"];

const COPY = {
	en: {
		title: "Open TUI Settings",
		tabs: { features: "General", icons: "Appearance", segments: "Footer", telemetry: "Telemetry" },
		sections: {
			extension: "Extension",
			interface: "Interface",
			messages: "Messages & tools",
			footer: "Footer",
			icons: "Icons",
			editor: "Editor",
			location: "Location",
			git: "Git",
			runtime: "Runtime",
			usage: "Usage",
			other: "Other",
			measurements: "Measurements",
		},
		hint: "Tab/Shift+Tab/←/→: tabs · ↑/↓: move · Enter/Space: change · Esc/q: close",
		labels: {
			enabled: "Enabled",
			header: "Override header",
			appearancePreset: "Appearance preset",
			inlineFooter: "Footer in editor border",
			copyButtons: "Copy buttons",
			thinkingPeek: "Thinking peek",
			toolView: "Tool view",
			extensionTools: "Compact extension tools",
			language: "Language",
			cursorStyle: "Cursor style",
			iconMode: "Icon mode",
			cwd: "CWD",
			hostname: "Hostname",
			sessionName: "Session name",
			gitBranch: "Git branch",
			gitStatus: "Git status",
			gitCommit: "Git tag (detached HEAD)",
			runtime: "Project runtime",
			context: "Context usage",
			contextBar: "Context bar",
			tokens: "Session tokens",
			cost: "Session cost",
			extensionStatuses: "Extension status line",
			extensionSegments: "Extension footer segments",
			capitalizeProviderName: "Capitalize provider name",
			nerdIconSpacing: "Extra space after Nerd icons",
			liveTps: "Live TPS",
			totalDuration: "Total duration",
			tokenCounts: "Run tokens",
			stallDetails: "Stall details",
			costRate: "Price per 1M tokens",
		},
		values: {
			on: "On",
			off: "Off",
			thinkingPeek: { off: "Off", one: "1 line", two: "2 lines" },
			toolView: { native: "Native", compact: "Compact" },
			appearancePreset: { "open-tui": "OpenTUI", "claude-code": "Claude Code" },
			languages: { en: "English", zh: "简体中文" },
			cursorStyles: { block: "Block", bar: "Bar", underline: "Underline" },
			icons: { auto: "Auto", nerd: "Nerd", unicode: "Unicode", ascii: "ASCII" },
		},
	},
	zh: {
		title: "Open TUI 设置",
		tabs: { features: "常规", icons: "外观", segments: "底栏", telemetry: "遥测" },
		sections: {
			extension: "扩展",
			interface: "界面",
			messages: "消息与工具",
			footer: "底栏",
			icons: "图标",
			editor: "输入框",
			location: "位置",
			git: "Git",
			runtime: "运行环境",
			usage: "用量",
			other: "其他",
			measurements: "测量指标",
		},
		hint: "Tab/Shift+Tab/←/→：切页 · ↑/↓：移动 · Enter/Space：更改 · Esc/q：关闭",
		labels: {
			enabled: "启用",
			header: "覆盖顶部信息栏",
			appearancePreset: "外观预设",
			inlineFooter: "底栏嵌入输入框",
			copyButtons: "复制按钮",
			thinkingPeek: "思考预览",
			toolView: "工具视图",
			extensionTools: "紧凑显示扩展工具",
			language: "语言",
			cursorStyle: "光标样式",
			iconMode: "图标模式",
			cwd: "当前目录",
			hostname: "主机名",
			sessionName: "会话名",
			gitBranch: "Git 分支",
			gitStatus: "Git 状态",
			gitCommit: "Git 标签（分离 HEAD）",
			runtime: "项目运行环境",
			context: "上下文用量",
			contextBar: "上下文进度条",
			tokens: "会话 Token",
			cost: "会话费用",
			extensionStatuses: "扩展状态行",
			extensionSegments: "扩展底栏片段",
			capitalizeProviderName: "提供商名称首字母大写",
			nerdIconSpacing: "Nerd 图标后额外留空",
			liveTps: "实时 TPS",
			totalDuration: "总耗时",
			tokenCounts: "单次运行 Token",
			stallDetails: "停顿详情",
			costRate: "每百万 Token 单价",
		},
		values: {
			on: "开启",
			off: "关闭",
			thinkingPeek: { off: "关闭", one: "单行", two: "双行" },
			toolView: { native: "原生", compact: "紧凑" },
			appearancePreset: { "open-tui": "OpenTUI", "claude-code": "Claude Code" },
			languages: { en: "English", zh: "简体中文" },
			cursorStyles: { block: "块", bar: "竖线", underline: "下划线" },
			icons: { auto: "自动", nerd: "Nerd", unicode: "Unicode", ascii: "ASCII" },
		},
	},
} as const;

type SettingsCopy = (typeof COPY)[SettingsLanguage];

function formatThinkingPeekLines(lines: ThinkingPeekLines, copy: SettingsCopy): string {
	const values = [copy.values.thinkingPeek.off, copy.values.thinkingPeek.one, copy.values.thinkingPeek.two];
	return values[lines] ?? values[0];
}

function toggleSetting(config: OpenTuiConfig, key: keyof OpenTuiConfig["footerSegments"]): OpenTuiConfig {
	return {
		...config,
		footerSegments: {
			...config.footerSegments,
			[key]: !config.footerSegments[key],
		},
	};
}

function cycleIconMode(config: OpenTuiConfig): OpenTuiConfig {
	const order: IconMode[] = ["auto", "nerd", "unicode", "ascii"];
	const currentIdx = order.indexOf(config.icons.mode);
	const next = order[(currentIdx + 1) % order.length]!;
	return { ...config, icons: { mode: next } };
}

function toggleEnabled(config: OpenTuiConfig): OpenTuiConfig {
	return { ...config, enabled: !config.enabled };
}

function toggleLanguage(config: OpenTuiConfig): OpenTuiConfig {
	return { ...config, settingsLanguage: config.settingsLanguage === "en" ? "zh" : "en" };
}

function cycleCursorStyle(config: OpenTuiConfig): OpenTuiConfig {
	const order: CursorStyle[] = ["block", "bar", "underline"];
	const currentIdx = order.indexOf(config.cursorStyle);
	const next = order[(currentIdx + 1) % order.length]!;
	return { ...config, cursorStyle: next };
}

function toggleTelemetry(config: OpenTuiConfig, key: keyof OpenTuiConfig["telemetry"]): OpenTuiConfig {
	return {
		...config,
		telemetry: { ...config.telemetry, [key]: !config.telemetry[key] },
	};
}

function cycleThinkingPeek(config: OpenTuiConfig): OpenTuiConfig {
	const next = ([1, 2, 0] as const)[config.thinkingPeek.lines] ?? 0;
	return {
		...config,
		thinkingPeek: { lines: next },
	};
}

function buildFeaturesItems(config: OpenTuiConfig, copy: SettingsCopy): SettingGroup[] {
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	return [
		{
			label: copy.sections.extension,
			items: [{ id: "enabled", label: copy.labels.enabled, currentValue: flag(config.enabled) }],
		},
		{
			label: copy.sections.interface,
			items: [
				{ id: "header", label: copy.labels.header, currentValue: flag(config.header) },
				{ id: "appearancePreset", label: copy.labels.appearancePreset, currentValue: copy.values.appearancePreset[config.appearancePreset] },
				{ id: "settingsLanguage", label: copy.labels.language, currentValue: copy.values.languages[config.settingsLanguage] },
			],
		},
		{
			label: copy.sections.messages,
			items: [
				{ id: "thinkingPeek", label: copy.labels.thinkingPeek, currentValue: formatThinkingPeekLines(config.thinkingPeek.lines, copy) },
				{ id: "copyButtons", label: copy.labels.copyButtons, currentValue: flag(config.copyButtons) },
				{ id: "toolView", label: copy.labels.toolView, currentValue: copy.values.toolView[config.toolView.mode] },
				...(config.toolView.mode === "compact" ? [
					{ id: "extensionTools", label: `  ${copy.labels.extensionTools}`, currentValue: flag(config.toolView.extensionTools) },
				] : []),
			],
		},
		{
			label: copy.sections.footer,
			items: [{ id: "inlineFooter", label: copy.labels.inlineFooter, currentValue: flag(config.inlineFooter) }],
		},
	];
}

function buildIconsItems(config: OpenTuiConfig, copy: SettingsCopy): SettingGroup[] {
	return [
		{
			label: copy.sections.icons,
			items: [{ id: "mode", label: copy.labels.iconMode, currentValue: copy.values.icons[config.icons.mode] }],
		},
		{
			label: copy.sections.editor,
			items: [{ id: "cursorStyle", label: copy.labels.cursorStyle, currentValue: copy.values.cursorStyles[config.cursorStyle] }],
		},
	];
}

function buildSegmentsItems(config: OpenTuiConfig, copy: SettingsCopy): SettingGroup[] {
	const segs = config.footerSegments;
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	return [
		{
			label: copy.sections.location,
			items: [
				{ id: "cwd", label: copy.labels.cwd, currentValue: flag(segs.cwd) },
				{ id: "hostname", label: copy.labels.hostname, currentValue: flag(segs.hostname) },
				{ id: "sessionName", label: copy.labels.sessionName, currentValue: flag(segs.sessionName) },
			],
		},
		{
			label: copy.sections.git,
			items: [
				{ id: "gitBranch", label: copy.labels.gitBranch, currentValue: flag(segs.gitBranch) },
				{ id: "gitStatus", label: copy.labels.gitStatus, currentValue: flag(segs.gitStatus) },
				{ id: "gitCommit", label: copy.labels.gitCommit, currentValue: flag(segs.gitCommit) },
			],
		},
		{
			label: copy.sections.runtime,
			items: [
				{ id: "runtime", label: copy.labels.runtime, currentValue: flag(segs.runtime) },
				{ id: "context", label: copy.labels.context, currentValue: flag(segs.context) },
				{ id: "contextBar", label: copy.labels.contextBar, currentValue: flag(segs.contextBar) },
				{ id: "liveTps", label: copy.labels.liveTps, currentValue: flag(segs.liveTps) },
			],
		},
		{
			label: copy.sections.usage,
			items: [
				{ id: "tokens", label: copy.labels.tokens, currentValue: flag(segs.tokens) },
				{ id: "cost", label: copy.labels.cost, currentValue: flag(segs.cost) },
			],
		},
		{
			label: copy.sections.other,
			items: [
				{ id: "extensionStatuses", label: copy.labels.extensionStatuses, currentValue: flag(segs.extensionStatuses) },
				{ id: "extensionSegments", label: copy.labels.extensionSegments, currentValue: flag(segs.extensionSegments) },
				{ id: "capitalizeProviderName", label: copy.labels.capitalizeProviderName, currentValue: flag(segs.capitalizeProviderName) },
				{ id: "nerdIconSpacing", label: copy.labels.nerdIconSpacing, currentValue: flag(segs.nerdIconSpacing) },
			],
		},
	];
}

function buildTelemetryItems(config: OpenTuiConfig, copy: SettingsCopy): SettingGroup[] {
	const telemetry = config.telemetry;
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	return [
		{ items: [{ id: "enabled", label: copy.labels.enabled, currentValue: flag(telemetry.enabled) }] },
		{
			label: copy.sections.measurements,
			items: [
				{ id: "tps", label: "TPS", currentValue: flag(telemetry.tps) },
				{ id: "ttft", label: "TTFT", currentValue: flag(telemetry.ttft) },
				{ id: "duration", label: copy.labels.totalDuration, currentValue: flag(telemetry.duration) },
				{ id: "tokens", label: copy.labels.tokenCounts, currentValue: flag(telemetry.tokens) },
				{ id: "stalls", label: copy.labels.stallDetails, currentValue: flag(telemetry.stalls) },
				{ id: "cost", label: copy.labels.costRate, currentValue: flag(telemetry.cost) },
			],
		},
	];
}

function buildItems(tab: Tab, config: OpenTuiConfig): SettingRow[] {
	const copy = COPY[config.settingsLanguage];
	let groups: SettingGroup[];
	switch (tab) {
		case "features": groups = buildFeaturesItems(config, copy); break;
		case "icons": groups = buildIconsItems(config, copy); break;
		case "segments": groups = buildSegmentsItems(config, copy); break;
		case "telemetry": groups = buildTelemetryItems(config, copy); break;
	}
	return groups.flatMap<SettingRow>((group) => [
		...(group.label ? [
			{ kind: "header" as const, label: group.label },
		] : []),
		...group.items.map((item) => ({ kind: "setting" as const, item })),
	]);
}

function handleSettingChange(
	tab: Tab,
	itemId: string,
	config: OpenTuiConfig,
): OpenTuiConfig {
	if (tab === "features") {
		if (itemId === "enabled") return toggleEnabled(config);
		if (itemId === "header") return { ...config, header: !config.header };
		if (itemId === "appearancePreset") {
			const preset = config.appearancePreset === "claude-code" ? "open-tui" : "claude-code";
			return applyAppearancePreset(config, preset);
		}
		if (itemId === "inlineFooter") return { ...config, inlineFooter: !config.inlineFooter };
		if (itemId === "copyButtons") return { ...config, copyButtons: !config.copyButtons };
		if (itemId === "settingsLanguage") return toggleLanguage(config);
		if (itemId === "thinkingPeek") return cycleThinkingPeek(config);
		if (itemId === "toolView") {
			return { ...config, toolView: { ...config.toolView, mode: config.toolView.mode === "native" ? "compact" : "native" } };
		}
		if (itemId === "extensionTools") {
			return { ...config, toolView: { ...config.toolView, extensionTools: !config.toolView.extensionTools } };
		}
	}
	if (tab === "icons") {
		if (itemId === "mode") return cycleIconMode(config);
		if (itemId === "cursorStyle") return cycleCursorStyle(config);
	}
	if (tab === "segments") {
		return toggleSetting(config, itemId as keyof OpenTuiConfig["footerSegments"]);
	}
	if (tab === "telemetry") {
		return toggleTelemetry(config, itemId as keyof OpenTuiConfig["telemetry"]);
	}
	return config;
}

// SelectList only receives actual settings. This component inserts section rows
// into its rendered output and scrolls in display rows, including the headers.
class SectionedSettingsList {
	readonly capturesViewportInput = true;
	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;
	private readonly selectList: SelectList;
	private readonly items: SelectItem[];
	private readonly rows: SettingRow[];
	private readonly theme: Theme;
	private readonly visibleRows: number;
	private readonly showScrollInfo: boolean;
	private pressedItemId: string | undefined;

	constructor(
		rows: SettingRow[],
		availableRows: number,
		width: number,
		theme: Theme,
	) {
		this.rows = rows;
		this.theme = theme;
		const compact = width <= 60;
		this.items = rows.flatMap<SelectItem>((row) => {
			if (row.kind !== "setting") return [];
			const item = row.item;
			return [{
				value: item.id,
				// Reserve Box padding (2), SelectList prefix/safety (4), and ": " (2).
				label: compact
					? `${truncateToWidth(item.label, Math.max(0, width - 8 - visibleWidth(item.currentValue)))}: ${item.currentValue}`
					: item.label,
				description: compact ? undefined : item.currentValue,
			}];
		});
		// Reserve the scroll indicator when there is room for it and a setting.
		this.showScrollInfo = rows.length > availableRows && availableRows > 1;
		this.visibleRows = Math.max(1, availableRows - (this.showScrollInfo ? 1 : 0));
		this.selectList = new SelectList(this.items, this.items.length, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		this.selectList.onSelect = (item) => this.onSelect?.(item);
		this.selectList.onCancel = () => this.onCancel?.();
		this.selectList.onSelectionChange = (item) => this.onSelectionChange?.(item);
	}

	getSelectedItem(): SelectItem | null {
		return this.selectList.getSelectedItem();
	}

	selectItem(itemId: string | undefined): void {
		const index = this.items.findIndex((item) => item.value === itemId);
		if (index >= 0) this.selectList.setSelectedIndex(index);
	}

	private selectedRowIndex(): number {
		const selected = this.getSelectedItem();
		return this.rows.findIndex((row) => row.kind === "setting" && row.item.id === selected?.value);
	}

	private visibleRange(): { start: number; end: number } {
		const start = Math.max(0, Math.min(
			this.selectedRowIndex() - Math.floor(this.visibleRows / 2),
			this.rows.length - this.visibleRows,
		));
		return { start, end: Math.min(start + this.visibleRows, this.rows.length) };
	}

	render(width: number): string[] {
		const settingLines = this.selectList.render(width);
		let itemIndex = 0;
		const lines = this.rows.map((row) => {
			if (row.kind === "setting") return settingLines[itemIndex++]!;
			const label = truncateToWidth(`  ──${row.label} `, width, "");
			return this.theme.fg("dim", label + "─".repeat(Math.max(0, width - visibleWidth(label))));
		});
		const { start, end } = this.visibleRange();
		const visible = lines.slice(start, end);
		if (this.showScrollInfo) {
			visible.push(this.theme.fg("dim", truncateToWidth(
				`  (${this.selectedRowIndex() + 1}/${this.rows.length})`, width, "",
			)));
		}
		return visible;
	}

	handleInput(data: string): void {
		this.pressedItemId = undefined;
		const kb = getKeybindings();
		const pageIndex = getSelectPageIndex(kb, data, this.selectedRowIndex(), this.rows.length, this.visibleRows);
		if (pageIndex === undefined) {
			this.selectList.handleInput(data);
			return;
		}
		const direction = kb.matches(data, "tui.select.pageUp") ? -1 : 1;
		let index = pageIndex;
		while (index >= 0 && index < this.rows.length && this.rows[index]?.kind !== "setting") index += direction;
		if (index < 0 || index >= this.rows.length) {
			index = pageIndex;
			while (index >= 0 && index < this.rows.length && this.rows[index]?.kind !== "setting") index -= direction;
		}
		const row = this.rows[index];
		if (row?.kind === "setting") {
			this.selectItem(row.item.id);
			const selected = this.getSelectedItem();
			if (selected) this.onSelectionChange?.(selected);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.pressedItemId = undefined;
			return this.selectList.handleMouse(event);
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const { start, end } = this.visibleRange();
		const rowIndex = start + event.y;
		const row = rowIndex >= start && rowIndex < end ? this.rows[rowIndex] : undefined;
		if (row?.kind !== "setting") {
			this.pressedItemId = undefined;
			return { handled: true, render: false };
		}
		const itemId = event.type === "click" ? this.pressedItemId ?? row.item.id : row.item.id;
		this.pressedItemId = event.type === "press" ? itemId : undefined;
		this.selectItem(itemId);
		const selected = this.getSelectedItem();
		if (selected) {
			this.onSelectionChange?.(selected);
			if (event.type === "click") this.onSelect?.(selected);
		}
		return { handled: true, focus: true, render: true };
	}

	invalidate(): void {
		this.selectList.invalidate();
	}
}

interface SettingsUiHandle {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
	handleMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

class SettingsUi implements SettingsUiHandle {
	private tab: Tab = "features";
	private config: OpenTuiConfig;
	private selectList!: SectionedSettingsList;
	private readonly selectedItemByTab: Partial<Record<Tab, string>> = {};
	private readonly container: Box;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly onChange: (config: OpenTuiConfig) => void;
	private readonly onClose: () => void;
	private layoutWidth: number | undefined;
	private layoutRows: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		config: OpenTuiConfig,
		onChange: (config: OpenTuiConfig) => void,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.config = config;
		this.onChange = onChange;
		this.onClose = onClose;
		this.container = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
		this.rebuild();
	}

	private applySetting(itemId: string): void {
		this.selectedItemByTab[this.tab] = itemId;
		this.config = handleSettingChange(this.tab, itemId, this.config);
		this.onChange(this.config);
		this.rebuild(itemId);
	}

	private switchTab(offset: number): void {
		const idx = TABS.indexOf(this.tab);
		this.tab = TABS[(idx + offset + TABS.length) % TABS.length]!;
		this.rebuild();
	}

	private rebuild(
		preferredItemId = this.selectedItemByTab[this.tab],
		width = this.layoutWidth ?? Math.min(80, this.tui.terminal.columns),
	): void {
		this.layoutWidth = width;
		this.layoutRows = this.tui.terminal.rows;
		const copy = COPY[this.config.settingsLanguage];
		this.container.clear();
		this.container.addChild(new Text(this.theme.bold(this.theme.fg("accent", copy.title)), 1, 0));

		const tabBar = TABS.map((tab) => {
			const active = tab === this.tab;
			const label = active ? `[${copy.tabs[tab]}]` : ` ${copy.tabs[tab]} `;
			return active ? this.theme.fg("accent", label) : this.theme.fg("dim", label);
		}).join(" ");
		this.container.addChild(new Text(tabBar, 1, 0));
		this.container.addChild(new Text(this.theme.fg("dim", copy.hint), 1, 0));

		const availableRows = this.layoutRows - this.container.render(width).length;
		this.selectList = new SectionedSettingsList(buildItems(this.tab, this.config), availableRows, width, this.theme);
		this.selectList.selectItem(preferredItemId);
		this.selectedItemByTab[this.tab] = this.selectList.getSelectedItem()?.value;
		this.selectList.onSelectionChange = (item) => {
			this.selectedItemByTab[this.tab] = item.value;
		};
		this.selectList.onSelect = (item) => {
			this.applySetting(item.value);
		};
		this.selectList.onCancel = () => {
			this.onClose();
		};
		this.container.addChild(this.selectList);

		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.switchTab(1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.switchTab(-1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.space) || data === " ") {
			const selected = this.selectList.getSelectedItem();
			if (selected) this.applySetting(selected.value);
		} else {
			this.selectList.handleInput?.(data);
		}
		this.invalidate();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = this.container.handleMouse(event);
		if (result?.handled && result.render !== false) this.invalidate();
		// Keep keyboard focus on SettingsUi so tab switching and close shortcuts
		// still run here after clicking a setting inside the nested Box.
		return result ? { handled: result.handled, render: result.render } : undefined;
	}

	render(width: number): string[] {
		if (width !== this.layoutWidth || this.tui.terminal.rows !== this.layoutRows) {
			this.rebuild(undefined, width);
		}
		if (this.cachedLines) return this.cachedLines;
		this.cachedLines = this.container.render(width);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.container.invalidate();
	}
}

export function registerSettingsCommand(
	pi: ExtensionAPI,
	hooks: {
		getConfig: () => OpenTuiConfig;
		onConfigChanged: (config: OpenTuiConfig) => void;
		onOverlayClosed?: () => void;
	},
): void {
	pi.registerCommand("open-tui", {
		description: "Open the open-tui settings UI",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			await ctx.ui.custom<void>((tui: TUI, theme, _kb, done) => {
				const ui = new SettingsUi(
					tui,
					theme,
					hooks.getConfig(),
					(config) => hooks.onConfigChanged(config),
					() => done(undefined),
				);
				return {
					capturesViewportInput: true,
					render: (w: number) => ui.render(w),
					invalidate: () => ui.invalidate(),
					handleInput: (data: string) => {
						ui.handleInput(data);
						tui.requestRender();
					},
					handleMouse: (event: TuiMouseEvent) => {
						const result = ui.handleMouse(event);
						if (result?.handled && result.render !== false) tui.requestRender();
						return result;
					},
				};
			}, { overlay: true });
			// Overlay is closed and focus is back on the editor. Deferred UI changes
			// (e.g. toggling the extension) run here, so pi core's focus restore
			// cannot strand the overlay without keyboard input.
			hooks.onOverlayClosed?.();
		},
	});
}
