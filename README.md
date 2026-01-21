# Character Sheet Extension

[English](#english) | [中文](#中文)

---

## English

### Overview

Character Sheet is a SillyTavern extension for managing AI character state and roleplay context in long-running conversations. It automatically updates a structured character sheet based on dialogue history, helping maintain character consistency and reducing context length.

### Features

- **Automatic Updates**: Updates character sheet at configurable message/word intervals
- **Lock Mode**: Ensures character sheet and memory extensions stay synchronized
- **Multiple API Sources**: Supports Main API, Extras API, and WebLLM
- **Slash Commands**: `/sheet update|sync|freeze|unfreeze|lock|unlock|get|edit`
- **Macros**: `{{char_sheet}}`, `{{char_sheet_enabled}}`, `{{char_sheet_frozen}}`, `{{char_sheet_lock_mode}}`
- **Pop-out Panel**: Draggable, resizable character sheet display

### File Structure

```
character-sheet/
├── index.js           # Main extension logic
├── manifest.json      # Extension metadata
├── settings.html      # Settings UI template
└── style.css          # Stylesheet
```

### Settings

| Setting | Description |
|---------|-------------|
| `enabled` | Enable/disable the extension |
| `frozen` | Pause automatic updates |
| `promptInterval` | Messages between updates (default: 10) |
| `promptForceWords` | Words threshold for update (0=disabled) |
| `promptWords` | Target character sheet length |
| `lockMode` | Sync with memory extension |
| `source` | API source: main/extras/webllm |

### Usage

1. Enable the extension in SillyTavern
2. Configure trigger intervals (messages/words)
3. Use `/sheet update` to manually trigger an update
4. Enable Lock Mode to sync with memory extension

---

## 中文

### 概述

Character Sheet 是一个用于 SillyTavern 的扩展插件，专门管理 AI 角色在长程对话中的状态和角色扮演上下文。它根据对话历史自动更新结构化的角色状态卡，帮助维护角色一致性并减少上下文长度。

### 功能特性

- **自动更新**：根据可配置的消息数/字数间隔自动更新角色状态卡
- **锁定模式**：确保角色状态卡和记忆扩展保持同步
- **多 API 支持**：支持主 API、Extras API 和 WebLLM
- **斜杠命令**：`/sheet update|sync|freeze|unfreeze|lock|unlock|get|edit`
- **宏命令**：`{{char_sheet}}`, `{{char_sheet_enabled}}`, `{{char_sheet_frozen}}`, `{{char_sheet_lock_mode}}`
- **弹出面板**：可拖拽、可调整大小的角色状态卡显示

### 文件结构

```
character-sheet/
├── index.js           # 扩展主逻辑
├── manifest.json      # 扩展元数据
├── settings.html      # 设置界面模板
└── style.css          # 样式表
```

### 设置选项

| 设置项 | 描述 |
|--------|------|
| `enabled` | 启用/禁用扩展 |
| `frozen` | 暂停自动更新 |
| `promptInterval` | 两次更新之间的消息数（默认: 10） |
| `promptForceWords` | 字数触发阈值（0=禁用） |
| `promptWords` | 角色状态卡目标长度 |
| `lockMode` | 与记忆扩展同步 |
| `source` | API 来源：main/extras/webllm |

### 使用方法

1. 在 SillyTavern 中启用扩展
2. 配置触发间隔（消息数/字数）
3. 使用 `/sheet update` 手动触发更新
4. 启用锁定模式以与记忆扩展同步

---

### Related Documentation

See [docs/design.md](docs/design.md) for technical details and architecture.
