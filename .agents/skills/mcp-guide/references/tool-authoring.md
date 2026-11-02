# 工具类写法

API 形状以 `node_modules/@lark-apaas/nestjs-mcp/dist/index.d.ts` 为准。下面是当前版本的写法与约束；字段名对不上时以 d.ts 为准。

## 工具面规模

工具面不是越全越好：每个工具的 schema 在消费方 Agent 的**每一轮**都占上下文，面越大它选错越多。

| 工具数 | 做法 |
|---|---|
| ≤ 15 | 一个动作一个工具 |
| 15–30 | 仍可用；把只有参数差别的近重复工具并掉 |
| > 30 | 收敛成「检索 + 执行」几个通用工具，高频的三五个再单独开 |

用户没说清要开放哪些能力、给谁用时，先问清再写，不要把 Service 层能做的全铺出去。

## 要不要界面

结果要用户动手挑、看、或确认的工具才配界面；只是给模型继续推理的数据不配。要配的话，界面类型与写法见 `mcp-apps.md`。

## 骨架

```typescript
// server/mcp/tools/order.tools.ts
import { z } from 'zod';
import {
  McpTools,
  McpTool,
  McpToolError,
  type Infer,
  type McpContext,
  type McpToolResult,
} from '@lark-apaas/fullstack-nestjs-core';
import { OrderService } from '@server/modules/order/order.service';

// schema 提成常量：方法签名用 Infer<typeof …> 引用
export const SearchOrdersInput = {
  keyword: z.string().optional().describe('客户名关键字，模糊匹配'),
  limit: z.number().int().min(1).max(50).default(20).describe('单页条数'),
  cursor: z.string().optional().describe('上一页返回的 nextCursor；首页不传'),
};
export const SearchOrdersOutput = {
  items: z.array(
    z.object({
      id: z.string(),
      customer: z.string(),
      amount: z.number().describe('金额，单位元'),
      status: z.enum(['pending', 'paid', 'cancelled']),
    }),
  ),
  nextCursor: z.string().nullable().describe('还有下一页时非空，原样传回 cursor'),
};

export const CancelOrderInput = { orderId: z.string().describe('订单 ID，来自 order_search 的 items[].id') };
export const CancelOrderOutput = { orderId: z.string(), status: z.literal('cancelled') };

@McpTools({ prefix: 'order_' })
export class OrderMcpTools {
  constructor(private readonly orders: OrderService) {}

  @McpTool({
    title: '查询订单',
    description:
      '按客户名关键字分页查询当前用户可见的订单。用户想找订单、看订单列表时调用；一页最多 50 条，超出用 cursor 翻页。',
    inputSchema: SearchOrdersInput,
    outputSchema: SearchOrdersOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  })
  async search(
    input: Infer<typeof SearchOrdersInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof SearchOrdersOutput>> {
    const userId = ctx.user.userId!; // requireUser 默认开启，执行到这里必有值；取一次往下传
    const page = await this.orders.search({ ...input, userId });
    return {
      // 按 outputSchema 挑字段，不把 Service 查出来的整行记录原样回传
      structuredContent: {
        items: page.items.map((o) => ({ id: o.id, customer: o.customer, amount: o.amount, status: o.status })),
        nextCursor: page.nextCursor,
      },
      // 不写 content：SDK 自动补一份 structuredContent 的 JSON 文本，只读文本的客户端也拿得到明细
    };
  }

  @McpTool({
    title: '取消订单',
    description:
      '取消一个待支付订单。仅在用户明确要求取消、且订单状态为 pending 时调用；订单不存在返回 ORDER_NOT_FOUND，状态不允许返回 ORDER_NOT_CANCELLABLE。重复取消同一订单返回同一结果。',
    inputSchema: CancelOrderInput,
    outputSchema: CancelOrderOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  })
  async cancel(
    input: Infer<typeof CancelOrderInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof CancelOrderOutput>> {
    const userId = ctx.user.userId!;
    const order = await this.orders.findVisibleTo(input.orderId, userId);
    if (!order) throw new McpToolError('订单不存在，用 order_search 按客户名重查一个有效 ID', { code: 'ORDER_NOT_FOUND' });
    if (order.status === 'cancelled') return { structuredContent: { orderId: order.id, status: 'cancelled' } };
    if (order.status !== 'pending') {
      throw new McpToolError(`订单状态为 ${order.status}，只有 pending 能取消，不要重试`, { code: 'ORDER_NOT_CANCELLABLE' });
    }
    await this.orders.cancel(order.id, userId);
    return { structuredContent: { orderId: order.id, status: 'cancelled' } };
  }
}
```

