#!/usr/bin/env node
/**
 * cc-wechat 补丁工具
 * 绕过 Claude Code 的 Channels 云控检查（tengu_harbor feature flag + accessToken auth）
 * 用法：node dist/patch.js 或 npx cc-wechat patch
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

// 补丁定义：[特征字符串, 替换字符串, 说明]
const PATCHES: Array<[string, string, string]> = [
  // 1. Channels feature flag 云控
  [
    'function PaH(){return lA("tengu_harbor",!1)}',
    'function PaH(){return                   !0 }',
    'Channels feature flag (tengu_harbor)',
  ],
  // 2. S1_ gate auth 检查
  [
    'if(!yf()?.accessToken)',
    'if(        false     )',
    'Channel gate accessToken check',
  ],
  // 3. UI 层 noAuth 检查
  [
    'noAuth:!yf()?.accessToken',
    'noAuth:         false    ',
    'UI noAuth display check',
  ],
];

/** 查找 claude.exe 路径 */
function findClaudeExe(): string | null {
  const candidates = [
    path.join(homedir(), '.local', 'bin', 'claude.exe'),
    path.join(homedir(), '.local', 'bin', 'claude'),
    // npm 全局安装
    path.join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function patch(): void {
  console.log('\n  cc-wechat patch — Claude Code Channels 补丁\n');

  const exePath = findClaudeExe();
  if (!exePath) {
    console.error('  找不到 Claude Code。请确认已安装。');
    process.exit(1);
  }
  console.log(`  目标: ${exePath}`);

  // 读取二进制
  const buf = fs.readFileSync(exePath);
  let totalPatched = 0;
  let alreadyPatched = 0;

  for (const [original, replacement, desc] of PATCHES) {
    if (original.length !== replacement.length) {
      console.error(`  错误: "${desc}" 长度不匹配 (${original.length} vs ${replacement.length})`);
      process.exit(1);
    }

    const origBuf = Buffer.from(original);
    const patchBuf = Buffer.from(replacement);

    // 搜索所有出现位置
    let pos = 0;
    let count = 0;
    let alreadyCount = 0;

    while (true) {
      const idx = buf.indexOf(origBuf, pos);
      if (idx === -1) break;
      patchBuf.copy(buf, idx);
      count++;
      pos = idx + 1;
    }

    // 检查是否已经 patch 过
    pos = 0;
    while (true) {
      const idx = buf.indexOf(patchBuf, pos);
      if (idx === -1) break;
      alreadyCount++;
      pos = idx + 1;
    }

    if (count > 0) {
      console.log(`  [PATCH] ${desc}: ${count} 处已修补`);
      totalPatched += count;
    } else if (alreadyCount > 0) {
      console.log(`  [SKIP]  ${desc}: 已修补过 (${alreadyCount} 处)`);
      alreadyPatched += alreadyCount;
    } else {
      console.log(`  [WARN]  ${desc}: 未找到特征字符串（CC 版本可能已更新）`);
    }
  }

  if (totalPatched === 0 && alreadyPatched > 0) {
    console.log('\n  所有补丁已生效，无需操作。\n');
    return;
  }

  if (totalPatched === 0) {
    console.error('\n  未找到任何可修补的位置。Claude Code 版本可能不兼容。\n');
    process.exit(1);
  }

  // 备份
  const backupPath = exePath + '.bak';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(exePath, backupPath);
    console.log(`  [BACKUP] 已备份到 ${backupPath}`);
  }

  // 写入 — 先写临时文件再替换
  const tmpPath = exePath + '.patched';
  fs.writeFileSync(tmpPath, buf);

  console.log(`\n  补丁已写入 ${tmpPath}`);
  console.log('  请关闭所有 Claude Code 进程后手动替换：\n');

  if (process.platform === 'win32') {
    const dir = path.dirname(exePath);
    const name = path.basename(exePath);
    console.log(`  cd ${dir}`);
    console.log(`  Move-Item ${name} ${name}.old -Force`);
    console.log(`  Move-Item ${name}.patched ${name} -Force\n`);
  } else {
    console.log(`  mv "${exePath}" "${exePath}.old"`);
    console.log(`  mv "${tmpPath}" "${exePath}"\n`);
  }

  console.log(`  恢复方法: 用 ${backupPath} 替换即可\n`);
}

function unpatch(): void {
  console.log('\n  cc-wechat unpatch — 恢复原始 Claude Code\n');

  const exePath = findClaudeExe();
  if (!exePath) {
    console.error('  找不到 Claude Code。');
    process.exit(1);
  }

  const backupPath = exePath + '.bak';
  if (!fs.existsSync(backupPath)) {
    console.error(`  未找到备份文件 ${backupPath}`);
    process.exit(1);
  }

  const tmpPath = exePath + '.restore';
  fs.copyFileSync(backupPath, tmpPath);
  console.log(`  已准备恢复文件 ${tmpPath}`);
  console.log('  请关闭所有 Claude Code 进程后手动替换：\n');

  if (process.platform === 'win32') {
    const dir = path.dirname(exePath);
    const name = path.basename(exePath);
    console.log(`  cd ${dir}`);
    console.log(`  Move-Item ${name} ${name}.patched -Force`);
    console.log(`  Move-Item ${name}.restore ${name} -Force\n`);
  } else {
    console.log(`  mv "${exePath}" "${exePath}.patched"`);
    console.log(`  mv "${tmpPath}" "${exePath}"\n`);
  }
}

// 入口
const cmd = process.argv[2];
if (cmd === 'unpatch' || cmd === 'restore') {
  unpatch();
} else {
  patch();
}
