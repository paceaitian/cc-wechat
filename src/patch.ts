#!/usr/bin/env node
/**
 * cc-wechat 补丁工具（双模式）
 * - 二进制模式（exe）：按固定字符串搜索替换
 * - AST 模式（cli.js / npm 安装）：acorn 解析 JS AST，按语义特征定位
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

// ─── 二进制模式补丁定义（通用正则匹配）─────────────────────
// 使用正则匹配函数结构，不依赖具体函数名，适配所有平台和 CC 版本
interface BinaryRegexPatch {
  desc: string;
  regex: RegExp;
  buildReplacement: (m: RegExpMatchArray) => string;
  isPatched: (text: string) => boolean;
}

const BINARY_REGEX_PATCHES: BinaryRegexPatch[] = [
  {
    desc: 'Channels feature flag (tengu_harbor)',
    regex: /function ([\w$]+)\(\)\{return ([\w$]+)\("tengu_harbor",!1\)\}/,
    buildReplacement(m) {
      const prefix = `function ${m[1]}(){return `;
      return prefix + '!0 '.padStart(m[0].length - prefix.length - 1) + '}';
    },
    isPatched: (text) => !text.includes('"tengu_harbor",!1'),
  },
  {
    desc: 'Channel gate auth check',
    regex: /if\(!([\w$]+)\(\)\?\.accessToken\)/,
    buildReplacement(m) {
      const inner = m[0].length - 4;
      const pad = Math.floor((inner - 5) / 2);
      return 'if(' + ' '.repeat(pad) + 'false' + ' '.repeat(inner - 5 - pad) + ')';
    },
    isPatched: (text) => /if\(\s{2,}false\s+\)/.test(text),
  },
  {
    desc: 'UI noAuth display check',
    regex: /noAuth:!([\w$]+)\(\)\?\.accessToken/,
    buildReplacement(m) {
      const inner = m[0].length - 7;
      const pad = Math.floor((inner - 5) / 2);
      return 'noAuth:' + ' '.repeat(pad) + 'false' + ' '.repeat(inner - 5 - pad);
    },
    isPatched: (text) => /noAuth:\s{2,}false/.test(text),
  },
];

// ─── 查找 claude ──────────────────────────────────────────
function findClaudeExe(): string | null {
  const home = homedir();
  try {
    const cmd = process.platform === 'win32' ? 'where claude 2>nul' : 'which claude 2>/dev/null';
    const p = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0].trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* ignore */ }

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
    '/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/usr/bin/claude', '/snap/bin/claude',
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }

  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (prefix) {
      for (const c of [path.join(prefix, 'claude.cmd'), path.join(prefix, 'claude'), path.join(prefix, 'bin', 'claude')]) {
        if (fs.existsSync(c)) return c;
      }
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

// ─── 解析到真正的可 patch 文件 ────────────────────────────
function resolvePatchTarget(claudePath: string): string {
  const ext = path.extname(claudePath).toLowerCase();
  const dir = path.dirname(claudePath);
  if (ext === '.exe') return claudePath;
  const stat = fs.statSync(claudePath);
  if (stat.size > 1_000_000) return claudePath;

  const cliJs = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (fs.existsSync(cliJs)) return cliJs;

  if (ext === '.cmd') {
    try {
      const content = fs.readFileSync(claudePath, 'utf-8');
      if (content.match(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js/)) {
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

// ─── 判断是否二进制文件 ──────────────────────────────────
function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.exe') return true;
  const header = Buffer.alloc(4);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);
  if (header[0] === 0x4D && header[1] === 0x5A) return true;
  if (header[0] === 0x7F && header[1] === 0x45) return true;
  if (header[0] === 0xFE && header[1] === 0xED) return true;
  if (header[0] === 0xCF && header[1] === 0xFA) return true;
  return false;
}

// ─── 写入结果 ──────────────────────────────────────────────
function writeResult(exePath: string, buf: Buffer): void {
  const backupPath = exePath + '.bak';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(exePath, backupPath);
    console.log(`\n  📦 已备份: ${backupPath}`);
  }
  try {
    fs.writeFileSync(exePath, buf);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(exePath, 0o755); } catch { /* ignore */ }
    }
    console.log('\n  ✅ 补丁已直接写入，立即生效！\n');
  } catch {
    const tmpPath = exePath + '.patched';
    fs.writeFileSync(tmpPath, buf);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tmpPath, 0o755); } catch { /* ignore */ }
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
    }
    console.log();
  }
  console.log('  恢复方法: npx cc-wechat unpatch\n');
}

