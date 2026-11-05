# Implementation and compatibility / 实现与兼容性

[English](#english) | [简体中文](#简体中文)

## English

Feature examples and everyday controls are in the [README](../README.md). All settings and defaults are in the [configuration reference](./configuration.md#english). This document explains the measurements, rendering rules, and integration boundaries behind those features.

### Lifecycle and data sources

[index.ts](../extensions/open-tui/index.ts) connects Pi events to the UI. At session start it loads settings and, when enabled in a TUI context, installs the footer, editor decoration, Copy-button integration, and the header if `header` is also enabled. Tool renderers are registered separately; configuration is loaded early when Pi rebuilds a resumed transcript before `session_start`.

The working timer requests a redraw every 250 ms while an agent run is active. Git and runtime reads capture a session generation; their results are discarded if the session has changed or shut down. Shutdown stops the timer, deactivates footer contributions, and removes the installed UI. Compact tool activity timers are stopped when execution ends or the session shuts down. See [session-lifecycle.ts](../extensions/open-tui/session-lifecycle.ts) for the generation guard.

- [git.ts](../extensions/open-tui/git.ts) parses `git status --porcelain=v1 --branch` and reads commit, tag, and stash information as requested. Each Git command has a two-second timeout. A failed status read produces an empty Git state. Turning off both branch and status display avoids the refresh; `gitCommit` only adds a tag to the detached branch display.
- [runtime.ts](../extensions/open-tui/runtime.ts) chooses the first matching definition from its ordered list of 50+ runtimes and environments. It checks project files, folders, extensions, and environment variables in the working directory. It reports the locally executed version command's result, not a declared dependency version. Version commands have a 2.5-second timeout; unavailable versions leave the runtime symbol visible. Results are cached by directory and runtime, with a fingerprint of relevant files and environment values.
- [state.ts](../extensions/open-tui/state.ts) reads model metadata and session usage. Usage is cached by session manager and leaf ID, with invalidation on message completion, compaction, tree changes, and session start.

### Editor and layout

[editor.ts](../extensions/open-tui/editor.ts) decorates the same editor instance, retaining input callbacks, completion, and ghost text. It requires native-style borders plus focus, border-color, mouse, and padding capabilities. An initial render probes for the borders; missing capabilities, an unrecognized layout, or a failing probe leave the editor undecorated. Each framed render checks the borders again. If they disappear, that render uses the full requested width without frame mouse offsets; framing resumes when the borders return.

Factories registered through the current `ctx.ui.setEditorComponent()` API can run before or after open-tui. Runtime replacements are decorated when Pi mounts them, including replacements from a fresh shortcut context. Temporary dialogs are left alone. Cleanup restores owned methods and preserves the latest editor factory, including wrappers registered later. This ordering guarantee does not extend to header/footer replacement or extensions that bypass the current registration API with a saved setter or replace its methods.

Block mode uses the editor's existing cursor behavior. Bar and underline modes enable the terminal hardware cursor and request its shape with terminal escape sequences. Terminal support is required; cleanup restores the prior hardware-cursor visibility.

[footer.ts](../extensions/open-tui/footer.ts) and [utils.ts](../extensions/open-tui/utils.ts) fit content by visible terminal width. Without contributed segments, the first row tries compact forms (directory basename, context percentage, timer without live TPS) before shrinking or dropping runtime/context, then Git, session name, hostname/timer, and finally the directory. The second row prioritizes statistics over the model label.

Inline mode puts session name and Git on the top-left border; the directory starts the right-hand group, followed by host, runtime, timer, and context. Model details remain bottom-left, with token/cost data bottom-right. A compatible framed editor is needed; otherwise the footer stays separate. Extension status rows remain outside the frame and may wrap. Styled statuses preserve their ANSI colors, while unstyled statuses use the muted theme color; terminal commands and line breaks are filtered.

Contributed main-row segments use the shared width and priority rules in the [footer API reference](./footer-segments.md#placement-and-width). Hiding a built-in field does not remove its anchor. Footer replacement, disablement, or session shutdown invalidates the contribution lifecycle; contributors must republish for a new lifecycle.

### Usage and telemetry

Footer totals include assistant messages, usage reported by tool results, standalone usage entries such as cache warming, compaction, and branch summaries. Input is displayed as uncached input plus cache reads: `U = input + cacheWrite`, `R = cacheRead`, for example `12k (U 2k + R 10k)`. Cost sums the recorded `usage.cost.total` values.

The cache-hit percentage uses the latest assistant response: `cacheRead / (input + cacheRead + cacheWrite) × 100`. It is not a cumulative hit rate and is omitted when cache usage has never been reported or the latest response lacks a usable denominator.

[telemetry.ts](../extensions/open-tui/telemetry.ts) combines measured assistant turns into one notification at `agent_settled`:

| Field | Calculation and limits |
| --- | --- |
| TPS | Sum of provider-reported assistant output tokens divided by summed generation seconds, from each `turn_start` to the assistant `message_end`. Includes TTFT, reasoning, buffering, and stalls; excludes tool execution between turns. Displays `—` without output tokens or measurable generation time |
| TTFT | First measured turn's start to its first nonempty text, thinking, or tool-call-argument delta. If only final output usage arrives, message completion is the available first-output timestamp |
| Duration | Elapsed time from `agent_start` to `agent_settled`, including tools |
| Tokens | Assistant usage in measured turns, with input separated into uncached (`input + cacheWrite`) and cache reads |
| Stalls | Gaps of at least one second between nonempty stream updates after output begins. Consecutive qualifying gaps form one stall until a shorter gap occurs. The entire gap contributes to stall time; shown only when detected |
| `$ / M` | `sum(usage.cost.total) / (sum(usage.totalTokens) / 1,000,000)`. An effective rate combining the reported input, output, and cache prices, not the session's total spend. Omitted without positive cost and token totals |

A turn produces no measurement when it lacks a completed assistant message or observed output. Observed output means a nonempty streamed text, thinking, or tool-call delta, or a positive final output usage value. A run with no measured turns produces no notification. Provider buffering and missing usage data limit what the extension can report. The notification covers assistant turns, whereas footer totals include the additional session usage sources above.

Live TPS uses streamed text, thinking, and tool-call arguments over a trailing two-second window. It estimates roughly four characters per token for Latin text/code and one token per CJK character. A stream pause makes the rate fall toward zero; during tool execution and between messages the last rate remains dimmed. It resets when the run settles. This estimate has its own `footerSegments.liveTps` switch and can differ from the provider-based final TPS.

### Thinking labels

[peek.ts](../extensions/open-tui/peek.ts) tracks idle, thinking, and done phases. It extracts the latest nonempty reasoning lines, normalizes whitespace, and strips terminal control sequences before display. The label is built using the width of the actual message component, so a layout extension can make it narrower than the terminal.

In two-line mode, a long latest logical line can occupy both rows; otherwise the previous and latest lines share the same indentation. Clipping retains the newest tail and respects visible width and grapheme boundaries. Answer text or assistant-message completion freezes the label at a check mark. After settlement, the native label returns after a short delay guarded against clearing a newer task's label. Pi's own Hide thinking toggle controls visibility.

### Tool rendering

[tool-view.ts](../extensions/open-tui/tool-view.ts) registers rendering wrappers, leaving execution, arguments, results, and model-visible content unchanged. Built-in summaries are selected only when Pi reports the tool source as `builtin`. A same-name replacement keeps its native renderer unless compact mode and `toolView.extensionTools` are both enabled, in which case it uses extension handling. `toolView.exclude` takes precedence over either category.

Successful rows have dim text and a green dot. Pending dots are dim; running dots alternate between accent and dim once per second. Errors retain a red dot and summary. Shell output shows the latest three nonempty lines while running; failures retain the closing status and last output line. Known tool truncation notices are summarized without discarding arbitrary bracketed text or error messages.

Completed rows reuse rendered lines until width, theme, icons, or invalidation changes them. Calls remain independent. Expansion uses the renderers Pi resolves, with generic argument/output components only for missing extension renderers. Inline images remain visible while collapsed because Pi renders them below the row.

#### Edit and write previews

[tool-preview.ts](../extensions/open-tui/tool-preview.ts) parses Pi's actual edit diff. Malformed diffs have no guessed preview. Old and new code are syntax-highlighted separately, with red/green backgrounds for removed/added lines. Adjacent removed/added groups are paired for stronger changed-word highlighting when they share enough content.

Word matching is bounded to an edit distance of 256. Lines up to 512 characters have no wall-clock timeout, so scheduling delays do not remove their word highlights. Longer lines up to 4,096 characters use a five-millisecond timeout; larger or unmatched lines keep whole-line highlighting. Syntax highlighting has a separate input-size budget.

Write previews use the submitted content with line numbers on the normal background. New files and overwrites look the same; no old-file diff is synthesized. Only successful completed edit/write results get previews. Bodies show at most 16 rows, including context and ellipsis rows, followed by a hidden-row count and `Ctrl+O` hint. Compact previews truncate long lines with `…`; expanded rendering retains Pi's native behavior.

#### Extension and FFF summaries

With `toolView.extensionTools` enabled, unknown tools use generic summaries: nonempty text-line counts, image counts, duration, and the first text line. They do not receive edit/write previews. Truncation requires `details.truncation.truncated: true`; a valid total line count may replace the displayed count, but built-in-specific limit fields are not interpreted. Running rows show elapsed time even before a first result arrives.

Native extension renderers start when a row is expanded. After collapse, hidden progress updates are skipped, but completion and error updates still reach previously initialized renderers so their timers can stop. Put tools that depend on native progress behavior in `toolView.exclude`.

Recognized `@ff-labs/pi-fff` installations use search summaries. `ffgrep` and `fff-multi-grep` report this page's match count; `fffind` reports the total matching file count. These rules also cover FFF's `grep`/`find`/`multi_grep` override names. Summaries preserve pagination, fuzzy and regex-to-literal fallback, and capped weak-match hints; indexed file counts are not treated as matches.

Recognition checks Pi's npm source metadata, the installed npm entry path, or the official `dmtrKovalenko/fff` GitHub source with its `packages/pi-fff/src/index.ts` entry point. Unrecognized sources or result metadata use the generic summary. Expansion preserves FFF's native output and its existing line-length limits.

### Copy-button behavior

[copy-buttons.ts](../extensions/open-tui/copy-buttons.ts) decorates Markdown code blocks and user messages in fullscreen mode. At a code block's rendering width below 8 columns, native fences are retained; from 8 through 15 columns, the frame has no label. A completed block can show `[Copy]` from 16 columns. Long code lines wrap inside the frame. The top/bottom borders replace the fence rows, and the label adds no extra row. Thinking blocks retain native fences; streaming blocks have a frame without a label.

Each Markdown owner tracks block descriptors and occurrence-specific copy regions. Marker data survives Pi's block cache and is removed before display; occurrence matching restores source tabs that Pi normalizes for rendering. A policy change, such as streaming completion, invalidates the Markdown cache so labels appear without resizing. Repeated identical blocks still copy their own source occurrence.

The user-message label occupies the bubble's last row and copies the original message. Code labels copy code without fences. Ordinary selection is passed to Pi; a qualifying left-button release on a recorded Copy press copies the text. Moving, removing, or changing a target cancels a held click, as do disabling or cleaning up the installation. Clipboard completion from a cleaned-up installation does not flash a notification.

Some integrations use Pi component internals: Copy buttons check required Markdown and fullscreen mouse methods before installing; per-message thinking labels and editor mounting also inspect component structure. Other extensions that patch the same renderers can affect compatibility. Cleanup restores methods still owned by open-tui and leaves later wrappers in place.

## 简体中文

功能示例和日常操作见 [README](../README.zh-CN.md)，全部设置与默认值见[配置参考](./configuration.md#简体中文)。本文说明这些功能背后的指标口径、渲染规则和集成边界。

### 生命周期与数据来源

[index.ts](../extensions/open-tui/index.ts) 将 Pi 事件接入界面。会话开始时读取配置；在已启用的 TUI 环境中安装底栏、编辑器装饰和复制按钮，并在 `header` 也开启时安装顶栏。工具渲染器单独注册；恢复会话时，Pi 可能在 `session_start` 之前重建记录，因此会提前读取配置。

Agent 运行期间，工作计时器每 250 毫秒请求一次重绘。Git 和运行环境读取会记录发起时的会话代次，如果会话已切换或关闭，结果会被丢弃。关闭会话会停止计时器、停用底栏贡献并移除已安装的界面；紧凑工具的动画计时器会在执行结束或会话关闭时停止。代次保护见 [session-lifecycle.ts](../extensions/open-tui/session-lifecycle.ts)。

- [git.ts](../extensions/open-tui/git.ts) 解析 `git status --porcelain=v1 --branch`，按需读取提交、标签和 stash。每条 Git 命令的超时为两秒，状态读取失败时返回空 Git 状态。分支和状态显示都关闭时跳过刷新；`gitCommit` 仅为分离 HEAD 的分支显示追加标签。
- [runtime.ts](../extensions/open-tui/runtime.ts) 从按顺序排列的 50 多种运行环境定义中选择第一个匹配项，检查工作目录中的项目文件、目录、扩展名和环境变量。版本来自本地实际执行的版本命令，不是依赖声明中的版本。命令超时为 2.5 秒，版本不可用时仍显示环境标记。结果按目录和环境缓存，并用相关文件与环境变量构成指纹。
- [state.ts](../extensions/open-tui/state.ts) 读取模型信息与会话用量。用量缓存绑定会话管理器和当前叶节点 ID，在消息结束、压缩、会话树变化和会话开始时失效。

### 编辑器与布局

[editor.ts](../extensions/open-tui/editor.ts) 直接装饰同一个编辑器实例，保留输入回调、补全和灰字建议。它要求编辑器保留原生风格的边界，以及焦点、边框颜色、鼠标和内边距接口。初次渲染会检测边界；能力缺失、布局不符或检测抛错时，不加装饰。之后每次加框也会重新检查；边界消失时，该次渲染使用完整请求宽度且不偏移鼠标坐标，边界恢复后继续加框。

通过当前 `ctx.ui.setEditorComponent()` 接口注册的工厂可以在 open-tui 之前或之后执行。运行时替换在 Pi 挂载编辑器时装饰，也支持来自新快捷键上下文的替换；临时对话框保持原样。清理时恢复自己拥有的方法，保留最新的编辑器工厂和后注册的包装。该顺序保证不涵盖顶栏/底栏替换，也不涵盖通过旧 setter 绕过当前注册接口或直接替换接口方法的扩展。

块状模式保留编辑器现有光标行为；竖线和下划线模式开启终端硬件光标，并通过终端转义序列请求形状，因此需要终端支持。清理时恢复先前的硬件光标可见性。

[footer.ts](../extensions/open-tui/footer.ts) 与 [utils.ts](../extensions/open-tui/utils.ts) 按终端可见宽度排版。没有扩展嵌入片段时，第一行先尝试目录末级名称、上下文百分比、去除实时 TPS 的计时器等紧凑形式，再缩短或移除运行环境/上下文、Git、会话名、主机名/计时器，最后才是当前目录。第二行优先保留统计数据，再缩短模型标签。

内嵌模式将会话名和 Git 放在上边框左侧，右侧从当前目录开始，接主机名、运行环境、计时器和上下文；下边框左侧为模型，右侧为 Token/费用。需要兼容且已加框的编辑器，否则底栏独立显示。扩展状态行始终在边框外，可换行。已设置样式的状态保留 ANSI 颜色，无样式内容使用 muted 主题色，终端命令和换行会被过滤。

主信息行中的扩展片段使用[底栏接口文档](./footer-segments.md#placement-and-width)规定的共享宽度与优先级。隐藏内置字段不会移除其锚点；底栏被替换、扩展被关闭或会话结束时，贡献生命周期失效，提供内容的扩展必须在新生命周期重新发布。

### 用量与遥测

底栏总计包含助手消息、工具结果报告的用量、缓存预热等独立用量记录、压缩和分支摘要。输入区分未缓存输入与缓存读取：`U = input + cacheWrite`，`R = cacheRead`，例如 `12k (U 2k + R 10k)`。费用对记录中的 `usage.cost.total` 求和。

缓存命中率使用最近一条助手回复的 `cacheRead / (input + cacheRead + cacheWrite) × 100`，不表示累计命中率。没有报告过缓存用量，或最新回复缺少有效分母时不显示。

[telemetry.ts](../extensions/open-tui/telemetry.ts) 将可测量的助手轮次合并，在 `agent_settled` 时生成一条通知：

| 字段 | 计算方式与限制 |
| --- | --- |
| TPS | 服务商报告的助手输出 Token 总量除以生成秒数总和，每轮从 `turn_start` 计到助手 `message_end`。包含 TTFT、推理、缓冲和停顿，不包含轮次之间的工具执行；无输出 Token 或有效生成时间时显示 `—` |
| TTFT | 第一个被统计轮次开始，到首次非空正文、思考或工具参数增量的时间。如果只在结束时收到输出用量，则以消息结束时间作为可用的首次输出时间 |
| 耗时 | 从 `agent_start` 到 `agent_settled` 的时间，包含工具执行 |
| Token | 被统计轮次中的助手用量，输入区分未缓存（`input + cacheWrite`）和缓存读取 |
| 停顿 | 输出开始后，非空流式更新之间至少一秒的间隔。连续满足条件的间隔归为一次停顿，直到出现更短间隔；停顿时长包含整个间隔，仅检测到时显示 |
| `$ / M` | `sum(usage.cost.total) / (sum(usage.totalTokens) / 1,000,000)`，综合输入、输出和缓存报告价格的费率，不是会话总费用；缺少正数费用或 Token 总量时不显示 |

缺少完成的助手消息或可识别的输出时，该轮不会产生统计。输出包括非空的流式文本、思考或工具调用增量，也包括正数的最终输出用量。没有可统计轮次的运行不显示通知。服务商缓冲输出和用量字段缺失会限制可测结果。通知统计助手轮次，底栏还包含前述其他会话用量来源。

实时 TPS 根据最近两秒的流式正文、思考和工具调用参数估算，拉丁文本/代码按约四个字符一个 Token，中日韩字符按每字一个 Token。流式停顿时速度降向零，工具执行期间和消息之间以暗色保留上一数值，任务结束后重置。它使用独立的 `footerSegments.liveTps` 开关，数值可能与基于服务商用量的最终 TPS 不同。

### 思考标签

[peek.ts](../extensions/open-tui/peek.ts) 跟踪空闲、思考中和完成三种状态，提取最近的非空推理行、规范空白，并在显示前去除终端控制序列。标签按实际消息组件宽度生成，因此其他布局扩展缩窄消息区域时也会适配。

双行模式中，如果最新逻辑行很长，会占用两行；否则上一行和最新一行保持相同缩进。截断保留最新末尾，并考虑可见宽度和完整字素边界。正文开始或助手消息结束后，标签变为对勾。任务结束后稍作延迟恢复原生标签，并防止旧任务的清理误清新任务标签。可见性仍由 Pi 自身的 Hide thinking 控制。

### 工具渲染

[tool-view.ts](../extensions/open-tui/tool-view.ts) 注册渲染包装，不修改执行、参数、结果或模型可见内容。仅在 Pi 将工具来源标记为 `builtin` 时使用内置摘要。同名替换工具默认保留原生渲染；只有紧凑模式和 `toolView.extensionTools` 同时开启时才使用扩展处理。`toolView.exclude` 优先于这两类规则。

成功行使用暗色文字和绿色圆点，等待圆点变暗，运行圆点每秒在强调色与暗色间切换，错误保留红色圆点和摘要。Shell 运行中显示最新三条非空输出行，失败时保留结束状态与最后一行输出。已知的工具截断通知会归纳为提示，不会把任意方括号正文或错误信息一并删除。

完成的行复用渲染结果，直到宽度、主题、图标变化或缓存失效。各次调用独立显示。展开使用 Pi 解析出的渲染器，仅在扩展缺少渲染器时补上通用参数/输出组件。折叠时内联图片仍可见，因为 Pi 将其绘制在行下方。

#### 编辑与写入预览

[tool-preview.ts](../extensions/open-tui/tool-preview.ts) 解析 Pi 的真实编辑 diff，格式无效时不猜测预览。旧代码和新代码分别做语法高亮，删除/新增行使用红/绿背景。相邻的删除/新增行组会配对，共享内容足够时进一步高亮变更词。

词差异匹配的编辑距离上限为 256。长度不超过 512 个字符的行不使用时钟超时，因此调度延迟不会让词高亮消失；更长且不超过 4,096 个字符的行使用五毫秒超时，更大或无法匹配的行保留整行高亮。语法高亮另有输入长度上限。

写入预览基于提交内容，在普通背景上显示行号；新建与覆盖相同，不生成旧文件 diff。仅完成且成功的编辑/写入会产生预览。正文最多 16 行，包含上下文和省略行，之后显示隐藏行数与 `Ctrl+O` 提示。紧凑预览用 `…` 截断长行，展开后保留 Pi 原生行为。

#### 扩展与 FFF 摘要

开启 `toolView.extensionTools` 后，未知工具使用通用摘要：非空文本行数、图片数、耗时和首行文本，不显示编辑/写入预览。截断要求明确的 `details.truncation.truncated: true`；有效总行数可以替代显示行数，不解释内置工具专用的上限字段。首次结果到达前，运行行也会显示耗时。

扩展原生渲染器在展开时开始运行；再次折叠后跳过隐藏进度更新，但完成和错误仍会传给已初始化的渲染器，以便停止自身计时器。依赖原生进度行为的工具可列入 `toolView.exclude`。

识别到的 `@ff-labs/pi-fff` 安装使用搜索摘要：`ffgrep` 和 `fff-multi-grep` 显示当前页匹配数，`fffind` 显示总匹配文件数，也适用于 FFF 的 `grep`/`find`/`multi_grep` 替换名称。摘要保留分页、模糊搜索、正则转字面搜索和弱匹配限制提示；索引文件总数不会当作命中数。

识别依据是 Pi 的 npm 来源元数据、已安装 npm 包的入口路径，或官方 `dmtrKovalenko/fff` GitHub 来源及其 `packages/pi-fff/src/index.ts` 入口。来源或结果元数据无法识别时使用通用摘要；展开保留 FFF 原生输出及其已有行长度限制。

### 复制按钮行为

[copy-buttons.ts](../extensions/open-tui/copy-buttons.ts) 在全屏模式中装饰 Markdown 代码块和用户消息。代码块渲染宽度不足 8 列时保留原生围栏，8 至 15 列显示无标签边框，从 16 列起完成的代码块可显示 `[Copy]`。长行在边框内换行，上下边框替代围栏行，标签不额外占一行。思考块保留原生围栏，流式代码块只有边框。

每个 Markdown 实例分别跟踪代码块描述和对应的复制区域。标记数据随 Pi 代码块缓存保留，在最终显示前移除；通过具体出现位置匹配源代码，恢复 Pi 渲染时规范化的制表符。流式结束等显示规则变化会使 Markdown 缓存失效，无需调整窗口大小即可显示标签。完全相同的重复代码块仍对应各自的源位置。

用户消息标签位于气泡末行，复制消息原文；代码标签复制不含围栏的代码。普通选择交给 Pi 处理，只有从已记录复制区域按下并满足条件的鼠标左键释放才执行复制。目标移动、消失或变化会取消尚未完成的点击，关闭按钮或清理安装也会取消。已清理安装的异步剪贴板操作结束后不再弹出提示。

部分集成依赖 Pi 组件内部结构：复制按钮安装前会检查所需 Markdown 和全屏鼠标方法，逐消息思考标签和编辑器挂载也会检查组件结构。其他扩展修改相同渲染器时可能影响兼容性。清理仅恢复仍由 open-tui 拥有的方法，保留后来添加的包装。
