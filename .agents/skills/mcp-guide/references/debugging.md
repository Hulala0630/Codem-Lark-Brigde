# 调试：mcp_inspect、错误定位、本地模式

本文说的「沙箱」= 工具清单里有 `mcp_inspect` 的环境（妙搭云端 code-agent）；「本地模式」= 没有 `mcp_inspect`、在开发者本机跑 `npm run dev` 的环境。先看自己有哪个，再读对应部分。

## mcp_inspect

云端沙箱里的开发态 MCP 调试工具。它经 MCP 网关连当前应用的开发态 MCP Server，以当前用户身份发起，与预览页里操作应用的身份一致。

| action | 参数 | 返回 |
|---|---|---|
| `list_tools` | 无 | server 名、每个工具的 name / title / description / annotations / `_meta.ui` / inputSchema（长 schema 截断）、资源清单 |
| `call` | `tool_name`（带 prefix 的完整名）、`arguments`（JSON 对象**字符串**，缺省 `{}`）、`safe` | 文本内容、`structuredContent`、`isError`、耗时；正文整体超 12k 字符时从尾部截断，`structuredContent` 的末尾最先被吃掉。脱敏后的完整结果超过 12k 字符时落盘到 `tmp/<会话>/tool/<调用ID>/result.json`，结果尾部给出路径，需要全量数据时 `read_file` 读它，不要缩小入参反复重调 |
| `read_resource` | `resource_uri`（如 `ui://order/list`） | uri、mimeType、`_meta.ui`、正文前若干字符 |

- `safe`：工具未声明 `annotations.readOnlyHint: true` 时，`call` 在发起前被拒为 `requires_safe`。只有这次调用影响的是你自建、且事后能自己清掉的数据时才传 `safe: true`；用户已有的真实数据未经明确要求不动。只读工具反复撞这条，是源码漏了 `readOnlyHint: true`，补注解而不是加 `safe`。
- 单个子请求 60s 无动静即超时，整次动作 600s 硬上限。server 是无状态 JSON 模式（不开 SSE），`ctx.extra.sendNotification` 发的 `notifications/progress` 到不了客户端、不会重置计时；超时只能靠缩小单次处理范围。
- 同一工具连续失败 4 次熔断 60s：先改代码或入参，不是等。`requires_safe`、`tool_not_found`、`aborted` 不计入熔断。
- 失败或 `isError: true` 时结果尾部附 Trace-ID 对应的 `server.log` / `trace.log` 片段。

**目录接口**：`GET http://localhost:<CLIENT_DEV_PORT><CLIENT_BASE_PATH>/__innerapi__/mcp/manifest`（`CLIENT_DEV_PORT` 默认 8080；`CLIENT_BASE_PATH` 沙箱里是平台下发的 `/app/<appId>`，漏了前缀拿不到 JSON，取值以 `.env.local` 或 dev server 启动日志为准）返回 `tools` / `resources` / `prompts` / `skills[]`（含 frontmatter 的完整正文）与源码定位，不要求身份，有无 `mcp_inspect` 都能 curl。应用 Skill 是 Prompt 不是资源，`mcp_inspect` 的三个动作都碰不到它，核对它只走这里。

## 回路

