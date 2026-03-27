# cc-wechat

用微信控制 Claude Code。扫码即用，不需要 OpenClaw。

```
微信 → 腾讯 iLink API → MCP Server (long-poll) → Claude Code
                       ← sendMessage              ← reply tool
```

底层直接调用腾讯的 iLink Bot API，不依赖 OpenClaw。

## 前提

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.80+
- Node.js >= 22
- 微信（iOS / Android / Mac / Windows 均可扫码）

## 快速开始

### 1. 安装微信插件

    npx cc-wechat@latest install

这会：
1. 注册 MCP server 到 Claude Code（user 级别）
2. 在终端显示二维码，微信扫码登录
3. 打印启动命令

### 2. 启用 Channels 功能（如遇 "Channels are not currently available"）

Claude Code 的 Channels 功能受服务端灰度控制，部分用户需要 patch 才能使用：

    npx cc-channel-patch@latest

- 全平台支持：Windows / macOS / Linux / WSL
- 全安装方式：exe 安装版、npm 安装版（自动检测）
- 正则匹配，适配所有 CC 版本，无需手动更新
- 如果 CC 正在运行会生成 `.patched` 文件，按提示手动替换即可
- 恢复原版：`npx cc-channel-patch unpatch`

### 3. 启动

    claude --dangerously-load-development-channels server:wechat-channel

### 手动安装（替代方式）

    npm i -g cc-wechat
    claude mcp add -s user wechat-channel -- npx -y cc-wechat@latest
    npx cc-wechat login
    claude --dangerously-load-development-channels server:wechat-channel

## 使用

登录后，在微信里发消息，Claude Code 会实时收到并处理。Claude 通过 reply 工具回复，消息会出现在你的微信对话里。

支持发送图片、视频和文件（通过 reply 工具的 media 参数）。

### 重新登录

    npx cc-wechat login

### 在 Claude Code 中登录

如果已经在 Claude Code 中，直接用 login 工具扫码。

## cc-channel-patch（独立补丁包）

不需要微信 Channel，只想启用 Channels 功能（用于 Telegram/Discord 等其他 Channel 插件）：

    npx cc-channel-patch@latest

这是一个独立的 npm 包，零依赖，一行命令。补丁内容：

| 补丁点 | 说明 |
|--------|------|
| tengu_harbor feature flag | 绕过 Anthropic 的灰度开关 |
| Channel gate auth | 跳过 accessToken 认证检查（代理用户需要）|
| UI notice | 消除 "Channels are not currently available" 提示 |

CC 更新后可能需要重新 patch。

## 工作原理

直接调用腾讯的 iLink Bot API（7 个 HTTP 接口）：

| API | 功能 |
|-----|------|
| get_bot_qrcode | 获取登录二维码 |
| get_qrcode_status | 轮询扫码状态 |
| getupdates | 长轮询收消息（35s 超时） |
| sendmessage | 发送消息 |
| sendtyping | 打字状态指示 |
| getconfig | 获取 typing ticket |
| getuploadurl | 获取 CDN 上传签名（媒体发送）|

## 多账号（项目级绑定）

通过 `WECHAT_PROFILE` 环境变量，不同项目可以绑定不同的微信号：

```json
// 项目 .mcp.json
{
  "mcpServers": {
    "wechat-channel": {
      "command": "npx",
      "args": ["-y", "cc-wechat@latest"],
      "env": { "WECHAT_PROFILE": "work" }
    }
  }
}
```

每个 profile 独立存储凭证和会话：

```
~/.claude/channels/wechat/
├── default/           # 默认账号（未设 WECHAT_PROFILE 时使用）
│   ├── account.json
│   └── sync-buf.txt
├── work/              # WECHAT_PROFILE=work
│   ├── account.json
│   └── sync-buf.txt
└── personal/          # WECHAT_PROFILE=personal
    ├── account.json
    └── sync-buf.txt
```

- 全局 `claude.json` 的配置作为默认账号，不需要设 `WECHAT_PROFILE`
- 项目 `.mcp.json` 中声明同名 `wechat-channel` 会覆盖全局配置
- 新 profile 首次使用需扫码登录（在 CC 中调用 login 工具，或命令行 `WECHAT_PROFILE=work npx cc-wechat login`）

## 状态文件

    ~/.claude/channels/wechat/<profile>/
    ├── account.json     # 登录凭证
    └── sync-buf.txt     # 消息同步游标

## 限制

- 权限审批仍需在终端（Claude Code 的固有限制）
- 语音消息仅提取转写文本
- Session 会过期，需重新扫码
- 需要用户先发消息（context_token 按消息发放）
- 部分模型（如 GLM-4.7）不支持图片输入，发送图片时需使用支持 vision 的模型

## 鸣谢

- npm包的patch由linuxdo哈雷佬@Haleclipse率先发布的方式修改而来
- 学AI上[Linux.do](https://linux.do)

## License

MIT
