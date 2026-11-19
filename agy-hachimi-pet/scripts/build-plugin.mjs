#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_ROOT = path.resolve(REPO_ROOT, '..', 'hachimi-pet');
const APP_ROOT = path.join(PLUGIN_ROOT, 'app');

fs.mkdirSync(APP_ROOT, { recursive: true });

// 1. Minimal package.json for Electron main entry (0 runtime npm deps)
fs.writeFileSync(
  path.join(APP_ROOT, 'package.json'),
  JSON.stringify(
    {
      name: 'hachimi-pet-app',
      version: '1.0.0',
      private: true,
      main: 'electron/main.cjs',
    },
    null,
    2
  ),
  'utf8'
);

const IGNORED_BASENAMES = new Set(['__pycache__', '.DS_Store']);
const IGNORED_EXTENSIONS = new Set(['.pyc', '.pyo']);

function shouldCopyPayloadEntry(src) {
  const base = path.basename(src);
  if (IGNORED_BASENAMES.has(base)) return false;
  const ext = path.extname(base).toLowerCase();
  if (IGNORED_EXTENSIONS.has(ext)) return false;
  return true;
}

// 2. Copy electron/*.cjs
const electronDest = path.join(APP_ROOT, 'electron');
fs.rmSync(electronDest, { recursive: true, force: true });
fs.cpSync(path.join(REPO_ROOT, 'electron'), electronDest, { recursive: true, filter: shouldCopyPayloadEntry });

// 3. Copy built dist/
const distDest = path.join(APP_ROOT, 'dist');
fs.rmSync(distDest, { recursive: true, force: true });
fs.cpSync(path.join(REPO_ROOT, 'dist'), distDest, { recursive: true, filter: shouldCopyPayloadEntry });

// 3b. Copy lightweight Windows WebView2 native shell (< 1 MB, zero Electron runtime needed on Windows)
const shellBinSrc = path.join(REPO_ROOT, 'shell-win32', 'bin');
const shellDest = path.join(APP_ROOT, 'shell-win32');
if (fs.existsSync(path.join(shellBinSrc, 'HachimiPetShell.exe'))) {
  fs.rmSync(shellDest, { recursive: true, force: true });
  fs.cpSync(shellBinSrc, shellDest, { recursive: true, filter: shouldCopyPayloadEntry });
  const wv2Lic = path.join(REPO_ROOT, 'shell-win32', 'vendor', 'WebView2-LICENSE.txt');
  if (fs.existsSync(wv2Lic)) {
    fs.copyFileSync(wv2Lic, path.join(shellDest, 'WebView2-LICENSE.txt'));
  }
}

// 4. Copy LICENSE.AGPL3 as plugin LICENSE
fs.copyFileSync(
  path.join(REPO_ROOT, 'public', 'coopanion', 'LICENSE.AGPL3'),
  path.join(PLUGIN_ROOT, 'LICENSE')
);

console.log(`Synced portable Hachimi Pet plugin payload -> ${APP_ROOT}`);
