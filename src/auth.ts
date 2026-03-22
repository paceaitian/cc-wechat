/**
 * QR 扫码登录 — 终端 ASCII 模式 + 浏览器弹窗模式
 */

import http from 'node:http';
import { exec } from 'node:child_process';
import { getQRCode, pollQRStatus, DEFAULT_BASE_URL } from './ilink-api.js';

// ─── 公共类型 ────────────────────────────────────────

export interface LoginResult {
  token: string;
  accountId: string;
  baseUrl?: string;
}

// ─── 常量 ─────────────────────────────────────────────

const MAX_QR_REFRESH = 3;
const LOGIN_TIMEOUT_MS = 5 * 60_000; // 5 分钟
const QR_WEB_PORT_START = 18891;
const QR_WEB_PORT_END = 18899;

// ─── 终端 ASCII 二维码模式 ────────────────────────────

/**
 * 终端 ASCII 二维码登录，适用于 CLI 调用
 * 输出到 stderr 避免干扰 MCP stdio
 */
export async function loginTerminal(baseUrl?: string): Promise<LoginResult> {
  const qrMod = await import('qrcode-terminal');
  const qrTerminal = (qrMod as unknown as { default: { generate: (text: string, opts: { small: boolean }, cb: (qr: string) => void) => void } }).default ?? qrMod;

  for (let qrRefreshCount = 0; qrRefreshCount < MAX_QR_REFRESH; qrRefreshCount++) {
    let qrResp;
    try {
      qrResp = await getQRCode(baseUrl);
    } catch (err) {
      throw new Error(`获取二维码失败（网络错误）: ${(err as Error).message ?? err}`);
    }

    // 输出 ASCII 二维码到 stderr
    await new Promise<void>((resolve) => {
      qrTerminal.generate(qrResp.qrcode_img_content, { small: true }, (qr: string) => {
        process.stderr.write('\n' + qr + '\n');
        process.stderr.write('请使用微信扫描上方二维码登录\n\n');
        resolve();
      });
    });

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let scannedNotified = false;

    // 内层轮询循环
    while (Date.now() < deadline) {
      const status = await pollQRStatus(qrResp.qrcode, baseUrl);

      switch (status.status) {
        case 'wait':
          break;

        case 'scaned':
          if (!scannedNotified) {
            process.stderr.write('已扫码，请在手机上确认...\n');
            scannedNotified = true;
          }
          break;

        case 'expired':
          process.stderr.write('二维码已过期，正在刷新...\n');
          break;

        case 'confirmed': {
          if (!status.bot_token || !status.ilink_bot_id) {
            throw new Error('登录确认但缺少 bot_token 或 ilink_bot_id');
          }
          process.stderr.write('登录成功！\n');
          return {
            token: status.bot_token,
            accountId: status.ilink_bot_id,
            baseUrl: status.baseurl ?? baseUrl ?? DEFAULT_BASE_URL,
          };
        }
      }

      if (status.status === 'expired') break;

      // 轮询间隔 1 秒
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error(`二维码已刷新 ${MAX_QR_REFRESH} 次仍未登录，请重试`);
}

// ─── 浏览器弹窗模式 ──────────────────────────────────

/**
 * 浏览器弹窗二维码登录，适用于 MCP 内 login tool
 * 启动本地 HTTP 服务展示二维码页面
 */
export async function loginBrowser(baseUrl?: string): Promise<LoginResult> {
  const qrResp = await getQRCode(baseUrl);

  // 状态变量
  let currentStatus: string = 'wait';
  let currentQrUrl: string = qrResp.qrcode_img_content;
  let currentQrCode: string = qrResp.qrcode;
  let failMessage: string = '';

  // 创建 HTTP 服务
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);

    if (url.pathname === '/' && req.method === 'GET') {
      // 主页面
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildLoginPage(currentQrUrl));
      return;
    }

    if (url.pathname === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: currentStatus, message: failMessage }));
      return;
    }

    if (url.pathname === '/qr-refresh' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: currentQrUrl }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // 尝试绑定端口
  const port = await findAvailablePort(server);

  try {
    // 打开浏览器
    openBrowser(`http://localhost:${port}`);

    process.stderr.write(`登录页面已打开: http://localhost:${port}\n`);

    // 后台轮询循环
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let qrRefreshCount = 0;

    while (Date.now() < deadline) {
      const status = await pollQRStatus(currentQrCode, baseUrl);
      currentStatus = status.status;

      switch (status.status) {
        case 'wait':
          break;

        case 'scaned':
          break;

        case 'expired': {
          qrRefreshCount++;
          if (qrRefreshCount >= MAX_QR_REFRESH) {
            failMessage = '二维码已多次过期，请重新发起登录';
            throw new Error(failMessage);
          }
          // 刷新二维码
          const newQr = await getQRCode(baseUrl);
          currentQrUrl = newQr.qrcode_img_content;
          currentQrCode = newQr.qrcode;
          currentStatus = 'wait';
          break;
        }

        case 'confirmed': {
          if (!status.bot_token || !status.ilink_bot_id) {
            throw new Error('登录确认但缺少 bot_token 或 ilink_bot_id');
          }
          currentStatus = 'success';
          return {
            token: status.bot_token,
            accountId: status.ilink_bot_id,
            baseUrl: status.baseurl ?? baseUrl ?? DEFAULT_BASE_URL,
          };
        }
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error('登录超时，请重试');
  } finally {
    server.close();
  }
}

// ─── 辅助函数 ─────────────────────────────────────────

/**
 * 在端口范围内寻找可用端口并监听
 */
function findAvailablePort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = QR_WEB_PORT_START;

    const tryListen = (): void => {
      if (port > QR_WEB_PORT_END) {
        reject(new Error(`端口 ${QR_WEB_PORT_START}-${QR_WEB_PORT_END} 均不可用`));
        return;
      }

      server.once('error', () => {
        port++;
        tryListen();
      });

      server.listen(port, '127.0.0.1', () => {
        // 移除之前绑定的 error 监听器
        server.removeAllListeners('error');
        resolve(port);
      });
    };

    tryListen();
  });
}