```typescript
// server/modules/order/order.module.ts —— 工具类和它依赖的 Service 注册在同一个模块
import { Module } from '@nestjs/common';
// OrderController / OrderService / OrderMcpTools 的 import 略

@Module({
  controllers: [OrderController],
  providers: [OrderService, OrderMcpTools],
})
export class OrderModule {}
```

`@McpTools()` 自带 `@Injectable()`。SDK 启动时用 DiscoveryService 扫所有 provider；类没进任何模块的 `providers` 就扫不到它，启动日志不会有任何提示，工具静默缺席——启动日志「已注册 N 个 MCP 工具：…」列出的名字才是真相，对不上就是没注册。工具类及其依赖必须是单例：request / transient 作用域会在启动时抛「MCP 工具必须使用单例及单例依赖」，整个应用起不来。单例意味着所有请求共用一个实例：当前用户、本次入参、分页游标只放方法内的局部变量，写进类字段或模块级变量会在并发请求间串号。

## 装饰器选项

`@McpTool(options)`：

| 字段 | 说明 |
|---|---|
| `name?` | 默认取方法名；最终工具名 = `prefix + name`，需匹配 `^[A-Za-z0-9_.-]{1,128}$`，全应用唯一 |
| `title?` | 面向人的展示名，面板里显示 |
| `description` | 必填，面向模型 |
| `inputSchema?` / `outputSchema?` | zod：原始形状 `{ a: z.string() }` 或 `z.object({...})` 都行；顶层必须是对象 |
| `annotations?` | `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`，四项都写 |
| `ui?` | `{ resourceUri: 'ui://…', visibility?: ['model' \| 'app'] }`，见 `mcp-apps.md` |
| `meta?` | 额外 `_meta`，与 `ui` 生成的字段合并 |

`@McpTools({ prefix? })`：给类下所有工具名加前缀，如 `order_`。

## 方法签名与返回值

- 固定 `(input, ctx)`。无入参的工具 `input` 为 `Record<string, never>`，仍要写第二个参数 `ctx`。
- 声明了 `outputSchema`：返回 `{ structuredContent }`，类型由 schema 推导；**默认不写 `content`**。SDK 只在 `content` 缺省时自动补一块 `JSON.stringify(structuredContent)` 文本。
  - 不支持结构化输出的客户端只读 `content` 文本：只渲染文本的宿主、把工具结果原样喂给模型的 Agent 都看不到 `structuredContent`。
  - 自己写了 `content`，SDK 就不再补。只写「找到 2 条待办」这类统计文案，这些客户端就只看到这一句，标题、ID、状态全丢——用户会反馈「调用了但没有实际内容」。
  - 确实要一句摘要时，摘要块后面再追加一块完整数据，不要把字段逐个拼进中文文案（拼漏、与 schema 走样）：

    ```typescript
    const data = { items, nextCursor };
    return {
      structuredContent: data,
      content: [
        { type: 'text', text: `找到 ${total} 条订单，本页 ${items.length} 条` },
        { type: 'text', text: JSON.stringify(data) },
      ],
    };
    ```

- 未声明 `outputSchema`：返回 `{ content: [{ type: 'text', text }] }`；`content` 还支持 `image` / `audio` / `resource_link` 块。
- `isError: true` 由 SDK 在捕获 `McpToolError` 时设置，不需要手动返回。

## 返回体积

