import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 让 Vite 同时构建侧边栏页面和 MV3 service worker。
const projectRoot = dirname(fileURLToPath(import.meta.url));

// Vite 默认不会复制根目录 manifest，构建时将其作为静态资源写入 dist。
const manifestPlugin = (): Plugin => ({
  name: 'copy-extension-manifest',
  generateBundle() {
    this.emitFile({
      type: 'asset' as const,
      fileName: 'manifest.json',
      source: readFileSync(resolve(projectRoot, 'manifest.json'), 'utf8'),
    });
    // 将 sql.js 的 WASM 文件作为扩展本地资源打包，运行时不访问远程代码。
    this.emitFile({
      type: 'asset' as const,
      fileName: 'sql-wasm.wasm',
      source: readFileSync(resolve(projectRoot, 'node_modules/sql.js/dist/sql-wasm.wasm')),
    });
  },
});

export default defineConfig({
  plugins: [manifestPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Edge 扩展隔离 world 不需要预加载提示，关闭后避免 modulepreload 跨 world 警告。
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(projectRoot, 'sidepanel.html'),
        capturePicker: resolve(projectRoot, 'capture-picker.html'),
        background: resolve(projectRoot, 'src/background.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => (
          chunkInfo.name === 'background'
            ? 'background.js'
            : 'assets/[name]-[hash].js'
        ),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
