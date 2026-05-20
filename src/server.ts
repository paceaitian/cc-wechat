#!/usr/bin/env node
/**
 * cc-wechat MCP Server 主入口
 * Claude Code Channel 插件 — 微信消息桥接
 */

// 代理支持（必须最先导入）
import './proxy.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';

import { getActiveAccount, saveAccount, loadSyncBuf, saveSyncBuf } from './store.js';
import { getUpdates, sendMessage, sendTyping, getConfig } from './ilink-api.js';
import { loginBrowser } from './auth.js';
import { uploadMedia, downloadMedia } from './cdn.js';
import { stripMarkdown, chunkText } from './text-utils.js';
import type { WeixinMessage, AccountData } from './types.js';
import { MessageItemType } from './types.js';

// ─── 状态变量 ─────────────────────────────────────────

let pollingActive = false;
let pollingAbort: AbortController | null = null;
const typingTicketCache = new Map<string, string>();
const typingHeartbeatMap = new Map<string, NodeJS.Timeout>();

// ─── Session 过期处理常量 ─────────────────────────────

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_SESSION_RETRIES = 3;
const MAX_CONSECUTIVE_FAILURES = 5;
const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;
const SESSION_PAUSE_MS = 5 * 60_000;

// ─── 辅助函数 ─────────────────────────────────────────

/** 启动 typing 心跳（每 3 秒发送一次 typing(1)） */
function startTypingHeartbeat(token: string, userId: string, ticket: string, baseUrl?: string): void {
  stopTypingHeartbeat(userId);
  sendTyping(token, userId, ticket, 1, baseUrl).catch(() => {});
  const timer = setInterval(() => {
    sendTyping(token, userId, ticket, 1, baseUrl).catch(() => {});
  }, 3000);
  typingHeartbeatMap.set(userId, timer);
}

/** 停止 typing 心跳并发送 typing(2) */
function stopTypingHeartbeat(userId: string): void {
  const timer = typingHeartbeatMap.get(userId);
  if (timer) {
    clearInterval(timer);
    typingHeartbeatMap.delete(userId);
    const account = getActiveAccount();
    const ticket = typingTicketCache.get(userId);
    if (account && ticket) {
      sendTyping(account.token, userId, ticket, 2, account.baseUrl).catch(() => {});
    }
  }
}

/** 停止所有 typing 心跳（进程退出时调用） */
function stopAllTypingHeartbeats(): void {
  for (const [userId] of typingHeartbeatMap) {
    stopTypingHeartbeat(userId);
  }
}

/** 可中断的 sleep */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

/** 从消息提取可读文本（异步，支持媒体下载） */
async function extractText(msg: WeixinMessage): Promise<string> {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    const t = item.type ?? 0;

    if (t === MessageItemType.TEXT) {
      if (item.text_item?.text) {
        // 提取引用回复内容
        if (item.ref_msg) {
          const refTitle = item.ref_msg.title ?? '';
          const refText = item.ref_msg.message_item?.text_item?.text ?? '';
          const refContent = refTitle || refText;
          if (refContent) {
            parts.push(`[引用: ${refContent}]`);
          }
        }
        parts.push(item.text_item.text);
      }
    } else if (t === MessageItemType.IMAGE) {
      let desc = '[图片]';
      if (item.image_item?.media?.encrypt_query_param && item.image_item?.media?.aes_key) {
        try {
          const filePath = await downloadMedia({
            encryptQueryParam: item.image_item.media.encrypt_query_param,
            aesKeyBase64: item.image_item.media.aes_key,
          });
          desc += `\n[附件: ${filePath}]`;
        } catch {
          // 下载失败不阻塞消息处理
        }
      }
      parts.push(desc);
    } else if (t === MessageItemType.VOICE) {
      parts.push(`[语音] ${item.voice_item?.text ?? ''}`);
    } else if (t === MessageItemType.FILE) {
      let desc = `[文件: ${item.file_item?.file_name ?? 'unknown'}]`;
      if (item.file_item?.media?.encrypt_query_param && item.file_item?.media?.aes_key) {
        try {
          const filePath = await downloadMedia({
            encryptQueryParam: item.file_item.media.encrypt_query_param,
            aesKeyBase64: item.file_item.media.aes_key,
            fileName: item.file_item.file_name,
          });
          desc += `\n[附件: ${filePath}]`;
        } catch {
          // 下载失败不阻塞消息处理
        }
      }
      parts.push(desc);
    } else if (t === MessageItemType.VIDEO) {
      parts.push('[视频]');
    }
  }
  return parts.join('\n') || '[空消息]';
}

