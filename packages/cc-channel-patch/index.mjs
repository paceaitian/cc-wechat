#!/usr/bin/env node
/**
 * cc-channel-patch — 一键启用 Claude Code Channels
 *
 * 双模式补丁：
 * - 二进制模式（exe）：按固定字符串搜索替换
 * - AST 模式（cli.js / npm 安装）：用 acorn 解析 JS AST，按语义特征定位替换
 *
 * 用法：npx cc-channel-patch          # 修补
 *       npx cc-channel-patch unpatch   # 恢复
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

// ─── 二进制模式补丁定义（通用正则匹配）────────────────────────
// 使用正则匹配函数结构，不依赖具体函数名，适配所有平台和 CC 版本
const BINARY_REGEX_PATCHES = [
  {
    desc: 'Channels feature flag (tengu_harbor)',
    // 匹配: function XXX(){return YYY("tengu_harbor",!1)}
    regex: /function ([\w$]+)\(\)\{return ([\w$]+)\("tengu_harbor",!1\)\}/,
    buildReplacement(m) {
      const prefix = `function ${m[1]}(){return `;
      return prefix + '!0 '.padStart(m[0].length - prefix.length - 1) + '}';
    },
    isPatched: (text) => !text.includes('"tengu_harbor",!1'),
  },
  {
    desc: 'Channel gate auth check',
    // 匹配: if(!XXX()?.accessToken)
    regex: /if\(!([\w$]+)\(\)\?\.accessToken\)/,
    buildReplacement(m) {
      const inner = m[0].length - 4; // "if(" + ")"
      const pad = Math.floor((inner - 5) / 2);
      return 'if(' + ' '.repeat(pad) + 'false' + ' '.repeat(inner - 5 - pad) + ')';
    },
    isPatched: (text) => /if\(\s{2,}false\s+\)/.test(text),
  },
  {
    desc: 'UI noAuth display check',
    // 匹配: noAuth:!XXX()?.accessToken
    regex: /noAuth:!([\w$]+)\(\)\?\.accessToken/,
    buildReplacement(m) {
      const inner = m[0].length - 7; // "noAuth:"
      const pad = Math.floor((inner - 5) / 2);
      return 'noAuth:' + ' '.repeat(pad) + 'false' + ' '.repeat(inner - 5 - pad);
    },
    isPatched: (text) => /noAuth:\s{2,}false/.test(text),
  },
];

// ─── 查找 claude 可执行文件 ──────────────────────────────

function findClaude() {
  try {
    const cmd = process.platform === 'win32' ? 'where claude 2>nul' : 'which claude 2>/dev/null';
    const p = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0].trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* ignore */ }

  const home = homedir();
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
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (prefix) {
      for (const c of [
        path.join(prefix, 'claude.cmd'), path.join(prefix, 'claude'),
        path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        path.join(prefix, 'bin', 'claude'),
      ]) { if (fs.existsSync(c)) return c; }
    }
  } catch { /* ignore */ }

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

// ─── 解析到真正的可 patch 文件 ─────────────────────────────

function resolvePatchTarget(claudePath) {
  const ext = path.extname(claudePath).toLowerCase();
  const dir = path.dirname(claudePath);

  if (ext === '.exe') return claudePath;
  const stat = fs.statSync(claudePath);

  // 大文件（>1MB）且文件头是二进制 → 直接作为目标
  if (stat.size > 1_000_000) {
    if (isBinaryFile(claudePath)) return claudePath;
  }

  // 尝试从同级 node_modules 找 cli.js
  const cliJs = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (fs.existsSync(cliJs)) return cliJs;

  // 读取文件内容，尝试解析 shim/wrapper 中的真实路径
  try {
    const content = fs.readFileSync(claudePath, 'utf-8');

    // .cmd shim 或 shell wrapper 中可能包含 cli.js 路径
    const cliJsMatch = content.match(/["']?([^\s"']*node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js)["']?/);
    if (cliJsMatch) {
      // 尝试绝对路径
      if (fs.existsSync(cliJsMatch[1])) return cliJsMatch[1];
      // 尝试相对于 dir 解析
      const resolved = path.resolve(dir, cliJsMatch[1]);
      if (fs.existsSync(resolved)) return resolved;
    }

    // npm shim 通常引用 npm prefix 下的 node_modules
    try {
      const prefix = execSync('npm config get prefix', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (prefix) {
        const prefixCliJs = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        if (fs.existsSync(prefixCliJs)) return prefixCliJs;
      }
    } catch { /* ignore */ }
  } catch { /* 非文本文件，忽略 */ }

  if (ext === '.cmd') {
    try {
      const content = fs.readFileSync(claudePath, 'utf-8');
      const match = content.match(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js/);
      if (match) {
        const resolved = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        if (fs.existsSync(resolved)) return resolved;
      }
    } catch { /* ignore */ }
  }

  try {
    const realPath = fs.realpathSync(claudePath);
    if (realPath !== claudePath) return resolvePatchTarget(realPath);
  } catch { /* ignore */ }

  return claudePath;
}

// ─── 判断文件类型 ──────────────────────────────────────────

function isBinaryFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.exe') return true;
  // 检查文件头是否是 PE/ELF/Mach-O 二进制
  const header = Buffer.alloc(4);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);
  // PE: MZ, ELF: \x7fELF, Mach-O: \xfe\xed\xfa\xce / \xcf\xfa\xed\xfe
  if (header[0] === 0x4D && header[1] === 0x5A) return true; // MZ (PE)
  if (header[0] === 0x7F && header[1] === 0x45) return true; // ELF
  if (header[0] === 0xFE && header[1] === 0xED) return true; // Mach-O
  if (header[0] === 0xCF && header[1] === 0xFA) return true; // Mach-O 64
  return false;
}