1. 改工具 / 资源 / 界面。
2. 等 dev server 重启（`nest --watch` 会自动重启；界面改动由 `[mcp-ui]` 插件自动重建）。定义有问题会让应用起不来并打印「MCP 定义校验失败」，修完再往下走。
3. `list_tools` 核对清单与源码一致（`visibility: ['app']` 的工具也在清单里，属正常）。
4. `call` 以真实入参验证所有只读工具，调用顺序按 [顶层「验证与汇报」](../SKILL.md#验证与汇报) 组织。除了 `structuredContent`，单独看「文本内容」那段是否带全了业务数据：只读文本的客户端只看得到这段，只有「找到 N 条」之类的统计文案就是 `content` 写坏了（见 `tool-authoring.md`「方法签名与返回值」）。写工具只在能自己清掉痕迹（有对应删除 / 撤销工具，或业务上可撤回）时才真调并随手清理；否则只验证入参校验与 `McpToolError` 分支，汇报里写明「写入链路未真实验证」。
5. 带界面的工具 `read_resource`。
6. 每个 `McpToolError` 分支构造一次触发（不存在的 ID、非法状态），确认 `isError: true` 且 `code` 与 `description` 预告一致。
7. 更新 `server/mcp/skills/<name>/SKILL.md`，再 curl 目录接口（frontmatter 不合法这里会 500）：`skills[]` 有该 `name`、`content` 是最新正文，`prompts[]` 的 `description` 一致。

## 错误分流

| 现象 | 原因 | 动作 |
|---|---|---|
| 端点 404「当前工程可能尚未接入 MCP 层，或 dev server 尚未就绪」 | `server/mcp` 不存在；dev server 没起来；零工具零资源无应用 Skill（SDK 此时返回 404） | 确认三者；有工具但 404 看启动日志是否被校验阻断 |
| `list_tools` 少了某个工具 | 类没进任何模块 `providers`，无任何日志提示 | 对照启动日志「已注册 N 个 MCP 工具：…」，缺的加进所属业务模块的 `providers` |
| dev server 起不来，报「MCP 工具必须使用单例及单例依赖」 | 工具类或其依赖是 request / transient 作用域 | 改回单例，身份从 `ctx.user` 取 |
| 启动日志「MCP 定义校验失败」 | 工具名不合法 / 重名、资源 URI 不以 `ui://` 开头 / 重名、`ui.resourceUri` 找不到 `@McpUiResource()`、同一方法同时标两个装饰器 | 按日志逐条列的问题逐个修 |
| `tool_not_found` | 名字没带 prefix，或用了 `title` | 用 `list_tools` 里的 name |
| `requires_safe` | 见上文 `safe` | 只读工具补注解；写工具按回路第 5 步——能清掉痕迹才 `safe: true`，否则只验错误分支 |
| `isError` + `code: MCP_USER_REQUIRED`（`prompts/get` / `resources/read` 则是 JSON-RPC error） | 请求没带用户身份：有 `mcp_inspect` 的环境里 curl 直连 dev server / NestJS 端口就是这样 | 无身份的 curl 只做 `tools/list`、`prompts/list`、`resources/list` 与目录接口；`tools/call` / `resources/read` 走 `mcp_inspect`，Prompt 正文看目录接口的 `skills[].content`。不改 `requireUser`、不拼身份头 |
| `isError` + 业务 `code` | 工具按设计抛了 `McpToolError` | 对照 `description` 检查是否预告了该 code；入参是否真的该触发 |
| `isError` + 通用失败提示 | 方法抛了非 `McpToolError` 的异常 | 读结果尾部 Trace-ID 日志定位；该异常若是可预期的业务失败，改抛 `McpToolError` |
| zod 校验错误 | 入参不符 inputSchema | 对照 `list_tools` 里的 schema 改 `arguments`；schema 本身不合理就改源码 |
| 用户在自己的 Agent / 客户端里调工具，只看到「找到 N 条」，没有明细 | 手写的 `content` 只放了摘要，关掉了 SDK 自动补的 JSON 文本；对方客户端只读 `content`。`mcp_inspect` 同时展示 `structuredContent`，所以自测看着正常 | 删掉 `content` 让 SDK 补，或在摘要块后追加 `JSON.stringify(structuredContent)`；不要把字段逐个拼成中文文案 |
| 「工具已执行，但输出与其声明的 outputSchema 不符」 | `structuredContent` 与 `outputSchema` 对不上 | 工具已跑通：改返回值或改 schema，不重试同一调用 |
| `timeout` | 单个子请求 60s 无动静，或整次超 600s | 收窄入参 / 分页 / 拆成「发起 + 查状态」两个工具；加进度通知无效（JSON 模式发不出去） |
| `connect_failed` / `http_error` / `unauthorized` | 网关或预览环境问题；`http_error` 500 先对下面 frontmatter 那行，应用自己也会 500 | 看 statusCode；不是应用代码问题时告知用户，不改代码绕 |
| `jsonrpc_error` + `data.code: MCP_APP_REVISION_MISMATCH` | 调用方带的应用修订与当前产物不一致（改代码、改界面、改应用 Skill、dev server 重启都会变），**本次业务未执行** | 重新 `list_tools` 取最新清单再调；不要原样重试，也不要把这当业务失败去改工具代码 |
| `jsonrpc_error` + `data.code: MCP_APP_REVISION_UNAVAILABLE` | 产物是旧版构建、不带修订，而调用方带了预期修订 | 同步新版构建脚本后重新发布；在那之前不要启用依赖修订的绑定 |
| 「已连续 4 次调用失败，已暂停对它的重复调用」 | 同一工具连续失败 4 次熔断 | 先修实现或入参，60s 后再验 |
| 「当前运行环境不支持开发态 MCP 调试」 | 本地 CLI 宿主没有 `mcp_inspect` 后端 | 走下节本地模式 |
| `read_resource` 报「读取 MCP Apps 界面产物失败」 | `dist/mcp-ui/<entry>.html` 不存在 | 入口名对齐 `readMcpUiTemplate('<entry>')`；确认 `server/mcp/ui/<entry>/index.html` 存在；看 `[mcp-ui]` 日志是否构建失败 |
| dev server 日志 `[mcp-ui] 构建失败：MCP UI 不能引用应用或服务端代码 / Node.js 模块` | 界面 import 了 `client/`、`server/` 的业务代码或 Node 内置模块；HTML `src`、CSS `url()` 指到界面目录外也算 | 把依赖挪进 `server/mcp/ui/` 或 `shared/`；不改预设配置 |
| `mcp_inspect` 任一动作 `http_error` 500、目录接口 500，server 日志有「处理 MCP 请求失败」、栈首行是「MCP Skill …」 | 某份 `server/mcp/skills/*/SKILL.md` frontmatter 不合法：缺 frontmatter、`name` 与目录名不等、`description` 空、重名、超限 | 按日志文案修 frontmatter |

同一失败不原样重试。改完代码再验，每轮只改一个变量。

## 本地模式（工具清单里没有 `mcp_inspect` 时才适用）

本地开发（`MIAODA_LOCAL_DEV=1`，`npm run dev` 走 `dev-local.js`）没有 `mcp_inspect`，MCP 客户端是你自己或 IDE 里的 Agent。

- 带身份的入口只有 dev server：`http://localhost:<CLIENT_DEV_PORT><CLIENT_BASE_PATH>/__innerapi__/mcp`（`CLIENT_BASE_PATH` 以 `.env.local` 为准，`+env-pull` 拉下来的是 `/app/<appId>`）。dev server 代理把 `+env-pull` 拉到的 `SUDA_WEBUSER` 注入为身份头，工具里的 `ctx.user` 就是开发者本人。直连 NestJS 端口没有身份，会撞 `MCP_USER_REQUIRED`。
- 标准 MCP 客户端配置 Streamable HTTP、URL 填上面地址即可连接。
- 看原始请求响应：`npx @modelcontextprotocol/inspector`，指向同一地址。
- 快速验证：

```bash
curl -s -X POST 'http://localhost:<port><base>/__innerapi__/mcp' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`accept` 必须同时含两种类型，否则 406。`GET` / `DELETE` 返回 405，端点只接受 `POST`；目录接口见上文。

## 汇报

按 [SKILL.md 的「验证与汇报」](../SKILL.md#验证与汇报) 对照实际调用结果，说明验证范围与测试数据清理情况。
