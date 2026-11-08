import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { packExtensionZip } from "./scripts/pack-extension.mjs";

// 构建前把 extension/ 打包成 public/extension.zip，供落地页下载。
// 打包规则集中在 scripts/pack-extension.mjs（排除 .DS_Store / 含密钥的死代码，
// 并在写盘后 fail-closed 校验），避免"vite 打包"和"手工打包"两套规则各写一份。
function packExtension() {
  return {
    name: "pack-extension",
    apply: "build",
    buildStart() {
      const outFile = path.resolve(__dirname, "public", "extension.zip");
      // 打包失败必须让构建失败：静默 warn 会让落地页继续分发旧包
      const { sizeKb, entries } = packExtensionZip(outFile);
      console.log(`[pack-extension] 已生成 public/extension.zip (${entries} 个条目, ${sizeKb} KB)`);
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react({ include: /\.(js|jsx|ts|tsx)$/ }),
    packExtension(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    host: true,
    open: false,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          motion: ["framer-motion"],
          icons: ["lucide-react"],
        },
      },
    },
  },
});
