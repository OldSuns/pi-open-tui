# pi-open-tui

[English](./README.md) | **简体中文**

一个为 [Pi](https://pi.dev) 编程代理打造的终端界面扩展，将 pi-haiku、pi-claude-code-tui 与 pi-zentui 的优秀设计整合为统一、可配置的使用体验。

![pi-open-tui 预览](https://raw.githubusercontent.com/OldSuns/pi-open-tui/main/assets/preview_dashboard_1.png)

## 功能亮点

- **Pi 顶栏**：显示模型、思考等级、当前目录和常用斜杠命令提示
- **自适应底栏**：集中展示 Git 状态、运行环境、上下文用量、Token、费用和扩展状态
- **带边框的编辑器**：支持块状、竖线和下划线三种光标样式
- **项目环境感知**：识别 50 多种运行环境，并展示 ahead/behind、已暂存、已修改、未跟踪、stash 和 detached HEAD 等 Git 状态
- **单轮遥测**：展示 TPS、首 Token 延迟（TTFT）、耗时、停顿、Token 数量和模型标价速率
- **交互式设置**：通过 `/open-tui` 配置，并支持英文和简体中文界面
- **带版本保护的 Pi 兼容层**：全屏滚轮速度所依赖的运行时支持发生变化时，会回退为 Pi 默认行为

## 环境要求

- Pi 0.80 或更高版本
- 支持 UTF-8 和彩色输出的终端
- 使用完整图标集时需要 [Nerd Font](https://www.nerdfonts.com/font-downloads)（可选；内置 ASCII 图标）

## 安装

安装扩展：

```bash
pi install npm:pi-open-tui
```

也可以只在当前会话中试用：

```bash
pi -e npm:pi-open-tui
```

## 字体与图标

可从 [Nerd Fonts 官方下载页](https://www.nerdfonts.com/font-downloads)或 [GitHub 最新版本](https://github.com/ryanoasis/nerd-fonts/releases/latest)下载任意已修补字体。安装后，请在终端配置中选择该字体，并重启终端。

默认的 `auto` 模式检测的是终端环境，无法确认终端当前实际使用的字体。如果图标显示为方框、乱码或错误符号，请打开 `/open-tui`，在**外观**页选择合适的模式：

- `nerd`：终端已配置 Nerd Font 时，强制使用 Nerd Font 图标
- `ascii`：使用纯文本图标，无需安装修补字体
- `auto`：在已识别的终端中使用 Nerd Font 图标，其他环境回退到 ASCII

如果已经安装字体，但 `auto` 仍选择 ASCII，请手动切换为 `nerd`。使用 VS Code、Windows Terminal 等应用时，只在操作系统中安装字体还不够，还需要在对应的终端配置中选中该字体。

## 配置

运行 `/open-tui` 打开设置窗口，其中包含**常规**、**外观**、**底栏**和**遥测**四个页面。设置保存在 `~/.pi/agent/open-tui.json`：

```json
{
  "enabled": true,
  "settingsLanguage": "zh",
  "cursorStyle": "block",
  "fullscreen": {
    "wheelScrollLines": 4
  },
  "icons": {
    "mode": "auto"
  },
  "footerSegments": {
    "cwd": true,
    "sessionName": false,
    "gitBranch": true,
    "gitStatus": true,
    "gitCommit": false,
    "runtime": true,
    "context": true,
    "tokens": true,
    "cost": true,
    "extensionStatuses": true
  },
  "telemetry": {
    "enabled": true,
    "tps": true,
    "ttft": true,
    "duration": true,
    "tokens": true,
    "stalls": true,
    "cost": true
  }
}
```

主要选项：

| 选项 | 可选值 | 说明 |
| --- | --- | --- |
| `settingsLanguage` | `en`、`zh` | 切换 `/open-tui` 设置界面的语言 |
| `cursorStyle` | `block`、`bar`、`underline` | `bar` 和 `underline` 需要终端支持光标形状转义序列 |
| `fullscreen.wheelScrollLines` | `1`-`10` | 全屏模式下滚轮每格滚动的行数，默认值为 `4`；`/open-tui` 使用 `1`、`2`、`3`、`4`、`7`、`10` 快速切换 |
| `icons.mode` | `auto`、`nerd`、`ascii` | 控制底栏和遥测通知使用的图标 |
| `footerSegments` | 布尔开关 | 分别控制底栏中的各项数据 |
| `telemetry` | 布尔开关 | 控制遥测总开关和各项指标 |

`sessionName` 仅在会话有名称时显示；`gitCommit` 会在 detached HEAD 状态下显示短哈希和标签；关闭 `extensionStatuses` 会隐藏整行扩展状态，其中也包括 MCP 状态。

全屏滚轮速度通过隔离的兼容层写入 Pi 0.84.2 的运行时字段，因为 Pi 尚未提供公开 setter。若后续 Pi 版本不再包含兼容字段，该设置会被忽略并继续使用 Pi 的默认滚动行为。

## 单轮遥测

每次 Agent 完整运行结束后，pi-open-tui 会显示一条临时结果，并将其中的多个工具调用轮次合并统计：

```text
> TPS 42.5 tok/s | ~ TTFT 1.2s | + 29.7s | ↑ 567 | ↓ 1.2k | ! stall 1x / 4.3s | $ $3.60/M
```

TPS 的计算方式是：将本次运行中服务商报告的全部 Assistant 输出 Token，除以各个生成轮次的总耗时。计时范围从 `turn_start` 到 Assistant 的 `message_end`，包含 TTFT、隐藏推理、缓冲和停顿，但不包含轮次之间的工具执行时间。没有输出 Token 或无法测得生成时间时，会显示 `TPS —`。

`$ / M` 表示根据 `usage.cost.total` 得到的模型标价速率，不是底栏中的会话累计费用。所有遥测字段都可以在**遥测**页单独开关。

## 本地开发

```bash
npm install
npm test
npm run typecheck
pi -e .
```

## 致谢

本项目基于多个 Pi 社区包的工作：

- **[pi-haiku](https://github.com/nnocte/pi-haiku)** — 双行底栏结构和工作计时器
- **[pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)** — Pi Logo 帧与圆角编辑器边框技术
- **[pi-zentui](https://github.com/lmilojevicc/pi-zentui)** — Starship 风格底栏、运行环境检测、会话生命周期和设置界面模式
- **[pi-tps](https://github.com/monotykamary/pi-tps)** — 单轮计时、停顿检测和保守的 TPS 计算方式

Logo 帧源自 Pi 官方安装脚本（`pi.dev/install.sh`）。运行环境检测和 Git porcelain 解析借鉴了 `pi-zentui` 的结构。

特别感谢 **[LINUX DO](https://linux.do)** 社区的支持。

## 许可证

[MIT](./LICENSE)
