---
name: mcp-guide
description: "Use when 用户要把应用能力开放给外部 Agent / 工作伙伴 / MCP 客户端调用，新增或修改 MCP 工具，给工具结果加界面（MCP Apps / ui:// 资源），维护应用 Skill（server/mcp/skills/<name>/SKILL.md，SDK 注册为 MCP Prompt），要在开发态核对、调用、调试 MCP 工具，或要把本应用的 MCP 接到自己的 Agent 客户端上使用。触发词：MCP, MCP Server, MCP 工具, MCP Apps, ui://, @McpTools, @McpTool, @McpUiResource, McpToolError, readMcpUiTemplate, tools/list, tools/call, resources/read, prompts/list, prompts/get, mcp_inspect, 开放给 Agent, 工作伙伴调用, Agent 调用应用, 应用 Skill, server/mcp, server/mcp/ui, server/mcp/skills, 接入 MCP, 连接 MCP, 怎么用这个 MCP, MCP 客户端, Claude Code, Codex, mcp add, mcp login, config.toml, MCP 凭证, 可用范围, 连不上。不负责 HTTP 对外开放接口（走 openapi-guide）、自动化触发器（走 trigger-guide）。"
steering: true
steering-topic: mcp_guide
match-template-name: nestjs-react-fullstack
---

# MCP 开发与调试

应用的 MCP Server 是全栈工程里多出来的一层出口：同仓、同域名、同版本。SDK（`@lark-apaas/fullstack-nestjs-core` 重导出 `@lark-apaas/nestjs-mcp`）已经内置端点 `POST /__innerapi__/mcp`、Streamable HTTP 协议、zod 校验、身份读取、`ui://` 资源与应用 Skill（MCP Prompt）下发。你只写三种文件：工具类、界面入口、应用 Skill。

**真值顺序**：工程内 `node_modules/@lark-apaas/nestjs-mcp/dist/index.d.ts` > 本文。装饰器选项、类型名、返回值形状以它为准；本文与它冲突时按包改，不按本文改。**读它、但不从它 import**：公开 API 一律从 `@lark-apaas/fullstack-nestjs-core` 导入，直接 import 会被 ESLint 判「不在 dependencies 中」，那时改 import 源、不要加进 `dependencies`。

## 固定路径（不探测）

| 路径 | 内容 |
|---|---|
| `server/mcp/tools/<域>.tools.ts` | 工具类：一个业务域一个文件，`@McpTools()` 类 + 多个 `@McpTool()` 方法 |
| `server/mcp/ui/<entry>/index.html`（+ `main.tsx`）、`server/mcp/ui/tsconfig.json` | MCP Apps 界面源码：独立的浏览器代码，Vite 预设自动打成 `dist/mcp-ui/<entry>.html` |
| `server/mcp/skills/<name>/SKILL.md` | 应用 Skill：一个业务流程一份，给消费方 Agent 看的用法说明，SDK 注册为同名 MCP Prompt |

`server/mcp/` 不存在即为首次开通；开通只需建上述文件并把工具类注册为所属业务模块的 provider。`McpModule` 已由 `PlatformModule.forRoot()` 引入，SDK 启动时扫已加载模块的 provider 自动发现工具类——挂在已有业务模块上就不用动 `app.module.ts`，新建的模块仍要接进去，否则整个模块不会实例化、工具静默缺席；不写注册表，不写 `tools/index.ts`。

两份同名的 SKILL.md 别混：本文教你写代码，`server/mcp/skills/*/SKILL.md` 是产物、教下游 Agent 用工具。不把本文复制成应用 Skill，应用 Skill 不加 `steering: true`。

## 前置检查（一条命令）

```bash
ls -d node_modules/@lark-apaas/nestjs-mcp node_modules/@lark-apaas/coding-preset-vite-react/lib/plugins/mcp-ui.js
```

- 缺 `@lark-apaas/nestjs-mcp` → 当前 `@lark-apaas/fullstack-nestjs-core` 不含 MCP 层（`1.1.62` 起含）。告知用户升级 core，停止；不装 `@modelcontextprotocol/sdk`、不手写端点。
- 缺 `mcp-ui.js` → 只能做工具、不能做界面（`@lark-apaas/coding-preset-vite-react` `1.0.23` 起含）。要做界面先让用户升级该预设。Rspack 预设不支持 MCP Apps。

## 任务路由

`$SKILL_DIR` 取技能清单里本 skill 的 location 所在目录。

| 任务 | 读 |
|---|---|
| 新增 / 修改工具、开通 MCP、维护应用 Skill | `$SKILL_DIR/references/tool-authoring.md` |
| 给工具结果加界面、改界面、界面与工具联动 | `$SKILL_DIR/references/mcp-apps.md` |
| 用 `mcp_inspect` 核对与调用、按错误定位、本地模式调试 | `$SKILL_DIR/references/debugging.md` |
| 用户要在自己的 Agent（Claude Code / Codex / 其它客户端）里连本应用的 MCP | `$SKILL_DIR/references/client-onboarding.md` |

调用 `mcp_inspect` 前，先读 `$SKILL_DIR/references/debugging.md`。改工具、资源或界面后，等 dev server 重启再验证（定义有问题会在启动日志里报）。`mcp_inspect` 报「当前运行环境不支持」时，走该文件的本地模式。向用户汇报用业务表述（「找到 4 个演示航班」），不贴 JSON。

## 验证与汇报

