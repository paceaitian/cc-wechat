/**
 * cc-wechat 凭证持久化 — account.json 原子写入 + sync buf
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountData } from './types.js';

const ACCOUNT_FILE = 'account.json';
const SYNC_BUF_FILE = 'sync-buf.txt';

/**
 * 获取状态目录路径，不存在则自动创建
 */
export function getStateDir(): string {
  const dir = join(homedir(), '.claude', 'channels', 'wechat');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 原子写入账号数据（先写 tmp 再 rename）
 */
export function saveAccount(data: AccountData): void {
  const dir = getStateDir();
  const tmpPath = join(dir, `${ACCOUNT_FILE}.tmp`);
  const finalPath = join(dir, ACCOUNT_FILE);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmpPath, finalPath);
}

/**
 * 读取当前活跃账号，文件不存在返回 null
 */
export function getActiveAccount(): AccountData | null {
  try {
    const filePath = join(getStateDir(), ACCOUNT_FILE);
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as AccountData;
  } catch {
    return null;
  }
}

/**
 * 读取 sync buf，不存在返回空字符串
 */
export function loadSyncBuf(): string {
  try {
    return readFileSync(join(getStateDir(), SYNC_BUF_FILE), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * 写入 sync buf
 */
export function saveSyncBuf(buf: string): void {
  writeFileSync(join(getStateDir(), SYNC_BUF_FILE), buf, 'utf-8');
}