// ─── MCP Server 创建 ─────────────────────────────────

const server = new Server(
  { name: 'wechat-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `Messages arrive as <channel source="wechat-channel" user_id="..." context_token="..." message_id="...">.
Reply using the reply tool. Pass user_id and context_token from the channel tag.
For media: set media to an absolute local file path to send image/video/file.
For quote reply: set reply_to_message_id to the message_id from the channel tag to send a quoted reply.
IMPORTANT: Always use the reply tool to respond to WeChat messages. Do not just output text.`,
  },
);

// ─── Tools — ListToolsRequestSchema ──────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'login',
      description: '扫码登录微信。首次使用或 session 过期后运行。',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'reply',
      description: '回复微信消息',
      inputSchema: {
        type: 'object' as const,
        properties: {
          user_id: { type: 'string', description: '微信用户 ID（来自消息 meta 的 user_id）' },
          context_token: { type: 'string', description: '会话上下文令牌（来自消息 meta 的 context_token）' },
          content: { type: 'string', description: '回复文本内容' },
          media: { type: 'string', description: '可选：本地文件绝对路径，发送图片/视频/文件' },
          reply_to_message_id: { type: 'string', description: '可选：引用回复的原消息 ID（来自 meta 的 message_id）' },
        },
        required: ['user_id', 'context_token', 'content'],
      },
    },
  ],
}));

// ─── Tools — CallToolRequestSchema ───────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── login tool ──
  if (name === 'login') {
    try {
      const result = await loginBrowser();
      saveAccount({
        token: result.token,
        baseUrl: result.baseUrl ?? '',
        botId: result.accountId,
        savedAt: new Date().toISOString(),
      });
      startPolling();
      return {
        content: [{ type: 'text' as const, text: `登录成功！账号 ID: ${result.accountId}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `登录失败: ${String(err)}` }],
        isError: true,
      };
    }
  }

  // ── reply tool ──
  if (name === 'reply') {
    const userId = args?.user_id as string | undefined;
    const contextToken = args?.context_token as string | undefined;
    const content = args?.content as string | undefined;
    const media = args?.media as string | undefined;
    const replyToMessageId = args?.reply_to_message_id as string | undefined;

    // 验证必填参数
    if (!userId || !contextToken || !content) {
      return {
        content: [{ type: 'text' as const, text: '缺少必填参数: user_id, context_token, content' }],
        isError: true,
      };
    }

    // 验证账号存在
    const account = getActiveAccount();
    if (!account) {
      return {
        content: [{ type: 'text' as const, text: '未登录，请先使用 login 工具扫码登录' }],
        isError: true,
      };
    }

    // 检查媒体文件是否存在
    if (media && !fs.existsSync(media)) {
      return {
        content: [{ type: 'text' as const, text: `媒体文件不存在: ${media}` }],
        isError: true,
      };
    }

    try {
      // 停止 typing 心跳（Claude 已完成处理）
      stopTypingHeartbeat(userId);

      // 发送 typing 状态（best-effort）
      try {
        let ticket = typingTicketCache.get(userId);
        if (!ticket) {
          const config = await getConfig(account.token, userId, contextToken, account.baseUrl);
          ticket = config.typing_ticket ?? '';
          if (ticket) typingTicketCache.set(userId, ticket);
        }
        if (ticket) {
          await sendTyping(account.token, userId, ticket, 1, account.baseUrl);
        }
      } catch {
        // typing 失败不阻塞
      }

      // 清理 Markdown 并分段发送（第一段带引用回复）
      const plainText = stripMarkdown(content);
      const chunks = chunkText(plainText, 3900);
      for (let i = 0; i < chunks.length; i++) {
        const refId = i === 0 ? replyToMessageId : undefined;
        await sendMessage(account.token, userId, chunks[i], contextToken, account.baseUrl, refId);
      }

      // 发送媒体文件（如有）
      let mediaError = '';
      if (media) {
        try {
          await uploadMedia({
            token: account.token,
            toUser: userId,
            contextToken,
            filePath: media,
            baseUrl: account.baseUrl,
          });
        } catch (err) {
          mediaError = `（媒体发送失败: ${String(err)}）`;
        }
      }

      // 停止 typing 状态（best-effort）
      try {
        const ticket = typingTicketCache.get(userId);
        if (ticket) {
          await sendTyping(account.token, userId, ticket, 2, account.baseUrl);
        }
      } catch {
        // typing 失败不阻塞
      }

      return {
        content: [{
          type: 'text' as const,
          text: `已发送 ${chunks.length} 段文本${media ? ' + 1 个媒体文件' : ''}${mediaError}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `发送失败: ${String(err)}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text' as const, text: `未知工具: ${name}` }],
    isError: true,
  };
});

// ─── 轮询循环 ─────────────────────────────────────────

/** 消息长轮询循环 */
async function pollLoop(account: AccountData): Promise<void> {
  let buf = loadSyncBuf();
  let consecutiveFailures = 0;
  let sessionRetries = 0;
  let retryDelay = INITIAL_RETRY_DELAY_MS;
  let nextTimeoutMs: number | undefined;
  // 消息去重：缓存最近处理过的 message_id（最多保留 1000 个）
  const processedMessageIds = new Set<string>();
  const MAX_PROCESSED_IDS = 1000;

  while (pollingActive && !pollingAbort?.signal.aborted) {
    try {
      const resp = await getUpdates(account.token, buf, account.baseUrl, nextTimeoutMs);

      // 更新长轮询超时
      if (resp.longpolling_timeout_ms) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      // 检查 API 错误
      if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
        const errcode = resp.errcode ?? resp.ret ?? 0;

        if (errcode === SESSION_EXPIRED_ERRCODE) {
          sessionRetries++;
          process.stderr.write(`[wechat-channel] Session 过期 (${sessionRetries}/${MAX_SESSION_RETRIES})\n`);

          if (sessionRetries >= MAX_SESSION_RETRIES) {
            pollingActive = false;
            // 通知 Claude session 过期
            server.notification({
              method: 'notifications/message',
              params: {
                level: 'error',
                data: 'WeChat session expired, please use login tool to reconnect',
              },
            });
            return;
          }

          await sleep(SESSION_PAUSE_MS, pollingAbort?.signal);
          continue;
        }

        // 其他错误
        consecutiveFailures++;
        process.stderr.write(
          `[wechat-channel] API 错误 errcode=${errcode} errmsg=${resp.errmsg ?? ''} ` +
          `(${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})\n`,
        );

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          process.stderr.write(`[wechat-channel] 连续失败过多，暂停 ${SESSION_PAUSE_MS / 1000}s\n`);
          await sleep(SESSION_PAUSE_MS, pollingAbort?.signal);
          consecutiveFailures = 0;
        } else {
          await sleep(retryDelay, pollingAbort?.signal);
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
        }
        continue;
      }

      // 成功 → 重置计数器
      consecutiveFailures = 0;
      retryDelay = INITIAL_RETRY_DELAY_MS;

      // 保存 sync buf
      if (resp.get_updates_buf) {
        buf = resp.get_updates_buf;
        saveSyncBuf(buf);
      }

      // 处理消息（仅用户消息 message_type === 1）
      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== 1) continue;

        // 消息去重：跳过已处理的 message_id
        const msgId = String(msg.message_id ?? '');
        if (msgId && processedMessageIds.has(msgId)) {
          process.stderr.write(`[wechat-channel] 跳过重复消息: ${msgId}\n`);
          continue;
        }
        // 记录已处理的 message_id
        if (msgId) {
          processedMessageIds.add(msgId);
          // 限制缓存大小，移除最旧的条目
          if (processedMessageIds.size > MAX_PROCESSED_IDS) {
            const firstId = processedMessageIds.values().next().value;
            processedMessageIds.delete(firstId);
          }
        }

        const fromUser = msg.from_user_id ?? '';
        const contextToken = msg.context_token ?? '';

        // 提取文本
        const text = await extractText(msg);

        // 缓存 typing ticket（best-effort）
        try {
          const config = await getConfig(account.token, fromUser, contextToken, account.baseUrl);
          if (config.typing_ticket) {
            typingTicketCache.set(fromUser, config.typing_ticket);
          }
        } catch {
          // 忽略
        }

        // 启动 typing 心跳（每 3 秒发送一次 typing(1)）
        try {
          const ticket = typingTicketCache.get(fromUser);
          if (ticket) {
            startTypingHeartbeat(account.token, fromUser, ticket, account.baseUrl);
          }
        } catch {
          // 忽略
        }

        // 通知 Claude 有新消息
        server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: text,
            meta: {
              source: 'wechat',
              user_id: fromUser,
              context_token: contextToken,
              message_id: String(msg.message_id ?? ''),
              session_id: msg.session_id ?? '',
            },
          },
        });
      }
    } catch (err) {
      if (pollingAbort?.signal.aborted) return;

      // 网络错误 → 指数退避
      consecutiveFailures++;
      process.stderr.write(
        `[wechat-channel] 网络错误: ${String(err)} ` +
        `(${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})\n`,
      );

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        process.stderr.write(`[wechat-channel] 连续失败过多，暂停 ${SESSION_PAUSE_MS / 1000}s\n`);
        await sleep(SESSION_PAUSE_MS, pollingAbort?.signal);
        consecutiveFailures = 0;
      } else {
        await sleep(retryDelay, pollingAbort?.signal);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }
}