SDK 不截断，返回多少消费方 Agent 就吃多少，超了是它的上下文被挤掉。`mcp_inspect` 里看到的截断与落盘是调试通道的显示预算，与工具该返回多少无关。

- `structuredContent` 只放对方推理或界面渲染要用的字段。Service 查出来的整行记录、外键、审计字段先挑一遍再返回。
- 列表工具 `limit` 默认不超过 20、上限写进 zod（`.max(50)`）；要更多靠 `cursor` 翻页，不靠调大 `limit`。
- 结果仍可能很大时自己截断，把截断标记和出路一起返回，让对方知道怎么缩小范围。两个字段都要写进 `outputSchema`，否则与声明对不上；位置放在数据字段**前面**，按尾部截断时先没的才是数组尾巴而不是这两个字段：

```typescript
return {
  structuredContent: {
    truncated: true,
    hint: '命中 847 条，只返回前 20 条；加 status 过滤或换更具体的关键字',
    items: page.items,
  },
  // 不写 content：SDK 补的 JSON 文本里 truncated / hint 排在最前，只读文本的客户端也能看到
};
```

- 图片、附件、长文本用 `content` 里的 `resource_link` 给指针，不内联进结果。`mcp_inspect` 只渲染文本块，这类块在调试结果里不显示，别据此以为工具什么都没返回。

## McpContext

| 字段 | 用途 |
|---|---|
| `user` | 与 REST 里的 `req.userContext` 同源：`userId` / `tenantId` / `roles` / `env`（`preview` \| `runtime`）等，字段全部可选（`userId?: string`）。默认 `requireUser: true`，缺 `userId` 时 SDK 直接返回 `MCP_USER_REQUIRED`、方法不执行，所以方法体开头 `const userId = ctx.user.userId!;` 取一次往下传；不要为迁就类型去改 Service 签名 |
| `request` | 原始 HTTP 请求，读 header、logid |
| `signal` | 客户端取消时触发，长任务把它传给下游 |
| `requestId` | MCP 请求 id |
| `extra` | SDK 的 `RequestHandlerExtra`（`sessionId` / `requestId` / `authInfo` 等）。它有 `sendNotification`，但端点是无状态 JSON 模式，`notifications/progress` 发不到客户端——长任务别靠进度通知续命，拆成「发起 + 查状态」两个工具 |

工具执行中途要不到用户输入：SDK 没有 elicitation，无状态 JSON 模式下服务端发往客户端的请求也出不去（与进度通知同因）。需要用户确认或补参数时，把它做成入参交给模型去问，或者做确认型界面（见 `mcp-apps.md`），不要设计成「工具跑一半停下来等人」。

## 错误处理

- 可预期的业务失败抛 `new McpToolError(message, { code?, data? })`：SDK 转成 `isError: true`，`message` / `code` / `data` 原样进 Agent 上下文。`code` 用 `SCREAMING_SNAKE`，并在 `description` 里预告，Agent 才知道怎么应对。
- `message` 写成「哪里错了 + 下一步做什么」：「订单不存在，用 order_search 按客户名重查一个有效 ID」。错误消息必达，应用 Skill 里的处理说明要消费方主动取 Prompt 才看得到，出路别只写在那边。
- 其他异常：SDK 记日志、返回通用失败提示，Agent 看不到原因。调试时看到「通用失败提示」就去读 Trace-ID 日志。
- 入参校验交给 zod，方法体不重复判空；zod 失败由 SDK 返回，方法不执行。

## description 怎么写

消费方 Agent 只靠 `description` 与字段 `.describe()` 决定调不调、怎么填。写全五件事：用途、何时调用（含前置条件）、参数从哪来（「来自 order_search 的 items[].id」）、返回什么、失败会返回哪些 code。写操作再加一句幂等语义（「重复取消返回同一结果」）。

字段描述写单位、格式、取值来源；枚举用 `z.enum`；入参不用 `z.any()` / `z.unknown()`。

## 开通（首次）

