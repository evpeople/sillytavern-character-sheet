# 角色扮演（RP）上下文管理与总结策略技术文档

## 1. 核心问题

在长程大语言模型（LLM）角色扮演中，随着对话轮次增加，上下文长度呈线性增长，导致：
- **Token消耗剧增**，成本上升
- **上下文窗口溢出**，早期关键信息丢失
- **角色一致性下降**，出现性格漂移
- **叙事连贯性减弱**，情节逻辑断裂

## 2. 解决方案概述

采用**增量式压缩总结策略**，定期将冗长的原始对话历史压缩为精简的结构化世界状态快照，以此替换上下文中的原始内容，实现：
- **上下文长度稳定控制**
- **关键信息持久化保存**
- **角色状态一致性维护**
- **叙事脉络清晰延续**

## 3. 数据结构定义

### 3.1 符号定义

| 符号 | 定义 | 生成扩展 | 存储位置 |
|------|------|----------|----------|
| **Hₙ** | 第n轮时间段内的原始对话历史 | - | `context.chat` |
| **Pₙ** | 第n轮**客观剧情摘要**（Plot Summary） | `memory` (Summarize) | `message.extra.memory` |
| **Sₙ** | 第n轮**角色状态卡**（Character Sheet） | `character-sheet` | `message.extra.characterSheet` |

### 3.2 P - 剧情摘要（Plot Summary）

**用途**：记录客观发生的剧情事件、对话内容、场景变化

**特征**：
- 客观中立，不含角色主观感受
- 按时间线记录关键事件
- 保留情节发展的脉络

**示例格式**：
```
[Plot Summary]
- 主角在王都与NPC_A初次相遇，NPC_A告诉主角关于失落神器的事
- 主角团队获得藏宝图线索，发现地图指向北方山脉
- 主角与NPC_A在酒馆听到冒险者谈论古代遗迹的传说
- 团队决定前往北方山脉寻找遗迹
```

### 3.3 S - 角色状态卡（Character Sheet）

**用途**：记录AI角色的当前状态、性格特征、关系变化

**特征**：
- 主观视角（站在AI角色的立场描述）
- 动态更新，反映角色成长和关系变化
- 格式不固定，直接存储LLM返回的原始文本

**存储方式**：直接存储LLM生成的文本内容，不做结构化处理

## 4. 扩展协同流程

### 4.1 独立触发策略（默认模式）

memory 和 character_sheet 是两个**完全独立**的扩展：

- **memory 扩展**：按设定的消息间隔触发，生成剧情摘要 Pₙ
- **character_sheet 扩展**：按设定的消息间隔触发，生成角色状态卡 Sₙ

**设计要点**：
- 两个扩展使用**相同的默认触发条件**（消息数/字数间隔），因此天然同步
- 用户可独立配置两个扩展的触发参数（如 memory 间隔设为10，character_sheet 也设为10）
- **互不干扰**：memory 的更新不影响 character_sheet，反之亦然


### 4.2 锁定模式（Lock Mode）

**设计意图**：作为用户可选的**安全网**，确保 memory 和 character_sheet **一定一起调用**。

**触发流程**：

```
┌─────────────────────────────────────────────────────────────┐
│ 用户启用 Lock Mode                                          │
│   ↓                                                         │
│ character_sheet 扩展冻结 memory 扩展 (memoryFrozen = true)  │
│   ↓                                                         │
│ 任意一方触发条件满足时：                                      │
│   ↓                                                         │
│ ① character_sheet 检测到触发条件                              │
│   ↓                                                         │
│ ② character_sheet 执行更新，生成 Sₙ                          │
│   ↓                                                         │
│ ③ character_sheet 主动调用 memory.forceSummarizeChat()      │
│   ↓                                                         │
│ ④ memory 被强制执行（绕过 frozen 检查），生成 Pₙ             │
│   ↓                                                         │
│ 结果：两者在同一次对话轮次内完成更新，保持完全同步              │
└─────────────────────────────────────────────────────────────┘
```

**与默认模式的区别**：

| 特性 | 默认模式 | Lock Mode |
|------|----------|-----------|
| 触发条件 | 各自独立配置 | 任意一方满足即触发双方 |
| memory.frozen | 不修改 | 设置为 true |
| memory 更新 | 按自身间隔 | character_sheet 触发后强制调用 |
| 同步保证 | 依赖配置一致 | 强制同步 |

**使用场景**：
- 用户不确定两个扩展是否配置一致时，开启 Lock Mode 作为保险
- 确保 Pₙ 和 Sₙ 永远在同一个消息索引处更新，便于追踪

### 4.3 触发机制

character_sheet 扩展的触发条件：

```javascript
// 触发条件（满足任一即触发）
const conditions = {
    messageCount: messagesSinceLastUpdate >= intervalMessages,
    wordCount: wordsSinceLastUpdate >= intervalWords,
    manualTrigger: userRequestedUpdate
};
```

### 4.4 输入输出规范

**输入给AI的提示结构**（character_sheet 扩展）：
```
=== CHARACTER SHEET PREVIOUS ===
{Sₙ₋₁}
=== END CHARACTER SHEET ===

=== NEW DIALOGUE ===
{Hₙ_new}
=== END NEW DIALOGUE ===

请根据以上信息，更新角色状态卡（从AI角色视角出发，记录状态变化、情感、关系等）。
```

## 5. Character-Sheet 扩展设计

### 5.1 文件结构

```
character-sheet/
├── index.js           # 主入口文件
├── manifest.json      # 扩展元数据
├── settings.html      # 设置界面
└── style.css          # 样式表
```

### 5.2 manifest.json

