/**
 * cc-wechat iLink Bot API 封装 — 7 个 HTTP API
 */
import { randomBytes } from 'node:crypto';
import type {
  BaseInfo,
  QRCodeResponse,
  QRStatusResponse,
  GetUpdatesResp,
  GetConfigResp,
  GetUploadUrlResp,
} from './types.js';

// 默认 iLink 服务地址
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';
const LONG_POLL_TIMEOUT_MS = 35_000;

/** 构造 base_info 通用字段 */
export function buildBaseInfo(): BaseInfo {
  return { channel_version: '0.1.0' };
}

/** 生成随机 wechat uin（4 字节随机数 → 十进制 → base64） */
export function randomWechatUin(): string {
  const num = randomBytes(4).readUInt32BE(0);
  const str = num.toString(10);
  return Buffer.from(str, 'utf-8').toString('base64');
}

/** 构造请求头 */
export function buildHeaders(
  token?: string,
  body?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (body) {
    headers['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
  }
  return headers;
}

/** 通用 HTTP 请求 */
export async function apiFetch(params: {
  baseUrl?: string;
  endpoint: string;
  body?: string;
  token?: string;
  timeoutMs: number;
  label: string;
  method?: string;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  const {
    endpoint,
    body,
    token,
    timeoutMs,
    label,
    method = 'POST',
  } = params;

  // 确保 base URL 末尾有 /
  let base = params.baseUrl ?? DEFAULT_BASE_URL;
  if (!base.endsWith('/')) base += '/';

  const url = `${base}${endpoint}`;
  const isGet = method === 'GET';

  // GET 请求不传 body 和 Content-Type/Content-Length
  const headers: Record<string, string> = isGet
    ? {
        'AuthorizationType': 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }
    : buildHeaders(token, body);

  // 合并额外请求头
  if (params.extraHeaders) {
    Object.assign(headers, params.extraHeaders);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method,
      headers,
      ...(isGet ? {} : { body }),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`[${label}] HTTP ${resp.status}: ${text}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ─── QR 登录 API（GET 请求） ─────────────────────────

/** 获取登录二维码 */
export async function getQRCode(
  baseUrl?: string,
): Promise<QRCodeResponse> {
  const text = await apiFetch({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_BOT_TYPE}`,
    timeoutMs: 10_000,
    label: 'getQRCode',
    method: 'GET',
  });
  return JSON.parse(text) as QRCodeResponse;
}

/** 轮询二维码扫描状态（长轮询，35s 超时） */
export async function pollQRStatus(
  qrcode: string,
  baseUrl?: string,
): Promise<QRStatusResponse> {
  try {
    const text = await apiFetch({
      baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
      label: 'pollQRStatus',
      method: 'GET',
      extraHeaders: { 'iLink-App-ClientVersion': '1' },
    });
    return JSON.parse(text) as QRStatusResponse;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError' || (err as { name?: string })?.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw err;
  }
}

// ─── 消息 API（POST 请求） ───────────────────────────

/** 长轮询获取新消息 */
export async function getUpdates(
  token: string,
  buf: string,
  baseUrl?: string,
  timeoutMs?: number,
): Promise<GetUpdatesResp> {
  const body = JSON.stringify({
    get_updates_buf: buf,
    base_info: buildBaseInfo(),
  });
  try {
    const text = await apiFetch({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body,
      token,
      timeoutMs: timeoutMs ?? LONG_POLL_TIMEOUT_MS,
      label: 'getUpdates',
    });
    return JSON.parse(text) as GetUpdatesResp;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError' || (err as { name?: string })?.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw err;
  }
}

/** 发送文本消息，返回 client_id。支持引用回复（ref_msg） */
export async function sendMessage(
  token: string,
  to: string,
  text: string,
  contextToken: string,
  baseUrl?: string,
  refMsgId?: string,
): Promise<string> {
  const clientId = `cc-wechat-${randomBytes(4).toString('hex')}`;
  // 构造消息内容项，支持引用回复
  const textItem: Record<string, unknown> = { type: 1, text_item: { text } };
  if (refMsgId) {
    textItem.ref_msg = { title: text.slice(0, 40) };
  }
  const msg: Record<string, unknown> = {
    from_user_id: '',
    to_user_id: to,
    client_id: clientId,
    message_type: 2,
    message_state: 2,
    item_list: [textItem],
    context_token: contextToken,
  };
  if (refMsgId) {
    msg.ref_message_id = refMsgId;
  }
  const body = JSON.stringify({ msg, base_info: buildBaseInfo() });
  await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body,
    token,
    timeoutMs: 10_000,
    label: 'sendMessage',
  });
  return clientId;
}

/** 发送输入状态指示 */
export async function sendTyping(
  token: string,
  userId: string,
  ticket: string,
  status: number,
  baseUrl?: string,
): Promise<void> {
  const body = JSON.stringify({
    user_id: userId,
    typing_ticket: ticket,
    typing_status: status,
    base_info: buildBaseInfo(),
  });
  await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body,
    token,
    timeoutMs: 5_000,
    label: 'sendTyping',
  });
}

/** 获取配置（typing ticket 等） */
export async function getConfig(
  token: string,
  userId: string,
  contextToken?: string,
  baseUrl?: string,
): Promise<GetConfigResp> {
  const body = JSON.stringify({
    user_id: userId,
    ...(contextToken ? { context_token: contextToken } : {}),
    base_info: buildBaseInfo(),
  });
  const text = await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body,
    token,
    timeoutMs: 10_000,
    label: 'getConfig',
  });
  return JSON.parse(text) as GetConfigResp;
}

/** 获取文件上传地址 */
export async function getUploadUrl(
  token: string,
  params: Record<string, unknown>,
  baseUrl?: string,
): Promise<GetUploadUrlResp> {
  const body = JSON.stringify({
    ...params,
    base_info: buildBaseInfo(),
  });
  const text = await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    body,
    token,
    timeoutMs: 10_000,
    label: 'getUploadUrl',
  });
  return JSON.parse(text) as GetUploadUrlResp;
}
