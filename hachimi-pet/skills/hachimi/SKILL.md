---
name: hachimi
description: Launch or summon the lightweight Hachimi Starry Catgirl Desktop Pet HUD (/hachimi) to display real-time agent status, subagent/Swarm catgirl pets, context window usage, and token throughput on the desktop.
---

# Hachimi Desktop Pet HUD (`/hachimi`)

When the user activates `/hachimi` (or asks to launch/summon the Hachimi desktop pet):
1. Check `http://127.0.0.1:17890/health`; if the pet is not yet running, launch it detached via `node "<plugin_dir>/scripts/launch-pet.mjs"` (using the plugin directory path of this skill).
2. Optionally call `hachimi_pet_notify` with a friendly greeting (`expression: "happy"`, `motion: "wave"`).
3. End your turn normally.

## Local Pet Packs & Workshop (`/workshop`)

- **Local packs directory**: `~/.hachimi-pet/packs/<packId>/pack.json` (private local storage outside the plugin directory; built-in Pack A `hachimi` is always available, and local packs appear as slots `B`, `C`, ... in the tray menu and workshop).
- **Visual Studio (`/workshop`)**: Open `http://127.0.0.1:17890/workshop` (or click `设置…` in the tray/context menu) to preview and hot-switch between installed packs/members, spawn/clear test subagents, copy the "锚点图 → 4×3 绿幕动作表" AI prompt, or upload `compact-4x3`, `single-image` (PNG/GIF/WebP), or `codex-v2-8x11` spritesheets.
- **CLI Pack Builder (`pack-builder.mjs`)**: Create or update a local pack from local images and reload the running bridge:
  ```bash
  node "<plugin_dir>/scripts/pack-builder.mjs" \
    --pack my-cat --pack-name "我的猫" --variant mimi --variant-name "咪咪" \
    --layout compact-4x3 --input /path/to/sheet.png --select
  ```
  Supported `--layout` values: `compact-4x3`, `single-image`, `codex-v2-8x11`. Run with `--help` for all options.
