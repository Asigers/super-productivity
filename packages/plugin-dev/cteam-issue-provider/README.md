# CTeam + local Pi: initial implementation

本版本复用原生 Task、Project 和 Issue Provider 插件机制。没有独立工单列表、Git 工作区管理器或 AI 报告 schema。

## 使用

1. 按仓库现有流程安装依赖并运行 `npm run plugins:build`，生成 bundled plugin 资源。
2. 在 Settings → Plugins 启用 **CTeam**，通过插件卡片的设置按钮保存本机 DevOps user ID、Access Token 和可选 Tenant ID。CTeam 是 issue-provider 集成，不添加独立侧栏页面；启停入口在 Settings → Plugins，应用功能开关不管理插件。凭证不进入 Provider 配置、SP 同步或备份；现有本机秘密存储未加密。
3. 在 Settings → Plugins 的 CTeam 卡片点击 **Set up in Issue Provider Panel**，或从现有 Issue Integrations 配置 CTeam。每个 CTeam 来源项目配置一个 Provider，并选择目标 **Default project**；一个 Provider 可映射多个工作项类型。
4. 填入 URL 中的 project key、主 classification 和主 model type ID。若还要导入其他类型，在 **Additional work-item types** 中每行填写一个 `CLASSIFY:MODEL_TYPE_ID`，例如 `BUG:0a434677da5449da9d0441b01809201c`、`DEMAND:693` 或 `TASK:690`。相同 classification 的多个 model type ID 可分别列出。主类型之外的 classification 会自动读取各自的动态 **经办人** 字段；主类型仍从选项中选择经办人字段。加载选项后，对每个类型分别选择要排除的状态；空排除集合表示不排除任何状态，不硬编码“已完成”等名称。
5. 先测试连接和手动搜索/导入；确认真实部署的经办人过滤正确后，再主动勾选 **Auto import to default project** 并设置默认项目。CTeam 新单轮询间隔为 30 分钟；**Polling mode: Always** 控制轮询是否要求目标 Project 当前打开，但不代替 Auto import 开关。搜索始终带经办人条件，返回结果也必须能确认当前用户，不能退化为全项目查询。
6. 桌面版的 Project 设置中配置 **Pi Agent**：本机启动目录、Pi 入口、可选模型和可编辑提示词，并开启 **Automatically analyze new CTeam imports on this device**。此后本机新导入该 Project 的 CTeam Task（手动和后台导入都包括）会自动启动首次分析，不需要逐条点击。Pi 1.4 或更新版本和 CWLink 须已在本机配置完成；同批多条导入可并行调用模型并产生费用。
7. 用户自己维护启动目录里的 `AGENTS.md`，说明 CWLink 调用、仓库位置、代码更新和独立 worktree 约定。应用不生成指引、不操作 Git。同 Project 的不同 Task 可并行。
8. 如需新单提醒，在同一 Project 设置中开启 **Notify when new CTeam Tasks are imported on this device**，保存后生效；该开关默认关闭，也可独立于 Pi 分析开启。通知按 Project 合并一批导入，只显示数量，不显示工单标题/正文。点击系统通知可定位到新导入的 Task；系统通知不可用时显示带定位操作的应用内提示。
9. 打开 CTeam Task 的 **AI Analysis & Pi Agent** 面板查看自动分析结果，也可手动重试、继续 Session 或新建分析 Session。对于已结束的运行，也可以复制该 Task 的终端恢复命令，在独立 Pi 终端里继续同一 Session；不要让 SP 和外部 Pi 同时写同一 Session。模型最终回复直接作为 Markdown 展示，运行信息与正文分离；不覆盖 Notes，不回写 CTeam。

Pi 在启动目录读取指引，使用其现有工具调用 CWLink。CWLink 凭证和模型凭证沿用各自的本机配置，不从 SP 转交。受 Pi 项目信任保护的本地扩展需要用户先在 Pi 中信任该目录；应用不自动批准扩展对话或更改信任配置。

## 自动触发边界