// ─── 二进制模式 patch ──────────────────────────────────────
function patchBinary(exePath: string): void {
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

  if (patched === 0 && skipped > 0) { console.log('\n  所有补丁已生效。\n'); return; }
  if (patched === 0) { console.error('\n  未找到可修补位置。\n'); process.exit(1); }
  writeResult(exePath, buf);
}

// ─── AST 模式 patch ──────────────────────────────────────
async function patchAst(exePath: string): Promise<void> {
  console.log('  模式: AST 语义分析\n');

  // 动态下载 acorn
  const acornPath = path.join(homedir(), '.cache', 'cc-channel-patch', 'acorn.js');
  if (!fs.existsSync(acornPath)) {
    console.log('  下载 acorn 解析器...');
    fs.mkdirSync(path.dirname(acornPath), { recursive: true });
    const resp = await fetch('https://unpkg.com/acorn@8.14.0/dist/acorn.js');
    if (!resp.ok) throw new Error(`下载 acorn 失败: HTTP ${resp.status}`);
    fs.writeFileSync(acornPath, await resp.text());
  }

  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const acorn = require(acornPath) as { parse: (code: string, opts: Record<string, unknown>) => ASTNode };

  let code = fs.readFileSync(exePath, 'utf-8');
  let shebang = '';
  if (code.startsWith('#!')) { const idx = code.indexOf('\n'); shebang = code.slice(0, idx + 1); code = code.slice(idx + 1); }

  let ast: ASTNode;
  try { ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' }); }
  catch (e) { console.error(`  AST 解析失败: ${(e as Error).message}`); process.exit(1); }

  const src = (node: ASTNode) => code.slice(node.start, node.end);

  function findNodes(node: unknown, predicate: (n: ASTNode) => boolean, results: ASTNode[] = []): ASTNode[] {
    if (!node || typeof node !== 'object') return results;
    const n = node as ASTNode;
    if (predicate(n)) results.push(n);
    for (const key in n) {
      const val = (n as Record<string, unknown>)[key];
      if (val && typeof val === 'object') {
        if (Array.isArray(val)) val.forEach(child => findNodes(child, predicate, results));
        else findNodes(val, predicate, results);
      }
    }
    return results;
  }

  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  let patchCount = 0;

  // Patch 1: tengu_harbor
  const harborCalls = findNodes(ast, n =>
    n.type === 'CallExpression' && n.arguments?.length === 2 &&
    n.arguments[0]?.type === 'Literal' && n.arguments[0]?.value === 'tengu_harbor'
  );
  let harborPatched = false;
  for (const call of harborCalls) {
    const arg = call.arguments![1]!;
    if (arg.type === 'UnaryExpression' && arg.operator === '!' && arg.argument?.type === 'Literal' && arg.argument?.value === 1) {
      replacements.push({ start: arg.start, end: arg.end, replacement: '!0' });
      patchCount++;
      console.log(`  ✅ tengu_harbor flag → !0`);
      break;
    }
    if (arg.type === 'UnaryExpression' && arg.operator === '!' && arg.argument?.type === 'Literal' && arg.argument?.value === 0) {
      harborPatched = true;
      console.log('  ⏭️  tengu_harbor flag — 已修补');
      break;
    }
  }

  // Patch 2: channel decision function
  const markerLiterals = findNodes(ast, n => n.type === 'Literal' && n.value === 'channels feature is not currently available');
  let qMqPatched = false;
  if (markerLiterals.length > 0) {
    const markerPos = markerLiterals[0].start;
    const enclosing = findNodes(ast, n =>
      (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && n.start < markerPos && n.end > markerPos
    ).sort((a, b) => (a.end - a.start) - (b.end - b.start));

    if (enclosing.length > 0) {
      const fn = enclosing[0];
      const body = fn.body?.body;
      if (body?.length && body[0].type === 'IfStatement' && src(body[0]).includes('claude/channel')) {
        const newBody = '{' + src(body[0]) + 'return{action:"register"}}';
        replacements.push({ start: fn.body!.start, end: fn.body!.end, replacement: newBody });
        patchCount++;
        console.log(`  ✅ Channel decision — 绕过 check 2-7`);
      }
    }
  } else if (code.includes('claude/channel capability') && !code.includes('channels feature is not currently available')) {
    qMqPatched = true;
    console.log('  ⏭️  Channel decision — 已修补');
  }

  // Patch 3: UI notice
  const policyProps = findNodes(ast, n =>
    n.type === 'Property' && n.key?.type === 'Identifier' && n.key?.name === 'policyBlocked' &&
    n.value != null && src(n.value as ASTNode).includes('channelsEnabled')
  );
  let noticePatched = false;
  if (policyProps.length > 0) {
    const propPos = policyProps[0].start;
    const noticeFuncs = findNodes(ast, n =>
      (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && n.start < propPos && n.end > propPos
    ).sort((a, b) => (a.end - a.start) - (b.end - b.start));

    if (noticeFuncs.length > 0) {
      const nf = noticeFuncs[0];
      const firstCalls = findNodes(nf.body!.body![0], n => n.type === 'CallExpression' && n.callee?.type === 'Identifier');
      const getAllowed = firstCalls.length > 0 ? src(firstCalls[0]) : '$N()';
      const mapCalls = findNodes(nf, n => n.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && n.callee?.property?.name === 'map');
      const formatter = mapCalls.length > 0 && mapCalls[0].arguments?.[0] ? src(mapCalls[0].arguments[0]) : 'naH';

      const newBody = '{let A=' + getAllowed + ';let q=A.length>0?A.map(' + formatter + ').join(", "):"";return{channels:A,disabled:!1,noAuth:!1,policyBlocked:!1,list:q,unmatched:[]}}';
      replacements.push({ start: nf.body!.start, end: nf.body!.end, replacement: newBody });
      patchCount++;
      console.log(`  ✅ UI notice — disabled/noAuth/policyBlocked 全部置 false`);
    }
  } else if (code.includes('policyBlocked') && !code.includes('channelsEnabled!==!0')) {
    noticePatched = true;
    console.log('  ⏭️  UI notice — 已修补');
  }

  if (patchCount === 0) {
    if (harborPatched || qMqPatched || noticePatched) { console.log('\n  所有补丁已生效。\n'); return; }
    console.error('\n  未找到可修补位置。CC 版本可能不兼容。\n'); process.exit(1);
  }

  replacements.sort((a, b) => b.start - a.start);
  let newCode = code;
  for (const r of replacements) { newCode = newCode.slice(0, r.start) + r.replacement + newCode.slice(r.end); }

  writeResult(exePath, Buffer.from(shebang + newCode, 'utf-8'));
}

// ─── AST 节点类型（简化） ─────────────────────────────────
interface ASTNode {
  type: string;
  start: number;
  end: number;
  value?: unknown;
  name?: string;
  operator?: string;
  arguments?: ASTNode[];
  argument?: ASTNode;
  callee?: ASTNode;
  property?: ASTNode;
  key?: ASTNode;
  body?: ASTNode & { body?: ASTNode[] };
  id?: ASTNode;
  [key: string]: unknown;
}

// ─── patch 入口 ────────────────────────────────────────────
async function patch(): Promise<void> {
  console.log('\n  cc-wechat patch — Claude Code Channels 补丁\n');

  const claudePath = findClaudeExe();
  if (!claudePath) { console.error('  找不到 Claude Code。\n'); process.exit(1); }

  const exePath = resolvePatchTarget(claudePath);
  console.log(`  查找: ${claudePath}`);
  if (exePath !== claudePath) console.log(`  解析: ${exePath}`);
  console.log(`  目标: ${exePath}\n`);

  if (isBinaryFile(exePath)) { patchBinary(exePath); }
  else { await patchAst(exePath); }
}

function unpatch(): void {
  console.log('\n  cc-wechat unpatch — 恢复原始 Claude Code\n');
  const claudePath = findClaudeExe();
  if (!claudePath) { console.error('  找不到 Claude Code。\n'); process.exit(1); }
  const exePath = resolvePatchTarget(claudePath);
  const backupPath = exePath + '.bak';
  if (!fs.existsSync(backupPath)) { console.error(`  未找到备份 ${backupPath}\n`); process.exit(1); }
  try {
    fs.copyFileSync(backupPath, exePath);
    console.log('  ✅ 已恢复。\n');
  } catch {
    const tmpPath = exePath + '.restore';
    fs.copyFileSync(backupPath, tmpPath);
    console.log(`  ⚠️  CC 正在运行，恢复文件: ${tmpPath}\n`);
  }
}

// 入口
const cmd = process.argv[2];
if (cmd === 'unpatch' || cmd === 'restore') { unpatch(); }
else { patch().catch(e => { console.error(`  错误: ${(e as Error).message}\n`); process.exit(1); }); }
