#!/usr/bin/env node
/**
 * cc-wechat CLI 入口 — install/login/status/help 命令
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginTerminal } from './auth.js';
import { saveAccount, getActiveAccount } from './store.js';

// ─── help ────────────────────────────────────────────

/** 打印帮助信息 */
function help(): void {
  console.log(`
  cc-wechat — 微信 Claude Code Channel 插件

  用法: npx cc-wechat <命令>

  命令:
    install   注册 MCP server + 扫码登录
    patch     修补 Claude Code 以启用 Channels 功能
    unpatch   恢复原始 Claude Code
    login     重新扫码登录
    status    查看连接状态
    help      显示帮助
`);
}

// ─── install ─────────────────────────────────────────

/** 注册 MCP server + 扫码登录 */
async function install(): Promise<void> {
  console.log('\n🔧 cc-wechat 安装向导\n');

  // [1/3] 注册 MCP server
  console.log('[1/3] 注册 MCP server...');
  const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.js');

  try {
    execSync('claude mcp add -s user wechat-channel node ' + serverPath, { stdio: 'pipe' });
    console.log('  ✅ MCP server 已注册');
  } catch {
    try {
      execSync('claude mcp remove wechat-channel', { stdio: 'pipe' });
      execSync('claude mcp add -s user wechat-channel node ' + serverPath, { stdio: 'pipe' });
      console.log('  ✅ MCP server 已重新注册');
    } catch (e) {
      console.error('  ❌ MCP server 注册失败:', (e as Error).message);
    }
  }

  // [2/3] 微信扫码登录
  console.log('\n[2/3] 微信扫码登录...');
  const existing = getActiveAccount();
  if (existing) {
    console.log('  ⏭️  已有登录账号，跳过扫码。如需重新登录请运行: npx cc-wechat login');
  } else {
    const { token, accountId, baseUrl } = await loginTerminal();
    saveAccount({
      token,
      baseUrl: baseUrl ?? '',
      botId: accountId.replace(/@/g, '-').replace(/\./g, '-'),
      savedAt: new Date().toISOString(),
    });
    console.log('  ✅ 登录成功');
  }

  // [3/3] 完成
  console.log('\n[3/3] 安装完成！');
  console.log('\n启动 Claude Code 时使用:');
  console.log('  claude --dangerously-load-development-channels server:wechat-channel\n');
}

// ─── login ───────────────────────────────────────────

/** 重新扫码登录 */
async function login(): Promise<void> {
  console.log('\n🔑 微信扫码登录\n');
  const { token, accountId, baseUrl } = await loginTerminal();
  saveAccount({
    token,
    baseUrl: baseUrl ?? '',
    botId: accountId.replace(/@/g, '-').replace(/\./g, '-'),
    savedAt: new Date().toISOString(),
  });
  console.log('\n✅ 登录成功！账号已保存。\n');
}

// ─── status ──────────────────────────────────────────

/** 查看连接状态 */
function status(): void {
  const account = getActiveAccount();
  if (account) {
    console.log('\n📋 当前账号状态:\n');
    console.log(`  botId:   ${account.botId.substring(0, 12)}...`);
    console.log(`  baseUrl: ${account.baseUrl}`);
    console.log(`  savedAt: ${account.savedAt}\n`);
  } else {
    console.log('\n❌ 尚未登录。请运行: npx cc-wechat install\n');
  }
}

// ─── main ────────────────────────────────────────────

const command = process.argv[2];
switch (command) {
  case 'install': case 'setup': install(); break;
  case 'login': login(); break;
  case 'patch': case 'unpatch': {
    // 动态导入 patch 模块，传递命令
    process.argv[2] = command;
    await import('./patch.js');
    break;
  }
  case 'status': status(); break;
  case 'help': case '--help': case '-h': case undefined: help(); break;
  default: console.error(`未知命令: ${command}`); help(); process.exit(1);
}
