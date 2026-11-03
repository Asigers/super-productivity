# CTeam 与 Pi Agent 原生集成需求

> 状态：产品需求与技术方案（待 M0 技术验证）  
> 目标仓库：`Asigers/super-productivity`  
> 当前基线：Fork 中的 Super Productivity 19.3.1  
> 核心原则：在保留 Super Productivity 原有任务管理体验的基础上，将 CTeam 工单作为原生 Task 接入，并为 Task 增加 AI 分析与 Pi Agent 能力。

## 1. 产品定位与设计原则

本项目不是在 Super Productivity 旁边再造一套工单系统或项目管理系统，而是增强现有任务，使其能够接收外部工单、自动分析并在用户授权后委托 Agent 执行。

职责边界：

- **CTeam**：公司工单的事实来源。本期只读，不向 CTeam 写入评论、状态、指派或其他变更。
- **Super Productivity**：唯一的个人任务管理入口。继续负责 Task、Project、标签、子任务、计划、看板、时间追踪和完成状态；其中现有 Project 同时作为 CTeam 项目映射、代码仓库配置和项目级 AI 上下文的组织边界。
- **Pi Agent**：围绕某个 Super Productivity Task 执行代码级分析；后续可在用户明确授权后执行开发工作。
- **集成层**：负责同步、来源映射、Pi 调度和分析数据持久化，不建立平行的任务管理模型。

必须遵守以下产品原则：

1. **原生 Task 是唯一的个人工作对象。** 每张导入的 CTeam 工单创建或更新一条 Super Productivity 原生 Task；列表、详情、Project、Board、Planner 和 Time Tracking 都复用这条 Task。
2. **不增加第二套任务入口。** 不新增 CTeam Inbox、Work Inbox、独立工单列表、独立 Work Item Detail 或另一套看板。
3. **不重做 Super Productivity 的工作流。** 不强制新增固定看板列，不要求用户改变已有任务状态、Project 组织方式或项目切换习惯。
4. **AI 是 Task 的增强能力。** AI 报告和 Pi 执行信息与 Task 关联，但不取代 Task 本身，也不把 Agent 状态混入个人任务状态。
5. **不重复存储任务事实。** 复用现有 Task、Project、Issue Provider、筛选、详情和设置机制；只增加必要的来源映射、分析报告和执行记录。
6. **低打扰。** 新工单导入、Agent 开始分析和普通分析完成默认静默；只在关键决策、阻塞、严重风险或无法自动恢复的故障时通知。
7. **先只读、后授权执行。** 第一轮只读代码分析，不修改工作区、不提交、不推送；后续代码修改必须由用户明确授权。

## 2. 本期目标与非目标

### 2.1 本期目标

1. 定时查询嘉为蓝鲸 DevOps / CTeam 中分配给当前用户的工作项。
2. 将 CTeam 工作项通过现有 Issue Provider / 外部任务导入机制创建或更新为原生 Super Productivity Task。
3. 根据明确配置的 CTeam 项目到现有 Super Productivity Project 的映射，将任务放入正确的 Project；每个 Project 可以配置多个允许 Pi 访问的 Git 仓库及项目级 AI 上下文。
4. 对新工单自动派发 Pi Agent 做第一轮代码级只读分析。
5. 在原生 Task Detail 中展示 CTeam 来源信息、AI 分析报告和 Pi 执行摘要。
6. 在现有 Task List / 搜索 / 筛选中支持按来源和 AI 状态过滤，不建立新的任务列表。
7. 在现有 Boards 中继续管理 CTeam Task 和普通 Task；只增加来源及 AI 状态标识，不改变用户已有列和工作流。
8. 在现有 Settings / Project Settings 中配置 CTeam、仓库映射、Pi RPC 和通知。
9. 支持同步去重、变化检测、失败重试、手动同步和应用重启恢复。
10. 首期支持 macOS 和 Windows 桌面版。

### 2.2 本期非目标

- 不创建独立 CTeam Inbox / Work Inbox / Work Item 管理页面。
- 不创建独立的 CTeam 任务数据库或第二套个人工作流状态机。
- 不创建独立看板，不强制增加“新工单、AI 分析中、待我确认、待补充信息”等固定列。
- 不向 CTeam 写回任何数据。
- 不自动修改代码、创建提交、推送分支或创建 MR/PR。
- 不访问生产环境，不执行未经授权的破坏性操作。
- 不拉取分配给其他人的全公司工单。
- 不把完整 Pi 对话历史复制进 Task Notes。
- 不因启用集成而改变普通 Task 的原有行为。

## 3. 用户工作流

### 3.1 首次同步与 Task 创建

