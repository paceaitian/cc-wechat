# cc-channel-patch

一键启用 Claude Code Channels 功能。

适用于使用代理认证（非 claude.ai 直接登录）的用户，绕过 Anthropic 的 `tengu_harbor` 云控开关和 `accessToken` 检查。

## 用法

```bash
# 修补（启用 Channels）
npx cc-channel-patch

# 恢复原始版本
npx cc-channel-patch unpatch
```

## 原理

Claude Code v2.1.80+ 内置了 Channels 功能（通过 MCP Server 桥接外部消息平台），但受服务端 feature flag 灰度控制。此补丁修改 3 处检查：

1. `PaH()` — `tengu_harbor` feature flag 始终返回 true
2. `S1_ gate` — 跳过 `accessToken` 认证检查
3. `xl1() UI` — 跳过 UI 层的 noAuth 提示

补丁按特征字符串搜索（非硬编码偏移量），CC 小版本更新后通常仍可用。

## 注意事项

- 如果 Claude Code 正在运行，补丁无法直接写入（文件被锁），会生成 `.patched` 文件并提示手动替换
- 原始文件自动备份到 `.bak`
- CC 大版本更新后可能需要重新 patch
- `npx cc-channel-patch unpatch` 可随时恢复

## License

MIT
