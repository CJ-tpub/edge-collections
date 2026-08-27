import { defineConfig } from 'vitest/config';

// 测试只覆盖纯逻辑和 IndexedDB 数据层，不启动浏览器 UI。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
  },
});