1. 前置检查通过（见 SKILL.md）。
2. 建 `server/mcp/tools/<域>.tools.ts`，至少一个只读工具复用现有 Service。
3. 把工具类加进所属业务模块的 `providers`。
4. 写 `server/mcp/skills/<name>/SKILL.md`（下节）。
5. 跑 `lark-cli apps +mcp-get --app-id "$app_id"` 开启线上 MCP。不跑这一步，应用发布后外部客户端也连不上。
6. 进 `debugging.md` 的调试回路。

## 应用 Skill：`server/mcp/skills/<name>/SKILL.md`

给消费方 Agent 的使用说明。一个业务流程一个目录，目录里只认固定文件名 `SKILL.md`。SDK 把每份注册为同名 MCP Prompt：`prompts/list` 给 `name` / `description`，`prompts/get` 返回去掉 frontmatter 的正文（一条 `role: user` 文本消息）。它不是 Resource、没有 `skill://` URI，`resources/list` 里看不到它是正常的。每次请求重新读文件，改完不用重启。

frontmatter 规则。SDK 每次请求都会校验，不合法时整个 MCP 请求 500，不会静默跳过这一份：

- `name` 必填且等于目录名：1–64 位小写字母、数字与单个连字符，不能首尾连字符、不能连续 `--`。
- `description` 必填非空，不超过 1024 字符；消费方只靠它决定要不要取这份 Prompt，写清适用场景。
- 全应用不重名；最多 100 份，单文件不超过 1 MiB，合计不超过 8 MiB；必须是工程内普通文件，不接受符号链接。
- 只有 `SKILL.md` 会被读取和交付，同目录的图片、附件不会。

正文必含：适用场景、实际工具名与关键参数、调用顺序、需要用户确认的边界、身份与权限要求、每个错误 code 的处理、界面 URI（如有）。只写已实现的能力；不写凭证、用户数据、内部实现。

示例 `server/mcp/skills/orders/SKILL.md`。`---` 必须是文件第一行，前面不能有任何字符，注释也不行：

```markdown
---
name: orders
description: 查询当前用户可见的订单，并在用户明确要求后取消待支付订单。
---
# 订单能力
- 需要已登录用户身份；只返回当前用户可见的订单。
- 找订单：order_search，keyword 模糊匹配客户名；nextCursor 非空时用 cursor 翻页。
- 取消订单：只有用户明确要求取消、且 status 为 pending 时调用 order_cancel；orderId 取自 order_search 的 items[].id。
- ORDER_NOT_FOUND：请用户核对订单 ID。ORDER_NOT_CANCELLABLE：告知当前状态，不重试。
- 支持界面的宿主会用 ui://order/list 展示查询结果。
```

## 定义校验

工具名格式与重名、资源 URI 的 `ui://` 前缀与重名、`ui.resourceUri` 能否找到对应的 `@McpUiResource()`——这些在应用启动时统一校验，失败直接阻断启动并打印「MCP 定义校验失败」，逐条列出问题与出错的类和方法。一个方法不能同时标 `@McpTool()` 与 `@McpUiResource()`。改完等 dev server 重启看日志即可，没有单独的离线校验命令。

## 模块配置

```typescript
PlatformModule.forRoot({
  mcp: {
    serverName: 'travel-approval',  // 首次开通 MCP 时按用途设置，别留缺省
    serverVersion: '1.0.0',
    instructions: '…',              // initialize 响应里的说明
  },
});
// 关闭端点：PlatformModule.forRoot({ mcp: false })
```

**`serverName` 首次开通时就设上。** `initialize` 把它返回给连上来的外部 Agent，`mcp_inspect` 的 `list_tools` 也显示它；不设则是 `miaoda-app`，谁看都不知道是哪个应用。取材于本 MCP 做什么（差旅审批 → `travel-approval`，库存查询 → `inventory`），小写字母 + 数字 + `-`／`_`，两三个词以内。

其余项一般不动。`requireUser` 保持默认 `true`。零工具、零资源、无应用 Skill 时端点返回 404，这是正常状态不是故障。
