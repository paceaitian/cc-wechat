#!/usr/bin/env node
/**
 * cc-wechat 补丁工具
 * 绕过 Claude Code 的 Channels 云控检查（tengu_harbor feature flag + accessToken auth）
 * 用法：node dist/patch.js 或 npx cc-wechat patch
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

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

/** 查找 claude 可执行文件路径 */
function findClaudeExe(): string | null {
  const home = homedir();

  // 1. which/where（最可靠）
  try {
    const cmd = process.platform === 'win32' ? 'where claude 2>nul' : 'which claude 2>/dev/null';
    const p = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0].trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* ignore */ }

  // 2. 常见安装路径
  const candidates = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(home, 'scoop', 'shims', 'claude.exe'),
    path.join('C:', 'ProgramData', 'chocolatey', 'bin', 'claude.exe'),
    path.join('C:', 'Program Files', 'Claude Code', 'claude.exe'),
    path.join('C:', 'Program Files (x86)', 'Claude Code', 'claude.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'claude-code', 'claude.exe'),
    path.join(home, 'AppData', 'Local', 'claude-code', 'claude.exe'),
    path.join(home, 'AppData', 'Local', 'AnthropicClaude', 'claude.exe'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
    '/snap/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // 3. npm global prefix 动态查找
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (prefix) {
      for (const c of [path.join(prefix, 'claude.cmd'), path.join(prefix, 'claude'), path.join(prefix, 'bin', 'claude')]) {
        if (fs.existsSync(c)) return c;
      }
    }
  } catch { /* ignore */ }

  // 4. PATH 逐目录搜索（兜底）
  const pathDirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  const exeNames = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of pathDirs) {
    for (const name of exeNames) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
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
