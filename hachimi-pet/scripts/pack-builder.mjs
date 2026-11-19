#!/usr/bin/env node
/**
 * Zero-dependency CLI tool to create or update local pet packs under `~/.hachimi-pet/packs/<id>`
 * and notify the running Hachimi Pet bridge (`/api/packs/reload`).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadRegistry() {
  const candidates = [
    process.env.HACHIMI_REGISTRY_PATH,
    path.resolve(__dirname, '..', 'app', 'electron', 'pack-registry.cjs'),
    path.resolve(__dirname, '..', '..', 'agy-hachimi-pet', 'electron', 'pack-registry.cjs'),
  ].filter(Boolean);
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      return require(cand);
    }
  }
  throw new Error('Cannot locate pack-registry.cjs under app/electron or agy-hachimi-pet/electron.');
}

function printHelp() {
  console.log(`Hachimi Pet Local Pack Builder (pack-builder.mjs)

Usage:
  node pack-builder.mjs --pack <id> --input <file> [options]
  node pack-builder.mjs --pack <id> --layout faceted --front <file> [--side <file>] [--back <file>] [--extra <file> ...]

Inputs:
  --input <path>          Input image file path (PNG/WebP/GIF/JPG). Repeatable (1-12 files); optional "<role>:<path>" hint (front|side|back|extra).
  --front <path>          Front view image for faceted layout
  --side <path>           Side view image for faceted layout
  --back <path>           Back view image for faceted layout
  --extra <path>          Extra action pose image for faceted layout (repeatable)
  --pack <id>             Local pack ID (^[a-z0-9][a-z0-9_-]{0,48}$, not "hachimi"; optional if --pack-name is provided)

Options:
  --pack-name <name>      Display name of the pack (defaults to --pack)
  --emoji <emoji>         Optional badge label (default: empty)
  --variant <id>          Member variant ID (auto-assigned if omitted)
  --variant-name <name>   Member display name (defaults to --variant)
  --color <hex>           Accent hex color (auto-extracted when omitted)
  --layout <kind>         auto | faceted | three-view | compact-4x3 | single-image | codex-v2-8x11 (default: auto)
  --flip-side             Flip detected side view horizontally
  --order <i0,i1,i2>      View index order override for multi-view mode (e.g. 0,1,2)
  --asymmetric            Preserve horizontal left/right markings without mirroring (single-image / compact-4x3)
  --select                Activate this pack/variant immediately in the running pet
  --packs-dir <dir>       Override packs directory (default: ~/.hachimi-pet/packs)
  --port <port>           Bridge HTTP port (default: 17890)
  --json                  Output machine-readable JSON
  --help, -h              Show this help
`);
}

function parseInputArg(raw) {
  const val = String(raw || '').trim();
  if (!val) return { path: '', roleHint: '' };
  if (fs.existsSync(val)) {
    return { path: val, roleHint: '' };
  }
  const m = val.match(/^(front|side|back|extra):(.+)$/i);
  if (m) {
    return { path: m[2].trim(), roleHint: m[1].toLowerCase() };
  }
  return { path: val, roleHint: '' };
}

function parseArgs(argv) {
  const opts = {
    inputs: [],
    facets: {
      front: '',
      side: '',
      back: '',
      extras: [],
      flipSide: false,
    },
    layout: '',
    emoji: '',
    color: undefined,
    flipSide: false,
    order: undefined,
    asymmetric: false,
    select: false,
    json: false,
    port: Number(process.env.HACHIMI_PET_PORT || process.env.AGY_WHALE_PORT || 17890),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--asymmetric') {
      opts.asymmetric = true;
    } else if (a === '--flip-side') {
      opts.flipSide = true;
      opts.facets.flipSide = true;
    } else if (a === '--select') {
      opts.select = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--pack') {
      opts.packId = argv[++i];
    } else if (a === '--pack-name') {
      opts.packName = argv[++i];
    } else if (a === '--emoji') {
      opts.emoji = argv[++i];
    } else if (a === '--variant') {
      opts.variantId = argv[++i];
    } else if (a === '--variant-name') {
      opts.variantName = argv[++i];
    } else if (a === '--color') {
      opts.color = argv[++i];
    } else if (a === '--layout') {
      opts.layout = argv[++i];
    } else if (a === '--order') {
      opts.order = String(argv[++i] || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0);
    } else if (a === '--input') {
      opts.inputs.push(parseInputArg(argv[++i]));
    } else if (a === '--front') {
      opts.facets.front = argv[++i];
    } else if (a === '--side') {
      opts.facets.side = argv[++i];
    } else if (a === '--back') {
      opts.facets.back = argv[++i];
    } else if (a === '--extra') {
      opts.facets.extras.push(argv[++i]);
    } else if (a === '--packs-dir') {
      opts.packsDir = argv[++i];
    } else if (a === '--port') {
      opts.port = Number(argv[++i]) || opts.port;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  const hasFacets = Boolean(
    opts.facets.front || opts.facets.side || opts.facets.back || opts.facets.extras.length > 0
  );
  if (!opts.layout) {
    opts.layout = hasFacets ? 'faceted' : 'auto';
  }
  return opts;
}

function postBridge(port, reqPath, body) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ ok: res.statusCode < 400, status: res.statusCode });
          }
        });
      }
    );
    req.setTimeout(1500, () => {
      req.destroy();
      resolve({ ok: false, offline: true });
    });
    req.on('error', () => resolve({ ok: false, offline: true }));
    req.write(payload);
    req.end();
  });
}

function resolveExistingFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    const err = new Error(`File not found: ${abs}`);
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }
  return abs;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const hasFacets = Boolean(
    opts.facets.front || opts.facets.side || opts.facets.back || opts.facets.extras.length > 0
  );
  if ((!opts.packId && !opts.packName) || (opts.inputs.length === 0 && !hasFacets)) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const registry = loadRegistry();
  const packsRoot = opts.packsDir ? path.resolve(opts.packsDir) : registry.getPacksRoot();

  const resolvedFiles = opts.inputs.map((item) => {
    const abs = resolveExistingFile(item.path);
    return item.roleHint
      ? { path: abs, name: path.basename(abs), roleHint: item.roleHint }
      : abs;
  });

  const resolvedFacets = hasFacets
    ? {
        front: opts.facets.front ? resolveExistingFile(opts.facets.front) : undefined,
        side: opts.facets.side ? resolveExistingFile(opts.facets.side) : undefined,
        back: opts.facets.back ? resolveExistingFile(opts.facets.back) : undefined,
        extras: opts.facets.extras.map(resolveExistingFile),
        flipSide: Boolean(opts.facets.flipSide),
      }
    : undefined;

  let result;
  try {
    result = registry.createOrUpdateLocalPack(
      {
        packId: opts.packId,
        packName: opts.packName || opts.packId,
        badgeEmoji: opts.emoji,
        variantId: opts.variantId,
        variantName: opts.variantName || opts.variantId,
        color: opts.color,
        layout: opts.layout,
        asymmetric: opts.asymmetric,
        flipSide: opts.flipSide,
        order: opts.order,
        threeViewOptions: {
          flipSide: opts.flipSide,
          order: opts.order,
        },
        files: resolvedFiles,
        facets: resolvedFacets,
        allowFilePaths: true,
      },
      packsRoot
    );
  } catch (err) {
    const humanMsg = typeof registry.toHumanErrorMessage === 'function'
      ? registry.toHumanErrorMessage(err)
      : (err?.message || String(err));
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: humanMsg }, null, 2));
      process.exitCode = 1;
      return;
    }
    throw new Error(humanMsg);
  }

  const resolvedPackId = result.pack?.id || opts.packId;
  const resolvedVariantId = result.variant?.id || opts.variantId;

  let reloaded = false;
  let selected = false;
  if (!opts.packsDir) {
    const reloadRes = await postBridge(opts.port, '/api/packs/reload', {});
    reloaded = Boolean(reloadRes.ok);
    if (reloaded && opts.select && resolvedPackId) {
      const selRes = await postBridge(opts.port, '/api/packs/select', {
        packId: resolvedPackId,
        scheme: resolvedVariantId,
      });
      selected = Boolean(selRes.ok);
    }
  }

  const summary = {
    ok: true,
    packId: resolvedPackId,
    variantId: resolvedVariantId,
    layout: result.variant?.layout || opts.layout,
    mode: result.mode,
    modeLabel: result.modeLabel,
    splitCount: result.splitCount,
    warnings: result.warnings || [],
    packJsonPath: result.packJsonPath,
    assetPath: result.assetPath,
    thumbPath: result.thumbPath,
    engine: result.engine,
    suggestedColor: result.suggestedColor,
    reloaded,
    selected,
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Created/updated local pack "${summary.packId}" (variant: ${summary.variantId}, mode: ${summary.modeLabel}, engine: ${summary.engine})`);
    console.log(`  pack.json : ${summary.packJsonPath}`);
    console.log(`  asset     : ${summary.assetPath}`);
    console.log(`  thumb     : ${summary.thumbPath}`);
    console.log(`  bridge    : ${reloaded ? (selected ? 'reloaded & activated' : 'reloaded') : 'offline (start pet or reload manually)'}`);
  }
}

main().catch((err) => {
  console.error(`[pack-builder] ${err?.message || err}`);
  process.exit(1);
});