1. 用户在现有 Issue Provider / Integrations 设置中配置 CTeam 连接和只读认证。
2. 用户在一个已存在的 Super Productivity Project 设置中，关联一个或多个 CTeam 项目，并配置该 Project 对应的一个或多个 Git 仓库。
3. 用户可在该 Project 中维护经过确认的项目级 AI 上下文，例如架构说明、技术栈、模块索引、开发约定和测试说明。
4. Poller 定时查询分配给当前用户的工作项。
5. CTeam Adapter 根据 CTeam 项目映射找到目标 Super Productivity Project。
6. 复用 Super Productivity 原有任务创建/更新路径，将工单创建为该 Project 下的原生 Task。
7. 通过来源实例、工作项类型和工作项 ID 建立稳定映射，确保重复同步不会创建重复 Task。
8. 新工单进入原有 Task List 和 Project；用户可以像管理普通 Task 一样安排、计时、拆分、标记和完成它。

如果 CTeam 项目尚未映射到 Super Productivity Project，不应自动创建 Project 或独立 Inbox。该工作项应保留在同步待处理记录中，并在现有集成设置/诊断区域提示用户补充映射；映射完成后再导入。

映射规则：一个 CTeam 项目在同一个 CTeam 实例内默认只映射到一个 Super Productivity Project，以避免来源归属歧义；一个 Super Productivity Project 可以汇集多个 CTeam 项目。首期不支持按工单类型或字段把同一个 CTeam 项目拆分到多个 Super Productivity Project。

### 3.2 新工单自动分析

1. 工单被导入为原生 Task 后，集成层读取其来源元数据。
2. 根据 CTeam 项目映射找到明确配置的本地 Git 仓库；不得根据项目名称猜测仓库路径。
3. 创建或恢复该 Task 对应的 Pi Session。
4. 使用对应工单类型的分析提示词，派发只读代码分析。
5. 保存结构化分析报告和可审计的执行事件。
6. 在 Task Detail 的 AI 区域展示分析摘要和状态。
7. 普通分析完成不改变用户的 Task 状态，不自动移动看板列，也不弹出打断式通知。

### 3.3 已有工单更新

- 定期检测工单标题、描述、状态、优先级、更新时间、评论和附件等变化。
- 更新 CTeam 来源元数据，不覆盖用户的 Task Notes、子任务、时间记录、计划安排、个人标签和个人工作状态。
- 对 Task 标题等可能同时被用户编辑的字段，采用变更检测：若本地值仍等于上次同步的来源值，则可同步来源更新；若本地已被用户修改，则保留本地值并记录来源新值/冲突提示，不静默覆盖。
- 只有影响分析结论的描述、关键评论、附件或代码版本变化才触发重新分析；状态或优先级变化通常只更新来源标识。
- 短时间内连续变化应合并为一次分析请求，避免重复启动 Pi。
- 工单取消分配或在 CTeam 关闭时，不直接删除本地 Task、个人笔记、时间记录和分析历史；按配置提示、标记来源状态或归档。

### 3.4 用户处理

用户始终通过 Super Productivity 原有入口工作：

- 从原有 Task List 打开任务。
- 从现有 Project 查看该项目下的 CTeam Task。
- 从现有 Board 管理任务状态。
- 从 Planner 安排工作。
- 使用原有 Time Tracking 记录投入。
- 在 Task Detail 中查看 CTeam 信息和 AI 分析。
- 根据分析结果自行决定下一步，或明确授权 Pi 继续执行。

## 4. CTeam 与原生 Task 的映射

### 4.1 一对一映射

每个 CTeam 工作项在本地对应一条原生 Super Productivity Task。稳定唯一键：

`source_instance + work_item_type + work_item_id`

同一工作项在多个视图中出现时必须引用同一个 Task ID，不允许分别创建 Inbox Task、Board Task 或 AI Task。

### 4.2 来源元数据

在不破坏现有 Task 数据结构和同步兼容性的前提下，为外部任务增加可选来源元数据。建议概念结构如下，最终字段位置应在 M0 根据当前 Task 模型和持久化方式确定：

```ts
interface ExternalIssueMetadata {
  provider: 'cteam';
  instanceId: string;
  workItemId: string;
  workItemType: string;
  sourceTitle?: string;
  sourceStatus: string;
  sourcePriority?: string;
  sourceUrl: string;
  sourceUpdatedAt: string;
  lastSyncedAt: string;
  sourceRevision?: string;
}
```

来源元数据可以作为 Task 的可选扩展字段；如果当前模型不适合直接扩展，则使用以 Task ID 和来源唯一键关联的轻量 sidecar 记录。无论采用哪种方式，都不得复制一套完整的本地 WorkItem / Task 业务模型。

### 4.3 字段所有权

