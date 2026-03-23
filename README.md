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

- 支持 Windows/macOS/Linux
- 支持 exe 安装版和 npm 安装版（自动检测）
- 如果 CC 正在运行会生成 `.patched` 文件，按提示手动替换即可
- 恢复原版：`npx cc-channel-patch unpatch`

### 3. 启动

    claude --dangerously-load-development-channels server:wechat-channel

### 手动安装（替代方式）

    npm i -g cc-wechat
    claude mcp add -s user wechat-channel node $(which cc-wechat-server)
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

## 状态文件

    ~/.claude/channels/wechat/
    ├── account.json     # 登录凭证
    └── sync-buf.txt     # 消息同步游标

## 限制

- 仅支持单账号
- 权限审批仍需在终端（Claude Code 的固有限制）
- 语音消息仅提取转写文本
- Session 会过期，需重新扫码
- 需要用户先发消息（context_token 按消息发放）

##友链

- npm包的patch由linuxdo哈雷佬@Haleclipse率先发布的方式修改而来
- 学AI上Linux.do 

## License

MIT
