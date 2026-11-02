# MCP Apps：给工具结果加界面

一个 MCP App = 一个 `ui://` 资源（单文件 HTML）+ 至少一个用 `ui.resourceUri` 指向它的工具。宿主调用工具后把 HTML 放进沙箱 iframe 渲染，再把工具入参与结果通过通知推给界面；界面里的操作经宿主回调 server 的工具。

## 选哪种界面

| 信号 | 界面类型 |
|---|---|
| 工具已返回候选，要用户挑一个或几个再继续（航班、订单、文件） | 选择型，选中后 `updateModelContext` 同步给模型 |
| 结果是图表、地图、对比、文件预览等看图才懂的信息 | 展示型 |
| 写操作前要让用户在界面里核对、确认 | 确认型，确认动作经 `callServerTool` 调一个 `visibility: ['app']` 的工具 |
| 工具跑之前要用户补一组结构化输入（多字段表单、长列表里选参数） | 表单型。服务端中途问不了用户（没有 elicitation），只有模型和界面能问 |
| 长任务要用户看着进展 | 进度型：发起工具绑界面并返回任务 ID，界面轮询 `visibility: ['app']` 的查状态工具。进度通知在无状态 JSON 模式下发不出去，界面是唯一的路 |
| 以上都不匹配 | 不做界面 |

## 目录与构建

```text
server/mcp/ui/
├── tsconfig.json              # 界面独立的 TS 配置，整个 ui/ 共用一份，从本 skill 的 assets/ 拷
└── <entry>/
    ├── index.html             # 入口骨架，见下
    └── main.tsx               # 或 main.ts；React 或原生 JS 都行
dist/mcp-ui/<entry>.html       # 预设产物，@McpUiResource 经 readMcpUiTemplate 读取
```

```html
<!-- server/mcp/ui/<entry>/index.html -->
<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>
```

`<div id="root">` 不能少：缺了 `createRoot(document.getElementById('root')!)` 拿到 null，iframe 全白，而 `read_resource` 照样能读到 HTML，不会报错。

- `<entry>` 只允许 `A-Z a-z 0-9 _ -`。
- `@lark-apaas/coding-preset-vite-react` 的 `mcp-ui` 插件：检测到 `server/mcp/ui/` 就为每个入口跑一次独立子构建，JS / CSS / 资源全部内联成一个 HTML。开发态监听 `server/mcp/ui/` 与 `shared/`，改完自动重建；生产在主构建之后构建，并同步进发布目录。
- 子构建只带 React 插件与 `@shared` 别名，不加载主应用的 `vite.config.ts`、`.env`、`public/` 与 PostCSS 配置：`@/`、`@client/*`、`@server/*` 解析不到，不支持 styled-jsx、Tailwind 与主应用全局样式。样式写在入口自己的 CSS 里；颜色字体优先读宿主下发的 CSS 变量（`useHostStyles`），深浅两套主题下都要能看。
- 依赖边界由子构建强制：界面只能 import `server/mcp/ui/` 内的文件、`shared/` 与浏览器可用的 npm 包。引到 `client/`、`server/` 里的业务代码、工具类或服务端实现报「MCP UI 不能引用应用或服务端代码」，引到 `fs`、`path` 等报「MCP UI 不能引用 Node.js 模块」；HTML 的 `src` / `href`、CSS 的 `url()` 指到界面目录外同样被拒。要复用的纯展示组件挪到 `shared/`，且不得依赖应用的 Provider、Router 或登录态。
- 界面不继承主应用的 TS / ESLint 配置，各自带一份，首次开通界面从本 skill 的 `assets/` 拷进工程。逐字照拷、别自己写：子构建只转译不查类型，配置漏一项，错误要等界面在 iframe 里白屏才暴露。`SKILL_DIR` 取技能清单里本 skill 的 location 所在目录：

```bash
SKILL_DIR=<本 skill SKILL.md 所在目录>
mkdir -p server/mcp/ui
cp "$SKILL_DIR/assets/ui-tsconfig.json" server/mcp/ui/tsconfig.json
cp "$SKILL_DIR/assets/eslint.mcp-ui.config.cjs" eslint.mcp-ui.config.cjs
```