| 数据 | 所有者 | 同步规则 |
|---|---|---|
| 来源 ID、类型、原始链接 | CTeam | 只读同步 |
| 来源状态、来源优先级 | CTeam | 更新来源元数据，不覆盖个人状态 |
| 来源更新时间、版本 | CTeam | 用于变化检测和分析有效性判断 |
| Task 标题 | 初始来自 CTeam，之后允许用户本地调整 | 检测本地修改，避免静默覆盖 |
| Task 所属 Project | 本地映射配置 | CTeam 项目按显式映射归属，不擅自改动用户 Project |
| Task Notes / 个人备注 | 用户 | CTeam 同步不得覆盖 |
| 子任务、标签、计划、时间记录 | 用户 / Super Productivity | 完全沿用原有行为 |
| Task 完成状态及 Board 列 | 用户 / Super Productivity | 不由 CTeam 或 AI 自动覆盖 |
| AI 报告、Pi Session 映射 | 集成层 | 独立保存并通过 Task ID 关联 |

CTeam 状态、Super Productivity 原生 Task 状态、AI 分析状态和 Pi 执行状态是四个不同维度。UI 可以并列展示，但不能合并成一套状态机。

## 5. 与 Super Productivity 原有功能的融合要求

### 5.1 Task List、搜索与筛选

不新增 CTeam Inbox 或第二套工单列表。

在现有 Task List / 搜索 / 筛选能力允许的范围内，增加可选筛选条件：

- 来源：全部 / CTeam / 普通任务。
- AI 分析：未分析 / 排队中 / 分析中 / 已完成 / 已阻塞 / 失败 / 报告过期。
- 需要我处理：关键决策、资料阻塞、严重风险或 Agent 故障。

筛选结果仍然是原生 Task，沿用现有排序、分组、批量操作和打开详情行为。优先复用现有筛选机制；若当前架构不适合扩展筛选器，先使用来源标识和可选标签作为兼容方案，不另建任务列表。

新工单不需要被放入独立 Inbox。它直接进入映射的现有 Project 和 Task List；用户可以用来源筛选找到它。

### 5.2 Project：任务组织、外部映射与 AI 上下文边界

Super Productivity 原有 Project 不只是任务分组；在本集成中，它同时承担外部项目映射、代码仓库组织和项目级 AI 上下文的职责。它仍然是 Super Productivity 原生 Project，不另建一套项目管理模型。

#### 5.2.1 CTeam 项目映射

- 在现有 Project Settings 中配置 CTeam 实例和一个或多个 CTeam 项目 ID。
- 一个 CTeam 项目在同一个 CTeam 实例内默认只能映射到一个 Super Productivity Project，避免同一工单被导入多个 Project。
- 一个 Super Productivity Project 可以汇集多个 CTeam 项目，例如多个团队子项目共同归属于同一个个人工作项目。
- 首期不支持按工单类型、标签或其他规则将同一个 CTeam 项目拆分到多个 Super Productivity Project；如未来确有需要，再增加显式路由规则。
- 不因 CTeam 项目自动创建 Super Productivity Project。未映射项目在现有集成诊断区域提示用户处理。
- 一个 Project 可以同时包含普通 Task 和多个 CTeam 项目导入的 Task。

#### 5.2.2 Project 到 Git 仓库映射

一个 Super Productivity Project 可以关联多个 Git 仓库。每个仓库配置至少包括：

- 稳定的逻辑仓库标识和显示名称。
- 预期 Git remote URL，用于校验本地目录是否指向正确仓库。
- 默认分支及可选的分析分支策略。
- 仓库用途或模块说明，例如后端服务、前端应用、公共组件。
- 是否允许 Pi 只读访问；首期所有仓库均为只读。
- 仓库优先级或分析顺序（可选）。

本地路径必须按设备分别保存，不应将 Mac 的路径同步到 Windows，也不应把本地绝对路径作为跨设备共享的 Project 数据。例如，同一个逻辑仓库可以分别配置 macOS 路径和 Windows 路径。Pi 访问仓库前必须验证路径存在，并校验 Git remote 与配置的预期仓库一致；校验失败时停止访问并提示用户，不得自行搜索或猜测替代目录。

Project 可以关联多个仓库，但 Pi 只能访问当前 Project 明确配置并授权的仓库。分析报告必须记录实际使用的仓库、分支和 Commit。

#### 5.2.3 Project 级 AI 上下文

在现有 Project Settings 中增加可选的项目级 AI 上下文，用于让不同 Task 的分析共享稳定、经过确认的项目知识。建议包含：

