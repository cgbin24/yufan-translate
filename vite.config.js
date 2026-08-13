import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { execSync } from "node:child_process";
import fs from "node:fs";

// 构建前把 extension/ 打包成 public/extension.zip，供落地页下载
function packExtension() {
  return {
    name: "pack-extension",
    apply: "build",
    buildStart() {
      const extDir = path.resolve(__dirname, "extension");
      const outFile = path.resolve(__dirname, "public", "extension.zip");
      if (!fs.existsSync(extDir)) {
        console.warn("[pack-extension] extension/ 目录不存在，跳过打包");
        return;
      }
      // 用 zip 命令打包（macOS 自带）；失败则提示手动打包
      try {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        execSync(`cd "${extDir}" && zip -r -q "${outFile}" .`, {
          stdio: "ignore",
        });
        console.log(`[pack-extension] 已生成 public/extension.zip`);
      } catch (e) {
        console.warn("[pack-extension] zip 打包失败，请手动生成 extension.zip");
      }
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