// ─── 轮询控制 ─────────────────────────────────────────

/** 启动消息轮询 */
function startPolling(): void {
  const account = getActiveAccount();
  if (!account || pollingActive) return;
  pollingActive = true;
  pollingAbort = new AbortController();
  pollLoop(account).catch((err) => {
    if (!pollingAbort?.signal.aborted) {
      process.stderr.write(`[wechat-channel] Poll loop crashed: ${String(err)}\n`);
    }
    pollingActive = false;
  });
}

/** 停止消息轮询 */
function stopPolling(): void {
  pollingActive = false;
  pollingAbort?.abort();
  pollingAbort = null;
}

// ─── 主入口 ───────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[wechat-channel] MCP server started\n');

  // 进程退出时清理所有心跳
  process.on('SIGINT', () => { stopAllTypingHeartbeats(); process.exit(0); });
  process.on('SIGTERM', () => { stopAllTypingHeartbeats(); process.exit(0); });
  process.on('exit', () => { stopAllTypingHeartbeats(); });

  const account = getActiveAccount();
  if (account) {
    process.stderr.write(`[wechat-channel] Found saved account: ${account.botId}\n`);
    startPolling();
  } else {
    process.stderr.write('[wechat-channel] No saved account. Use the login tool to connect.\n');
  }
}

main().catch((err) => {
  process.stderr.write(`[wechat-channel] Fatal: ${String(err)}\n`);
  process.exit(1);
});
