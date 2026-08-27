import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';

// 使用扩展自身资源初始化 sql.js，避免从网络加载 WASM 或脚本。
export async function initializeSqlJs(): Promise<SqlJsStatic> {
  return initSqlJs({
    locateFile: () => chrome.runtime.getURL('sql-wasm.wasm'),
  });
}