- 项目目标、业务边界和系统职责。
- 技术栈、主要服务/应用和模块索引。
- 架构说明、关键调用链和系统依赖。
- 代码规范、目录约定和重要设计约束。
- 构建、测试、Lint 和本地验证方式。
- 项目术语、缩写和业务概念说明。
- 经用户确认的项目级分析指引和注意事项。
- 可选的项目文档引用或本地文档路径。

项目级上下文必须与 Project 绑定，不得跨 Project 自动共享。文档路径属于设备本地配置；可同步的文本说明、逻辑仓库元数据和项目指引应遵循 Super Productivity 现有 Project 数据同步机制。若现有同步机制无法安全同步某类内容，M0 应明确其存储边界，不能假定所有设置都会自动跨设备同步。

**知识维护规则：**

- 项目上下文以用户维护或明确批准的内容为准。
- Pi 可以提出“建议加入项目知识”的变更，但不能把未经验证的分析结论自动沉淀为长期项目事实。
- 项目上下文应有版本或更新时间；每次分析记录使用的上下文版本。
- 用户修改仓库映射、关键架构说明或分析规则后，相关旧报告可以标记为可能过期；不应因此无差别重跑该 Project 下所有 Task。
- 项目级上下文是分析参考，不是高于用户当前明确指令的命令。若 Task 的明确要求与通用项目指引冲突，应遵循用户对该 Task 的明确要求，并在报告中指出冲突。

#### 5.2.4 Task 分析时的上下文组合

每次 Pi 分析按以下范围组装上下文：

1. 当前 Task 的工单描述、验收条件、相关评论和附件。
2. 该 Task 所属 Super Productivity Project 的项目级 AI 上下文。
3. 该 Project 显式配置且与本 Task 相关的 Git 仓库、分支和当前 Commit。
4. 用户对当前 Task 的额外指示。

不同 Project 的项目知识和仓库访问范围必须隔离。不同 Task 可以复用同一 Project 的只读项目知识，但默认不共享彼此的 Pi 对话历史。Task 专属 Session 负责保持单张工单的分析连续性，Project 上下文负责提供稳定的共享背景，两者不可混为一个长期共享 Session。

#### 5.2.5 Project 配置与跨设备边界

建议在现有 Project Settings 中组织为以下配置区，不新增独立项目管理页面：

- **CTeam Projects**：关联的 CTeam 实例和项目 ID。
- **Repositories**：逻辑仓库、remote URL、默认分支、用途说明和本机路径。
- **AI Project Context**：项目说明、技术栈、架构知识、开发约定、测试说明和文档引用。

配置数据按性质区分：

- 可跨设备共享：CTeam 项目逻辑映射、逻辑仓库标识、remote URL、默认分支、项目级 AI 文本上下文（须确认现有同步机制和公司数据政策允许）。
- 设备本地保存：仓库绝对路径、机器专属运行参数和本地文档路径。
- 系统凭证管理器保存：CTeam Token、Pi RPC 凭证等秘密信息。

不得把凭证或机器专属绝对路径写入可同步的 Project 数据。

### 5.3 Boards

- 直接使用 Super Productivity 原有 Boards。
- CTeam Task 与普通 Task 混合显示。
- 不新增专用 CTeam Board，不强制固定看板列。
- 用户现有列、列顺序、状态和拖拽行为保持不变。
- Task 卡片可显示轻量来源标识（例如 CTeam）和 AI 状态徽标。
- AI 分析中、已完成、阻塞等状态不得自动映射成 Board 列，也不得擅自改变 Task 的完成状态。

### 5.4 Planner 与 Time Tracking

- CTeam Task 可以像普通 Task 一样加入 Planner / Schedule。
- 原有预计耗时、实际耗时、计时器、日历和统计功能保持不变。
- 同步 CTeam 数据不得重置任务计划或时间记录。

### 5.5 Task Detail

不新增独立 Work Item Detail 页面。扩展现有 Task Detail，在保留原有描述、子任务、标签、备注、预计耗时和时间追踪的基础上，增加两个可折叠区域或适配现有详情布局的面板：

**A. CTeam Source**

- 工单编号、类型、来源项目和原始链接。
- CTeam 源状态、优先级、分配信息和最近同步时间。
- 原始描述、评论和附件列表。
- 评论及附件优先按需从 CTeam 加载；不得把大段源内容重复写入 Task Notes。
- 本期只读；点击原始链接可跳转 CTeam。
- 网络不可用时展示最近一次可用快照（若实现缓存），并明确标记缓存时间。

**B. AI Analysis & Pi Agent**

