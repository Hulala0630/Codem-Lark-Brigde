# 接入：把本应用的 MCP 连到外部客户端

适用于「应用已经有 MCP 工具，用户要在自己的 Agent（Claude Code / Codex / 其它 MCP 客户端）里调用它」。开发态自己验工具走 `debugging.md` 的 `mcp_inspect`，与本文无关。

**产出是一条用户复制即可执行的命令，不是操作说明。**连接地址由你查出来填好，不要让用户自己去界面上找。

## 取连接地址

```bash
lark-cli apps +mcp-get --app-id "$app_id" --format pretty
```

stdout 只有一条连接地址（形如 `https://bytedance.feishu.link/mcp/app_17ej3z4w7zr`），原样填进下面的模板，不改写、不拼接。

该命令同时会开启本应用的线上 MCP；重复调用返回同一结果。没开启过的应用不跑它就连不上，所以即使用户说自己知道地址，也先跑一次。

## 服务名你来起

`<名字>` 会成为客户端里的工具前缀（`mcp__<名字>__<工具名>`），用户此后每次看到这些工具都要读它。**直接给一个贴合本 MCP 用途的名字，不要问用户要。**

- 取材于这个 MCP 做什么：差旅审批叫 `travel-approval`，库存查询叫 `inventory`
- 小写字母 + 数字 + `-` 或 `_`，两三个词以内；不要空格、点号、中文
- 同一台机器内唯一。用户可能已经接过别的妙搭应用，泛指类的名字会撞上
- server 声明的 `serverName` 一眼能看出这个 MCP 做什么时，直接用它，保持开发态与客户端一致
- 给完顺带说一句名字可改，但不要停下来等用户确认

## 落到客户端

把连接地址与上面定好的名字填进对应模板，整条给用户。

**Claude Code**

```bash
claude mcp add --transport http <名字> <连接地址>
claude mcp login <名字>
```

**Codex**

```bash
codex mcp add <名字> --url "<连接地址>"
codex mcp login <名字>
```

## 为什么是两条命令

第一条只登记连接地址；第二条在浏览器里完成一次飞书授权，客户端拿到用户令牌并自行续期。工具以授权用户的身份执行，不 `login` 就是 401。

`login` 只服务 HTTP 传输。用户若报「only supported for streamable HTTP servers」，是配置成了本地 stdio 形态，按上面的模板改成 `url` 形式。

## 两件命令解决不了的事

| 条件 | 不满足时的表现 |
|---|---|
| 应用已发布 | 连接失败 |
| 调用人在应用可用范围内 | 403，与授权是否成功无关 |

这两条你查不到也改不了，连不上时按下表对号，属于这两类就直接告诉用户去处理，不要反复重试。

## 排错

| 现象 | 原因 | 动作 |
|---|---|---|
| 401，reason `lark_oauth_client_mismatch` | 授权用的 client_id 与服务端元数据不一致 | 清掉客户端授权缓存重新 `login` |
| 401，reason `lark_oauth_conf_unavailable` | 平台侧配置问题 | 告知用户找平台同学，不要让他反复重试 |
| 401，无 reason | 没执行 `login`，或授权已失效 | 重新 `login` |
| 403 `user is not in the visible scope of this app` | 不在可用范围，或授权账号不属于应用租户 | 前者找负责人放开范围；后者换应用租户内的账号授权 |
| 404 | 连接地址没原样使用 `+mcp-get` 的输出；或零工具零资源无应用 Skill（SDK 此时也返回 404） | 重跑 `+mcp-get` 整段替换地址；后者是正常状态不是故障，确认本应用确实注册了工具 |
| POST 被拒，CSRF 相关 | 旧模板应用对 POST 有 CSRF 双提交校验 | 平台侧已知未收口项，告知用户，不在客户端侧拼 cookie 绕 |
