# CodeM 建群 Webhook 服务

收到 webhook 请求后，自动创建一个飞书群聊，并把 **CodeM 机器人**、**你本人**以及**指定成员**拉进群，群名由请求动态传入。

## 依赖

- Node.js >= 18（零 npm 依赖）
- 本机已安装 `lark-cli` 并完成登录（以你的用户身份建群；`lark-cli im +chat-list --as user` 能返回即视为可用）

## 启动

```bash
cd codem-webhook-group
node server.js
# 可选配置：
# PORT=3210 HOST=0.0.0.0 WEBHOOK_TOKEN=你的密钥 node server.js
```

- `WEBHOOK_TOKEN`：设置后请求必须带 `X-Webhook-Token` 头，防止任意人调用建群。
- `CODEM_BOT_APP_ID`：默认已内置 CodeM 机器人的 app_id，一般不用改。

## 调用

```bash
curl -X POST http://127.0.0.1:3210/webhook/group \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Token: 你的密钥' \
  -d '{
    "name": "XX需求讨论组",
    "description": "由 webhook 自动创建",
    "members": ["张三", "lisi@corp.com", "ou_xxxxxxxx"],
    "include_me": true
  }'
```

- `name`：群名，必填（≤60 字）
- `members`：可选，支持**姓名 / 邮箱 / open_id 混合**；姓名会自动解析为 open_id，同名多人会取第一个精确/首个匹配并在响应 `unresolved_members` / 控制台中提示
- `include_me`：默认 `true`，把服务部署者拉进群
- 建群成功响应：

```json
{
  "ok": true,
  "chat_id": "oc_xxx",
  "chat_name": "XX需求讨论组",
  "link": "https://applink.feishu.cn/client/chat/open?openChatId=oc_xxx",
  "members_added": 3,
  "unresolved_members": []
}
```

## 进群之后

群建好后直接 `@飞书 CodeM` 发任务即可；群里 CodeM 只响应被 @ 的消息，按发起人路由会话。

## 注意事项

- 服务以本机 lark-cli 登录身份执行建群，群 owner 是你本人；请确保 `WEBHOOK_TOKEN` 已设置再暴露到内网。
- 姓名解析走通讯录搜索，只能搜到你有权限看到的用户；解析失败的成员会列在 `unresolved_members`，可改传 open_id 重试。