- 当前分析状态和最近分析时间。
- 分析摘要、问题理解、相关模块。
- 代码证据（仓库、Commit、文件路径、行号/符号）。
- 根因假设、置信程度、影响范围和验证建议。
- 待补充信息及阻塞原因。
- 当前报告版本和历史报告入口。
- Pi Session 标识、运行状态和最近执行事件摘要。
- 操作：继续分析、重新分析、停止运行、打开 Pi Session（以 Pi RPC 能力实际支持为准）。

AI 报告是独立、版本化的数据，不追加到 Task Notes。完整 Pi 对话保留在 Pi Session；Super Productivity 只保存必要摘要、结构化报告和可审计执行事件。

### 5.6 全局 Agent 状态入口

不建设独立 Agent Activity 页面或 Agent 管理工作台。

可以在现有工具栏/状态区域增加轻量状态指示器，显示：

- 正在运行的 Agent 数量。
- 是否存在需要人工介入的阻塞或故障。
- 点击后定位到相关原生 Task。

详细执行记录放在对应 Task Detail 的 AI Analysis & Pi Agent 区域。不得要求用户通过监控大屏管理 Agent。

### 5.7 Settings

不新增独立 WorkBridge Settings 一级页面。配置融合到现有设置体系：

| 现有设置位置 | 增加配置 |
|---|---|
| Issue Providers / Integrations | CTeam 服务地址、认证方式、当前用户、连接测试、轮询间隔、同步范围 |
| Project Settings | CTeam 项目映射、多个逻辑 Git 仓库、remote 校验、设备本地路径、默认分支、项目级 AI 上下文及映射验证 |
| AI / Agent 或现有集成设置 | Pi RPC 地址、认证、模型/Agent 选择、最大并发数、超时、Session 策略 |
| Notifications | 关键决策、资料阻塞、严重风险、无法恢复的 Agent 故障通知 |
| 现有诊断/日志区域 | 同步历史、失败原因、重试和最近成功时间 |

凭证存储必须使用 macOS Keychain、Windows Credential Manager 或项目已有的安全凭证机制，不得明文写入普通设置文件、Task 数据或 SQLite。

## 6. AI 代码级分析

### 6.1 Session 隔离与生命周期

- 一个 CTeam Task 对应一个稳定的 Pi Session 映射。
- 同一工单后续更新时优先延续原 Session，避免重复创建上下文。
- 不同 Task 的 Session 默认隔离，避免工单之间上下文污染。
- Task ID、CTeam 来源唯一键和 Pi Session ID 之间建立稳定映射。
- 用户可以从 Task Detail 继续分析或重新分析。
- 调度器限制并发数；应用重启后能够恢复排队和运行状态，避免重复派发。
- 关闭窗口后的后台行为遵循应用现有生命周期和用户配置；首期优先研究系统托盘常驻模式，不默认引入独立系统服务。

### 6.2 分析输入与仓库映射

Pi Agent 输入包括：

- 当前 CTeam 工单标题、描述、类型、验收条件。
- 对分析有意义的评论和附件文本（按权限和配置读取）。
- 显式映射的本地 Git 仓库。
- 仓库当前 Commit、分支和工作区状态。
- 允许提供的项目文档和必要上下文。

仓库映射必须由用户在对应 Super Productivity Project 设置中明确配置。一个 Project 可以关联多个仓库；Pi 可根据工单涉及的模块，从该 Project 的允许列表中选择一个或多个仓库，但必须说明选择依据。禁止访问其他 Project 的仓库，也禁止根据工单标题、项目名称或模型猜测本地路径。

每次分析还应加载该 Project 当前有效的项目级 AI 上下文，但只加载该 Project 的内容。Task 专属输入、Project 级背景和仓库代码证据应在报告中区分来源。分析记录至少保存 Project ID、项目上下文版本、实际使用的仓库、分支和 Commit。

如果没有仓库映射或仓库不可访问，只执行工单文本层面的分析，并明确标记缺少代码上下文，不得假装完成代码级分析。若 Project 上下文缺失，也应正常分析可用资料，并明确说明缺少项目背景，不得编造架构信息。

### 6.3 分析任务类型

根据工单类型采用不同分析模板：

- **Bug**：理解现象、分析复现条件、搜索相关调用链、提出候选根因和验证步骤。
- **需求**：理解业务目标和验收条件、定位涉及模块、分析实现边界、依赖和风险。
- **研发任务**：理解交付目标、分析代码位置、依赖、工作拆分和测试建议。

### 6.4 只读安全边界

- 第一轮分析不修改仓库文件、不创建提交、不推送分支。
- 不访问生产环境，不执行破坏性命令。
- 只访问已配置且用户有权访问的仓库。
- 需要日志、环境、权限或业务信息时，标记为待补充。
- 结论必须区分已验证事实、代码证据、推测和未知。
- 报告引用尽可能包含仓库、Commit、文件路径、行号或符号名。

