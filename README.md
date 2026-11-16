<div align="center">
  <img src="./hachimi-pet/assets/logo.png" alt="Hachimi Pet Logo" width="128" height="128" />
  <h1>Hachimi Pet (`hachimi-pet`)</h1>
  <p><strong>轻量级 Antigravity 哈基米桌面伴侣插件（完整源码 + 即装插件包）· Starry Catgirl Desktop Pet HUD for Google Antigravity</strong></p>

  <p>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg" alt="License: AGPL-3.0-or-later" /></a>
    <img src="https://img.shields.io/badge/Antigravity-Plugin%20(Hooks%20%2B%20MCP%20%2B%20Skill)-purple.svg" alt="Antigravity Plugin" />
    <img src="https://img.shields.io/badge/Windows-Native%20WebView2%20(~0.8%20MB)-0078D4.svg" alt="Windows WebView2" />
    <img src="https://img.shields.io/badge/macOS%20%2F%20Linux-Electron%20Fallback-lightgrey.svg" alt="Cross Platform" />
  </p>
</div>

---

## 📁 仓库结构 · Repository Structure

本仓库包含**可直接安装的便携插件包**与**完整可编译源代码**：

| 目录 | 说明 |
| :--- | :--- |
| [`hachimi-pet/`](./hachimi-pet/) | **Antigravity 插件本体（~9.9 MB）**：包含 `plugin.json`、`hooks.json`、`mcp_config.json`、`skills/hachimi/`、`rules/AGENTS.md`、Windows 原生 WebView2 轻壳与打包产物，可直接安装使用 |
| [`agy-hachimi-pet/`](./agy-hachimi-pet/) | **完整源码工程**：React + TypeScript + Vite 前端（`src/`）、Node.js 桥接与目录/遥测监听引擎（`electron/`）、Windows 原生 WebView2 透明壳源码（`shell-win32/HachimiPetShell.cs`）、哈基米骨骼模型与 8 套配色资产（`public/`） |

---

## 🚀 快速安装（插件本体）

### 方式一：通过 Antigravity CLI 安装（推荐）
```bash
git clone https://github.com/hwt675217/hachimi-pet.git
cd hachimi-pet
agy plugin validate ./hachimi-pet --strict
agy plugin install ./hachimi-pet
```

### 方式二：手动复制到全局插件目录

**Windows (PowerShell):**
```powershell
git clone https://github.com/hwt675217/hachimi-pet.git "$env:TEMP\hachimi-pet-repo"
Copy-Item -Recurse -Force "$env:TEMP\hachimi-pet-repo\hachimi-pet" "$HOME\.gemini\config\plugins\hachimi-pet"
```

**macOS / Linux:**
```bash
git clone https://github.com/hwt675217/hachimi-pet.git /tmp/hachimi-pet-repo
mkdir -p ~/.gemini/config/plugins
cp -R /tmp/hachimi-pet-repo/hachimi-pet ~/.gemini/config/plugins/hachimi-pet
```

安装完成后，在 Antigravity 对话框输入 **`/hachimi`** 即可唤醒桌宠。

---

## 🛠️ 从源码编译打包

```bash
cd agy-hachimi-pet
npm install
npm run dev           # 启动 Vite + 桌面端开发调试
npm run build:plugin  # 编译前端并同步输出到 ../hachimi-pet/app/
```

Windows 原生 WebView2 轻壳源码位于 [`agy-hachimi-pet/shell-win32/HachimiPetShell.cs`](./agy-hachimi-pet/shell-win32/HachimiPetShell.cs)，可直接使用系统自带 `.NET Framework 4.x` (`csc.exe`) 编译。

详细特性列表、系统托盘菜单与运行环境要求请参阅 [`hachimi-pet/README.md`](./hachimi-pet/README.md)。

---

## 📄 开源协议 · License

- 本项目遵循 **GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`)**，详见 [`LICENSE`](./LICENSE) 与 [`hachimi-pet/THIRD_PARTY_NOTICES.md`](./hachimi-pet/THIRD_PARTY_NOTICES.md)。