/**
 * 跨平台打开浏览器
 */
function openBrowser(url: string): void {
  switch (process.platform) {
    case 'win32':
      exec(`start ${url}`);
      break;
    case 'darwin':
      exec(`open ${url}`);
      break;
    default:
      exec(`xdg-open ${url}`);
      break;
  }
}

/**
 * 构建登录 HTML 页面
 */
function buildLoginPage(qrUrl: string): string {
  const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(qrUrl)}`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WeChat × Claude Code</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
  }
  .container {
    text-align: center;
    padding: 2rem;
  }
  h1 {
    font-size: 1.8rem;
    margin-bottom: 0.5rem;
    color: #fff;
  }
  .subtitle {
    font-size: 1rem;
    color: #888;
    margin-bottom: 2rem;
  }
  .qr-wrapper {
    background: #fff;
    border-radius: 16px;
    padding: 20px;
    display: inline-block;
    margin-bottom: 1.5rem;
  }
  .qr-wrapper img {
    width: 280px;
    height: 280px;
    display: block;
  }
  .status {
    font-size: 1.1rem;
    min-height: 2rem;
    transition: color 0.3s;
  }
  .status.scaned { color: #f0a030; }
  .status.success { color: #4caf50; }
  .status.expired { color: #f44336; }
  .checkmark {
    font-size: 3rem;
    color: #4caf50;
    display: none;
    margin-bottom: 1rem;
  }
  .cmd-hint {
    display: none;
    margin-top: 1rem;
    background: #16213e;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 1rem;
    font-family: monospace;
    font-size: 0.9rem;
    color: #7ec8e3;
    cursor: pointer;
    position: relative;
  }
  .cmd-hint:hover { background: #1a2744; }
  .copied {
    position: absolute;
    top: -1.5rem;
    right: 0.5rem;
    font-size: 0.75rem;
    color: #4caf50;
    opacity: 0;
    transition: opacity 0.3s;
  }
  .copied.show { opacity: 1; }
</style>
</head>
<body>
<div class="container">
  <h1>WeChat &times; Claude Code</h1>
  <p class="subtitle">使用微信扫码连接</p>
  <div class="checkmark" id="checkmark">&#10003;</div>
  <div class="qr-wrapper" id="qr-wrapper">
    <img id="qr-img" src="${qrImgUrl}" alt="QR Code">
  </div>
  <div class="status" id="status">等待扫码...</div>
  <div class="cmd-hint" id="cmd-hint" onclick="copyCmd()">
    npx cc-wechat
    <span class="copied" id="copied">已复制</span>
  </div>
</div>
<script>
  const statusEl = document.getElementById('status');
  const qrImg = document.getElementById('qr-img');
  const checkmark = document.getElementById('checkmark');
  const qrWrapper = document.getElementById('qr-wrapper');
  const cmdHint = document.getElementById('cmd-hint');

  setInterval(async () => {
    try {
      const res = await fetch('/status');
      const data = await res.json();
      statusEl.className = 'status ' + data.status;

      switch (data.status) {
        case 'wait':
          statusEl.textContent = '等待扫码...';
          break;
        case 'scaned':
          statusEl.textContent = '已扫码，请在手机上确认...';
          break;
        case 'expired':
          statusEl.textContent = '二维码已过期，正在刷新...';
          refreshQR();
          break;
        case 'success':
          statusEl.textContent = '登录成功！';
          checkmark.style.display = 'block';
          qrWrapper.style.display = 'none';
          cmdHint.style.display = 'block';
          copyCmd();
          break;
        default:
          if (data.message) statusEl.textContent = data.message;
      }
    } catch {}
  }, 2000);

  async function refreshQR() {
    try {
      const res = await fetch('/qr-refresh');
      const data = await res.json();
      const newUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(data.url);
      qrImg.src = newUrl;
    } catch {}
  }

  function copyCmd() {
    navigator.clipboard.writeText('npx cc-wechat').then(() => {
      const copied = document.getElementById('copied');
      copied.classList.add('show');
      setTimeout(() => copied.classList.remove('show'), 1500);
    }).catch(() => {});
  }
</script>
</body>
</html>`;
}