### 6.5 分析状态与人工介入

AI 分析状态独立于 Super Productivity Task 状态：

- `NOT_STARTED`：未开始。
- `QUEUED`：等待调度。
- `RUNNING`：分析中。
- `COMPLETED`：分析完成。
- `BLOCKED`：缺少资料或依赖，无法继续。
- `FAILED`：执行失败。
- `STALE`：工单内容或代码版本变化，当前报告可能过期。

“需要我决策”不是 AI 执行状态，也不是新的 Task/Board 状态；它是分析结果上的 Attention 标记或通知条件。Task 本身仍保持用户原有状态。

### 6.6 分析触发规则

| 事件 | 默认行为 |
|---|---|
| 新 CTeam Task 导入 | 自动启动首次分析 |
| 描述或验收条件发生实质变化 | 合并变化后重新分析 |
| 新增关键评论 | 判断是否影响结论，必要时补充分析 |
| 新增附件 | 判断是否影响结论，必要时补充分析 |
| 优先级变化 | 更新来源元数据，通常不重新分析 |
| CTeam 状态变化 | 更新来源元数据，不重新分析 |
| 仓库 Commit 变化 | 根据报告依赖和配置判断是否标记过期；不因每次提交自动全量重分析 |
| 用户手动点击重新分析 | 创建新的分析版本 |
| 同一工单短时间多次变化 | 去重并合并为一次分析任务 |

### 6.7 分析报告结构

每次分析保存独立报告版本，至少包含：

1. 工单摘要和类型判断。
2. 问题/需求理解。
3. 相关仓库、Commit、模块和代码证据。
4. 候选根因或实现方案。
5. 置信程度及证据依据。
6. 影响范围和风险。
7. 验证/测试建议。
8. 尚缺少的信息。
9. 推荐下一步。
10. 分析时间、来源工单版本、Pi Session 引用。

## 7. 通知与 Attention

遵循低打扰策略，复用 Super Productivity 现有通知能力：

| 事件 | 默认行为 |
|---|---|
| 发现并导入新工单 | 静默出现在原有 Task List |
| Pi 开始分析 | 静默更新 AI 标识 |
| 普通分析完成 | 静默保存报告 |
| 需要用户作关键决策 | 通知，并可定位对应 Task |
| 缺少关键资料导致阻塞 | 通知，并展示缺失项 |
| 发现重大安全/数据风险 | 通知 |
| Pi 异常且自动恢复失败 | 通知 |
| 普通轮询失败 | 记录日志，连续失败达到阈值后通知 |

Attention 不是第二套任务列表或看板。它只是一种任务标记/通知条件，可在现有任务筛选中选择查看；用户点击通知后直接打开对应 Task。

## 8. 技术架构建议

优先复用 Super Productivity 当前代码架构和数据流，不重写任务管理层。

### 8.1 CTeam Issue Provider

- 优先接入现有 Issue Provider / Issue Provider Service 抽象。
- 复用现有外部任务查询、导入、更新和 Task 创建路径。
- 实现 CTeam 认证、分页、当前用户筛选、增量同步和字段转换。
- 如果现有 Issue Provider 抽象无法覆盖定时同步或所需元数据，再做最小范围扩展；M0 必须先确认真实接口，不要假设。
- Issue Provider 负责外部工单接入，不负责建立第二套 Task 列表。

### 8.2 Task 与 Renderer

- 扩展原生 Task 的来源元数据或建立轻量 sidecar 映射。
- 在现有 Task List、搜索、筛选、Board 卡片和 Task Detail 中增加来源/AI 展示。
- 不新增一级导航和独立工单页面。
- 使用受控 IPC 调用后台能力；Renderer 不直接持有 CTeam Token，也不获得任意进程执行权限。

### 8.3 后台协调器

在 Electron Main 或项目认可的后台服务层实现：

- CTeam Poll Scheduler：定时同步、手动同步、重试。
- CTeam Adapter：认证、查询、分页、字段映射。
- Task Sync Service：来源去重、原生 Task 创建/更新、字段冲突检测。
- Project Context Service：读取指定 SP Project 的 CTeam 项目映射、允许访问的仓库和版本化 AI 上下文。
- Project / Repository Mapper：CTeam 项目到 SP Project 的映射，以及逻辑仓库到设备本地路径的解析和 remote 校验。
- Pi RPC Adapter：创建/恢复 Session、派发分析、停止任务、获取执行状态。
- Analysis Service：提示词模板、分析触发、报告结构校验和版本管理。
- Notification Adapter：将决策、阻塞和风险事件接入现有通知机制。

### 8.4 持久化

优先使用 Super Productivity 现有持久化、状态管理和迁移机制。只增加完成集成所需的最小扩展数据：

