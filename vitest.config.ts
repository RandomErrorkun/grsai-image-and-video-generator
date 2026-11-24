import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // core/ 与 i18n 是不依赖 React 和 DOM 的纯 TypeScript，直接在 Node 里跑
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