- `mcp_inspect` 先用 `action: "list_tools"` 核对工具清单，再用 `action: "call"` 以真实入参验证所有只读工具。入参已确定的调用在同一轮发出，依赖前一步结果的调用后置。`tool_name` 取清单中的完整名，`arguments` 传 JSON 对象字符串（无入参用 `"{}"`）。正常调用应返回 `isError: false`，文本内容和 `structuredContent` 应包含预期业务数据；REST 接口或页面自测不能替代 MCP 调用。
- 写工具只在操作自建、且能自行删除或撤销的数据时传 `safe: true`；调用后读回确认变更并清理，汇报实际变更及清理情况。不能清理时只验证入参校验与业务错误分支，汇报「写入链路未真实验证」。
- 每个 `McpToolError` 分支构造一次触发，确认 `isError: true`，且 `code` 与工具描述一致。出现通用失败或结果不符合预期时按 `references/debugging.md` 定位，修复后复测失败项。
- 总结前对照工具清单与本轮实际调用结果，点名未调用的工具、未验证的分支和仍失败的项；只测了错误分支就只报错误分支通过，不写整个工具通过。有未覆盖项，不写「全部通过」。

## 不变量

1. 一个工具对应一件用户说得出口的事（找订单、取消订单），不按库表铺增删改查；读和写分在不同工具里。
2. schema 用 zod，提成常量放类上方；方法签名固定 `(input: Infer<typeof In>, ctx: McpContext)`，返回 `McpToolResult<typeof Out>`。签名写错在 `npm run type:check:server` 暴露。
3. `description` 面向模型：用途、何时调用、参数来源、返回什么、失败怎样。每个 zod 字段 `.describe()`。消费方 Agent 只靠这些选工具、填参数。
4. 四项 `annotations` 显式写出。只读工具必须 `readOnlyHint: true`：缺省会被当成可能写数据，调试时每次都要 `safe: true`，消费方也会额外确认。
5. 声明了 `outputSchema` 就返回匹配的 `structuredContent`，对不上时 `mcp_inspect` 报「输出与其声明的 outputSchema 不符」。`content` 默认不写，由 SDK 补 `structuredContent` 的 JSON 文本；自己写了 `content` 就关掉了这份兜底，只读文本的客户端只看得到你写的那几句——要摘要就在摘要后再追加一块完整 JSON，不要只写「找到 N 条」这类统计文案。列表工具入参带 `limit`（默认不超过 20）与 `cursor`；写操作的幂等由 Service 保证，不引入幂等键字段。
6. 返回值按消费方够用来裁：`structuredContent` 只放它推理或界面渲染要用的字段。SDK 不截断，返回多少对方就吃多少，详见 `$SKILL_DIR/references/tool-authoring.md` 的「返回体积」。
7. 业务失败抛 `McpToolError(message, { code })`，Agent 原样收到；`message` 连下一步一起写（「订单不存在，用 order_search 按客户名重查一个有效 ID」），只陈述现象会让对方原样重试或直接放弃。其他异常只落日志、返回通用提示，Agent 看不到原因。
8. 身份只从 `ctx.user` 读；权限与行级过滤留在 Service。工具类作为业务模块 provider 注册，单例——请求态（当前用户、本次入参、游标）只放方法内的局部变量，写进类字段会在并发请求间串号。
9. 工具名 = `prefix + 方法名`，匹配 `^[A-Za-z0-9_.-]{1,128}$`，全应用唯一；用 `域_动作`。
10. 界面源码只放 `server/mcp/ui/<entry>/`，TS 与 ESLint 配置从 `$SKILL_DIR/assets/` 拷、不手写（见 `$SKILL_DIR/references/mcp-apps.md`）。用 `@McpUiResource` + `readMcpUiTemplate('<entry>')` 下发，工具用 `ui: { resourceUri }` 关联。
11. 新增、改名、删除工具后同步改对应的 `server/mcp/skills/<name>/SKILL.md`；frontmatter 的 `name` 必须等于目录名。

## 禁止

- 从入参接收用户 ID、token、连接串——身份来自网关，入参里的身份可伪造。
- 自己拼一个 `x-larkgw-suda-webuser` 头来让调用通过——SDK 会把它当真实用户，写工具会以这个身份落库、发通知。
- 把 `requireUser` 设为 `false` 绕开身份检查——SDK 只是跳过检查，方法照样执行，`ctx.user.userId` 是 undefined，跟着 `ctx.user.userId!` 一路进 Service 的权限过滤。
- 服务端 import `server/mcp/ui/` 里的源码，或界面 import `client/`、`server/` 里的业务代码、工具类、Node 模块——子构建的边界检查直接报错，服务端只经 `readMcpUiTemplate` 读构建产物。
- 界面里存凭证、直连业务系统——沙箱 iframe 是独立 origin，用户登录态带不进来；数据走宿主转发的工具调用。
- `McpToolError.data` 与 `structuredContent` 里放密钥、内部连接信息——两者原样进 Agent 上下文。
- 自己实现 MCP 协议、JSON-RPC、`/mcp` 路由、鉴权——SDK 与网关已做，重复实现会与网关映射冲突。

## 交付前核对

1. `list_tools` 与源码里的工具、资源一一对应。
2. 每个工具有面向模型的 `description`、四项 `annotations`；写工具有 `outputSchema`。
3. 每个 `ui.resourceUri` 能 `read_resource` 读到，界面拿到 `structuredContent` 后能渲染；`npx tsc --noEmit -p server/mcp/ui/tsconfig.json` 与 `npx eslint -c eslint.mcp-ui.config.cjs server/mcp/ui` 通过。
4. `server/mcp/skills/` 下每个业务流程一份 SKILL.md，合起来覆盖全部工具：何时调用、如何选工具、调用顺序、约束、失败处理、界面 URI；目录接口的 `prompts[]` 与目录一一对应。