```json
{
    "display_name": "Character Sheet",
    "loading_order": 11,
    "requires": [],
    "optional": [],
    "js": "index.js",
    "css": "style.css",
    "author": "Your Name",
    "version": "1.0.0",
    "homePage": "https://github.com/your-repo/character-sheet"
}
```

### 5.3 核心功能模块

#### 5.3.1 状态管理

```javascript
const MODULE_NAME = 'character_sheet';

let lastMessageHash = null;
let lastMessageId = null;
let inApiCall = false;

// 设置结构
const defaultSettings = {
    enabled: true,                 // 启用扩展
    frozen: false,                 // 暂停自动更新
    source: summary_sources.main,  // 使用主API
    prompt: defaultPrompt,         // 角色卡生成提示词
    template: defaultTemplate,     // 注入模板
    position: 0,                   // 注入位置
    role: extension_prompt_roles.SYSTEM,  // 注入角色
    depth: 2,                      // 注入深度
    scan: false,                   // 包含在WI扫描中

    // 触发间隔
    promptInterval: 10,            // 消息数间隔
    promptForceWords: 0,           // 字数间隔（0=禁用）

    // 生成参数
    promptWords: 300,              // 目标长度（词）
    overrideResponseLength: 0,     // API响应长度

    // 锁定模式
    lockMode: false,               // 启用后禁用memory扩展，由character_sheet接管
};
```

#### 5.3.2 核心API

```javascript
// 获取最新的角色状态卡
function getLatestCharacterSheetFromChat(chat) { ... }

// 设置角色状态卡到上下文
function setCharacterSheetContext(value, saveToMessage, index) { ... }

// 生成角色状态卡
async function updateCharacterSheet(context) { ... }

// 锁定模式：禁用memory扩展
function enableLockMode() {
    extension_settings.memory.disabled = true;
}

// 锁定模式：恢复memory扩展
function disableLockMode() {
    extension_settings.memory.disabled = false;
}
```

#### 5.3.3 宏命令

```javascript
// {{char_sheet}} - 获取当前角色状态卡内容
macros.register('char_sheet', {
    callback: () => $('#character_sheet_contents').val() || '',
});

// {{char_sheet_sections}} - 获取特定章节
macros.register('char_sheet_section', (args) => {
    const section = args[0]?.trim();
    // 返回指定章节内容
});
```

#### 5.3.4 Slash命令

```javascript
/sheet
    - update - 手动触发角色状态卡更新
    - freeze - 暂停自动更新
    - unfreeze - 恢复自动更新
    - edit - 编辑角色状态卡
    - lock - 启用锁定模式（禁用memory扩展）
    - unlock - 禁用锁定模式
```

### 5.4 默认提示词

```javascript
const defaultPrompt = `你是一个角色扮演游戏的AI。请根据对话历史，更新角色状态卡。

历史角色状态卡：
{{previous_sheet}}

新增对话：
{{new_dialogue}}

请根据以上信息，更新角色状态卡。直接输出更新后的内容，不需要JSON格式，不需要任何前缀或后缀。`;

const defaultTemplate = '[Character Sheet: {{sheet}}]';
```

## 6. 设置界面设计

### 6.1 主面板

```
┌─ Character Sheet ──────────────────────┐
│                                         │
│  当前角色状态卡：                        │
│  ┌───────────────────────────────────┐  │
│  │                                   │  │
│  │   [角色状态卡内容...]             │  │
│  │                                   │  │
│  └───────────────────────────────────┘  │
│                                         │
│  [立即更新] [暂停]                       │
│                                         │
└─────────────────────────────────────────┘
```

### 6.2 详细设置

- **触发设置**
  - 消息间隔
  - 字数间隔（0=禁用）

- **生成设置**
  - 提示词模板
  - 目标长度
  - 注入位置/角色

- **锁定模式**
  - [ ] 启用锁定模式（禁用memory扩展，由character_sheet接管）

## 7. 实现优先级

### Phase 1: 基础功能
- [ ] 创建扩展骨架（manifest, index.js）
- [ ] 实现角色状态卡的获取/设置
- [ ] 实现基本的UI界面
- [ ] 实现触发间隔逻辑

### Phase 2: 锁定模式
- [ ] 实现锁定模式开关
- [ ] 实现禁用memory扩展的功能
- [ ] 实现锁定模式下的联合生成

### Phase 3: 高级功能
- [ ] 宏命令支持
- [ ] Slash命令支持
- [ ] 角色状态分析（情感、目标追踪）
- [ ] 批量编辑/导入导出

## 8. 存储格式

### 8.1 消息Extra字段结构

```typescript
interface MessageExtra {
    memory?: string;              // 剧情摘要 Pₙ（LLM返回的原始文本）
    characterSheet?: string;      // 角色状态卡 Sₙ（LLM返回的原始文本）
    rpContextVersion?: number;    // 版本号
    lastUpdate?: number;          // 更新时间戳
}
```

### 8.2 聊天存档格式

```json
{
    "chat": [
        {
            "name": "User",
            "mes": "Hello!",
            "extra": {
                "memory": "[Plot Summary content...]",
                "characterSheet": "[Character Sheet content...]"
            }
        }
    ]
}
```

## 9. 注意事项

1. **独立性**：memory 和 character_sheet 是两个完全独立的扩展，各自按设定的间隔触发
2. **默认同步**：由于两个扩展使用相同的触发逻辑（消息数间隔），在配置一致时天然同步
3. **Lock Mode**：作为用户可选的安全网，确保两者在同一次对话轮次内更新
4. **版本兼容性**：新字段需要向后兼容旧版本
5. **错误处理**：单个扩展失败不应影响另一个扩展的正常运行
6. **用户控制**：提供暂停/恢复能力，让用户完全控制更新时机