- `@modelcontextprotocol/ext-apps` 随 SDK 安装，直接 import。解析失败时把它加进 `package.json` `dependencies`，版本与 `node_modules/@lark-apaas/nestjs-mcp/package.json` 里声明的一致（1.x），不装 2.x。

## server 侧：声明资源并关联工具

```typescript
import { McpTools, McpTool, McpUiResource, readMcpUiTemplate } from '@lark-apaas/fullstack-nestjs-core';

@McpTools({ prefix: 'order_' })
export class OrderMcpTools {
  @McpTool({
    title: '查询订单',
    description: '…',
    inputSchema: SearchOrdersInput,
    outputSchema: SearchOrdersOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ui: { resourceUri: 'ui://order/list' },            // 结果由该界面渲染；模型与界面都可调
  })
  async search(/* … */) { /* … */ }

  @McpTool({
    description: '按 ID 取一条订单明细，供订单列表界面展开详情时调用。',
    inputSchema: GetOrderInput,
    outputSchema: GetOrderOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ui: { resourceUri: 'ui://order/list', visibility: ['app'] },   // 只供界面回调，模型工具清单里隐藏
  })
  async detail(/* … */) { /* … */ }

  @McpUiResource({
    uri: 'ui://order/list',
    title: '订单列表',
    description: '分页订单列表，可展开详情、勾选后取消。',
    csp: { connectDomains: [], resourceDomains: [] },   // 界面要访问的外部域名写这里，默认全禁
  })
  listView() {
    return readMcpUiTemplate('order-list');            // 读 dist/mcp-ui/order-list.html
  }
}
```

- `uri` 必须以 `ui://` 开头，全应用唯一；`ui.resourceUri` 找不到对应 `@McpUiResource()` 时应用启动会报错。
- `visibility` 默认 `['model', 'app']`。只给界面用的取数 / 刷新工具写 `['app']`，避免污染模型的工具清单。隐藏由宿主做，server 不过滤：`mcp_inspect` 的 `list_tools` 仍会列出它，`_meta.ui.visibility` 为 `['app']` 即正确，不要因为「还在清单里」去改代码。
- 绑了界面就在 `description` 里说出来（「结果以可交互的订单列表展示，可在界面里展开详情、取消订单」）。模型只看 `description` 选工具，不写它可能改调别的工具或自己拼 ID。
- 一个工具既返回 `structuredContent` 又绑界面是常态；模型还需要纯数据继续推理时，拆成「取数工具（无 ui）」+「展示工具（绑 ui）」。
- 资源读取沿用 `requireUser`：无身份的 `resources/read` 会被拒。

## 界面侧：接结果、回调工具

React 写法（`@modelcontextprotocol/ext-apps/react`）：

```tsx
// server/mcp/ui/order-list/main.tsx
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
// 与 outputSchema 对齐的 TS 类型放 shared/（如 shared/mcp-types.ts），server 与界面共用；@shared 是子构建唯一可用别名
import type { OrderPage as Page } from '@shared/mcp-types';

function OrderList() {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { app, isConnected } = useApp({
    appInfo: { name: 'order-list', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (app) => {
      // 宿主推送：工具入参（可先渲染骨架）、工具结果、取消
      app.ontoolinput = ({ arguments: args }) => console.debug('input', args);
      app.ontoolresult = (result) => {
        if (result.isError) setError(textOf(result));
        else setPage(result.structuredContent as Page);
      };
      app.ontoolcancelled = () => setError('调用已取消');
    },
  });
  useHostStyles(app, app?.getHostContext()); // 应用宿主主题、CSS 变量与字体；第二参数让首帧就生效

  async function cancel(orderId: string) {
    if (!app) return;
    const res = await app.callServerTool({ name: 'order_cancel', arguments: { orderId } });
    if (res.isError) return setError(textOf(res));
    // 把用户在界面里做的选择同步给模型，模型下一轮据此继续
    await app.updateModelContext({
      content: [{ type: 'text', text: `用户已在界面中取消订单 ${orderId}` }],
      structuredContent: { cancelledOrderId: orderId },
    });
    setPage((p) => p && { ...p, items: p.items.filter((i) => i.id !== orderId) });
  }

  if (!isConnected) return <p>连接宿主中…</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!page) return <p>等待查询结果…</p>;
  return (
    <ul>
      {page.items.map((o) => (
        <li key={o.id}>
          {o.customer} · {o.amount} 元 · {o.status}
          {o.status === 'pending' && <button onClick={() => cancel(o.id)}>取消</button>}
        </li>
      ))}
    </ul>
  );
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }) {
  return result.content?.find((c) => c.type === 'text')?.text ?? '调用失败';
}

createRoot(document.getElementById('root')!).render(<OrderList />);
```

