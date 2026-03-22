#!/usr/bin/env node
/**
 * cc-channel-patch — 一键启用 Claude Code Channels
 *
 * 绕过 Anthropic 的 tengu_harbor 云控 + accessToken 认证检查，
 * 使代理认证模式下也能使用 --dangerously-load-development-channels。
 *
 * 用法：npx cc-channel-patch          # 修补
 *       npx cc-channel-patch unpatch   # 恢复
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

// ─── 补丁定义 ──────────────────────────────────────────
// [原始字符串, 替换字符串, 说明]
// 长度必须完全一致（二进制原地替换）

const PATCHES = [
  [
    'function PaH(){return lA("tengu_harbor",!1)}',
    'function PaH(){return                   !0 }',
    'Channels feature flag (tengu_harbor)',
  ],
  [
    'if(!yf()?.accessToken)',
    'if(        false     )',
    'Channel gate auth check',
  ],
  [
    'noAuth:!yf()?.accessToken',
    'noAuth:         false    ',
    'UI noAuth display check',
  ],
];

// ─── 查找 claude 可执行文件 ──────────────────────────────

function findClaude() {
  // 1. which/where 查找
  try {
    const p = execSync(process.platform === 'win32' ? 'where claude' : 'which claude', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n')[0].trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* ignore */ }

  // 2. 常见路径
  const home = homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ─── patch ──────────────────────────────────────────────

function patch() {
  console.log('\n  cc-channel-patch — 启用 Claude Code Channels\n');

  const exePath = findClaude();
  if (!exePath) {
    console.error('  找不到 Claude Code 可执行文件。');
    console.error('  请确认已安装 Claude Code 并在 PATH 中。\n');
    process.exit(1);
  }
  console.log(`  目标: ${exePath}`);

  const buf = fs.readFileSync(exePath);
  let patched = 0;
  let skipped = 0;
  let missing = 0;

  for (const [original, replacement, desc] of PATCHES) {
    if (original.length !== replacement.length) {
      console.error(`  致命错误: "${desc}" 补丁长度不匹配`);
      process.exit(1);
    }

    const origBuf = Buffer.from(original);
    const patchBuf = Buffer.from(replacement);

    // 搜索并替换所有出现
    let pos = 0;
    let count = 0;
    while (true) {
      const idx = buf.indexOf(origBuf, pos);
      if (idx === -1) break;
      patchBuf.copy(buf, idx);
      count++;
      pos = idx + 1;
    }

    // 检查是否已 patch
    let alreadyCount = 0;
    pos = 0;
    while (true) {
      const idx = buf.indexOf(patchBuf, pos);
      if (idx === -1) break;
      alreadyCount++;
      pos = idx + 1;
    }

    if (count > 0) {
      console.log(`  ✅ ${desc} — ${count} 处已修补`);
      patched += count;
    } else if (alreadyCount > 0) {
      console.log(`  ⏭️  ${desc} — 已修补 (${alreadyCount} 处)`);
      skipped += alreadyCount;
    } else {
      console.log(`  ⚠️  ${desc} — 未找到 (CC 版本可能不兼容)`);
      missing++;
    }
  }

  if (patched === 0 && skipped > 0) {
    console.log('\n  所有补丁已生效，无需操作。\n');
    return;
  }

  if (patched === 0) {
    console.error('\n  未找到可修补位置。Claude Code 版本可能不兼容。\n');
    process.exit(1);
  }

  // 备份
  const backupPath = exePath + '.bak';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(exePath, backupPath);
    console.log(`\n  📦 已备份: ${backupPath}`);
  }

  // 尝试直接写入
  try {
    fs.writeFileSync(exePath, buf);
    console.log('\n  ✅ 补丁已直接写入，立即生效！\n');
  } catch {
    // 文件被锁（CC 正在运行），写到临时文件
    const tmpPath = exePath + '.patched';
    fs.writeFileSync(tmpPath, buf);
    console.log(`\n  ⚠️  Claude Code 正在运行，无法直接写入。`);
    console.log(`  补丁已保存到: ${tmpPath}\n`);
    console.log('  请退出所有 Claude Code 后执行:\n');

    if (process.platform === 'win32') {
      const dir = path.dirname(exePath);
      const name = path.basename(exePath);
      console.log(`    cd "${dir}"`);
      console.log(`    Move-Item ${name} ${name}.old -Force`);
      console.log(`    Move-Item ${name}.patched ${name} -Force`);
    } else {
      console.log(`    mv "${exePath}" "${exePath}.old"`);
      console.log(`    mv "${tmpPath}" "${exePath}"`);
    }
    console.log();
  }

  console.log('  恢复方法: npx cc-channel-patch unpatch\n');
}

// ─── unpatch ────────────────────────────────────────────

function unpatch() {
  console.log('\n  cc-channel-patch unpatch — 恢复原始 Claude Code\n');

  const exePath = findClaude();
  if (!exePath) {
    console.error('  找不到 Claude Code。\n');
    process.exit(1);
  }

  const backupPath = exePath + '.bak';
  if (!fs.existsSync(backupPath)) {
    console.error(`  未找到备份文件: ${backupPath}`);
    console.error('  无法恢复（可能从未 patch 过）。\n');
    process.exit(1);
  }

  try {
    fs.copyFileSync(backupPath, exePath);
    console.log('  ✅ 已恢复原始 Claude Code。\n');
  } catch {
    const tmpPath = exePath + '.restore';
    fs.copyFileSync(backupPath, tmpPath);
    console.log('  ⚠️  Claude Code 正在运行，无法直接恢复。');
    console.log(`  恢复文件已保存到: ${tmpPath}\n`);
    console.log('  请退出所有 Claude Code 后执行:\n');

    if (process.platform === 'win32') {
      const dir = path.dirname(exePath);
      const name = path.basename(exePath);
      console.log(`    cd "${dir}"`);
      console.log(`    Move-Item ${name} ${name}.patched -Force`);
      console.log(`    Move-Item ${name}.restore ${name} -Force`);
    } else {
      console.log(`    mv "${exePath}" "${exePath}.patched"`);
      console.log(`    mv "${tmpPath}" "${exePath}"`);
    }
    console.log();
  }
}

// ─── 入口 ───────────────────────────────────────────────

const cmd = process.argv[2];
if (cmd === 'unpatch' || cmd === 'restore') {
  unpatch();
} else if (cmd === '--help' || cmd === '-h') {
  console.log(`
  cc-channel-patch — 启用 Claude Code Channels 功能

  用法:
    npx cc-channel-patch           修补 Claude Code
    npx cc-channel-patch unpatch   恢复原始版本
    npx cc-channel-patch --help    显示帮助
  `);
} else {
  patch();
}