- `external_issue_mapping`：来源唯一键与原生 Task ID 的映射，以及同步版本/指纹。
- `pi_session_mapping`：Task ID 与 Pi Session ID 的映射。
- `analysis_run`：分析运行状态、时间、输入来源版本、仓库 Commit 和失败信息。
- `analysis_report`：结构化报告及历史版本。
- `agent_event`：可审计的执行事件摘要。
- `sync_checkpoint`：增量游标、最近成功时间和同步错误。
- Project 扩展配置：优先作为现有 Super Productivity Project 的可选扩展字段保存 CTeam 项目映射、逻辑仓库配置和项目级 AI 上下文；只有现有 Project 模型不适合承载时，才使用以 Project ID 关联的轻量 sidecar。
- 设备本地仓库路径：单独保存在设备本地配置中，不进入跨设备同步数据。
- 项目上下文版本元数据：记录上下文版本/更新时间，供分析报告追溯。

不得建立完整的 `work_item`、`work_item_task`、独立任务状态或第二套 Project 表。来源工单的完整描述、评论和附件优先通过 CTeam API 按需读取；如需缓存，应明确缓存用途、过期策略和数据清理方式。

### 8.5 进程与平台边界

- Pi RPC 和本地仓库访问属于桌面端能力，首期以 macOS 和 Windows Electron 桌面版为目标。
- 不应假定 Web / 移动端能够访问本地 Pi Runtime 或本地 Git 仓库。
- 后台调度应避免依赖 Renderer 页面是否打开。
- 首期优先验证系统托盘常驻是否符合现有 Electron 生命周期；真正退出应用时是否继续运行作为后续独立服务选项，不在首期默认引入。
- 本地 RPC 应限制在 loopback，使用认证并校验调用来源。

## 9. CTeam API 前置验证（M0）

当前尚未确认公司实际部署的 CTeam 版本、API 文档和认证方式。实现前必须完成技术 Spike，不得猜测接口地址或字段。

必须确认：

- 产品版本、实际工单模块及工作项类型。
- 查询分配给当前用户工作项的 API 和用户身份字段。
- 分页、更新时间过滤或增量查询能力。
- 工单详情、评论、附件的只读接口。
- 状态、优先级、迭代、截止日期等字段字典。
- SSO、个人 Token 或其他认证方式。
- API 限流、访问审计和公司数据使用要求。

如果没有可靠的增量接口，第一版可以定期分页查询并在本地去重。不要把浏览器临时抓包得到的接口作为长期契约，除非已确认公司允许且接口稳定。

## 10. 隐私、安全与合规

- 只读取当前用户有权访问且分配给当前用户的工单。
- 使用最小权限的只读凭证。
- CTeam Token 和 Pi RPC 凭证存入系统凭证管理器或项目认可的安全凭证机制。
- 日志中的工单描述、用户信息、Token、附件内容和代码路径按需要脱敏。
- 本地运行 Pi 不代表模型推理一定发生在本地；向模型发送工单或源代码前，必须确认符合公司数据使用规定。
- 默认不将工单全文、代码或附件上传到未经批准的外部模型服务。
- 只允许 Pi 访问明确配置的本地仓库。
- 第一阶段分析只读；后续执行能力必须使用隔离工作区并要求明确授权。
- 不向 CTeam 写回，不执行任何未经用户授权的外部系统操作。

## 11. 里程碑与验收标准

### M0：代码结构与 API 技术验证

- 检查当前版本 Task 和 Project 数据模型、持久化、跨设备同步及迁移机制。
- 找到现有 Issue Provider 的查询、导入、更新和身份认证扩展点。
- 确认 Project Settings 如何扩展、哪些 Project 字段会跨设备同步，哪些配置必须本地保存。
- 找到 Task List、Board、Task Detail、搜索/筛选、Project Settings 和全局 Settings 的真实组件入口。
- 验证一个 Project 关联多个 CTeam 项目和多个 Git 仓库的配置模型，以及项目级 AI 上下文的加载和版本管理方式。
- 确认 Electron Main、IPC、后台生命周期和系统托盘实现方式。
- 验证 CTeam 只读 API、当前用户筛选、分页和增量能力。
- 验证 Pi RPC 的创建/恢复 Session、发送任务、停止和读取事件方式。
- 输出文件级改造清单和技术风险，不在此阶段预设未经验证的接口。

### M1：CTeam 原生 Task 接入

验收：

