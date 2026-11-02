---
name: server-contacts-contract
description: "Use when server/NestJS/OpenAPI code needs display info for known Miaoda user IDs via AuthNPaasService.listUsersByIds. Covers MiaodaUserInfo fields, I18nText name, ordered/null results, and non-triggering boundaries."
hook: SessionStart
steering: true
steering-topic: server_contacts_contract
match-template-name: nestjs-react-fullstack
---

# 服务端按 ID 查人合同

仅在 `server/**` 中按已知妙搭用户 ID 回填姓名或头像时使用；当前登录用户、前端选择器、静态团队卡片、按关键词搜人/搜部门/搜群不触发。

- 先区分当前用户 `userId`、应用 `appId` 与人员 ID；`listUsersByIds(ids)` 不要求当前用户，但要求请求上下文已有非空 `appId`。匿名 / OpenAPI 入口不得仅凭人员 ID 假定具备应用上下文，也不得凭空补身份头。
- 仅在确认非空 `appId` 后，从 `@lark-apaas/fullstack-nestjs-core` 注入 `AuthNPaasService` 并调用 `listUsersByIds(ids)`；不要自建 provider、直连平台接口、复用应用用户 service 或从库表 join 人名头像。
- 入参是 `miaoda_user_id`；返回 `(MiaodaUserInfo | null)[]`，与 `ids` 等长同序；用 `ids[i]` 或 `user.miaodaUserID` 建 Map，对 `null` 保留空展示，不要丢项错位。
- `MiaodaUserInfo` 只有 `miaodaUserID`、`name`、`avatar`；没有 `userId` / `userName`、邮箱、手机号、工号、部门。
- `name` 是 I18nText，不是字符串；展示名取 `user?.name?.zh_cn ?? user?.name?.en_us ?? ''`。
- 未在 `node_modules` 或 grep 搜到类型时，不要猜字段；平台错误会抛异常。公开匿名接口不得让人员补全失败拖挂主体响应：字段允许缺省时用可观测降级并保持列表/详情可读；字段不可缺省时调整接口合同或入口，不能伪造姓名。