// ─── 二进制模式 patch ──────────────────────────────────────

function patchBinary(exePath) {
  console.log('  模式: 二进制正则匹配\n');
  const buf = fs.readFileSync(exePath);
  const text = buf.toString('latin1');
  let patched = 0, skipped = 0;

  for (const { desc, regex, buildReplacement, isPatched } of BINARY_REGEX_PATCHES) {
    const match = text.match(regex);
    if (match) {
      const original = match[0];
      const replacement = buildReplacement(match);
      if (original.length !== replacement.length) {
        console.error(`  致命错误: "${desc}" 补丁长度不匹配 (${original.length} vs ${replacement.length})`);
        process.exit(1);
      }
      const origBuf = Buffer.from(original, 'latin1');
      const patchBuf = Buffer.from(replacement, 'latin1');
      let pos = 0, count = 0;
      while (true) {
        const idx = buf.indexOf(origBuf, pos);
        if (idx === -1) break;
        patchBuf.copy(buf, idx);
        count++;
        pos = idx + 1;
      }
      console.log(`  ✅ ${desc} — ${count} 处已修补 (${match[1]})`);
      patched += count;
    } else if (isPatched(text)) {
      console.log(`  ⏭️  ${desc} — 已修补`);
      skipped++;
    } else {
      console.log(`  ⚠️  ${desc} — 未找到`);
    }
  }

  if (patched === 0 && skipped > 0) { console.log('\n  所有补丁已生效，无需操作。\n'); return; }
  if (patched === 0) { console.error('\n  未找到可修补位置。\n'); process.exit(1); }

  writeResult(exePath, buf);
}

// ─── AST 模式 patch（npm cli.js）──────────────────────────