- 工单链接使用对应的 `twBug` / `twDemand` / `twTask` 路由，并包含 `vmode=table` 和内部工单 `id`，与 CTeam 可直接打开的列表详情链接一致。
- 仅本机真正新建 Task 的导入流程触发自动分析与新单提醒。应用启动、同步收到任务、备份恢复、已有 Task 的刷新以及重复导入去重，都不会作为新单再次触发。
- 开启 Pi 时不扫描旧任务补跑；项目未启用 Pi 的导入也不在日后自动补跑。若要避免首次历史批量导入消耗模型额度，先关闭 Pi，导入并核对历史范围后再启用。
- 已有本机运行记录的 Task 不因重复导入事件重试；失败后由用户明确重试。不同 Task 可并行，同一 Task 仍受现有运行锁保护，没有新增 Project 级锁、队列或自动重试循环。
- 导入与 Pi 启动失败相互独立：Pi 路径、配置或模型异常不会撤销已导入 Task；启动失败显示应用内错误，运行后的状态与 Markdown 在 Task AI 面板查看。
- 系统通知需要本机权限；只在用户主动开启通知开关时请求浏览器通知权限，后台导入不弹权限询问。不新增通知中心或第二套工单列表。

## 本机数据与故障

- Provider 配置复用现有同步机制，凭证使用本机插件秘密存储；只保留一个本机 CTeam 账号，API origin 固定为 `https://devops.cwoa.net`。
- Pi 配置保存在 Electron User Data 的 `pi-agent/projects/`，分析记录在 `pi-agent/tasks/`，Session 在 `pi-agent/sessions/`，均不进入普通应用同步或备份。它们可能包含公司资料。
- 每个 Task 保留最近 10 次运行记录；Pi Session 文件持久保留，由用户在不运行时自行清理。本版本没有 Session 磁盘配额或自动清理 UI。
- Pi 正常结束后才保存完成结果；请求接受和 `agent_end` 不是完成。崩溃留下的运行在下次读取时标为 interrupted，不自动重新执行。
- 同一 Task 同时仅一个活动 Session 写入者，不设置 Project 级锁。切换 Project 或启动目录会使用新 Session。
- Pi 入口支持 PATH 中的 `pi`、可执行文件或 CLI 的 `dist/cli.js` 路径。Windows npm 的已知 shim 直接解析到 JS 入口，以 Node 模式运行；不通过 Shell 拼接工单或提示词。
- 本地运行不是沙箱，也不意味着本地推理；启用前确认本机 Pi 的工具、扩展和模型配置符合资料使用要求。

## 已知边界与未验证项

这是已接入新单自动分析与导入通知的初版代码，不等于需求文档全部里程碑已验收：

- 来源界面只有编号、源标题、源状态和原始链接；没有描述、评论或附件阅读器。
- 默认关闭标题拉取，保护本地改名；源标题仍可在详情看到。尚未实现需求中的标题三方合并。
- 沿用现有导入、归档去重和刷新路径；没有新增跨 Provider 配置的唯一映射校验、持久删除/忽略抑制或单执行设备选举。每个来源项目只配置一个 CTeam Provider，并在其中加入所需类型；请勿重复配置同一来源项目。自动导入的 Task 删除后可能重新导入。
- 尚无报告过期推断、AI 状态筛选、分析完成/介入通知、流式正文、扩展交互对话或后台队列。删除 Task/Project 暂不自动取消已经启动的 Pi；请先在 Task 面板停止，或关闭该 Project 的 Pi 开关。真正退出应用会停止本机运行。
- 当前测试使用脱敏形状的 HTTP fixtures 和真实子进程协议 fixture，不使用真实凭证，也没有调用真实 CTeam 或付费模型。
- 动态字段值编码、实际状态选项、分页期间一致性、公司内网证书/CORS 以及 Pi → CWLink → 真实代码的端到端结果仍需在用户环境验证。接口不符时修正已知路径，不另建分析 HTTP/MCP 代理。
- 未修改 Task/Project 持久模型、同步协议或公共插件 API；未安装插件的客户端仍可管理原生 Task，但不会在其本机运行 Pi。

## 检查

从仓库根运行：

```sh
npm --prefix packages/plugin-dev/cteam-issue-provider run quiet -- typecheck
npm --prefix packages/plugin-dev/cteam-issue-provider run quiet -- test
npm run quiet -- plugins:build
npm run quiet -- test:electron
npm run quiet -- test:file "src/app/features/pi-agent/*.spec.ts"
npm run quiet -- e2e:file e2e/tests/plugins/cteam-bundled.spec.ts --retries=0 --workers=2
```