- CTeam 配置位于现有 Issue Provider / Integrations 设置中。
- 只拉取分配给当前用户的工作项。
- 工单通过现有导入路径创建为原生 Task，并进入映射的现有 Project。
- 支持多个 CTeam 项目汇入同一个 SP Project；同一 CTeam 项目不会在同一实例内被重复映射到多个 SP Project。
- 同一来源工单始终映射到同一个 Task，不重复创建。
- 未映射项目不会自动创建独立项目或 Inbox，而是在现有集成诊断中提示。
- 来源字段更新不会覆盖用户备注、计划、子任务、时间记录和个人状态。
- 原有普通 Task 的创建、编辑、计划、看板和计时行为无回归。

### M2：Pi Agent 自动只读分析

验收：

- 新导入的 CTeam Task 自动创建或恢复专属 Pi Session。
- 不同 Task 的 Session 隔离。
- 工单变化能够去重、合并，并在必要时延续原 Session 分析。
- 根据所属 Project 的显式仓库映射执行代码级只读分析，支持一个 Project 下多个仓库。
- 分析能够加载该 Project 的版本化 AI 上下文，且不会混入其他 Project 的知识或仓库。
- Mac 和 Windows 可以为同一个逻辑仓库配置各自的本地路径；访问前校验 Git remote。
- 支持并发限制、失败重试和应用重启恢复。
- 分析完成后保存结构化报告和执行事件。
- 分析过程不改变 Task 的个人状态或 Board 列。

### M3：原生 Task Detail AI 扩展

验收：

- 在现有 Task Detail 中查看 CTeam 来源信息和原始链接。
- 评论和附件可按需加载，不污染 Task Notes。
- 在同一详情中查看 AI 分析摘要、代码证据、假设、缺失信息和报告历史。
- 可以继续分析、重新分析、停止任务或查看 Pi Session（以 RPC 能力为准）。
- 报告保留工单版本、仓库/Commit 和 Project AI 上下文版本，支持过期标记。
- 普通 Task 不显示无意义的 CTeam / AI 区域，原有详情体验无回归。

### M4：原生筛选、通知与可观测性

验收：

- 现有 Task List / 搜索 / 筛选可按 CTeam 来源和 AI 状态过滤。
- 现有 Boards 可以混合显示普通 Task 和 CTeam Task，不新增强制列。
- 卡片来源标识和 AI 状态徽标不影响原有拖拽和状态操作。
- 关键决策、阻塞、严重风险和无法恢复的故障通过现有通知机制提醒。
- 全局 Agent 状态入口只负责显示摘要并定位 Task，不成为独立管理系统。
- 同步历史、Agent 失败原因和手动重试可从现有设置/诊断入口访问。

### M5：授权开发执行（后续，不属于首期）

- 用户明确批准后，Pi 才能进入代码修改阶段。
- 使用独立 Git Worktree 或其他隔离工作区。
- 先展示计划和变更范围，再执行。
- 测试、Diff、提交、推送和 MR/PR 分别设置授权边界。
- 默认不向 CTeam 写回。

## 12. 待确认事项

1. 公司 CTeam 的准确产品版本、API 文档和认证方式。
2. 多个 CTeam 项目汇入一个 Super Productivity Project 的映射规则及边界。
3. 每个 Project 关联多个 Git 仓库时的选择、优先级和默认分支策略。
4. 项目级 AI 上下文的维护方式、允许同步的内容及版本管理策略。
4. 应用最小化到托盘后是否继续同步和调度。
5. 允许用于工单和代码分析的模型服务及数据边界。
6. 评论和附件是否纳入第一版分析输入，以及附件类型和大小限制。
7. 当前 Super Productivity 版本的 Issue Provider 抽象是否足以承载 CTeam 定时同步；如不足，确认最小必要扩展。

## 13. 最终产品验收原则

完成后，用户应该仍然只使用 Super Productivity 原来的工作方式：

- 打开原有 Task List，就能看到导入的 CTeam 工单和普通任务。
- 打开原有 Project，就能看到映射到该项目的工单、项目级 CTeam 关联和已配置的仓库上下文。
- 使用原有 Board、Planner 和 Time Tracking 管理 CTeam Task。
- 打开原有 Task Detail，就能看到外部工单信息、AI 分析和 Pi 执行摘要。
- 使用现有筛选找到 CTeam Task、分析中任务或需要人工介入的任务。
- 一个原有 Project 可以组织普通 Task、多个 CTeam 项目的工单、多个代码仓库和经确认的项目级 AI 知识。
- Pi 在分析某个 Task 时自动复用其所属 Project 的背景知识，但不共享其他 Task 的对话历史。
- 不需要维护第二套 Inbox、第二套看板、第二套 Task 状态或第二套项目体系。

**最终目标：让 Super Productivity 原有 Task 获得外部工单同步、AI 理解和 Agent 执行能力，而不是让用户学习和维护另一套工作管理产品。**