async function patchAst(exePath) {
  console.log('  模式: AST 语义分析\n');

  // 动态下载 acorn（不加依赖）
  const acornPath = path.join(homedir(), '.cache', 'cc-channel-patch', 'acorn.js');
  if (!fs.existsSync(acornPath)) {
    console.log('  下载 acorn 解析器...');
    fs.mkdirSync(path.dirname(acornPath), { recursive: true });
    try {
      const resp = await fetch('https://unpkg.com/acorn@8.14.0/dist/acorn.js');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      fs.writeFileSync(acornPath, await resp.text());
    } catch (e) {
      console.error(`  下载 acorn 失败: ${e.message}`);
      console.error('  可手动下载 https://unpkg.com/acorn@8.14.0/dist/acorn.js 到 ' + acornPath);
      process.exit(1);
    }
  }

  // 加载 acorn
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const acorn = require(acornPath);

  // 读取 cli.js
  let code = fs.readFileSync(exePath, 'utf-8');
  let shebang = '';
  if (code.startsWith('#!')) {
    const idx = code.indexOf('\n');
    shebang = code.slice(0, idx + 1);
    code = code.slice(idx + 1);
  }

  // 解析 AST
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
  } catch (e) {
    console.error(`  AST 解析失败: ${e.message}`);
    process.exit(1);
  }

  const src = (node) => code.slice(node.start, node.end);

  function findNodes(node, predicate, results = []) {
    if (!node || typeof node !== 'object') return results;
    if (predicate(node)) results.push(node);
    for (const key in node) {
      if (node[key] && typeof node[key] === 'object') {
        if (Array.isArray(node[key])) node[key].forEach(child => findNodes(child, predicate, results));
        else findNodes(node[key], predicate, results);
      }
    }
    return results;
  }

  const replacements = [];
  let patchCount = 0;

  // ── Patch 1: tengu_harbor feature flag ──
  const harborCalls = findNodes(ast, n =>
    n.type === 'CallExpression' && n.arguments?.length === 2 &&
    n.arguments[0].type === 'Literal' && n.arguments[0].value === 'tengu_harbor' &&
    n.arguments[0].value !== 'tengu_harbor_ledger'
  );

  let harborPatched = false;
  let harborCalleeName = '';
  for (const call of harborCalls) {
    harborCalleeName = src(call.callee);
    const arg = call.arguments[1];
    if (arg.type === 'UnaryExpression' && arg.operator === '!' && arg.argument.type === 'Literal' && arg.argument.value === 1) {
      replacements.push({ start: arg.start, end: arg.end, replacement: '!0', name: 'harborFlag' });
      patchCount++;
      console.log(`  ✅ tengu_harbor flag — ${harborCalleeName}("tengu_harbor", !1) → !0`);
      break;
    }
    if (arg.type === 'UnaryExpression' && arg.operator === '!' && arg.argument.type === 'Literal' && arg.argument.value === 0) {
      harborPatched = true;
      console.log('  ⏭️  tengu_harbor flag — 已修补');
      break;
    }
  }

  // ── Patch 2: channel decision function（qMq）──
  const markerLiterals = findNodes(ast, n =>
    n.type === 'Literal' && n.value === 'channels feature is not currently available'
  );

  let qMqPatched = false;
  if (markerLiterals.length > 0) {
    const markerPos = markerLiterals[0].start;
    const enclosingFuncs = findNodes(ast, n =>
      (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') &&
      n.start < markerPos && n.end > markerPos
    );
    if (enclosingFuncs.length > 0) {
      const targetFunc = enclosingFuncs.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      const funcName = targetFunc.id?.name || '(anonymous)';
      const bodyStatements = targetFunc.body.body;

      if (bodyStatements?.length > 0 && bodyStatements[0].type === 'IfStatement') {
        const firstStmt = bodyStatements[0];
        const firstSrc = src(firstStmt);
        if (firstSrc.includes('claude/channel')) {
          // 保留第一个 capability check，删除其余所有 check，直接 return register
          const capCheckSrc = src(firstStmt);
          const newBody = '{' + capCheckSrc + 'return{action:"register"}}';
          replacements.push({ start: targetFunc.body.start, end: targetFunc.body.end, replacement: newBody, name: 'qMq' });
          patchCount++;
          console.log(`  ✅ Channel decision ${funcName}() — 绕过 check 2-7，保留 capability check`);
        }
      }
    }
  } else {
    // 检查是否已 patch
    if (code.includes('claude/channel capability') && !code.includes('channels feature is not currently available')) {
      qMqPatched = true;
      console.log('  ⏭️  Channel decision — 已修补');
    }
  }

  // ── Patch 3: UI notice function（xl1/Kq_）──
  const policyProps = findNodes(ast, n =>
    n.type === 'Property' && n.key?.type === 'Identifier' && n.key.name === 'policyBlocked' &&
    n.value && src(n.value).includes('channelsEnabled')
  );

  let noticePatched = false;
  if (policyProps.length > 0) {
    const propPos = policyProps[0].start;
    const noticeFuncs = findNodes(ast, n =>
      (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') &&
      n.start < propPos && n.end > propPos
    );
    if (noticeFuncs.length > 0) {
      const noticeFunc = noticeFuncs.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      const nfName = noticeFunc.id?.name || '(anonymous)';

      // 提取 getAllowedChannels 和 formatter
      const firstCalls = findNodes(noticeFunc.body.body[0], n =>
        n.type === 'CallExpression' && n.callee?.type === 'Identifier'
      );
      const getAllowedChannels = firstCalls.length > 0 ? src(firstCalls[0]) : '$N()';

      const mapCalls = findNodes(noticeFunc, n =>
        n.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && n.callee.property?.name === 'map'
      );
      let formatter = 'naH';
      if (mapCalls.length > 0 && mapCalls[0].arguments[0]) formatter = src(mapCalls[0].arguments[0]);

      const newBody = '{let A=' + getAllowedChannels + ';let q=A.length>0?A.map(' + formatter + ').join(", "):"";return{channels:A,disabled:!1,noAuth:!1,policyBlocked:!1,list:q,unmatched:[]}}';
      replacements.push({ start: noticeFunc.body.start, end: noticeFunc.body.end, replacement: newBody, name: 'notice' });
      patchCount++;
      console.log(`  ✅ UI notice ${nfName}() — disabled/noAuth/policyBlocked 全部置 false`);
    }
  } else {
    if (code.includes('policyBlocked') && !code.includes('channelsEnabled!==!0')) {
      noticePatched = true;
      console.log('  ⏭️  UI notice — 已修补');
    }
  }

  if (patchCount === 0) {
    if (harborPatched || qMqPatched || noticePatched) {
      console.log('\n  所有补丁已生效，无需操作。\n');
      return;
    }
    console.error('\n  未找到可修补位置。Claude Code 版本可能不兼容。\n');
    process.exit(1);
  }

  // 从后往前替换（保持位置不变）
  replacements.sort((a, b) => b.start - a.start);
  let newCode = code;
  for (const r of replacements) {
    newCode = newCode.slice(0, r.start) + r.replacement + newCode.slice(r.end);
  }

  // 验证
  if (!newCode.includes('claude/channel')) {
    console.error('  验证失败: capability check 未保留');
    process.exit(1);
  }

  writeResult(exePath, Buffer.from(shebang + newCode, 'utf-8'));
}

// ─── 写入结果 ──────────────────────────────────────────────

function writeResult(exePath, buf) {
  const backupPath = exePath + '.bak';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(exePath, backupPath);
    console.log(`\n  📦 已备份: ${backupPath}`);
  }

  try {
    fs.writeFileSync(exePath, buf);
    // 保留执行权限（Linux/macOS）
    if (process.platform !== 'win32') {
      try { fs.chmodSync(exePath, 0o755); } catch { /* ignore */ }
    }
    // macOS 需要重新签名（ad-hoc），否则 Gatekeeper 阻止运行
    if (process.platform === 'darwin') {
      try {
        execSync(`codesign --force --sign - "${exePath}"`, { stdio: 'pipe' });
        console.log('\n  ✅ 补丁已直接写入 + codesign 重签名，立即生效！\n');
      } catch {
        console.log('\n  ✅ 补丁已直接写入！');
        console.log('  ⚠️  codesign 重签名失败，请手动执行:');
        console.log(`      codesign --force --sign - "${exePath}"\n`);
      }
    } else {
      console.log('\n  ✅ 补丁已直接写入，立即生效！\n');
    }
  } catch {
    const tmpPath = exePath + '.patched';
    fs.writeFileSync(tmpPath, buf);
    // 保留执行权限（Linux/macOS）
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tmpPath, 0o755); } catch { /* ignore */ }
    }
    // macOS 需要重新签名
    if (process.platform === 'darwin') {
      try {
        execSync(`codesign --force --sign - "${tmpPath}"`, { stdio: 'pipe' });
      } catch { /* ignore, user will need to codesign manually */ }
    }
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
      if (process.platform === 'darwin') {
        console.log(`    codesign --force --sign - "${exePath}"`);
      }
    }
    console.log();
  }
  console.log('  恢复方法: npx cc-channel-patch unpatch\n');
}

