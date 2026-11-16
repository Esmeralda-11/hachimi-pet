# `agy-hachimi-pet` · Hachimi Pet 源码构建工作区

本目录是 Antigravity 便携插件 **[`hachimi-pet`](../hachimi-pet/)** 的前端（React + TypeScript + Vite）与桌面端（Electron + 纯 Node 桥接服务）开发与打包源码工作区。

## 开发与打包命令

```bash
# 安装开发依赖
npm install

# 本地调试（Vite 热更新 + Electron 透明悬浮窗）
npm run dev

# 仅运行独立桥接服务器测试
npm run bridge:test

# 编译前端并同步输出到 ../hachimi-pet/app/（零 runtime node_modules）
npm run build:plugin
```

构建完成后，可通过 Antigravity CLI 严格校验便携插件包：

```bash
agy plugin validate ../hachimi-pet --strict --json
```

完整插件使用指南、特性列表与开源协议请参阅 [`../hachimi-pet/README.md`](../hachimi-pet/README.md)。