原生 JS 写法（`@modelcontextprotocol/ext-apps`）：

```typescript
import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'order-list', version: '1.0.0' }, {});
app.ontoolresult = (result) => render(result.structuredContent);
await app.connect();
```

`ontoolresult` 等回调必须在 `connect()` 之前挂好——`useApp` 用 `onAppCreated` 注册就是为此，原生写法先赋值再 `connect()`。连上之后再赋值会漏掉宿主推来的第一帧结果，界面停在「等待查询结果…」——页面本身不报错，但 ext-apps 会在控制台 warn 一句 handler 注册太晚。

宿主能力速查（`App` 实例方法）：

| 方法 | 用途 |
|---|---|
| `ontoolinput` / `ontoolinputpartial` / `ontoolresult` / `ontoolcancelled` | 宿主推送的入参（完整 / 流式）、结果、取消 |
| `callServerTool({ name, arguments })` | 经宿主调本 server 的工具；工具名带 prefix；返回标准 `CallToolResult` |
| `updateModelContext({ content?, structuredContent? })` | 把界面状态同步给模型，不触发模型立刻回复 |
| `sendMessage({ role: 'user', content })` | 以用户身份发一条消息，触发模型回复 |
| `getHostContext()` / `onhostcontextchanged` | 主题、`displayMode`、`containerDimensions`、`locale`、`timeZone`、发起本次渲染的 `toolInfo` |
| `requestDisplayMode({ mode })` | 请求 inline / fullscreen 等展示模式，以 `availableDisplayModes` 为限 |

`useApp` 默认开自动调高（`autoResize`），内容变化不用手动发尺寸。

## 界面约束

- 不存凭证、不读 cookie / localStorage 里的登录态：iframe 是独立 origin，用户在业务系统的登录态带不进来。所有数据走 `callServerTool`，身份由宿主转发。
- 外部域名写进 `@McpUiResource` 的 `csp`：`connectDomains`（fetch / WebSocket）、`resourceDomains`（图片、脚本、样式）、`frameDomains`（内嵌 iframe）、`baseUriDomains`；默认全禁，漏写表现为资源静默加载失败。
- 业务返回值用 `textContent` 或 JSX 文本渲染，不拼 `innerHTML`。
- 每次调用重新注入数据；界面不假设自己能跨调用保留状态。
- 宿主不支持 MCP Apps 时只显示 `content` 文本，所以带界面的工具同样默认不写 `content`、由 SDK 补 JSON；要加摘要就在后面追加完整 JSON 块（见 `tool-authoring.md`「方法签名与返回值」），只给摘要会让这类宿主看不到数据。
- 一个工具配一个专注的界面。一个界面同时伺候多个工具的结果，每次渲染都要先判断数据从哪来，模型也更难预期结果长什么样。

## 调试

- `mcp_inspect` `read_resource` 读 `ui://…`：成功返回 `text/html;profile=mcp-app` 与正文开头；报「读取 MCP Apps 界面产物失败」→ `dist/mcp-ui/<entry>.html` 不存在：入口名与 `readMcpUiTemplate('<entry>')` 不一致、`server/mcp/ui/<entry>/index.html` 缺失、或 dev server 还没重建，看 dev server 日志里 `[mcp-ui]` 前缀的行。构建失败行里出现「MCP UI 不能引用…」是依赖越界，按上文边界规则改 import，不改预设。
- 界面逻辑用 `mcp_inspect` 看不到；先用 `call` 确认 `structuredContent` 形状正确，再在预览里看渲染。宿主渲染失败时保留工具结果，只重试界面。
- 界面里调 `callServerTool` 失败，错误也走 server 日志：按 Trace-ID 查。