// ─── patch 入口 ────────────────────────────────────────────

async function patch() {
  console.log('\n  cc-channel-patch — 启用 Claude Code Channels\n');

  const claudePath = findClaude();
  if (!claudePath) {
    console.error('  找不到 Claude Code。请确认已安装并在 PATH 中。\n');
    process.exit(1);
  }

  const exePath = resolvePatchTarget(claudePath);
  console.log(`  查找: ${claudePath}`);
  if (exePath !== claudePath) console.log(`  解析: ${exePath}`);
  console.log(`  目标: ${exePath}\n`);

  if (isBinaryFile(exePath)) {
    patchBinary(exePath);
  } else {
    await patchAst(exePath);
  }
}

// ─── unpatch ────────────────────────────────────────────────

function unpatch() {
  console.log('\n  cc-channel-patch unpatch — 恢复原始 Claude Code\n');

  const claudePath = findClaude();
  if (!claudePath) { console.error('  找不到 Claude Code。\n'); process.exit(1); }

  const exePath = resolvePatchTarget(claudePath);
  const backupPath = exePath + '.bak';
  if (!fs.existsSync(backupPath)) {
    console.error(`  未找到备份文件: ${backupPath}\n`);
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

// ─── 入口 ───────────────────────────────────────────────────

const cmd = process.argv[2];
if (cmd === 'unpatch' || cmd === 'restore') {
  unpatch();
} else if (cmd === '--help' || cmd === '-h') {
  console.log(`
  cc-channel-patch — 启用 Claude Code Channels 功能

  支持 exe 安装版（二进制模式）和 npm 安装版（AST 模式），自动检测。

  用法:
    npx cc-channel-patch           修补 Claude Code
    npx cc-channel-patch unpatch   恢复原始版本
    npx cc-channel-patch --help    显示帮助
  `);
} else {
  patch().catch(e => { console.error(`  错误: ${e.message}\n`); process.exit(1); });
}
