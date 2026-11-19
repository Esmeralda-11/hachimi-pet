#!/usr/bin/env python3
"""Smart image importer, background remover, classifier, and codex-v2-8x11 (1536x2288) builder.

Subcommands / modes:
  --analyze '<json>' | --analyze --config <path>
  --build   '<json>' | --build   --config <path>
"""

from __future__ import annotations

import argparse
import base64
import colorsys
import io
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps, UnidentifiedImageError
from scipy import ndimage

# Allow large static images without false-positive bomb errors while still bounding extremes
Image.MAX_IMAGE_PIXELS = 64_000_000

COLS = 8
ROWS = 11
CELL_W = 192
CELL_H = 208
ATLAS_W = COLS * CELL_W  # 1536
ATLAS_H = ROWS * CELL_H  # 2288

NORM_MAX_W = 168.0
NORM_TARGET_H = 184.0
NORM_BOTTOM_EXCL = 200  # bottom pixel at y = 199

MAX_INPUTS = 16

EXTERNAL_BUBBLES_DIR = Path(
    os.environ.get(
        "HACHIMI_BUBBLES_DIR",
        str(Path.home() / ".hachimi-pet" / "packs" / "six-cats" / "_tools" / "bubbles"),
    )
)

UNSUPPORTED_EXTS = {
    ".heic",
    ".heif",
    ".avif",
    ".svg",
    ".svgz",
    ".tif",
    ".tiff",
    ".psd",
    ".ai",
    ".eps",
    ".pdf",
    ".raw",
    ".cr2",
    ".nef",
    ".arw",
    ".dng",
}

VALID_ROLES = ("front", "left_side", "right_side", "back", "top", "face_closeup", "action")

ROLE_LABELS = {
    "front": "正面",
    "left_side": "左侧面",
    "right_side": "右侧面",
    "back": "背面",
    "top": "顶面",
    "face_closeup": "脸部特写",
    "action": "动作姿态",
    "side": "侧面",
    "extra": "动作姿态",
    "animated": "动态图",
    "grid-8x11": "8×11 动作表",
    "grid-4x3": "4×3 精灵表",
}

MODE_LABELS = {
    "animated": "动态图",
    "grid-8x11": "8×11 动作表",
    "grid-4x3": "4×3 精灵表",
    "three-view": "三视图拆分",
    "single-char": "单张立绘（自动补全）",
    "multi-view": "多图智能归类",
    "faceted": "分面上传",
}

MSG_MISSING_INPUT = "请先上传至少一张角色图片，再开始生成。"
MSG_TOO_MANY_INPUTS = "一次最多导入 16 张图片，请精简后再试。"
MSG_UNSUPPORTED_OR_CORRUPT = "这张图片格式暂不支持或文件已损坏，请改用 PNG、JPG、WebP 或动图 GIF。"
MSG_EMPTY_IMAGE = "没有在图片里找到清楚的角色主体，请换一张背景干净、主体完整的图片。"
MSG_FILE_NOT_FOUND = "有一张已选图片找不到了，请重新选择后再试。"
MSG_INTERNAL_ERROR = "生成这一套动作图时遇到一点问题，请换一张图片或改用「分面上传」再试。"


class SmartImportError(Exception):
    """Structured user-facing error with machine code and pure Chinese guidance."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.user_message = message


@dataclass
class LoadedImage:
    rgba: Image.Image
    is_animated: bool
    n_frames: int
    size: tuple[int, int]
    orig_format: str
    path: Path
    name: str
    role_hint: str = ""


@dataclass
class PoseFeatures:
    width: int
    height: int
    aspect: float
    area: int
    head_mirror_iou: float
    body_mirror_iou: float
    facial_contrast: float
    feat_asym: float
    head_vs_lower_offset: float
    centroid_offset: float
    clipped_bottom: bool = False
    clipped_sides: bool = False
    top_heavy_ratio: float = 1.0
    bottom_contrast: float = 0.0
    bottom_taper_ratio: float = 1.0
    head_area_frac: float = 0.5
    compact_fill: float = 0.5
    sharpness: float = 0.0
    eye_highlight_score: float = 0.0


def _pil_to_data_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _normalize_role_hint(raw: Any) -> str:
    val = str(raw or "").strip().lower()
    if not val or val == "auto":
        return ""
    if val == "extra":
        return "action"
    if val in ("front", "left_side", "right_side", "back", "top", "face_closeup", "action", "side"):
        return val
    return ""


def _parse_input_entry(item: Any, idx: int, default_name: str = "") -> tuple[str, str, str]:
    """Return (path_str, display_name, role_hint)."""
    if isinstance(item, str):
        p = item.strip()
        name = default_name or (Path(p).name if p else f"图片 {idx + 1}")
        return p, name, ""
    if isinstance(item, dict):
        raw_path = (
            item.get("path")
            or item.get("file")
            or item.get("input")
            or item.get("src")
            or ""
        )
        p = str(raw_path).strip()
        raw_name = item.get("name") or item.get("filename") or ""
        name = str(raw_name).strip() or default_name or (Path(p).name if p else f"图片 {idx + 1}")
        manual = _normalize_role_hint(item.get("manualRole"))
        hint = manual or _normalize_role_hint(item.get("roleHint") or item.get("role"))
        return p, name, hint
    raise SmartImportError("MISSING_INPUT", MSG_MISSING_INPUT)


def _sniff_unsupported_magic(header: bytes) -> bool:
    if len(header) >= 12 and header[4:8] == b"ftyp":
        return True
    stripped = header.lstrip()
    if stripped.startswith((b"<svg", b"<SVG", b"<?xml", b"<!DOCTYPE svg", b"<!doctype svg")):
        return True
    if header[:4] in (b"II*\x00", b"MM\x00*"):
        return True
    if header[:4] == b"%PDF":
        return True
    return False


def _is_supported_magic(header: bytes) -> bool:
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    if header.startswith(b"\xff\xd8\xff"):
        return True
    if header.startswith((b"GIF87a", b"GIF89a")):
        return True
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return True
    if header.startswith(b"BM"):
        return True
    return False


def _load_image_strict(path_str: str, name: str = "", role_hint: str = "") -> LoadedImage:
    if not path_str:
        raise SmartImportError("MISSING_INPUT", MSG_MISSING_INPUT)

    p = Path(path_str)
    if p.suffix.lower() in UNSUPPORTED_EXTS:
        raise SmartImportError("UNSUPPORTED_FORMAT", MSG_UNSUPPORTED_OR_CORRUPT)

    if not p.is_file():
        raise SmartImportError("FILE_NOT_FOUND", MSG_FILE_NOT_FOUND)

    try:
        with p.open("rb") as fh:
            header = fh.read(64)
    except OSError as exc:
        raise SmartImportError("FILE_NOT_FOUND", MSG_FILE_NOT_FOUND) from exc

    if len(header) == 0:
        raise SmartImportError("CORRUPT_IMAGE", MSG_UNSUPPORTED_OR_CORRUPT)

    if _sniff_unsupported_magic(header) or not _is_supported_magic(header):
        raise SmartImportError("UNSUPPORTED_FORMAT", MSG_UNSUPPORTED_OR_CORRUPT)

    try:
        with Image.open(p) as im:
            fmt = str(im.format or "").upper()
            if fmt not in {"PNG", "JPEG", "MPO", "WEBP", "GIF", "BMP"}:
                raise SmartImportError("UNSUPPORTED_FORMAT", MSG_UNSUPPORTED_OR_CORRUPT)
            w, h = im.size
            if w <= 0 or h <= 0:
                raise SmartImportError("CORRUPT_IMAGE", MSG_UNSUPPORTED_OR_CORRUPT)

            n_frames = int(getattr(im, "n_frames", 1) or 1)
            is_animated = n_frames > 1 and fmt in {"GIF", "WEBP"}

            im.seek(0)
            im.load()
            if not is_animated:
                try:
                    im_oriented = ImageOps.exif_transpose(im)
                except Exception:
                    im_oriented = im
                w, h = im_oriented.size
                frame0 = im_oriented.convert("RGBA")
            else:
                frame0 = im.convert("RGBA")

            if is_animated:
                # If frame 0 happens to be empty, pick the first visible frame for preview/color
                arr0 = np.array(frame0, dtype=np.uint8)
                if not np.any(arr0[:, :, 3] > 16):
                    for fi in range(1, min(n_frames, 16)):
                        im.seek(fi)
                        im.load()
                        cand = im.convert("RGBA")
                        arr_c = np.array(cand, dtype=np.uint8)
                        if np.any(arr_c[:, :, 3] > 16):
                            frame0 = cand
                            break
    except SmartImportError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError, EOFError) as exc:
        raise SmartImportError("CORRUPT_IMAGE", MSG_UNSUPPORTED_OR_CORRUPT) from exc

    return LoadedImage(
        rgba=frame0,
        is_animated=is_animated,
        n_frames=n_frames,
        size=(w, h),
        orig_format=fmt,
        path=p,
        name=name or p.name,
        role_hint=role_hint,
    )


def _sample_border_background(arr: np.ndarray) -> tuple[bool, tuple[int, int, int], float, str]:
    """Inspect outer border to classify transparent, green-screen, or uniform solid backdrop."""
    h, w, _ = arr.shape
    ring_y = min(2, max(1, h // 100))
    ring_x = min(2, max(1, w // 100))

    border_chunks = [
        arr[:ring_y, :, :].reshape(-1, 4),
        arr[h - ring_y :, :, :].reshape(-1, 4),
        arr[:, :ring_x, :].reshape(-1, 4),
        arr[:, w - ring_x :, :].reshape(-1, 4),
    ]
    border = np.concatenate(border_chunks, axis=0)
    total = max(1, len(border))

    alpha = border[:, 3]
    trans_cnt = int((alpha < 16).sum())
    opaque = border[alpha >= 16]

    if len(opaque) == 0:
        return True, (0, 0, 0), 0.0, "transparent"

    rgb_op = opaque[:, :3].astype(np.int32)
    r_op, g_op, b_op = rgb_op[:, 0], rgb_op[:, 1], rgb_op[:, 2]
    green_cnt = int(((g_op >= 100) & ((g_op - np.maximum(r_op, b_op)) >= 38) & (r_op <= 175) & (b_op <= 175)).sum())

    if trans_cnt > total * 0.25 and green_cnt < total * 0.15:
        return True, (0, 0, 0), 0.0, "transparent"

    # Quantize opaque border pixels into 12-unit bins to locate dominant backdrop color
    bins = rgb_op // 12
    packed = (bins[:, 0] << 16) | (bins[:, 1] << 8) | bins[:, 2]
    uniq, counts = np.unique(packed, return_counts=True)
    mode_packed = int(uniq[int(np.argmax(counts))])
    mr = ((mode_packed >> 16) & 0xFF) * 12 + 6
    mg = ((mode_packed >> 8) & 0xFF) * 12 + 6
    mb = (mode_packed & 0xFF) * 12 + 6

    dist_mode = np.sqrt((r_op - mr) ** 2 + (g_op - mg) ** 2 + (b_op - mb) ** 2)
    cluster = rgb_op[dist_mode <= 38.0]
    if len(cluster) == 0:
        cluster = rgb_op

    med = np.rint(np.median(cluster, axis=0)).astype(int)
    kr, kg, kb = int(med[0]), int(med[1]), int(med[2])
    dist_med = np.sqrt((cluster[:, 0] - kr) ** 2 + (cluster[:, 1] - kg) ** 2 + (cluster[:, 2] - kb) ** 2)
    p90 = float(np.percentile(dist_med, 90)) if len(dist_med) > 0 else 8.0

    bg_g_dom = kg - max(kr, kb)
    if (kg >= 100 and bg_g_dom >= 34) or green_cnt >= total * 0.20:
        if bg_g_dom < 34:
            return False, (0, 255, 0), p90, "green"
        return False, (kr, kg, kb), p90, "green"

    return False, (kr, kg, kb), p90, "solid"


def _edge_despill_green(rgba: Image.Image, key_rgb: tuple[int, int, int], radius: int = 2, strength: float = 0.9) -> Image.Image:
    """Linear-light chroma green spill suppression limited strictly to alpha boundary."""
    arr = np.array(rgba.convert("RGBA"), dtype=np.uint8)
    alpha = arr[:, :, 3]
    visible = alpha > 0
    if not np.any(visible):
        return rgba

    trans = ~visible
    near_trans = ndimage.binary_dilation(trans, iterations=radius) & visible
    if not np.any(near_trans):
        return rgba

    rgb_f = arr[:, :, :3].astype(np.float32) / 255.0
    lin = np.where(rgb_f <= 0.04045, rgb_f / 12.92, ((rgb_f + 0.055) / 1.055) ** 2.4)

    r_u = arr[:, :, 0].astype(np.int32)
    g_u = arr[:, :, 1].astype(np.int32)
    b_u = arr[:, :, 2].astype(np.int32)
    max_rb = np.maximum(r_u, b_u)

    kr, kg, kb = [c / 255.0 for c in key_rgb]
    key_lin = np.array([
        c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        for c in (kr, kg, kb)
    ], dtype=np.float32)
    k_chroma = key_lin - key_lin.mean()
    k_norm = float(np.sqrt(np.sum(k_chroma ** 2))) + 1e-8

    mean_lin = lin.mean(axis=2, keepdims=True)
    chroma_lin = lin - mean_lin
    dot = np.sum(chroma_lin * k_chroma[None, None, :], axis=2)
    c_norm = np.sqrt(np.sum(chroma_lin ** 2, axis=2)) + 1e-8
    sim = dot / (c_norm * k_norm)

    spill_mask = near_trans & (((alpha < 250) & ((g_u - max_rb) > 4)) | (sim >= 0.56))
    if not np.any(spill_mask):
        return rgba

    solid_fg = visible & (~spill_mask)
    if not np.any(solid_fg):
        return rgba

    valid_f = solid_fg.astype(np.float32)
    sum_lin = np.zeros_like(lin)
    for ch in range(3):
        sum_lin[:, :, ch] = ndimage.uniform_filter(lin[:, :, ch] * valid_f, size=5, mode="constant")
    cnt_f = ndimage.uniform_filter(valid_f, size=5, mode="constant")

    has_ref = spill_mask & (cnt_f > 1e-4)
    out_lin = lin.copy()
    if np.any(has_ref):
        ref = sum_lin[has_ref] / cnt_f[has_ref, None]
        out_lin[has_ref] = lin[has_ref] + (ref - lin[has_ref]) * strength

    no_ref = spill_mask & (~has_ref)
    if np.any(no_ref):
        lum = mean_lin[no_ref]
        out_lin[no_ref] = lin[no_ref] + (lum - lin[no_ref]) * strength

    out_lin = np.clip(out_lin, 0.0, 1.0)
    srgb = np.where(out_lin <= 0.0031308, out_lin * 12.92, 1.055 * (out_lin ** (1.0 / 2.4)) - 0.055)
    out = arr.copy()
    out[:, :, :3] = np.clip(np.rint(srgb * 255.0), 0, 255).astype(np.uint8)
    out[alpha == 0] = (0, 0, 0, 0)
    return Image.fromarray(out, "RGBA")


def _defringe_solid_edges(arr: np.ndarray, bg_rgb: tuple[int, int, int], fringe_mask: np.ndarray, thr: float) -> np.ndarray:
    """1px anti-aliased alpha feather + backdrop-spill color decontamination on solid cutouts."""
    out = arr.copy()
    alpha = out[:, :, 3].astype(np.float32)
    visible = alpha > 0
    if not np.any(visible) or not np.any(fringe_mask):
        return out

    kr, kg, kb = bg_rgb
    rgb = out[:, :, :3].astype(np.float32)
    dist = np.sqrt((rgb[:, :, 0] - kr) ** 2 + (rgb[:, :, 1] - kg) ** 2 + (rgb[:, :, 2] - kb) ** 2)

    soft_band = fringe_mask & visible & (dist <= thr * 2.25)
    if np.any(soft_band):
        ramp = np.clip((dist[soft_band] - thr * 0.65) / max(1.0, thr * 1.55), 0.14, 1.0)
        alpha[soft_band] = np.minimum(alpha[soft_band], ramp * 255.0)

    trans = (alpha <= 8).astype(np.int32)
    t_neighbors = (
        np.roll(trans, 1, axis=0)
        + np.roll(trans, -1, axis=0)
        + np.roll(trans, 1, axis=1)
        + np.roll(trans, -1, axis=1)
    )
    hard_aa = fringe_mask & (alpha >= 235) & (t_neighbors >= 2)
    if np.any(hard_aa):
        alpha[hard_aa] = np.minimum(alpha[hard_aa], 218.0)

    interior = (alpha >= 242) & (~fringe_mask)
    decontam = fringe_mask & (alpha > 8) & ((alpha < 245) | (dist <= thr * 2.25))
    if np.any(interior) and np.any(decontam):
        valid_f = interior.astype(np.float32)
        cnt_f = ndimage.uniform_filter(valid_f, size=3, mode="constant")
        has_ref = decontam & (cnt_f > 1e-4)
        if np.any(has_ref):
            for ch in range(3):
                mean_fg = ndimage.uniform_filter(rgb[:, :, ch] * valid_f, size=3, mode="constant")
                fg_est = mean_fg[has_ref] / cnt_f[has_ref]
                w = np.clip(1.0 - (alpha[has_ref] / 255.0) * 0.65, 0.35, 0.90)
                rgb[has_ref, ch] = rgb[has_ref, ch] * (1.0 - w) + fg_est * w

    out[:, :, :3] = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)
    out[:, :, 3] = np.where(alpha <= 10.0, 0, np.clip(np.rint(alpha), 0, 255)).astype(np.uint8)
    out[out[:, :, 3] == 0] = (0, 0, 0, 0)
    return out


_CACHED_VISION_BIN: Path | None | bool = False


def _ensure_vision_cutout_binary() -> Path | None:
    """Return compiled macOS Apple Vision subject-lift helper binary (auto-compiling once if needed)."""
    global _CACHED_VISION_BIN
    if _CACHED_VISION_BIN is not False:
        return _CACHED_VISION_BIN if isinstance(_CACHED_VISION_BIN, Path) else None

    if sys.platform != "darwin":
        _CACHED_VISION_BIN = None
        return None

    cache_dir = Path.home() / ".hachimi-pet" / "cache"
    bin_path = cache_dir / "vision-cutout"
    swift_src = Path(__file__).resolve().with_name("vision-cutout.swift")

    try:
        if bin_path.is_file() and os.access(bin_path, os.X_OK):
            if not swift_src.is_file() or bin_path.stat().st_mtime >= swift_src.stat().st_mtime - 1.0:
                _CACHED_VISION_BIN = bin_path
                return bin_path

        if not swift_src.is_file():
            _CACHED_VISION_BIN = None
            return None

        cache_dir.mkdir(parents=True, exist_ok=True)
        tmp_bin = cache_dir / f"vision-cutout.{os.getpid()}.tmp"
        res = subprocess.run(
            ["swiftc", "-O", str(swift_src), "-o", str(tmp_bin)],
            capture_output=True,
            text=True,
            timeout=45,
        )
        if res.returncode == 0 and tmp_bin.is_file():
            tmp_bin.chmod(0o755)
            tmp_bin.replace(bin_path)
            _CACHED_VISION_BIN = bin_path
            return bin_path
        if tmp_bin.exists():
            tmp_bin.unlink(missing_ok=True)
    except Exception:
        pass

    _CACHED_VISION_BIN = None
    return None


def _run_vision_cutout_batch(
    jobs_spec: list[tuple[int, Image.Image, Path | None, bool]],
) -> dict[int, Image.Image]:
    """Run Apple Vision foreground instance mask segmentation on a batch of complex-backdrop images."""
    if not jobs_spec:
        return {}
    bin_path = _ensure_vision_cutout_binary()
    if bin_path is None:
        return {}

    out_map: dict[int, Image.Image] = {}
    try:
        with tempfile.TemporaryDirectory(prefix="hachimi-vision-") as tdir:
            tpath = Path(tdir)
            payload: list[dict[str, Any]] = []
            out_files: dict[int, Path] = {}

            for idx, rgba, orig_path, allow_multi in jobs_spec:
                if orig_path is not None and orig_path.is_file() and orig_path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}:
                    in_file = orig_path
                else:
                    in_file = tpath / f"in_{idx}.png"
                    rgba.save(in_file, format="PNG")
                out_file = tpath / f"out_{idx}.png"
                out_files[idx] = out_file
                payload.append({
                    "input": str(in_file),
                    "output": str(out_file),
                    "allowMultiple": bool(allow_multi),
                })

            cfg_file = tpath / "jobs.json"
            cfg_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            res = subprocess.run(
                [str(bin_path), str(cfg_file)],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if res.returncode != 0 or not res.stdout.strip():
                return {}

            parsed = json.loads(res.stdout.strip().splitlines()[-1])
            if not isinstance(parsed, list):
                return {}

            for (idx, _rgba, _orig, _am), item in zip(jobs_spec, parsed):
                if not isinstance(item, dict) or not item.get("ok"):
                    continue
                fg_ratio = float(item.get("fgRatio") or 0.0)
                out_f = out_files.get(idx)
                if out_f is not None and out_f.is_file() and 0.008 <= fg_ratio <= 0.95:
                    with Image.open(out_f) as cut_im:
                        cut_im.load()
                        arr_c = np.array(cut_im.convert("RGBA"), dtype=np.uint8)
                        arr_c[arr_c[:, :, 3] <= 10] = (0, 0, 0, 0)
                        out_map[idx] = Image.fromarray(arr_c, "RGBA")
    except Exception:
        return out_map

    return out_map


def _border_flood_remove_background(image: Image.Image) -> tuple[Image.Image, bool]:
    """Remove transparent, green-screen, white, or uniform backdrop; return (rgba, is_clean_uniform_bg)."""
    rgba = image.convert("RGBA")
    arr = np.array(rgba, dtype=np.uint8)
    alpha = arr[:, :, 3]

    is_trans, bg_rgb, border_p90, bg_kind = _sample_border_background(arr)
    if is_trans:
        cleaned = arr.copy()
        cleaned[alpha <= 8] = (0, 0, 0, 0)
        return Image.fromarray(cleaned, "RGBA"), True

    rgb = arr[:, :, :3].astype(np.int32)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    kr, kg, kb = bg_rgb
    dist = np.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2)

    if bg_kind == "green":
        max_rb = np.maximum(r, b)
        g_dom = g - max_rb
        bg_candidate = (alpha < 16) | ((dist <= 132.0) & (g_dom >= 32)) | (
            (g_dom >= 44) & (g >= 115) & (max_rb <= 220)
        )
        thr = 128.0
    else:
        thr = float(np.clip(border_p90 * 2.2 + 24.0, 26.0, 48.0))
        bg_chroma = max(kr, kg, kb) - min(kr, kg, kb)
        if bg_chroma <= 24:
            c_diff = np.maximum(
                np.maximum(np.abs((r - kr) - (g - kg)), np.abs((g - kg) - (b - kb))),
                np.abs((r - kr) - (b - kb)),
            )
            bg_candidate = (alpha < 16) | ((dist <= thr) & (c_diff <= 28))
        else:
            bg_candidate = (alpha < 16) | (dist <= thr)

    structure_8 = np.ones((3, 3), dtype=int)
    labeled, _ = ndimage.label(bg_candidate, structure=structure_8)

    border_ids: set[int] = set()
    border_ids.update(np.unique(labeled[0, :]).tolist())
    border_ids.update(np.unique(labeled[-1, :]).tolist())
    border_ids.update(np.unique(labeled[:, 0]).tolist())
    border_ids.update(np.unique(labeled[:, -1]).tolist())

    # Seed pure gutter columns and rows (>=98% background) so middle sheet regions stay reachable
    gutter_cols = np.where(bg_candidate.mean(axis=0) >= 0.98)[0]
    if len(gutter_cols) > 0:
        border_ids.update(np.unique(labeled[:, gutter_cols]).tolist())
    gutter_rows = np.where(bg_candidate.mean(axis=1) >= 0.98)[0]
    if len(gutter_rows) > 0:
        border_ids.update(np.unique(labeled[gutter_rows, :]).tolist())
    border_ids.discard(0)

    if not border_ids:
        return rgba, False

    bg_mask = np.isin(labeled, list(border_ids))
    if bg_kind == "green":
        max_rb = np.maximum(r, b)
        g_dom = g - max_rb
        if kg >= 180 and (kg - max(kr, kb)) >= 90:
            enclosed_exact_green = (g >= 185) & (g_dom >= 90) & (dist <= 65.0) & (~bg_mask)
            if np.any(enclosed_exact_green):
                bg_mask = bg_mask | enclosed_exact_green
    removed_frac = float(bg_mask.mean())
    dilated_1 = ndimage.binary_dilation(bg_mask, iterations=1)
    fringe_1 = dilated_1 & (~bg_mask)

    if bg_kind == "green":
        dilated_2 = ndimage.binary_dilation(bg_mask, iterations=2)
        fringe_2 = dilated_2 & (~dilated_1)
        new_alpha = alpha.astype(np.float64)
        new_alpha[bg_mask] = 0.0
        max_rb = np.maximum(r, b)
        g_dom = g - max_rb
        for mask, min_dom_cut, max_dist_cut in ((fringe_1, 8, 185.0), (fringe_2, 22, 145.0)):
            if not np.any(mask):
                continue
            f_dom = g_dom[mask]
            f_dist = dist[mask]
            is_matte = (f_dom >= min_dom_cut) & (f_dist <= max_dist_cut)
            if np.any(is_matte):
                non_g = max_rb[mask][is_matte].astype(np.float64)
                g_val = g[mask][is_matte].astype(np.float64)
                denom = np.maximum(max(1.0, float(kg)) - non_g, 1.0)
                dom_alpha = 1.0 - np.clip((g_val - non_g) / denom, 0.0, 1.0)
                ramp = np.clip((f_dist[is_matte] - 36.0) / 115.0, 0.0, 1.0)
                a_vals = np.minimum(dom_alpha, ramp) * 255.0
                a_vals = np.where(a_vals <= 14.0, 0.0, a_vals)
                cur = new_alpha[mask]
                cur[is_matte] = np.minimum(cur[is_matte], a_vals)
                new_alpha[mask] = cur

        out = arr.copy()
        out[:, :, 3] = np.clip(np.rint(new_alpha), 0, 255).astype(np.uint8)
        out[out[:, :, 3] == 0] = (0, 0, 0, 0)
        return _edge_despill_green(Image.fromarray(out, "RGBA"), bg_rgb, radius=2, strength=0.90), (removed_frac >= 0.10)

    out = arr.copy()
    out[bg_mask] = (0, 0, 0, 0)
    out = _defringe_solid_edges(out, bg_rgb, fringe_1, thr)

    fg_after = out[:, :, 3] > 24
    border_fg_frac = 0.25 * (
        float(fg_after[0, :].mean())
        + float(fg_after[-1, :].mean())
        + float(fg_after[:, 0].mean())
        + float(fg_after[:, -1].mean())
    )
    is_clean_uniform = (removed_frac >= 0.30) and (border_fg_frac <= 0.20) and (border_p90 <= 26.0)
    return Image.fromarray(out, "RGBA"), is_clean_uniform


def adaptive_remove_background(
    image: Image.Image,
    *,
    orig_path: Path | None = None,
    allow_multiple: bool = False,
) -> Image.Image:
    """Remove uniform studio/green/transparent backdrop, or lift real-world photo subject via Apple Vision."""
    flood_cut, is_clean = _border_flood_remove_background(image)
    if is_clean:
        return flood_cut

    vision_map = _run_vision_cutout_batch([(0, image.convert("RGBA"), orig_path, allow_multiple)])
    if 0 in vision_map:
        return vision_map[0]
    return flood_cut


def filter_isolated_noise(rgba: Image.Image, *, area_ratio_thresh: float = 0.008) -> Image.Image:
    """Remove <0.8% isolated noise specks and clearly detached text annotation remnants."""
    arr = np.array(rgba.convert("RGBA"), dtype=np.uint8)
    fg = arr[:, :, 3] > 16
    if not np.any(fg):
        return rgba

    labeled, num = ndimage.label(fg, structure=np.ones((3, 3), dtype=int))
    if num <= 1:
        return rgba

    counts = np.bincount(labeled.ravel())
    counts[0] = 0
    max_area = int(counts.max())
    if max_area <= 0:
        return rgba

    slices = ndimage.find_objects(labeled)
    main_cids = [cid for cid in range(1, num + 1) if counts[cid] >= 0.08 * max_area]
    if not main_cids:
        main_cids = [int(np.argmax(counts))]

    main_y0 = min(slices[c - 1][0].start for c in main_cids)
    main_y1 = max(slices[c - 1][0].stop for c in main_cids)
    main_h = max(1, main_y1 - main_y0)

    keep_mask = np.zeros(fg.shape, dtype=bool)
    min_keep = area_ratio_thresh * max_area

    for cid in range(1, num + 1):
        area = int(counts[cid])
        if area < min_keep:
            continue
        if area < 0.05 * max_area:
            sy, sx = slices[cid - 1]
            bh = sy.stop - sy.start
            bw = sx.stop - sx.start
            gap_above = main_y0 - sy.stop
            gap_below = sy.start - main_y1
            if max(gap_above, gap_below) > max(10, int(0.03 * main_h)):
                fill_ratio = area / max(1, bw * bh)
                if (bw / max(1, bh) >= 1.8) or fill_ratio < 0.45:
                    continue
        keep_mask |= labeled == cid

    out = arr.copy()
    out[~keep_mask] = (0, 0, 0, 0)
    return Image.fromarray(out, "RGBA")


def _crop_tight(img: Image.Image) -> Image.Image:
    bb = img.getbbox()
    return img.crop(bb) if bb else img


def _has_visible_foreground(rgba: Image.Image, min_pixels: int = 12) -> bool:
    arr = np.array(rgba.convert("RGBA"), dtype=np.uint8)
    return int((arr[:, :, 3] > 16).sum()) >= min_pixels


def _detect_grid_layout(keyed: Image.Image) -> str | None:
    """Detect whether a single image is an 8x11 or 4x3 spritesheet with clean internal grid gutters."""
    arr = np.array(keyed.convert("RGBA"), dtype=np.uint8)
    h, w, _ = arr.shape
    fg = arr[:, :, 3] > 20
    if int(fg.sum()) < 64:
        return None

    def check_grid(cols: int, rows: int, min_w: int, min_h: int, min_pop: int, min_rows: int, min_cols: int) -> bool:
        if w < min_w or h < min_h:
            return False
        cell_w = w / float(cols)
        cell_h = h / float(rows)
        cell_ratio = cell_w / max(1.0, cell_h)
        if cell_ratio < 0.58 or cell_ratio > 1.55:
            return False

        # Check vertical seams around column boundaries
        tol_x = max(1, int(0.03 * cell_w))
        clean_v = 0
        for c in range(1, cols):
            cx = round(c * w / cols)
            x0 = max(0, cx - tol_x)
            x1 = min(w - 1, cx + tol_x)
            best_v = 1.0
            for x in range(x0, x1 + 1):
                xa, xb = max(0, x - 1), min(w, x + 2)
                dens = float(fg[:, xa:xb].mean())
                if dens < best_v:
                    best_v = dens
            if best_v <= 0.03:
                clean_v += 1

        # Check horizontal seams around row boundaries
        tol_y = max(1, int(0.03 * cell_h))
        clean_h = 0
        for r in range(1, rows):
            ry = round(r * h / rows)
            y0 = max(0, ry - tol_y)
            y1 = min(h - 1, ry + tol_y)
            best_h = 1.0
            for y in range(y0, y1 + 1):
                ya, yb = max(0, y - 1), min(h, y + 2)
                dens = float(fg[ya:yb, :].mean())
                if dens < best_h:
                    best_h = dens
            if best_h <= 0.03:
                clean_h += 1

        if clean_v < (cols - 1) - (1 if cols >= 8 else 0):
            return False
        if clean_h < (rows - 1) - (2 if rows >= 11 else 0):
            return False

        pop_cells = 0
        pop_rows = set()
        pop_cols = set()
        min_cell_px = max(18, int(0.015 * cell_w * cell_h))
        fills: list[float] = []
        for r in range(rows):
            y0 = round(r * h / rows)
            y1 = round((r + 1) * h / rows)
            for c in range(cols):
                x0 = round(c * w / cols)
                x1 = round((c + 1) * w / cols)
                sub = fg[y0:y1, x0:x1]
                cnt = int(sub.sum())
                if cnt >= min_cell_px:
                    pop_cells += 1
                    pop_rows.add(r)
                    pop_cols.add(c)
                    fills.append(cnt / max(1.0, float((y1 - y0) * (x1 - x0))))

        if pop_cells < min_pop or len(pop_rows) < min_rows or len(pop_cols) < min_cols:
            return False
        med_fill = float(np.median(fills)) if fills else 0.0
        return 0.03 <= med_fill <= 0.88

    if check_grid(8, 11, 512, 704, 28, 6, 5):
        return "grid-8x11"
    if check_grid(4, 3, 320, 240, 10, 3, 4):
        return "grid-4x3"
    return None


def _split_horizontal_band(band_arr: np.ndarray, *, depth: int = 0) -> list[Image.Image]:
    """Split a horizontal foreground band into 1..4 distinct views while guarding single wide poses."""
    sub_fg = band_arr[:, :, 3] > 16
    if not np.any(sub_fg):
        return []
    h_fg, w_fg = sub_fg.shape
    aspect = w_fg / max(1.0, float(h_fg))

    col_mass = sub_fg.sum(axis=0)
    total_mass = max(1, int(col_mass.sum()))
    valley_thresh = max(1, int(0.012 * h_fg))

    # Pass 1: Clean vertical gutter intervals
    raw_intervals: list[tuple[int, int]] = []
    in_seg = False
    seg_start = 0
    for x in range(w_fg):
        if col_mass[x] > valley_thresh:
            if not in_seg:
                in_seg = True
                seg_start = x
        elif in_seg:
            raw_intervals.append((seg_start, x))
            in_seg = False
    if in_seg:
        raw_intervals.append((seg_start, w_fg))

    if len(raw_intervals) >= 2:
        min_gutter_px = max(2, int(0.004 * w_fg))
        intervals: list[tuple[int, int]] = [raw_intervals[0]]
        for a, b in raw_intervals[1:]:
            prev_a, prev_b = intervals[-1]
            if (a - prev_b) < min_gutter_px:
                intervals[-1] = (prev_a, b)
            else:
                intervals.append((a, b))

        def measure(iv: tuple[int, int]) -> tuple[int, int, int]:
            a, b = iv
            block_fg = sub_fg[:, a:b]
            area = int(block_fg.sum())
            bys, _ = np.where(block_fg)
            bh = (int(bys.max()) - int(bys.min()) + 1) if len(bys) > 0 else 0
            bw = b - a
            return area, bw, bh

        stats = [measure(iv) for iv in intervals]
        max_area = max(s[0] for s in stats)
        max_bh = max(s[2] for s in stats)
        major_indices = [
            i for i, (area, _bw, bh) in enumerate(stats)
            if area >= 0.18 * max_area and bh >= 0.45 * max_bh
        ]
        if len(major_indices) in (2, 3, 4):
            buckets: dict[int, list[tuple[int, int]]] = {m: [intervals[m]] for m in major_indices}
            for i, iv in enumerate(intervals):
                if i in buckets:
                    continue
                center_i = 0.5 * (iv[0] + iv[1])
                nearest_m = min(
                    major_indices,
                    key=lambda m: min(abs(center_i - intervals[m][0]), abs(center_i - intervals[m][1])),
                )
                buckets[nearest_m].append(iv)

            merged_intervals = sorted(
                (min(iv[0] for iv in b_ivs), max(iv[1] for iv in b_ivs))
                for b_ivs in buckets.values()
            )
            gutters_ok = True
            for k in range(len(merged_intervals) - 1):
                a0, b0 = merged_intervals[k]
                a1, b1 = merged_intervals[k + 1]
                gap = a1 - b0
                if a1 <= b0 or gap < min_gutter_px or int(col_mass[b0:a1].min()) > valley_thresh or float(col_mass[b0:a1].mean()) > valley_thresh * 1.5:
                    gutters_ok = False
                    break

            if gutters_ok:
                m_stats = [measure(iv) for iv in merged_intervals]
                areas = [s[0] for s in m_stats]
                widths = [s[1] for s in m_stats]
                heights = [s[2] for s in m_stats]
                min_share = 0.10 if len(merged_intervals) == 4 else 0.12
                if (
                    min(areas) / max(1, max(areas)) >= 0.20
                    and min(heights) / max(1, max(heights)) >= 0.45
                    and min(widths) / max(1, max(widths)) >= 0.22
                    and min(areas) >= min_share * total_mass
                    and min(widths) >= min_share * w_fg
                ):
                    views: list[Image.Image] = []
                    for x_a, x_b in merged_intervals:
                        cleaned = filter_isolated_noise(Image.fromarray(band_arr[:, x_a:x_b].copy(), "RGBA"))
                        tight = _crop_tight(cleaned)
                        if tight.getbbox():
                            views.append(tight)
                    if len(views) in (2, 3, 4):
                        return views

    # Pass 2: 2D connected components + mild progressive erosion to separate touching paws/tails
    work_scale = min(1.0, 160.0 / max(1, h_fg))
    wh = max(16, round(h_fg * work_scale))
    ww = max(16, round(w_fg * work_scale))
    if work_scale < 1.0:
        work_mask = np.array(
            Image.fromarray((sub_fg.astype(np.uint8) * 255), "L").resize((ww, wh), Image.Resampling.NEAREST)
        ) > 127
    else:
        work_mask = sub_fg

    work_col_mass = work_mask.sum(axis=0).astype(np.float32)
    er_levels = [0] if aspect < 1.32 else [0, 1, 2, 3, 4, 5]
    for er in er_levels:
        m = work_mask if er == 0 else ndimage.binary_erosion(work_mask, iterations=er)
        if not np.any(m):
            break
        lbl_w, n_w = ndimage.label(m, structure=np.ones((3, 3), dtype=int))
        if n_w < 2:
            continue
        cnts = np.bincount(lbl_w.ravel())
        cnts[0] = 0
        max_c = int(cnts.max())
        if max_c <= 0:
            continue
        slices = ndimage.find_objects(lbl_w)
        maj: list[tuple[int, int, int, int, float]] = []
        max_bh_seen = 0
        raw_cands: list[tuple[int, int, int, int, float]] = []
        for cid in range(1, n_w + 1):
            area_c = int(cnts[cid])
            if area_c < 0.18 * max_c:
                continue
            sy, sx = slices[cid - 1]
            bh_c = sy.stop - sy.start
            bw_c = sx.stop - sx.start
            cx_c = 0.5 * (sx.start + sx.stop)
            max_bh_seen = max(max_bh_seen, bh_c)
            raw_cands.append((cid, area_c, bw_c, bh_c, cx_c))
        for cid, area_c, bw_c, bh_c, cx_c in raw_cands:
            if bh_c >= 0.45 * max(wh, max_bh_seen) and bw_c >= 0.14 * ww:
                asp_c = bw_c / max(1.0, float(bh_c))
                if 0.36 <= asp_c <= 2.35:
                    maj.append((cid, area_c, bw_c, bh_c, cx_c))

        if len(maj) not in (2, 3, 4):
            continue

        maj.sort(key=lambda item: item[4])
        # Verify horizontal separation and clean valley between neighboring components
        sep_ok = True
        for k in range(len(maj) - 1):
            _, _, bw_a, _, cx_a = maj[k]
            _, _, bw_b, _, cx_b = maj[k + 1]
            if (cx_b - cx_a) < 0.45 * min(bw_a, bw_b):
                sep_ok = False
                break
            if er > 0:
                x0_v, x1_v = max(0, int(cx_a)), min(ww, int(cx_b) + 1)
                if x1_v > x0_v + 1:
                    pk_a = float(work_col_mass[max(0, int(cx_a - bw_a * 0.45)) : min(ww, int(cx_a + bw_a * 0.45))].max(initial=1.0))
                    pk_b = float(work_col_mass[max(0, int(cx_b - bw_b * 0.45)) : min(ww, int(cx_b + bw_b * 0.45))].max(initial=1.0))
                    min_v = float(work_col_mass[x0_v:x1_v].min())
                    if min_v > 0.68 * min(pk_a, pk_b):
                        sep_ok = False
                        break
        if not sep_ok:
            continue

        # Propagate major seeds to original work_mask and measure seam touch
        seed_ids = [item[0] for item in maj]
        seed_w = np.isin(lbl_w, seed_ids)
        _, idx_w = ndimage.distance_transform_edt(~seed_w, return_indices=True)
        full_w = lbl_w[idx_w[0], idx_w[1]]
        full_w[~work_mask] = 0

        touch_w = 0
        for dy, dx in ((0, 1), (1, 0)):
            a_m = full_w[: wh - dy, : ww - dx]
            b_m = full_w[dy:, dx:]
            touch_w += int(((a_m > 0) & (b_m > 0) & (a_m != b_m)).sum())

        min_bh_w = min(item[3] for item in maj)
        max_touch_allowed = 0 if er == 0 else max(8, int(0.14 * min_bh_w))
        if touch_w > max_touch_allowed:
            continue

        # Map seed labels cleanly back to full resolution and propagate via EDT
        if work_scale < 1.0:
            seed_u8 = np.zeros((wh, ww), dtype=np.uint8)
            for new_id, orig_id in enumerate(seed_ids, start=1):
                seed_u8[lbl_w == orig_id] = new_id
            full_seed_lbl = np.array(
                Image.fromarray(seed_u8, "L").resize((w_fg, h_fg), Image.Resampling.NEAREST),
                dtype=np.int32,
            )
            full_seed_lbl[~sub_fg] = 0
            seed_bool = full_seed_lbl > 0
            if not np.any(seed_bool):
                continue
            _, idx_full = ndimage.distance_transform_edt(~seed_bool, return_indices=True)
            full_lbl = full_seed_lbl[idx_full[0], idx_full[1]]
            full_lbl[~sub_fg] = 0
            ordered_ids = list(range(1, len(seed_ids) + 1))
        else:
            _, idx_full = ndimage.distance_transform_edt(~seed_w, return_indices=True)
            full_lbl = lbl_w[idx_full[0], idx_full[1]]
            full_lbl[~sub_fg] = 0
            ordered_ids = seed_ids

        extracted: list[Image.Image] = []
        for cid in ordered_ids:
            cmask = full_lbl == cid
            if not np.any(cmask):
                continue
            cys, cxs = np.where(cmask)
            cy0, cy1 = int(cys.min()), int(cys.max()) + 1
            cx0, cx1 = int(cxs.min()), int(cxs.max()) + 1
            piece = band_arr[cy0:cy1, cx0:cx1].copy()
            piece[~cmask[cy0:cy1, cx0:cx1]] = (0, 0, 0, 0)
            cleaned = filter_isolated_noise(Image.fromarray(piece, "RGBA"))
            tight = _crop_tight(cleaned)
            if tight.getbbox():
                if depth == 0 and len(ordered_ids) == 2 and (tight.width / max(1.0, float(tight.height))) >= 1.50:
                    sub_arr = np.array(tight, dtype=np.uint8)
                    sub_views = _split_horizontal_band(sub_arr, depth=1)
                    extracted.extend(sub_views if len(sub_views) >= 2 else [tight])
                else:
                    extracted.append(tight)
        if 2 <= len(extracted) <= 4:
            return extracted

    # Pass 3: Wide horizontal sheet valley fallback (e.g. slight horizontal foot/tail overlap)
    if aspect >= 2.20 and w_fg >= 120:
        smooth = ndimage.uniform_filter1d(col_mass.astype(np.float32), size=max(3, w_fg // 60))
        pk_max = float(smooth.max())
        if pk_max > 0:
            peaks: list[int] = []
            win = max(6, w_fg // 16)
            for x in range(win, w_fg - win):
                if smooth[x] >= 0.45 * pk_max and smooth[x] == float(smooth[x - win : x + win + 1].max()):
                    if not peaks or (x - peaks[-1]) >= max(18, w_fg // 6):
                        peaks.append(x)
            if 2 <= len(peaks) <= 4:
                cuts = [0]
                cuts_ok = True
                for k in range(len(peaks) - 1):
                    p0, p1 = peaks[k], peaks[k + 1]
                    vx = p0 + int(np.argmin(smooth[p0:p1]))
                    if smooth[vx] > 0.28 * min(smooth[p0], smooth[p1]):
                        cuts_ok = False
                        break
                    cuts.append(vx)
                cuts.append(w_fg)
                if cuts_ok:
                    v_views: list[Image.Image] = []
                    for k in range(len(cuts) - 1):
                        piece = band_arr[:, cuts[k] : cuts[k + 1]].copy()
                        cleaned = filter_isolated_noise(Image.fromarray(piece, "RGBA"))
                        tight = _crop_tight(cleaned)
                        if tight.getbbox():
                            v_views.append(tight)
                    if 2 <= len(v_views) <= 4:
                        areas = [int((np.array(v)[:, :, 3] > 16).sum()) for v in v_views]
                        heights = [v.height for v in v_views]
                        if min(areas) >= 0.20 * max(areas) and min(heights) >= 0.48 * max(heights):
                            return v_views

    tight_single = _crop_tight(Image.fromarray(band_arr, "RGBA"))
    return [tight_single] if tight_single.getbbox() else []


def _split_combined_views(sheet: Image.Image) -> list[Image.Image]:
    """Split 1 combined turnaround sheet (1x2..1x4 or 2x2) into 2..4 independent single views."""
    cleaned_sheet = filter_isolated_noise(sheet.convert("RGBA"))
    arr = np.array(cleaned_sheet, dtype=np.uint8)
    fg = arr[:, :, 3] > 16
    if not np.any(fg):
        return [cleaned_sheet]

    ys, xs = np.where(fg)
    if len(xs) == 0:
        return [cleaned_sheet]

    fx0, fx1 = int(xs.min()), int(xs.max()) + 1
    fy0, fy1 = int(ys.min()), int(ys.max()) + 1
    sub = arr[fy0:fy1, fx0:fx1]
    h_fg, w_fg, _ = sub.shape
    sub_fg = sub[:, :, 3] > 16

    # Check 2x2 turnaround grid first (two horizontal rows separated by a clean mid-band gutter)
    if h_fg >= 72 and w_fg >= 72 and 0.65 <= (w_fg / max(1.0, float(h_fg))) <= 1.85:
        row_mass = sub_fg.sum(axis=1)
        y_a, y_b = int(0.32 * h_fg), int(0.68 * h_fg)
        if y_b > y_a + 2:
            mid_slice = row_mass[y_a:y_b]
            gutter_y_rel = int(np.argmin(mid_slice))
            gutter_val = int(mid_slice[gutter_y_rel])
            if gutter_val <= max(1, int(0.015 * w_fg)):
                gy = y_a + gutter_y_rel
                top_sub = sub[:gy, :, :]
                bot_sub = sub[gy + 1 :, :, :]
                top_fg = top_sub[:, :, 3] > 16
                bot_fg = bot_sub[:, :, 3] > 16
                top_area = int(top_fg.sum())
                bot_area = int(bot_fg.sum())
                total_a = max(1, top_area + bot_area)
                if min(top_area, bot_area) >= 0.22 * total_a:
                    tys, txs = np.where(top_fg)
                    bys, bxs = np.where(bot_fg)
                    top_crop = top_sub[tys.min() : tys.max() + 1, txs.min() : txs.max() + 1]
                    bot_crop = bot_sub[bys.min() : bys.max() + 1, bxs.min() : bxs.max() + 1]
                    top_views = _split_horizontal_band(top_crop)
                    bot_views = _split_horizontal_band(bot_crop)
                    quad_views = top_views + bot_views
                    if 3 <= len(quad_views) <= 4:
                        q_areas = [int((np.array(v)[:, :, 3] > 16).sum()) for v in quad_views]
                        q_hs = [v.height for v in quad_views]
                        if min(q_areas) >= 0.18 * max(q_areas) and min(q_hs) >= 0.42 * max(q_hs):
                            return quad_views

    band_views = _split_horizontal_band(sub)
    if 2 <= len(band_views) <= 4:
        return band_views

    tight = _crop_tight(Image.fromarray(sub, "RGBA"))
    return [tight] if tight.getbbox() else [cleaned_sheet]


def _extract_pose_features(
    view_img: Image.Image,
    *,
    clipped_bottom: bool = False,
    clipped_sides: bool = False,
) -> PoseFeatures:
    """Extract mirror IoU, aspect ratio, inner facial contrast, and centroid/feature offset."""
    sp = _crop_tight(view_img.convert("RGBA"))
    w, h = sp.size
    if w < 4 or h < 4 or not sp.getbbox():
        return PoseFeatures(w, h, 1.0, 0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, clipped_bottom, clipped_sides)

    # Downscale very large sprites slightly for uniform scale-invariant feature analysis
    scale = min(1.0, 160.0 / max(w, h))
    nw = max(16, round(w * scale))
    nh = max(16, round(h * scale))
    work = sp.resize((nw, nh), Image.Resampling.BILINEAR) if scale < 1.0 else sp

    arr = np.array(work, dtype=np.uint8)
    alpha = arr[:, :, 3] > 24
    if not np.any(alpha):
        return PoseFeatures(w, h, w / max(1.0, float(h)), 0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, clipped_bottom, clipped_sides)

    ys, xs = np.where(alpha)
    area = int(len(xs))
    centroid_offset = abs(float(xs.mean()) / max(1.0, float(nw)) - 0.5)

    def best_aligned_mirror_iou(mask: np.ndarray, center_x: float, search_frac: float) -> float:
        mw = mask.shape[1]
        if mw < 2:
            return 1.0
        flip_m = mask[:, ::-1]
        dx0 = int(round(2.0 * center_x - (mw - 1)))
        rad = max(2, int(search_frac * mw))
        best = 0.0
        for dx in range(dx0 - rad, dx0 + rad + 1):
            if dx == 0:
                a1, a2 = mask, flip_m
            elif dx > 0:
                if dx >= mw:
                    continue
                a1, a2 = mask[:, dx:], flip_m[:, : mw - dx]
            else:
                k = -dx
                if k >= mw:
                    continue
                a1, a2 = mask[:, : mw - k], flip_m[:, k:]
            inter = int(np.logical_and(a1, a2).sum())
            union = int(np.logical_or(a1, a2).sum())
            # Penalize tiny overlap shifts by measuring over full mask area
            denom = max(1, int(mask.sum()) * 2 - inter)
            iou = inter / max(1, max(union, denom))
            if iou > best:
                best = iou
        return best

    # Full-body mirror IoU centered around foreground median x so a tail/prop doesn't misalign the torso
    cx_med = float(np.median(xs))
    best_body_iou = best_aligned_mirror_iou(alpha, cx_med, 0.14)

    # Upper head region (0..52% height) cropped horizontally to head core
    head_y1 = max(4, int(0.52 * nh))
    head_alpha_band = alpha[:head_y1, :]
    hys, hxs = np.where(head_alpha_band)
    if len(hxs) > 0:
        hx0, hx1 = int(hxs.min()), int(hxs.max()) + 1
        head_sub = head_alpha_band[:, hx0:hx1]
        cx_head_local = float(np.median(hxs)) - hx0
        head_mirror_iou = best_aligned_mirror_iou(head_sub, cx_head_local, 0.12)
        cx_head = float(np.median(hxs))
    else:
        head_mirror_iou = best_body_iou
        cx_head = cx_med

    lower_alpha = alpha[int(0.45 * nh) : max(int(0.48 * nh), int(0.92 * nh)), :]
    _, lxs = np.where(lower_alpha)
    cx_lower = float(np.median(lxs)) if len(lxs) > 0 else cx_med
    head_vs_lower_offset = abs(cx_head - cx_lower) / max(1.0, float(nw))

    # Inner facial texture contrast & left/right feature asymmetry inside eroded head interior (8%..42% height)
    fy0, fy1 = int(0.08 * nh), max(int(0.14 * nh), int(0.42 * nh))
    face_rgb = arr[fy0:fy1, :, :3].astype(np.float32) / 255.0
    face_alpha = alpha[fy0:fy1, :]
    lum = 0.299 * face_rgb[:, :, 0] + 0.587 * face_rgb[:, :, 1] + 0.114 * face_rgb[:, :, 2]
    gx = np.abs(np.diff(lum, axis=1, prepend=lum[:, :1]))
    gy = np.abs(np.diff(lum, axis=0, prepend=lum[:1, :]))
    grad = np.hypot(gx, gy)

    erosion_iters = max(1, min(4, round(min(nw, nh) * 0.045)))
    inner_face = ndimage.binary_erosion(face_alpha, iterations=erosion_iters)
    if int(inner_face.sum()) < 16:
        inner_face = ndimage.binary_erosion(face_alpha, iterations=1)
    if int(inner_face.sum()) < 8:
        inner_face = face_alpha

    if np.any(inner_face):
        vals_g = grad[inner_face]
        vals_l = lum[inner_face]
        edge_frac = float((vals_g > 0.08).mean())
        grad_mean = float(vals_g.mean())
        lum_std = float(vals_l.std())
        facial_contrast = 0.45 * edge_frac + 0.35 * min(1.0, grad_mean * 6.0) + 0.20 * min(1.0, lum_std * 3.0)

        split_x = int(round(cx_head))
        left_mask = inner_face[:, :split_x] if split_x > 0 else np.zeros((0, 0), dtype=bool)
        right_mask = inner_face[:, split_x:] if split_x < nw else np.zeros((0, 0), dtype=bool)
        left_e = float(grad[:, :split_x][left_mask].sum()) if split_x > 0 and np.any(left_mask) else 0.0
        right_e = float(grad[:, split_x:][right_mask].sum()) if split_x < nw and np.any(right_mask) else 0.0
        feat_asym = abs(left_e - right_e) / max(1e-4, left_e + right_e)
    else:
        facial_contrast = 0.0
        feat_asym = 0.0

    # Upper vs lower body width balance & bottom-zone contrast (distinguishes macro/top-down shots from grounded stances)
    def band_p90_span(mask_band: np.ndarray) -> float:
        _, bxs = np.where(mask_band)
        if len(bxs) < 4:
            return 0.0
        return float(np.percentile(bxs, 95) - np.percentile(bxs, 5)) + 1.0

    w_upper = band_p90_span(alpha[int(0.08 * nh) : max(int(0.14 * nh), int(0.42 * nh)), :])
    w_lower = band_p90_span(alpha[int(0.48 * nh) : max(int(0.54 * nh), int(0.92 * nh)), :])
    w_bot18 = band_p90_span(alpha[int(0.80 * nh) :, :])
    top_heavy_ratio = w_upper / max(4.0, w_lower) if w_lower > 0 else 1.5
    bottom_taper_ratio = w_bot18 / max(4.0, max(w_upper, w_lower))

    by0, by1 = int(0.62 * nh), max(int(0.68 * nh), int(0.95 * nh))
    bot_rgb = arr[by0:by1, :, :3].astype(np.float32) / 255.0
    bot_alpha = alpha[by0:by1, :]
    inner_bot = ndimage.binary_erosion(bot_alpha, iterations=max(1, erosion_iters - 1))
    if int(inner_bot.sum()) < 8:
        inner_bot = bot_alpha
    if np.any(inner_bot):
        blum = 0.299 * bot_rgb[:, :, 0] + 0.587 * bot_rgb[:, :, 1] + 0.114 * bot_rgb[:, :, 2]
        bgx = np.abs(np.diff(blum, axis=1, prepend=blum[:, :1]))
        bgy = np.abs(np.diff(blum, axis=0, prepend=blum[:1, :]))
        bgrad = np.hypot(bgx, bgy)
        bv_g = bgrad[inner_bot]
        bv_l = blum[inner_bot]
        bottom_contrast = 0.45 * float((bv_g > 0.08).mean()) + 0.35 * min(1.0, float(bv_g.mean()) * 6.0) + 0.20 * min(1.0, float(bv_l.std()) * 3.0)
    else:
        bottom_contrast = 0.0

    head_area_frac = float(alpha[:head_y1, :].sum()) / max(1, area)
    compact_fill = float(area) / max(1.0, float(nw * nh))
    full_rgb = arr[:, :, :3].astype(np.float32) / 255.0
    full_lum = 0.299 * full_rgb[:, :, 0] + 0.587 * full_rgb[:, :, 1] + 0.114 * full_rgb[:, :, 2]
    fgx = np.abs(np.diff(full_lum, axis=1, prepend=full_lum[:, :1]))
    fgy = np.abs(np.diff(full_lum, axis=0, prepend=full_lum[:1, :]))
    fgrad = np.hypot(fgx, fgy)
    er_body = ndimage.binary_erosion(alpha, iterations=max(1, min(3, round(min(nw, nh) * 0.03))))
    if int(er_body.sum()) < 16:
        er_body = alpha
    sharpness = float(np.percentile(fgrad[er_body], 90)) if np.any(er_body) else 0.0

    if np.any(inner_face):
        lum_p90 = float(np.percentile(lum[inner_face], 90))
        lum_p30 = float(np.percentile(lum[inner_face], 30))
        eye_highlight_score = float(np.clip(lum_p90 - lum_p30, 0.0, 1.0))
    else:
        eye_highlight_score = 0.0

    return PoseFeatures(
        width=w,
        height=h,
        aspect=w / max(1.0, float(h)),
        area=area,
        head_mirror_iou=head_mirror_iou,
        body_mirror_iou=best_body_iou,
        facial_contrast=facial_contrast,
        feat_asym=feat_asym,
        head_vs_lower_offset=head_vs_lower_offset,
        centroid_offset=centroid_offset,
        clipped_bottom=clipped_bottom,
        clipped_sides=clipped_sides,
        top_heavy_ratio=top_heavy_ratio,
        bottom_contrast=bottom_contrast,
        bottom_taper_ratio=bottom_taper_ratio,
        head_area_frac=head_area_frac,
        compact_fill=compact_fill,
        sharpness=sharpness,
        eye_highlight_score=eye_highlight_score,
    )


def _silhouette_iou(a_img: Image.Image, b_img: Image.Image) -> float:
    sz = 64
    a = np.array(_crop_tight(a_img).resize((sz, sz), Image.Resampling.BILINEAR))[:, :, 3] > 24
    b = np.array(_crop_tight(b_img).resize((sz, sz), Image.Resampling.BILINEAR))[:, :, 3] > 24
    inter = int(np.logical_and(a, b).sum())
    union = int(np.logical_or(a, b).sum())
    return inter / max(1, union)


def _is_single_pose_more_like_side(f: PoseFeatures) -> bool:
    if f.feat_asym > 0.28 and (f.head_mirror_iou < 0.80 or f.head_vs_lower_offset > 0.06):
        return True
    if f.head_mirror_iou < 0.68 and f.body_mirror_iou < 0.68 and f.feat_asym > 0.16:
        return True
    return False


def _detect_side_orientation_detail(side_img: Image.Image) -> tuple[bool, float, str]:
    """Determine whether a side-view sprite faces +X right (True) or -X left (False), with margin & reason."""
    sp = _crop_tight(side_img.convert("RGBA"))
    arr = np.array(sp, dtype=np.uint8)
    h, w, _ = arr.shape
    alpha = arr[:, :, 3] > 16
    if not np.any(alpha) or w < 4 or h < 4:
        return True, 0.0, "默认朝向右侧"

    ys, xs = np.where(alpha)
    cx_all = float(xs.mean())

    head_mask = alpha[: max(2, int(h * 0.44)), :]
    lower_mask = alpha[int(h * 0.44) : max(int(h * 0.46), int(h * 0.92)), :]

    _, hx = np.where(head_mask)
    _, lx = np.where(lower_mask)
    cx_head = float(hx.mean()) if len(hx) > 0 else cx_all
    cx_lower = float(lx.mean()) if len(lx) > 0 else cx_all
    head_vs_lower = (cx_head - cx_lower) / max(1.0, float(w))

    hy0, hy1 = int(h * 0.08), max(int(h * 0.12), int(h * 0.46))
    head_arr = arr[hy0:hy1, :, :]
    lum = (0.299 * head_arr[:, :, 0] + 0.587 * head_arr[:, :, 1] + 0.114 * head_arr[:, :, 2]) / 255.0
    gx = np.abs(np.diff(lum, axis=1, prepend=lum[:, :1]))
    gy = np.abs(np.diff(lum, axis=0, prepend=lum[:1, :]))
    grad = np.hypot(gx, gy)
    inner_head = ndimage.binary_erosion(alpha[hy0:hy1, :], iterations=max(1, min(3, w // 25)))
    if not np.any(inner_head):
        inner_head = alpha[hy0:hy1, :]
    head_split = int(round(cx_head))
    left_feat = float(grad[:, :head_split][inner_head[:, :head_split]].sum()) if head_split > 0 and np.any(inner_head[:, :head_split]) else 0.0
    right_feat = float(grad[:, head_split:][inner_head[:, head_split:]].sum()) if head_split < w and np.any(inner_head[:, head_split:]) else 0.0
    feat_bias = (right_feat - left_feat) / max(1e-3, right_feat + left_feat)

    # Bright eye/muzzle highlight centroid inside head interior (distinguishes facial side from back of head)
    bright_face_bias = 0.0
    if np.any(inner_head):
        ih_lum = lum[inner_head]
        hi_thresh = float(np.percentile(ih_lum, 82))
        hi_mask = inner_head & (lum >= hi_thresh)
        _, b_xs = np.where(hi_mask)
        if len(b_xs) >= 4:
            bright_face_bias = (float(b_xs.mean()) - cx_head) / max(1.0, float(w))

    m_rows = alpha[int(h * 0.26) : max(int(h * 0.28), int(h * 0.44)), :]
    u_rows = alpha[int(h * 0.10) : max(int(h * 0.12), int(h * 0.24)), :]
    _, mx = np.where(m_rows)
    _, ux = np.where(u_rows)
    muzzle_bias = 0.0
    if len(mx) > 0 and len(ux) > 0:
        r_protrude = (float(mx.max()) - cx_head) - (float(ux.max()) - cx_head)
        l_protrude = (cx_head - float(mx.min())) - (cx_head - float(ux.min()))
        muzzle_bias = (r_protrude - l_protrude) / max(1.0, float(w))

    feet_mask = alpha[int(h * 0.86) :, :]
    _, fx = np.where(feet_mask)
    feet_bias = ((float(fx.mean()) - 0.5 * w) / max(1.0, float(w))) if len(fx) > 0 else 0.0

    score = 2.8 * head_vs_lower + 1.5 * feat_bias + 1.8 * bright_face_bias + 1.2 * muzzle_bias + 0.4 * feet_bias
    faces_right = score >= 0.0
    dir_cn = "右侧" if faces_right else "左侧"
    return faces_right, abs(score), f"头部重心与面部亮区偏向{dir_cn}"


def detect_side_faces_right(side_img: Image.Image) -> bool:
    """Heuristically determine whether a side-view sprite faces +X right (True) or -X left (False)."""
    faces_right, _margin, _reason = _detect_side_orientation_detail(side_img)
    return faces_right


def make_back_silhouette(front: Image.Image) -> Image.Image:
    """Create a soft fur-toned rear silhouette from front view (no facial features on the back)."""
    sp = _crop_tight(front.convert("RGBA"))
    arr = np.array(sp, dtype=np.uint8)
    alpha = arr[:, :, 3]
    vis = alpha > 24
    if not np.any(vis):
        return sp

    rgb = arr[:, :, :3].astype(np.float32)
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    coat_mask = vis & (lum > 45.0)
    if np.sum(coat_mask) < 20:
        coat_mask = vis
    coat_rgb = np.median(rgb[coat_mask], axis=0)
    rear_base = np.clip(coat_rgb * 0.88, 28.0, 235.0)

    h, w, _ = arr.shape
    grad_y = np.linspace(1.03, 0.88, h, dtype=np.float32)[:, None, None]
    fill = np.clip(rear_base[None, None, :] * grad_y, 20.0, 240.0)

    rim_iters = max(2, round(max(h, w) / 95.0))
    eroded = ndimage.binary_erosion(vis, iterations=rim_iters)
    outer_rim = vis & (~eroded)
    rim_rgb = np.clip(coat_rgb * 0.24, 22.0, 48.0)

    out = np.zeros_like(arr)
    out[:, :, :3] = np.rint(fill).astype(np.uint8)
    soft_rgb = Image.fromarray(out[:, :, :3], "RGB").filter(ImageFilter.GaussianBlur(radius=0.7))
    out[:, :, :3] = np.array(soft_rgb)
    out[outer_rim, :3] = np.rint(rim_rgb).astype(np.uint8)
    out[:, :, 3] = alpha
    out[alpha == 0] = (0, 0, 0, 0)
    return Image.fromarray(out, "RGBA")


def extract_suggested_color(front: Image.Image) -> str:
    """Extract a soft yet vivid saturated representative #RRGGBB accent color from foreground."""
    arr = np.array(front.convert("RGBA"), dtype=np.uint8)
    fg = arr[:, :, 3] > 180
    if not np.any(fg):
        return "#708D3D"

    pts = arr[fg][:, :3]
    if len(pts) > 8000:
        step = max(1, len(pts) // 8000)
        pts = pts[::step]

    rf = pts[:, 0].astype(np.float32) / 255.0
    gf = pts[:, 1].astype(np.float32) / 255.0
    bf = pts[:, 2].astype(np.float32) / 255.0

    cmax = np.maximum(np.maximum(rf, gf), bf)
    cmin = np.minimum(np.minimum(rf, gf), bf)
    delta = cmax - cmin

    sat = np.where(cmax > 1e-4, delta / np.maximum(cmax, 1e-4), 0.0)
    val = cmax

    hue = np.zeros_like(cmax)
    nz = delta > 1e-4
    r_m = nz & (cmax == rf)
    g_m = nz & (cmax == gf) & (~r_m)
    b_m = nz & (~r_m) & (~g_m)
    hue[r_m] = ((gf[r_m] - bf[r_m]) / delta[r_m]) % 6.0
    hue[g_m] = (bf[g_m] - rf[g_m]) / delta[g_m] + 2.0
    hue[b_m] = (rf[b_m] - gf[b_m]) / delta[b_m] + 4.0
    hue = (hue / 6.0) % 1.0

    chroma_mask = (sat >= 0.22) & (val >= 0.18) & ~((sat < 0.15) & (val > 0.95))
    if np.sum(chroma_mask) < max(12, int(len(pts) * 0.015)):
        chroma_mask = (sat >= 0.18) & (val >= 0.16)

    if np.sum(chroma_mask) < 10:
        return "#708D3D"

    h_c = hue[chroma_mask]
    s_c = sat[chroma_mask]
    v_c = val[chroma_mask]
    weights = (s_c ** 1.4) * (1.0 - np.abs(v_c - 0.65) * 0.5)

    bins = np.clip((h_c * 24.0).astype(int), 0, 23)
    bin_weights = np.bincount(bins, weights=weights, minlength=24)
    best_bin = int(np.argmax(bin_weights))

    in_bin = bins == best_bin
    med_h = float(np.median(h_c[in_bin]))
    med_s = float(np.clip(np.median(s_c[in_bin]), 0.52, 0.85))
    med_v = float(np.clip(np.median(v_c[in_bin]), 0.62, 0.90))

    rr, gg, bb = colorsys.hsv_to_rgb(med_h, med_s, med_v)
    return f"#{round(rr * 255):02X}{round(gg * 255):02X}{round(bb * 255):02X}"


def normalize_view_cell(view_img: Image.Image, *, target_h: float = NORM_TARGET_H, max_w: float = NORM_MAX_W, bottom_excl: int = NORM_BOTTOM_EXCL) -> Image.Image:
    """Normalize a view sprite into 192x208 cell with H~184px, bottomY=199, horizontally centered."""
    sp = _crop_tight(view_img.convert("RGBA"))
    if not sp.getbbox():
        return Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))

    scale = min(target_h / max(1, sp.height), max_w / max(1, sp.width))
    nw = max(1, round(sp.width * scale))
    nh = max(1, round(sp.height * scale))
    resized = sp.resize((nw, nh), Image.Resampling.LANCZOS)

    cell = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    dx = round((CELL_W - nw) / 2.0)
    dy = bottom_excl - nh
    cell.alpha_composite(resized, (dx, dy))
    return cell


def _make_premul(arr_u8: np.ndarray) -> np.ndarray:
    a = arr_u8[:, :, 3:4].astype(np.float32) / 255.0
    pm_rgb = arr_u8[:, :, :3].astype(np.float32) * a
    return np.concatenate([pm_rgb, a], axis=2)


def _sample_premul(pm: np.ndarray, src_x: np.ndarray, src_y: np.ndarray) -> Image.Image:
    h, w, _ = pm.shape
    warped = np.empty((h, w, 4), dtype=np.float32)
    coords = np.stack([src_y, src_x], axis=0)
    for ch in range(4):
        warped[:, :, ch] = ndimage.map_coordinates(pm[:, :, ch], coords, order=1, mode="constant", cval=0.0)

    out_a = np.clip(warped[:, :, 3], 0.0, 1.0)
    vis = out_a > 0.018
    safe_a = np.maximum(out_a, 1e-5)

    out = np.zeros((h, w, 4), dtype=np.uint8)
    for ch in range(3):
        val = np.where(vis, np.clip(warped[:, :, ch] / safe_a, 0.0, 255.0), 0.0)
        out[:, :, ch] = np.rint(val).astype(np.uint8)
    out[:, :, 3] = np.where(vis, np.clip(np.rint(out_a * 255.0), 0, 255), 0).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def _cell_bbox(cell: Image.Image) -> tuple[int, int, int, int]:
    arr = np.array(cell)
    vis = arr[:, :, 3] > 12
    if not np.any(vis):
        return 48, 16, 144, 200
    ys, xs = np.where(vis)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _articulate_cell(
    cell: Image.Image,
    *,
    angle_deg: float = 0.0,
    sx: float = 1.0,
    sy: float = 1.0,
    dx: float = 0.0,
    dy: float = 0.0,
    head_dx: float = 0.0,
    head_dy: float = 0.0,
    waist_frac: float = 0.58,
    neck_frac: float = 0.36,
    shear_x: float = 0.0,
    bottom_excl: int = NORM_BOTTOM_EXCL,
) -> Image.Image:
    """Premultiplied torso/head articulation anchored cleanly at feet."""
    arr = np.array(cell.convert("RGBA"), dtype=np.uint8)
    x0, y0, x1, y1 = _cell_bbox(cell)
    bh = max(1.0, float(y1 - y0))
    bw = max(1.0, float(x1 - x0))
    cx = 0.5 * (x0 + x1)
    anchor_y = float(bottom_excl)

    if abs(angle_deg) > 1e-3:
        rad = abs(angle_deg) * math.pi / 180.0
        half_span = 0.5 * bw * sx + (waist_frac * bh * sy) * math.sin(rad)
        if half_span > 92.0:
            shrink = 92.0 / half_span
            sx *= shrink
            sy *= shrink

    desired_top = anchor_y - bh * sy + dy + min(0.0, head_dy)
    if desired_top < 2.0:
        if dy < -4.0:
            avail_h = max(40.0, (anchor_y + dy) - 2.0)
            sy = min(sy, avail_h / bh)
            sx = min(sx, sy + 0.02)
        else:
            dy = max(dy, 2.0 - (anchor_y - bh * sy + min(0.0, head_dy)))

    pm = _make_premul(arr)
    yy, xx = np.mgrid[0:CELL_H, 0:CELL_W].astype(np.float32)

    px = (xx - dx - cx) / max(0.2, sx) + cx
    py = (yy - dy - anchor_y) / max(0.2, sy) + float(y1)

    if abs(shear_x) > 1e-4:
        u_sh = np.clip((float(y1) - py) / bh, 0.0, 1.0)
        px = px - shear_x * u_sh

    if abs(head_dx) > 1e-4 or abs(head_dy) > 1e-4:
        y_waist_h = float(y0) + waist_frac * bh
        y_neck_h = float(y0) + max(0.08, neck_frac * 0.72) * bh
        u_h = np.clip((y_waist_h - py) / max(1.0, y_waist_h - y_neck_h), 0.0, 1.0)
        blend_h = 0.5 * (1.0 - np.cos(math.pi * u_h))
        px = px - head_dx * blend_h
        py = py - head_dy * blend_h

    if abs(angle_deg) > 1e-3:
        y_waist = float(y0) + waist_frac * bh
        y_neck = float(y0) + neck_frac * bh
        u = np.clip((y_waist - py) / max(1.0, y_waist - y_neck), 0.0, 1.0)
        theta = (angle_deg * math.pi / 180.0) * (0.5 * (1.0 - np.cos(math.pi * u)))
        rx = px - cx
        ry = py - y_waist
        cos_t = np.cos(-theta)
        sin_t = np.sin(-theta)
        src_x = cx + rx * cos_t - ry * sin_t
        src_y = y_waist + rx * sin_t + ry * cos_t
    else:
        src_x, src_y = px, py

    return _sample_premul(pm, src_x, src_y)


def _articulate_hold_cell(
    cell: Image.Image,
    *,
    sway_deg: float = 0.0,
    sx: float = 0.95,
    sy: float = 1.06,
    top_margin: int = 14,
) -> Image.Image:
    """Synthesize scruff-held dangling pose anchored near top neck/scruff with smooth pendulum sway."""
    arr = np.array(cell.convert("RGBA"), dtype=np.uint8)
    x0, y0, x1, y1 = _cell_bbox(cell)
    bh = max(1.0, float(y1 - y0))
    bw = max(1.0, float(x1 - x0))
    cx = 0.5 * (x0 + x1)

    max_h_avail = float(CELL_H - 6 - top_margin)
    if bh * sy > max_h_avail:
        sy = max(0.75, max_h_avail / bh)
    if abs(sway_deg) > 1e-3:
        rad = abs(sway_deg) * math.pi / 180.0
        half_span = 0.5 * bw * sx + (0.86 * bh * sy) * math.sin(rad)
        if half_span > 90.0:
            shrink = 90.0 / half_span
            sx *= shrink
            sy *= shrink

    pm = _make_premul(arr)
    yy, xx = np.mgrid[0:CELL_H, 0:CELL_W].astype(np.float32)

    dst_cx = 0.5 * CELL_W
    dst_top = float(top_margin)
    px = (xx - dst_cx) / max(0.2, sx) + cx
    py = (yy - dst_top) / max(0.2, sy) + float(y0)

    if abs(sway_deg) > 1e-3:
        y_scruff = float(y0) + 0.14 * bh
        u = np.clip((py - y_scruff) / max(1.0, float(y1) - y_scruff), 0.0, 1.0)
        theta = (sway_deg * math.pi / 180.0) * (0.5 * (1.0 - np.cos(math.pi * u)))
        rx = px - cx
        ry = py - y_scruff
        cos_t = np.cos(theta)
        sin_t = np.sin(theta)
        src_x = cx + rx * cos_t + ry * sin_t
        src_y = y_scruff - rx * sin_t + ry * cos_t
    else:
        src_x, src_y = px, py

    return _sample_premul(pm, src_x, src_y)


def _articulate_run_cell(
    side_cell: Image.Image,
    *,
    lean_deg: float = 0.0,
    stride_px: float = 0.0,
    leg_scissor: float = 0.0,
    sx: float = 1.0,
    sy: float = 1.0,
    dx: float = 0.0,
    dy: float = 0.0,
    bottom_excl: int = 195,
) -> Image.Image:
    """Synthesize smooth side-profile running gait with forward lean, stride shear, and front/back paw lift."""
    arr = np.array(side_cell.convert("RGBA"), dtype=np.uint8)
    x0, y0, x1, y1 = _cell_bbox(side_cell)
    bh = max(1.0, float(y1 - y0))
    bw = max(1.0, float(x1 - x0))
    cx = 0.5 * (x0 + x1)

    desired_top = y1 - bh * sy + dy
    if desired_top < 2.0:
        dy = max(dy, 2.0 - (y1 - bh * sy))

    pm = _make_premul(arr)
    yy, xx = np.mgrid[0:CELL_H, 0:CELL_W].astype(np.float32)

    anchor_y = float(bottom_excl)
    px = (xx - dx - cx) / max(0.2, sx) + cx
    py = (yy - dy - anchor_y) / max(0.2, sy) + float(y1)

    y_pivot = float(y0) + 0.78 * bh
    y_top_lean = float(y0) + 0.16 * bh
    u_lean = np.clip((y_pivot - py) / max(1.0, y_pivot - y_top_lean), 0.0, 1.0)
    theta = (lean_deg * math.pi / 180.0) * (0.5 * (1.0 - np.cos(math.pi * u_lean)))
    rx = px - cx
    ry = py - y_pivot
    src_x = cx + rx * np.cos(-theta) - ry * np.sin(-theta)
    src_y = y_pivot + rx * np.sin(-theta) + ry * np.cos(-theta)

    # Damp lower-limb scissor on wide rigid silhouettes (e.g. vehicles/appliances) so wheels stay round
    gait_damp = 0.25 if (bw / max(1.0, bh)) >= 1.55 else 1.0
    y_hip = float(y0) + 0.68 * bh
    v_leg = np.clip((src_y - y_hip) / max(1.0, float(y1) - y_hip), 0.0, 1.0)
    v_leg = v_leg * v_leg * (3.0 - 2.0 * v_leg)
    side_sign = np.tanh((src_x - cx) / max(10.0, 0.22 * bw))

    src_x = src_x - v_leg * (stride_px * gait_damp * side_sign)
    src_y = src_y + v_leg * (leg_scissor * gait_damp * side_sign)

    return _sample_premul(pm, src_x, src_y)


def _load_or_draw_question_bubble() -> Image.Image:
    ext = EXTERNAL_BUBBLES_DIR / "question_bubble.png"
    if ext.is_file():
        return Image.open(ext).convert("RGBA")

    scale = 4
    w, h = 47 * scale, 45 * scale
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    draw.ellipse([2 * scale, 2 * scale, w - 2 * scale, h - 2 * scale], fill=(254, 253, 245, 255), outline=(28, 30, 36, 255), width=3 * scale)

    cx = w * 0.50
    draw.arc([cx - 8 * scale, 10 * scale, cx + 8 * scale, 24 * scale], start=185, end=25, fill=(28, 30, 36, 255), width=4 * scale)
    draw.line([(cx + 6.5 * scale, 19 * scale), (cx + 1.0 * scale, 24 * scale), (cx, 28 * scale)], fill=(28, 30, 36, 255), width=4 * scale, joint="curve")
    draw.ellipse([cx - 2.2 * scale, 31.5 * scale, cx + 2.2 * scale, 35.9 * scale], fill=(28, 30, 36, 255))
    return im.resize((47, 45), Image.Resampling.LANCZOS)


def _load_or_draw_ellipsis_bubble() -> Image.Image:
    ext = EXTERNAL_BUBBLES_DIR / "ellipsis_bubble.png"
    if ext.is_file():
        return Image.open(ext).convert("RGBA")

    scale = 4
    w, h = 55 * scale, 37 * scale
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    draw.rounded_rectangle([2 * scale, 2 * scale, w - 2 * scale, h - 7 * scale], radius=12 * scale, fill=(254, 253, 245, 255), outline=(28, 30, 36, 255), width=3 * scale)
    draw.ellipse([9 * scale, h - 11 * scale, 19 * scale, h - 1 * scale], fill=(254, 253, 245, 255), outline=(28, 30, 36, 255), width=3 * scale)
    for dx in (-11, 0, 11):
        cx = w * 0.5 + dx * scale
        cy = (h - 5 * scale) * 0.5
        draw.ellipse([cx - 2.2 * scale, cy - 2.2 * scale, cx + 2.2 * scale, cy + 2.2 * scale], fill=(28, 30, 36, 255))
    return im.resize((55, 37), Image.Resampling.LANCZOS)


def _draw_mini_butterfly() -> Image.Image:
    scale = 4
    w, h = 16 * scale, 14 * scale
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    draw.ellipse([1 * scale, 1 * scale, 9 * scale, 9 * scale], fill=(253, 224, 71, 255), outline=(34, 34, 38, 255), width=2 * scale)
    draw.ellipse([7 * scale, 2 * scale, 15 * scale, 10 * scale], fill=(250, 204, 21, 255), outline=(34, 34, 38, 255), width=2 * scale)
    draw.ellipse([3 * scale, 7 * scale, 9 * scale, 13 * scale], fill=(254, 240, 138, 255), outline=(34, 34, 38, 255), width=2 * scale)
    return im.resize((16, 14), Image.Resampling.LANCZOS)


def _draw_mini_yarn_orb(phase_deg: float = 0.0) -> Image.Image:
    """Render a 3D-shaded, crisp-outlined yarn ball with rotating wrapped strands and zero white halo."""
    scale = 4
    sz = 26 * scale
    cx = cy = 0.5 * sz
    r_outer = 10.6 * scale
    r_inner = 9.0 * scale

    yy, xx = np.mgrid[0:sz, 0:sz].astype(np.float32)
    dx = xx - cx
    dy = yy - cy
    dist = np.hypot(dx, dy)

    arr = np.zeros((sz, sz, 4), dtype=np.uint8)
    inside = dist <= r_inner
    if np.any(inside):
        nx = dx[inside] / r_inner
        ny = dy[inside] / r_inner
        nz = np.sqrt(np.clip(1.0 - nx * nx - ny * ny, 0.0, 1.0))
        # Soft directional diffuse + specular highlight from upper-left
        diff = np.clip(-0.34 * nx - 0.42 * ny + 0.84 * nz, 0.0, 1.0)
        spec = np.clip((-0.42 * nx - 0.50 * ny + 0.76 * nz), 0.0, 1.0) ** 8
        shade = 0.58 + 0.46 * diff

        base_r, base_g, base_b = 244.0, 134.0, 188.0
        rr = np.clip(base_r * shade + 48.0 * spec, 0, 255)
        gg = np.clip(base_g * shade + 64.0 * spec, 0, 255)
        bb = np.clip(base_b * shade + 56.0 * spec, 0, 255)

        # Curved yarn-strand ridges rotating cleanly with phase_deg
        rad = phase_deg * math.pi / 180.0
        rx = nx * math.cos(rad) - ny * math.sin(rad)
        ry = nx * math.sin(rad) + ny * math.cos(rad)
        strand1 = np.abs(np.sin((rx * 2.6 + 0.32 * ry * ry) * math.pi))
        strand2 = np.abs(np.sin((ry * 2.4 - 0.28 * rx * rx + 0.35) * math.pi))
        groove = (strand1 < 0.16) | ((strand2 < 0.14) & (rx > -0.35))
        crest = (strand1 > 0.90) & (diff > 0.55)

        rr = np.where(groove, rr * 0.74, np.where(crest, np.minimum(255.0, rr + 20.0), rr))
        gg = np.where(groove, gg * 0.54, np.where(crest, np.minimum(255.0, gg + 24.0), gg))
        bb = np.where(groove, bb * 0.76, np.where(crest, np.minimum(255.0, bb + 20.0), bb))

        arr[inside, 0] = np.rint(rr).astype(np.uint8)
        arr[inside, 1] = np.rint(gg).astype(np.uint8)
        arr[inside, 2] = np.rint(bb).astype(np.uint8)
        arr[inside, 3] = 255

    # Clean anti-aliased dark charcoal outline (zero white border)
    rim = (dist > r_inner) & (dist <= r_outer)
    arr[rim, 0] = 30
    arr[rim, 1] = 32
    arr[rim, 2] = 40
    arr[rim, 3] = 255

    aa = (dist > r_outer) & (dist <= r_outer + 1.2)
    if np.any(aa):
        a_val = np.clip(1.0 - (dist[aa] - r_outer) / 1.2, 0.0, 1.0)
        arr[aa, 0] = 30
        arr[aa, 1] = 32
        arr[aa, 2] = 40
        arr[aa, 3] = np.rint(a_val * 255.0).astype(np.uint8)

    im = Image.fromarray(arr, "RGBA")
    return im.resize((26, 26), Image.Resampling.LANCZOS)


def _overlay_bubble_smart(
    cell: Image.Image,
    bubble: Image.Image,
    *,
    prefer_xy: tuple[int, int],
    x_range: tuple[int, int],
    y_range: tuple[int, int],
) -> Image.Image:
    out = cell.copy()
    cat_alpha = np.array(out)[:, :, 3] > 24
    b_alpha = np.array(bubble)[:, :, 3] > 24
    bh, bw = bubble.height, bubble.width

    best_xy = prefer_xy
    best_score = (10 ** 9, 10 ** 9)
    px0, py0 = prefer_xy
    for by in range(y_range[0], min(y_range[1], CELL_H - bh - 2) + 1):
        for bx in range(x_range[0], min(x_range[1], CELL_W - bw - 2) + 1):
            sub_cat = cat_alpha[by : by + bh, bx : bx + bw]
            overlap = int(np.logical_and(sub_cat, b_alpha).sum())
            dist_pen = abs(bx - px0) * 2 + abs(by - py0)
            score = (overlap, dist_pen)
            if score < best_score:
                best_score = score
                best_xy = (bx, by)
                if overlap == 0 and dist_pen == 0:
                    break

    out.alpha_composite(bubble, best_xy)
    return out


def _make_thumbnail(front_cell: Image.Image, out_path: Path) -> None:
    sp = _crop_tight(front_cell.convert("RGBA"))
    canvas = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    if sp.getbbox():
        scale = min(220.0 / sp.width, 220.0 / sp.height)
        nw = max(1, round(sp.width * scale))
        nh = max(1, round(sp.height * scale))
        resized = sp.resize((nw, nh), Image.Resampling.LANCZOS)
        canvas.alpha_composite(resized, ((256 - nw) // 2, (256 - nh) // 2))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, format="PNG")


def _measure_border_clipping(cutout_rgba: Image.Image) -> tuple[bool, bool]:
    arr = np.array(cutout_rgba.convert("RGBA"), dtype=np.uint8)
    h, w, _ = arr.shape
    if h < 8 or w < 8:
        return False, False
    fg = arr[:, :, 3] > 32
    band_y = max(2, h // 80)
    band_x = max(2, w // 80)
    clipped_bottom = float(fg[h - band_y :, :].mean()) >= 0.06
    clipped_sides = (
        float(fg[:, :band_x].mean()) >= 0.08
        or float(fg[:, w - band_x :].mean()) >= 0.08
    )
    return clipped_bottom, clipped_sides


def _clean_loaded_items_batch(
    items: list[LoadedImage],
    *,
    allow_multiple: bool = False,
) -> list[tuple[Image.Image, bool, bool]]:
    """Remove backgrounds (batching Apple Vision cutouts for complex photos) and detect border clipping."""
    prelim: list[tuple[Image.Image, bool]] = []
    vision_jobs: list[tuple[int, Image.Image, Path | None, bool]] = []

    for idx, item in enumerate(items):
        flood_cut, is_clean = _border_flood_remove_background(item.rgba)
        prelim.append((flood_cut, is_clean))
        if not is_clean:
            orig_p = item.path if (not item.is_animated and item.path.is_file()) else None
            vision_jobs.append((idx, item.rgba.convert("RGBA"), orig_p, allow_multiple))

    vision_map = _run_vision_cutout_batch(vision_jobs) if vision_jobs else {}

    results: list[tuple[Image.Image, bool, bool]] = []
    for idx, (flood_cut, _is_clean) in enumerate(prelim):
        keyed = vision_map.get(idx, flood_cut)
        filtered = filter_isolated_noise(keyed)
        clip_b, clip_s = _measure_border_clipping(filtered)
        cropped = _crop_tight(filtered)
        if not _has_visible_foreground(cropped):
            raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)
        results.append((cropped, clip_b, clip_s))
    return results


def _clean_single_sprite(rgba: Image.Image, orig_path: Path | None = None) -> Image.Image:
    keyed = adaptive_remove_background(rgba, orig_path=orig_path, allow_multiple=False)
    cleaned = _crop_tight(filter_isolated_noise(keyed))
    if not _has_visible_foreground(cleaned):
        raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)
    return cleaned


_FILENAME_ROLE_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("left_side", ("left_side", "left-side", "leftside", "左侧面", "左侧", "朝左", "左视")),
    ("right_side", ("right_side", "right-side", "rightside", "右侧面", "右侧", "朝右", "右视")),
    ("face_closeup", ("face_closeup", "face-closeup", "closeup", "close_up", "close-up", "portrait", "avatar", "特写", "脸部", "大头", "面部")),
    ("front", ("front", "正面", "正坐", "正视", "立绘")),
    ("back", ("back", "rear", "behind", "背面", "后背", "背影")),
    ("top", ("top", "overhead", "birdview", "顶面", "俯视", "头顶")),
    ("action", ("action", "pose", "play", "sleep", "loaf", "rest", "jump", "run", "wave", "动作", "姿态", "玩耍", "趴卧")),
    ("side", ("side", "profile", "侧面", "侧视")),
)


def _infer_filename_role(name: str) -> tuple[str, str]:
    """Check display/file name for explicit angle keywords; return (role, matched_keyword)."""
    stem = Path(str(name or "")).stem.lower()
    if not stem:
        return "", ""
    tokens = set(t for t in re.split(r"[^a-z0-9\u4e00-\u9fff]+", stem) if t)
    for role, kws in _FILENAME_ROLE_KEYWORDS:
        for kw in kws:
            if any("\u4e00" <= ch <= "\u9fff" for ch in kw):
                if kw in stem:
                    return role, kw
            else:
                if kw in tokens or kw in stem:
                    if kw in ("left", "right") and not (kw in tokens):
                        continue
                    return role, kw
    if "left" in tokens:
        return "left_side", "left"
    if "right" in tokens:
        return "right_side", "right"
    return "", ""


def _classify_single_sprite_role(
    sp: Image.Image,
    f: PoseFeatures,
    name: str = "",
    ref_front_contrast: float | None = None,
) -> tuple[str, float, str]:
    """Classify 1 cutout view into one of the 7 canonical roles with confidence and Chinese reason."""
    fn_role, fn_kw = _infer_filename_role(name)
    if fn_role == "side":
        faces_r, margin, orient_r = _detect_side_orientation_detail(sp)
        resolved = "right_side" if faces_r else "left_side"
        conf = round(float(np.clip(0.76 + min(0.18, margin * 0.2), 0.75, 0.94)), 2)
        return resolved, conf, f"文件名含「{fn_kw}」且{orient_r}，判定为{ROLE_LABELS[resolved]}"
    if fn_role in VALID_ROLES:
        return fn_role, 0.92, f"文件名含「{fn_kw}」线索，判定为{ROLE_LABELS[fn_role]}"

    # 1. Overhead / top-down view
    if (
        (f.bottom_contrast > max(0.28, f.facial_contrast * 1.32) and f.top_heavy_ratio >= 1.15 and f.head_mirror_iou >= 0.72)
        or (f.head_mirror_iou >= 0.74 and f.body_mirror_iou >= 0.72 and f.aspect >= 1.05 and f.bottom_taper_ratio <= 0.68 and f.compact_fill >= 0.45)
    ):
        conf = round(float(np.clip(0.70 + 0.22 * min(1.0, f.head_mirror_iou), 0.68, 0.92)), 2)
        return "top", conf, "俯拍紧凑轮廓且重心分布符合俯视视角，判定为顶面"

    # 2. Face close-up (cropped bust/head or huge top-heavy head filling upper region)
    if (
        (f.clipped_bottom and f.top_heavy_ratio >= 1.12 and f.head_mirror_iou >= 0.64 and f.facial_contrast >= 0.20)
        or (not f.clipped_bottom and f.top_heavy_ratio >= 1.20 and f.head_mirror_iou >= 0.78 and f.facial_contrast >= 0.30 and f.aspect >= 0.88 and f.head_area_frac >= 0.50)
    ):
        conf = round(float(np.clip(0.74 + 0.16 * min(1.0, f.top_heavy_ratio - 1.0), 0.72, 0.92)), 2)
        return "face_closeup", conf, "头部占比较大且构图偏近景特写，判定为脸部特写"

    # 3. Back view (low facial detail or narrow rear-facing silhouette)
    back_contrast_cap = min(0.26, ref_front_contrast * 0.72) if ref_front_contrast is not None else 0.23
    if not f.clipped_bottom and (
        (f.facial_contrast < 0.23 and f.feat_asym < 0.22)
        or (f.facial_contrast <= back_contrast_cap and f.head_mirror_iou >= 0.55 and f.feat_asym < 0.28)
        or (f.aspect <= 0.48 and f.body_mirror_iou >= 0.68 and f.bottom_taper_ratio >= 0.85)
    ):
        conf = round(float(np.clip(0.68 + 0.22 * max(0.0, 1.0 - f.facial_contrast * 2.0), 0.66, 0.90)), 2)
        return "back", conf, "面部五官信号弱且呈对称或窄背影轮廓，判定为背面"

    # 4. Left / Right side profile (strong head-body offset or left/right asymmetry)
    if (
        (f.head_mirror_iou < 0.70 and f.feat_asym >= 0.18)
        or (f.head_vs_lower_offset >= 0.14 and f.feat_asym >= 0.25)
        or (f.aspect >= 1.08 and f.feat_asym >= 0.16 and f.head_mirror_iou < 0.78)
    ):
        faces_r, margin, orient_r = _detect_side_orientation_detail(sp)
        role_s = "right_side" if faces_r else "left_side"
        conf = round(float(np.clip(0.70 + min(0.24, margin * 0.25 + f.feat_asym * 0.12), 0.68, 0.94)), 2)
        return role_s, conf, f"轮廓呈侧身非对称且{orient_r}，判定为{ROLE_LABELS[role_s]}"

    # 5. Front upright / grounded portrait (distinguish upright front from wide curled/loaf resting poses)
    if (
        f.facial_contrast >= 0.24
        and f.head_mirror_iou >= 0.58
        and f.body_mirror_iou >= 0.52
        and f.feat_asym <= 0.48
        and f.head_vs_lower_offset <= 0.14
        and f.bottom_contrast <= max(0.22, f.facial_contrast * 1.25)
        and f.top_heavy_ratio <= 1.25
        and f.aspect < 0.96
    ):
        conf = round(float(np.clip(0.66 + 0.18 * f.head_mirror_iou + 0.12 * f.facial_contrast, 0.66, 0.95)), 2)
        return "front", conf, "五官清晰且头身对称端正，判定为正面"

    # 6. Action / dynamic / resting pose
    conf = 0.72
    return "action", conf, "姿态呈动态伸展或休闲动作，归类为动作姿态"


def _anchor_quality_score(role: str, f: PoseFeatures) -> float:
    """Rank images inside the same role group to select the sharpest, unclipped synthesis anchor."""
    clip_pen = (3.5 if f.clipped_bottom else 0.0) + (2.0 if f.clipped_sides else 0.0)
    area_bonus = 0.25 * min(1.5, math.log10(max(100, f.area)) / 4.0)
    sharp_bonus = 1.6 * min(0.5, f.sharpness)
    if role == "front":
        return (
            2.2 * f.head_mirror_iou
            + 1.6 * f.body_mirror_iou
            + 2.0 * f.facial_contrast
            - 2.2 * f.feat_asym
            - 1.4 * f.head_vs_lower_offset
            - max(0.0, f.top_heavy_ratio - 1.05) * 3.0
            + sharp_bonus
            + area_bonus
            - clip_pen
        )
    if role in ("left_side", "right_side"):
        return (
            1.6 * (1.0 - f.head_mirror_iou)
            + 1.4 * f.feat_asym
            + 1.2 * f.facial_contrast
            + sharp_bonus
            + area_bonus
            - clip_pen
        )
    if role == "back":
        return (
            1.8 * f.head_mirror_iou
            + 1.4 * f.body_mirror_iou
            + max(0.0, 1.0 - f.facial_contrast * 2.0)
            + sharp_bonus
            + area_bonus
            - clip_pen
        )
    return 1.2 * f.body_mirror_iou + 1.2 * f.facial_contrast + sharp_bonus + area_bonus - clip_pen


def _assign_multi_image_roles(
    cleaned_sprites: list[Image.Image],
    hints: list[str],
    order: list[int] | None,
    clip_flags: list[tuple[bool, bool]] | None = None,
    names: list[str] | None = None,
) -> dict[str, Any]:
    """Classify 2..16 views into 7 canonical roles, preserving all multi-image same-role groups."""
    n = len(cleaned_sprites)
    feats = [
        _extract_pose_features(
            sp,
            clipped_bottom=(clip_flags[idx][0] if clip_flags and idx < len(clip_flags) else False),
            clipped_sides=(clip_flags[idx][1] if clip_flags and idx < len(clip_flags) else False),
        )
        for idx, sp in enumerate(cleaned_sprites)
    ]
    item_names = [names[idx] if (names and idx < len(names)) else f"图片 {idx + 1}" for idx in range(n)]

    items_meta: list[dict[str, Any]] = [{} for _ in range(n)]
    warnings: list[str] = []

    # Legacy explicit order when no roleHint is provided
    if isinstance(order, list) and not any(hints):
        valid = [i for i in order if isinstance(i, int) and 0 <= i < n]
        dedup: list[int] = []
        for i in valid:
            if i not in dedup:
                dedup.append(i)
        for i in range(n):
            if i not in dedup:
                dedup.append(i)
        for pos, idx in enumerate(dedup):
            if pos == 0:
                role = "front"
                reason = "按指定顺序首图设为正面"
            elif pos == 1:
                faces_r, _m, orient_r = _detect_side_orientation_detail(cleaned_sprites[idx])
                role = "right_side" if faces_r else "left_side"
                reason = f"按指定顺序设为侧面（{orient_r}）"
            elif pos == 2:
                role = "back"
                reason = "按指定顺序设为背面"
            else:
                role = "action"
                reason = "按指定顺序设为动作姿态"
            items_meta[idx] = {
                "role": role,
                "roleLabel": ROLE_LABELS[role],
                "manualRole": role,
                "isManual": True,
                "isPrimaryAnchor": False,
                "reason": reason,
                "confidence": 1.0,
            }
    else:
        # First honor explicit manual roleHints (100% respected, never overwritten!)
        manual_front_contrasts: list[float] = []
        for idx, h in enumerate(hints):
            if not h:
                continue
            if h == "side":
                faces_r, _m, orient_r = _detect_side_orientation_detail(cleaned_sprites[idx])
                resolved = "right_side" if faces_r else "left_side"
                items_meta[idx] = {
                    "role": resolved,
                    "roleLabel": ROLE_LABELS[resolved],
                    "manualRole": "side",
                    "isManual": True,
                    "isPrimaryAnchor": False,
                    "reason": f"人工指定为侧面（{orient_r}）",
                    "confidence": 1.0,
                }
            elif h in VALID_ROLES:
                items_meta[idx] = {
                    "role": h,
                    "roleLabel": ROLE_LABELS[h],
                    "manualRole": h,
                    "isManual": True,
                    "isPrimaryAnchor": False,
                    "reason": f"人工指定为{ROLE_LABELS[h]}",
                    "confidence": 1.0,
                }
                if h == "front":
                    manual_front_contrasts.append(feats[idx].facial_contrast)

        # Estimate reference upright front contrast for accurate back vs front separation
        ref_front_contrast: float | None = max(manual_front_contrasts) if manual_front_contrasts else None
        if ref_front_contrast is None:
            upright_cands = [
                feats[i].facial_contrast
                for i in range(n)
                if not items_meta[i]
                and not feats[i].clipped_bottom
                and 0.50 <= feats[i].aspect <= 0.96
                and feats[i].head_mirror_iou >= 0.58
                and feats[i].top_heavy_ratio <= 1.25
                and feats[i].bottom_contrast <= max(0.24, feats[i].facial_contrast * 1.2)
            ]
            if upright_cands:
                ref_front_contrast = min(0.42, float(np.median(upright_cands)))

        for idx in range(n):
            if items_meta[idx]:
                continue
            role, conf, reason = _classify_single_sprite_role(
                cleaned_sprites[idx],
                feats[idx],
                name=item_names[idx],
                ref_front_contrast=ref_front_contrast,
            )
            items_meta[idx] = {
                "role": role,
                "roleLabel": ROLE_LABELS[role],
                "manualRole": "",
                "isManual": False,
                "isPrimaryAnchor": False,
                "reason": reason,
                "confidence": conf,
            }

        # If auto mode left no front image at all, promote best unclipped symmetric non-manual candidate ONLY if none is manual
        has_any_front = any(m["role"] == "front" for m in items_meta)
        auto_idxs = [i for i in range(n) if not items_meta[i]["isManual"]]
        if not has_any_front and auto_idxs:
            cands = [
                i for i in auto_idxs
                if not feats[i].clipped_bottom
                and feats[i].facial_contrast >= 0.22
                and feats[i].bottom_contrast <= max(0.26, feats[i].facial_contrast * 1.25)
                and items_meta[i]["role"] not in ("top", "back", "left_side", "right_side")
            ]
            if cands:
                best_f = max(cands, key=lambda i: _anchor_quality_score("front", feats[i]))
                items_meta[best_f]["role"] = "front"
                items_meta[best_f]["roleLabel"] = ROLE_LABELS["front"]
                items_meta[best_f]["reason"] = "最清晰且五官对称完整，选作主正面"
                items_meta[best_f]["confidence"] = 0.78

    role_groups: dict[str, list[int]] = {r: [] for r in VALID_ROLES}
    for idx, meta in enumerate(items_meta):
        r = meta["role"]
        if r not in role_groups:
            r = "action"
            meta["role"] = "action"
            meta["roleLabel"] = ROLE_LABELS["action"]
        role_groups[r].append(idx)

    primary_by_role: dict[str, int] = {}
    for role, idxs in role_groups.items():
        if not idxs:
            continue
        best_idx = max(idxs, key=lambda i: _anchor_quality_score(role, feats[i]))
        primary_by_role[role] = best_idx
        items_meta[best_idx]["isPrimaryAnchor"] = True
        if len(idxs) > 1:
            for other_i in idxs:
                if other_i != best_idx and "同面补充参考" not in items_meta[other_i]["reason"]:
                    items_meta[other_i]["reason"] += "（同面参考组）"

    role_counts = {r: len(role_groups[r]) for r in VALID_ROLES}

    has_front_or_face = bool(role_groups["front"] or role_groups["face_closeup"])
    has_any_side = bool(role_groups["left_side"] or role_groups["right_side"])
    has_back = bool(role_groups["back"])

    if not role_groups["front"]:
        if role_groups["face_closeup"]:
            warnings.append("未检测到全身正面图，已结合脸部特写与现有角度补齐正面动作。")
        elif has_any_side or role_groups["action"]:
            warnings.append("未检测到正面图，已基于已有角度自动补齐正面与待机动作。")
        else:
            warnings.append("未检测到正面图，已基于背面图补齐正面待机动作。")

    if not has_any_side and not has_back:
        warnings.append("未包含侧面与背面图，已用现有画面补齐完整动作序列。")
    elif not has_any_side:
        warnings.append("未包含侧面图，奔跑与侧视动作已用现有画面补齐。")
    elif not has_back:
        warnings.append("未包含背面图，仰视与环视动作已用现有画面补齐。")
    elif bool(role_groups["left_side"]) ^ bool(role_groups["right_side"]):
        present = "左侧面" if role_groups["left_side"] else "右侧面"
        missing = "右侧面" if role_groups["left_side"] else "左侧面"
        warnings.append(f"已检测到{present}，{missing}动作已精准镜像补齐。")

    multi_notes = [f"{ROLE_LABELS[r]}×{cnt}" for r, cnt in role_counts.items() if cnt > 1]
    if multi_notes:
        warnings.append("同面多图已全部保留参考：" + "、".join(multi_notes) + "。")

    return {
        "itemsMeta": items_meta,
        "roleGroups": role_groups,
        "primaryByRole": primary_by_role,
        "roleCounts": role_counts,
        "warnings": warnings,
        "feats": feats,
    }


def _cell_aspect(cell: Image.Image) -> float:
    x0, y0, x1, y1 = _cell_bbox(cell)
    return max(1, x1 - x0) / max(1.0, float(y1 - y0))


def _synthesize_8x11_atlas(
    front_cell: Image.Image,
    side_right_cell: Image.Image,
    back_cell: Image.Image | None,
    extra_cells: list[Image.Image] | None = None,
    extra_clip_flags: list[tuple[bool, bool]] | None = None,
    *,
    has_real_side: bool = True,
    has_real_back: bool = True,
    side_left_cell: Image.Image | None = None,
    has_left_side: bool | None = None,
    has_right_side: bool | None = None,
    top_cell: Image.Image | None = None,
    face_closeup_cell: Image.Image | None = None,
    action_cells: list[Image.Image] | None = None,
    action_clip_flags: list[tuple[bool, bool]] | None = None,
) -> tuple[Image.Image, list[dict[str, Any]]]:
    """Build 1536x2288 codex-v2-8x11 spritesheet using real textured views (supports independent left/right sides)."""
    extras = list(action_cells if action_cells is not None else (extra_cells or []))
    extras_flags = list(action_clip_flags if action_clip_flags is not None else (extra_clip_flags or []))

    use_right = bool(has_real_side if has_right_side is None else has_right_side)
    use_left = bool(has_left_side) if has_left_side is not None else False
    has_any_side = use_right or use_left

    if use_right and use_left and side_left_cell is not None:
        effective_side_right = side_right_cell
        effective_side_left = side_left_cell
    elif use_right:
        effective_side_right = side_right_cell
        effective_side_left = side_right_cell.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    elif use_left and side_left_cell is not None:
        effective_side_left = side_left_cell
        effective_side_right = side_left_cell.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    else:
        effective_side_right = front_cell
        effective_side_left = front_cell.transpose(Image.Transpose.FLIP_LEFT_RIGHT)

    effective_back = back_cell if (has_real_back and back_cell is not None) else front_cell
    has_top_for_up = (not has_real_back) and (top_cell is not None) and (0.45 <= _cell_aspect(top_cell) <= 0.95)
    up_anchor_cell = effective_back if has_real_back else (top_cell if has_top_for_up else front_cell)
    has_up_view = has_real_back or has_top_for_up

    run_src_right = effective_side_right
    run_src_left = effective_side_left
    if not has_any_side and extras:
        for ei, ex in enumerate(extras):
            cb, cs = extras_flags[ei] if ei < len(extras_flags) else (False, False)
            if not cb and not cs and 0.70 <= _cell_aspect(ex) <= 1.55:
                run_src_right = ex
                run_src_left = ex
                break

    run_base_right = normalize_view_cell(_crop_tight(run_src_right), target_h=176.0, max_w=172.0)
    run_base_left_flipped = normalize_view_cell(
        _crop_tight(run_src_left).transpose(Image.Transpose.FLIP_LEFT_RIGHT),
        target_h=176.0,
        max_w=172.0,
    )

    q_bubble = _load_or_draw_question_bubble()
    butterfly = _draw_mini_butterfly()

    atlas = Image.new("RGBA", (ATLAS_W, ATLAS_H), (0, 0, 0, 0))
    extra_placements: list[dict[str, Any]] = []

    def put(r: int, c: int, tile: Image.Image) -> None:
        atlas.alpha_composite(tile, (c * CELL_W, r * CELL_H))

    front_aspect = _cell_aspect(front_cell)
    unclipped_eids: list[int] = []
    for ei in range(len(extras)):
        cb, cs = extras_flags[ei] if ei < len(extras_flags) else (False, False)
        if not cb and not cs:
            unclipped_eids.append(ei)
    candidate_eids = unclipped_eids if unclipped_eids else list(range(len(extras)))

    ex_feats = [_extract_pose_features(ex) for ex in extras]
    used_eids: set[int] = set()
    wait_ei: int | None = None
    review_ei: int | None = None
    work_ei: int | None = None

    resting_candidates = [
        ei for ei in candidate_eids
        if _cell_aspect(extras[ei]) >= front_aspect * 1.10
        and _cell_aspect(extras[ei]) <= 2.40
        and ex_feats[ei].bottom_contrast <= max(0.24, ex_feats[ei].facial_contrast * 1.25)
    ]
    if resting_candidates:
        wait_ei = max(
            resting_candidates,
            key=lambda ei: ex_feats[ei].body_mirror_iou + 0.40 * min(1.8, _cell_aspect(extras[ei]) / max(0.3, front_aspect)),
        )
        used_eids.add(wait_ei)
    elif candidate_eids:
        wait_ei = max(candidate_eids, key=lambda ei: ex_feats[ei].body_mirror_iou + ex_feats[ei].facial_contrast)
        used_eids.add(wait_ei)

    upright_candidates = [
        ei for ei in candidate_eids
        if ei not in used_eids
        and (0.68 * front_aspect <= _cell_aspect(extras[ei]) <= 1.35 * front_aspect)
        and ex_feats[ei].facial_contrast >= 0.22
        and ex_feats[ei].bottom_contrast <= max(0.22, ex_feats[ei].facial_contrast * 1.15)
    ]
    if upright_candidates:
        review_ei = max(
            upright_candidates,
            key=lambda ei: 1.4 * ex_feats[ei].body_mirror_iou + 1.2 * ex_feats[ei].facial_contrast,
        )
        used_eids.add(review_ei)

    work_candidates = [
        ei for ei in candidate_eids
        if ei not in used_eids
        and (0.68 * front_aspect <= _cell_aspect(extras[ei]) <= 1.50 * front_aspect)
        and ex_feats[ei].facial_contrast >= 0.22
        and ex_feats[ei].bottom_contrast <= max(0.24, ex_feats[ei].facial_contrast * 1.15)
    ]
    if work_candidates:
        work_ei = max(
            work_candidates,
            key=lambda ei: 1.5 * ex_feats[ei].facial_contrast + 0.8 * ex_feats[ei].body_mirror_iou,
        )
        used_eids.add(work_ei)

    # Row 0: idle (cols 0..5) — locked feet baseline (bottom_excl=200), smooth gentle breathing & micro-tilt
    idle_specs = [
        (0.0, 1.000, 1.000, 0.0),
        (0.6, 1.004, 0.994, 0.3),
        (1.2, 1.008, 0.988, 0.7),
        (1.5, 1.010, 0.985, 0.9),
        (0.9, 1.005, 0.991, 0.5),
        (0.3, 1.002, 0.997, 0.2),
    ]
    for c_idx, (ang, sx, sy, hdy) in enumerate(idle_specs):
        cell = (
            front_cell
            if c_idx == 0
            else _articulate_cell(front_cell, angle_deg=ang, sx=sx, sy=sy, head_dy=hdy, waist_frac=0.56, bottom_excl=200)
        )
        put(0, c_idx, cell)

    # Row 1: running-right (cols 0..7) & Row 2: running-left (independent left_side if present, else mirror)
    if has_any_side:
        # Smooth periodic 8-frame sinusoidal gait (zero sudden jumps or duplicate pauses)
        run_specs: list[tuple[float, float, float, float, float, float, float, tuple[int, int]]] = []
        for c_idx in range(8):
            ph = 2.0 * math.pi * c_idx / 8.0
            lean = 2.4 + 2.6 * math.sin(ph)
            stride = 8.5 * math.sin(ph + 0.35)
            scissor = -5.8 * math.sin(ph + 0.35)
            sx = 1.035 + 0.028 * math.sin(ph)
            sy = 0.975 - 0.025 * math.cos(ph)
            dx = 1.6 * math.sin(ph)
            dy = -5.5 + 7.0 * math.cos(ph)
            bx = round(169 + 2.2 * math.sin(ph))
            by = round(45 - 6.0 * math.sin(ph + 0.4))
            run_specs.append((lean, stride, scissor, sx, sy, dx, dy, (bx, by)))

        for c_idx, (lean, stride, scissor, sx, sy, dx, dy, bf_xy) in enumerate(run_specs):
            rcell = _articulate_run_cell(
                run_base_right,
                lean_deg=lean,
                stride_px=stride,
                leg_scissor=scissor,
                sx=sx,
                sy=sy,
                dx=dx,
                dy=dy,
                bottom_excl=195,
            )
            r_arr = np.array(rcell)[:, :, 3] > 20
            bx, by = bf_xy
            if not np.any(r_arr[max(0, by - 2) : by + 16, max(0, bx - 2) : bx + 18]):
                rcell.alpha_composite(butterfly, (bx, by))
            put(1, c_idx, rcell)

            if use_left and side_left_cell is not None:
                lcell_tmp = _articulate_run_cell(
                    run_base_left_flipped,
                    lean_deg=lean,
                    stride_px=stride,
                    leg_scissor=scissor,
                    sx=sx,
                    sy=sy,
                    dx=dx,
                    dy=dy,
                    bottom_excl=195,
                )
                l_arr = np.array(lcell_tmp)[:, :, 3] > 20
                if not np.any(l_arr[max(0, by - 2) : by + 16, max(0, bx - 2) : bx + 18]):
                    lcell_tmp.alpha_composite(butterfly, (bx, by))
                put(2, c_idx, lcell_tmp.transpose(Image.Transpose.FLIP_LEFT_RIGHT))
            else:
                put(2, c_idx, rcell.transpose(Image.Transpose.FLIP_LEFT_RIGHT))
    else:
        # Missing side views -> smooth periodic 8-frame bound/hop cycle on real textured character
        for c_idx in range(8):
            ph = 2.0 * math.pi * c_idx / 8.0
            ang_r = 1.6 + 3.4 * math.sin(ph)
            sx = 1.015 - 0.035 * math.sin(ph)
            sy = 0.985 + 0.035 * math.sin(ph)
            dx_r = 1.5 + 2.2 * math.sin(ph)
            dy = -6.0 - 7.5 * math.sin(ph)
            bx = round(169 + 2.0 * math.sin(ph))
            by = round(46 - 6.0 * math.sin(ph))
            rcell_r = _articulate_cell(run_base_right, angle_deg=ang_r, sx=sx, sy=sy, dx=dx_r, dy=dy, bottom_excl=196)
            rcell_l = _articulate_cell(run_base_right, angle_deg=-ang_r, sx=sx, sy=sy, dx=-dx_r, dy=dy, bottom_excl=196)
            r_arr = np.array(rcell_r)[:, :, 3] > 20
            if not np.any(r_arr[max(0, by - 2) : by + 16, max(0, bx - 2) : bx + 18]):
                rcell_r.alpha_composite(butterfly, (bx, by))
            bx_l = CELL_W - bx - butterfly.width
            l_arr = np.array(rcell_l)[:, :, 3] > 20
            if not np.any(l_arr[max(0, by - 2) : by + 16, max(0, bx_l - 2) : bx_l + 18]):
                rcell_l.alpha_composite(butterfly.transpose(Image.Transpose.FLIP_LEFT_RIGHT), (bx_l, by))
            put(1, c_idx, rcell_r)
            put(2, c_idx, rcell_l)

    # Row 3: waving / polite nod (cols 0..3) — NO horizontal squashing (sx >= 1.0), proportional gentle head nod
    wave_specs = [
        (0.0, 1.000, 1.000, 0.0),
        (1.0, 1.004, 0.992, 3.2),
        (1.4, 1.006, 0.988, 4.4),
        (0.4, 1.002, 0.996, 1.4),
    ]
    for c_idx, (ang, sx, sy, hdy) in enumerate(wave_specs):
        cell = (
            front_cell
            if c_idx == 0
            else _articulate_cell(
                front_cell,
                angle_deg=ang,
                sx=sx,
                sy=sy,
                head_dy=hdy,
                waist_frac=0.50,
                neck_frac=0.30,
                bottom_excl=200,
            )
        )
        put(3, c_idx, cell)

    # Row 4: 5-stage jumping (cols 0..4: crouch -> takeoff -> apex -> descend -> land), pre-normalized so apex doesn't shrink
    jump_base = normalize_view_cell(_crop_tight(front_cell), target_h=176.0, max_w=166.0)
    jump_specs = [
        (0.0, 1.06, 0.91, 0.0),
        (0.0, 0.97, 1.03, -9.0),
        (0.0, 0.99, 1.01, -17.0),
        (0.0, 0.98, 1.02, -8.0),
        (0.0, 1.05, 0.93, 0.0),
    ]
    for c_idx, (ang, sx, sy, dy) in enumerate(jump_specs):
        put(4, c_idx, _articulate_cell(jump_base, angle_deg=ang, sx=sx, sy=sy, dy=dy, bottom_excl=200))

    # Row 4 (cols 5..7): mouse-held scruff dangle (c5=HOLD static, c6=left sway, c7=right sway)
    hold_base = normalize_view_cell(_crop_tight(front_cell), target_h=176.0, max_w=166.0)
    hold_specs = [
        (5, 0.0, 0.95, 1.06),
        (6, 8.5, 0.94, 1.05),
        (7, -8.5, 0.94, 1.05),
    ]
    for c_idx, sway_deg, hsx, hsy in hold_specs:
        put(4, c_idx, _articulate_hold_cell(hold_base, sway_deg=sway_deg, sx=hsx, sy=hsy, top_margin=14))

    # Row 5: failed / curious upper-head tilt + clean ? bubble on c3, c4, c7 (cols 0..7)
    fail_specs = [
        (0.0, 0.0, False),
        (3.2, 0.5, False),
        (6.4, 1.0, False),
        (8.8, 1.5, True),
        (10.8, 2.0, True),
        (6.8, 1.2, False),
        (3.0, 0.6, False),
        (9.6, 1.6, True),
    ]
    for c_idx, (ang, hdx, has_q) in enumerate(fail_specs):
        cell = _articulate_cell(front_cell, angle_deg=ang, head_dx=hdx, waist_frac=0.46, neck_frac=0.26, bottom_excl=198)
        if has_q:
            cell = _overlay_bubble_smart(cell, q_bubble, prefer_xy=(136, 13), x_range=(126, 143), y_range=(6, 26))
        put(5, c_idx, cell)

    # Row 6: waiting / resting (cols 0..5) — prefer cozy resting pose or top curled pose if present
    wait_src = extras[wait_ei] if wait_ei is not None else (top_cell if (top_cell is not None and _cell_aspect(top_cell) >= 0.80) else front_cell)
    wait_specs = [
        (0.0, 1.003, 0.994, 0.0),
        (0.4, 1.010, 0.984, 0.6),
        (0.8, 1.016, 0.974, 1.2),
        (1.0, 1.018, 0.970, 1.4),
        (0.6, 1.011, 0.982, 0.8),
        (0.2, 1.005, 0.991, 0.3),
    ]
    for c_idx, (ang, sx, sy, hdy) in enumerate(wait_specs):
        if wait_ei is not None:
            extra_placements.append({"extraIndex": wait_ei, "row": 6, "col": c_idx})
        cell = _articulate_cell(wait_src, angle_deg=ang, sx=sx, sy=sy, head_dy=hdy, waist_frac=0.52, bottom_excl=198)
        put(6, c_idx, cell)

    # Row 7: working state with 3D rotating yarn ball (cols 0..5, shoulder & hip horizontal center strictly locked!)
    work_src = extras[work_ei] if work_ei is not None else front_cell
    work_arr = np.array(work_src)
    lower_fg = work_arr[162:202, :, 3] > 20
    _, lower_xs = np.where(lower_fg)
    paw_x0 = int(lower_xs.min()) if len(lower_xs) > 0 else 44
    base_orb_x = max(8, min(52, paw_x0 - 20))
    work_specs = [
        (-1.6, 1.004, 0.992, 0.8, (base_orb_x, 174), 0.0),
        (-3.2, 1.010, 0.980, 2.2, (max(6, base_orb_x - 3), 173), 38.0),
        (-1.8, 1.006, 0.988, 1.2, (max(6, base_orb_x - 2), 172), 75.0),
        (1.0, 1.008, 0.984, 0.6, (base_orb_x + 1, 174), 112.0),
        (2.0, 1.012, 0.978, 1.8, (max(6, base_orb_x - 1), 173), 148.0),
        (-0.4, 1.004, 0.994, 0.4, (base_orb_x, 174), 22.0),
    ]
    for c_idx, (ang, sx, sy, hdy, orb_xy, orb_phase) in enumerate(work_specs):
        if work_ei is not None:
            extra_placements.append({"extraIndex": work_ei, "row": 7, "col": c_idx})
        # Strictly dx=0.0, shear_x=0.0 so shoulder/hip center stays locked across all 6 frames
        cell = _articulate_cell(
            work_src,
            angle_deg=ang,
            sx=sx,
            sy=sy,
            dx=0.0,
            dy=0.0,
            head_dy=hdy,
            waist_frac=0.44,
            neck_frac=0.25,
            shear_x=0.0,
            bottom_excl=201,
        )
        orb_im = _draw_mini_yarn_orb(orb_phase)
        cell.alpha_composite(orb_im, orb_xy)
        put(7, c_idx, cell)

    # Row 8: calm reading / review (cols 0..5, steady torso + gentle attentive head motion)
    rev_src = extras[review_ei] if review_ei is not None else front_cell
    review_specs = [
        (0.0, 1.002, 0.996, 0.0),
        (1.6, 1.004, 0.992, 1.2),
        (2.8, 1.006, 0.989, 2.0),
        (2.0, 1.005, 0.991, 1.5),
        (-1.0, 1.004, 0.993, 0.8),
        (-0.4, 1.002, 0.997, 0.3),
    ]
    for c_idx, (ang, sx, sy, hdy) in enumerate(review_specs):
        if review_ei is not None:
            extra_placements.append({"extraIndex": review_ei, "row": 8, "col": c_idx})
        cell = _articulate_cell(
            rev_src,
            angle_deg=ang,
            sx=sx,
            sy=sy,
            head_dy=hdy,
            waist_frac=0.45,
            neck_frac=0.26,
            bottom_excl=198,
        )
        put(8, c_idx, cell)

    # Rows 9-10: 16-direction clockwise compass gaze (guaranteed smooth & zero 0% repeat frames)
    up_cell_0 = (up_anchor_cell, -2.2, 0.996, 1.014, 0.0, 0.0, 0.0, -1.5) if has_up_view else (front_cell, 0.0, 0.986, 1.024, 0.0, -3.0, 0.0, -2.5)
    up_cell_1 = (up_anchor_cell, 3.6, 1.000, 1.006, 2.5, 0.0, 2.0, -1.0) if has_up_view else (front_cell, 2.8, 0.990, 1.018, 2.0, -2.4, 2.2, -2.0)
    up_cell_15 = (up_anchor_cell, -3.6, 1.000, 1.006, -2.5, 0.0, -2.0, -1.0) if has_up_view else (front_cell, -2.8, 0.990, 1.018, -2.0, -2.4, -2.2, -2.0)

    if has_any_side:
        look_specs: list[tuple[Image.Image, float, float, float, float, float, float, float]] = [
            up_cell_0,
            up_cell_1,
            (effective_side_right, -4.8, 0.995, 1.014, 1.0, -2.0, 1.5, -1.5),
            (effective_side_right, -2.4, 1.000, 1.006, 1.0, -1.0, 1.0, -0.5),
            (effective_side_right, 0.4, 1.002, 0.998, 0.4, 0.0, 0.5, 0.5),
            (effective_side_right, 3.6, 1.006, 0.988, 1.0, 0.5, 1.2, 1.5),
            (front_cell, 4.4, 1.004, 0.992, 2.8, 0.2, 2.4, 1.0),
            (front_cell, 2.2, 1.007, 0.986, 1.2, 0.6, 1.2, 1.6),
            (front_cell, 0.0, 1.012, 0.978, 0.0, 1.0, 0.0, 2.4),
            (front_cell, -2.2, 1.007, 0.986, -1.2, 0.6, -1.2, 1.6),
            (front_cell, -4.4, 1.004, 0.992, -2.8, 0.2, -2.4, 1.0),
            (effective_side_left, -3.6, 1.006, 0.988, -1.0, 0.5, -1.2, 1.5),
            (effective_side_left, -0.4, 1.002, 0.998, -0.4, 0.0, -0.5, 0.5),
            (effective_side_left, 2.4, 1.000, 1.006, -1.0, -1.0, -1.0, -0.5),
            (effective_side_left, 4.8, 0.995, 1.014, -1.0, -2.0, -1.5, -1.5),
            up_cell_15,
        ]
    else:
        look_specs = []
        for idx16 in range(16):
            th = 2.0 * math.pi * idx16 / 16.0
            ang = 6.2 * math.sin(th)
            dx = 4.0 * math.sin(th)
            dy = -2.2 * math.cos(th)
            hdx = 3.2 * math.sin(th)
            hdy = -2.2 * math.cos(th)
            sx = 1.002 - 0.010 * math.cos(th)
            sy = 0.998 + 0.014 * math.cos(th)
            base_c = up_anchor_cell if (has_up_view and idx16 in (0, 1, 15)) else front_cell
            look_specs.append((base_c, ang, sx, sy, dx, dy, hdx, hdy))

    for idx16, (base_cell, ang, sx, sy, dx, dy, hdx, hdy) in enumerate(look_specs):
        r = 9 + (idx16 // 8)
        c = idx16 % 8
        tile = _articulate_cell(
            base_cell,
            angle_deg=ang,
            sx=sx,
            sy=sy,
            dx=dx,
            dy=dy,
            head_dx=hdx,
            head_dy=hdy,
            waist_frac=0.50,
            neck_frac=0.28,
            bottom_excl=198,
        )
        put(r, c, tile)

    out_arr = np.array(atlas, dtype=np.uint8)
    out_arr[out_arr[:, :, 3] <= 8] = (0, 0, 0, 0)
    return Image.fromarray(out_arr, "RGBA"), extra_placements


def _normalize_existing_grid(
    keyed_sheet: Image.Image,
    cols: int,
    rows: int,
    max_w: float,
    target_h: float,
    bottom_excl: int,
) -> tuple[Image.Image, Image.Image]:
    """Normalize an existing 4x3 or 8x11 spritesheet into canonical cell dimensions."""
    w, h = keyed_sheet.size
    out = Image.new("RGBA", (cols * CELL_W, rows * CELL_H), (0, 0, 0, 0))
    first_sprite: Image.Image | None = None
    for r in range(rows):
        y0 = round(r * h / rows)
        y1 = round((r + 1) * h / rows)
        for c in range(cols):
            x0 = round(c * w / cols)
            x1 = round((c + 1) * w / cols)
            cell = keyed_sheet.crop((x0, y0, x1, y1))
            bb = cell.getbbox()
            if not bb:
                continue
            sp = _crop_tight(filter_isolated_noise(cell))
            if not _has_visible_foreground(sp, min_pixels=6):
                continue
            norm = normalize_view_cell(sp, target_h=target_h, max_w=max_w, bottom_excl=bottom_excl)
            out.alpha_composite(norm, (c * CELL_W, r * CELL_H))
            if first_sprite is None:
                first_sprite = sp
    if first_sprite is None:
        raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)
    return out, first_sprite


def _assemble_prepared_result(
    *,
    sprites: list[Image.Image],
    clip_flags: list[tuple[bool, bool]],
    names: list[str],
    assigned: dict[str, Any],
    raw_layout: str,
    mode: str,
    split_count: int,
    flip_side: bool,
) -> dict[str, Any]:
    """Assemble standardized analyze/build payload from classified multi-view sprites."""
    role_groups: dict[str, list[int]] = assigned["roleGroups"]
    primary_by_role: dict[str, int] = assigned["primaryByRole"]
    items_meta: list[dict[str, Any]] = assigned["itemsMeta"]
    role_counts: dict[str, int] = assigned["roleCounts"]
    warnings: list[str] = list(assigned["warnings"])

    v_front_real = sprites[primary_by_role["front"]] if "front" in primary_by_role else None
    v_face = sprites[primary_by_role["face_closeup"]] if "face_closeup" in primary_by_role else None
    v_top = sprites[primary_by_role["top"]] if "top" in primary_by_role else None
    v_back = sprites[primary_by_role["back"]] if "back" in primary_by_role else None
    v_right_raw = sprites[primary_by_role["right_side"]] if "right_side" in primary_by_role else None
    v_left_raw = sprites[primary_by_role["left_side"]] if "left_side" in primary_by_role else None

    v_front = (
        v_front_real
        or v_face
        or (sprites[primary_by_role["action"]] if "action" in primary_by_role else None)
        or v_right_raw
        or v_left_raw
        or v_top
        or v_back
        or sprites[0]
    )

    has_right_side = v_right_raw is not None
    has_left_side = v_left_raw is not None
    has_real_side = has_right_side or has_left_side
    has_real_back = v_back is not None

    raw_faces_right = True
    if v_right_raw is not None:
        raw_faces_right = detect_side_faces_right(v_right_raw)
        side_right_sp = v_right_raw if raw_faces_right else v_right_raw.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    elif v_left_raw is not None:
        raw_faces_right = detect_side_faces_right(v_left_raw)
        side_right_sp = v_left_raw.transpose(Image.Transpose.FLIP_LEFT_RIGHT) if not raw_faces_right else v_left_raw
    else:
        side_right_sp = v_front

    if v_left_raw is not None:
        left_faces_right = detect_side_faces_right(v_left_raw)
        side_left_sp = v_left_raw if not left_faces_right else v_left_raw.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    else:
        side_left_sp = side_right_sp.transpose(Image.Transpose.FLIP_LEFT_RIGHT)

    if flip_side:
        if has_right_side and has_left_side:
            side_right_sp, side_left_sp = (
                side_left_sp.transpose(Image.Transpose.FLIP_LEFT_RIGHT),
                side_right_sp.transpose(Image.Transpose.FLIP_LEFT_RIGHT),
            )
        else:
            side_right_sp = side_right_sp.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            side_left_sp = side_left_sp.transpose(Image.Transpose.FLIP_LEFT_RIGHT)

    front_cell = normalize_view_cell(v_front)
    side_right_cell = normalize_view_cell(side_right_sp)
    side_left_cell = normalize_view_cell(side_left_sp) if has_left_side else None
    back_cell = normalize_view_cell(v_back) if has_real_back else front_cell
    top_cell = normalize_view_cell(v_top) if v_top is not None else None
    face_closeup_cell = normalize_view_cell(v_face) if v_face is not None else None

    action_idxs = role_groups.get("action", [])
    action_cells = [normalize_view_cell(sprites[i]) for i in action_idxs]
    action_clip_flags = [clip_flags[i] for i in action_idxs]

    items_summary: list[dict[str, Any]] = []
    for idx, (sp, name, meta) in enumerate(zip(sprites, names, items_meta)):
        r = meta.get("role") or "action"
        items_summary.append({
            "index": idx,
            "name": name,
            "role": r,
            "roleLabel": ROLE_LABELS.get(r, "动作姿态"),
            "manualRole": meta.get("manualRole", ""),
            "isManual": bool(meta.get("isManual", False)),
            "isPrimaryAnchor": bool(meta.get("isPrimaryAnchor", False)),
            "reason": meta.get("reason", ""),
            "confidence": float(meta.get("confidence", 0.75)),
            "previewDataUrl": _pil_to_data_url(normalize_view_cell(sp)),
        })

    views: list[dict[str, Any]] = [
        {
            "role": "front",
            "label": "正面" if v_front_real is not None else "正面（补齐）",
            "count": role_counts.get("front", 0),
            "dataUrl": _pil_to_data_url(front_cell),
        }
    ]
    if has_right_side:
        views.append({
            "role": "right_side",
            "label": "右侧面",
            "count": role_counts.get("right_side", 0),
            "canFlip": True,
            "dataUrl": _pil_to_data_url(side_right_cell),
        })
    if has_left_side and side_left_cell is not None:
        views.append({
            "role": "left_side",
            "label": "左侧面",
            "count": role_counts.get("left_side", 0),
            "canFlip": True,
            "dataUrl": _pil_to_data_url(side_left_cell),
        })
    if has_real_back:
        views.append({
            "role": "back",
            "label": "背面",
            "count": role_counts.get("back", 0),
            "dataUrl": _pil_to_data_url(back_cell),
        })
    if top_cell is not None:
        views.append({
            "role": "top",
            "label": "顶面",
            "count": role_counts.get("top", 0),
            "dataUrl": _pil_to_data_url(top_cell),
        })
    if face_closeup_cell is not None:
        views.append({
            "role": "face_closeup",
            "label": "脸部特写",
            "count": role_counts.get("face_closeup", 0),
            "dataUrl": _pil_to_data_url(face_closeup_cell),
        })
    for ac_cell in action_cells:
        views.append({
            "role": "action",
            "label": "动作姿态",
            "dataUrl": _pil_to_data_url(ac_cell),
        })

    color_src = v_front_real or v_face or v_front
    return {
        "layout": raw_layout,
        "mode": mode,
        "modeLabel": MODE_LABELS.get(mode, mode),
        "recommendedLayout": "codex-v2-8x11",
        "splitCount": split_count,
        "viewCount": len(items_summary),
        "roleCounts": role_counts,
        "warnings": warnings,
        "suggestedColor": extract_suggested_color(color_src),
        "sideFacesRight": not flip_side,
        "rawSideFacesRight": raw_faces_right,
        "hasLeftSide": has_left_side,
        "hasRightSide": has_right_side,
        "items": items_summary,
        "views": views,
        "front_cell": front_cell,
        "side_right_cell": side_right_cell,
        "side_left_cell": side_left_cell,
        "back_cell": back_cell,
        "top_cell": top_cell,
        "face_closeup_cell": face_closeup_cell,
        "has_real_side": has_real_side,
        "has_left_side": has_left_side,
        "has_right_side": has_right_side,
        "has_real_back": has_real_back,
        "extra_cells": action_cells,
        "extra_clip_flags": action_clip_flags,
    }


def _prepare_import(cfg: dict[str, Any]) -> dict[str, Any]:
    raw_layout = str(cfg.get("layout") or "auto").strip().lower()
    if raw_layout not in ("auto", "faceted", "three-view", "compact-4x3", "codex-v2-8x11", "single-image"):
        raw_layout = "auto"

    facets = cfg.get("facets") if isinstance(cfg.get("facets"), dict) else {}
    raw_inputs = cfg.get("inputs") or cfg.get("files") or []
    if not isinstance(raw_inputs, list):
        raw_inputs = [raw_inputs]

    facet_slot_keys = (
        "front",
        "left_side",
        "right_side",
        "back",
        "top",
        "face_closeup",
        "action",
        "side",
        "extras",
    )

    def _facet_list(key: str) -> list[Any]:
        val = facets.get(key)
        if not val:
            return []
        if isinstance(val, list):
            return [x for x in val if x]
        return [val]

    has_facets = any(len(_facet_list(k)) > 0 for k in facet_slot_keys)
    if raw_layout == "auto" and len(raw_inputs) == 0 and has_facets:
        raw_layout = "faceted"

    flip_side = bool(facets.get("flipSide", cfg.get("flipSide", False)))
    order = cfg.get("order")

    if raw_layout == "faceted":
        loaded_list: list[LoadedImage] = []
        if not has_facets and raw_inputs:
            if len(raw_inputs) > MAX_INPUTS:
                raise SmartImportError("TOO_MANY_INPUTS", MSG_TOO_MANY_INPUTS)
            for idx, entry in enumerate(raw_inputs):
                p_str, name, hint = _parse_input_entry(entry, idx)
                loaded = _load_image_strict(p_str, name=name, role_hint=hint or ("front" if idx == 0 else "action"))
                loaded_list.append(loaded)
        else:
            for slot_key in facet_slot_keys:
                entries = _facet_list(slot_key)
                if not entries:
                    continue
                target_role = "action" if slot_key == "extras" else slot_key
                for idx, val in enumerate(entries):
                    if len(loaded_list) >= MAX_INPUTS:
                        raise SmartImportError("TOO_MANY_INPUTS", MSG_TOO_MANY_INPUTS)
                    default_lbl = f"{ROLE_LABELS.get(target_role, '参考')} {idx + 1}" if len(entries) > 1 else ROLE_LABELS.get(target_role, "参考")
                    p_str, name, _ = _parse_input_entry(val, len(loaded_list), default_name=default_lbl)
                    loaded_list.append(_load_image_strict(p_str, name=name, role_hint=target_role))

        if len(loaded_list) == 0:
            raise SmartImportError("MISSING_INPUT", MSG_MISSING_INPUT)
        if len(loaded_list) > MAX_INPUTS:
            raise SmartImportError("TOO_MANY_INPUTS", MSG_TOO_MANY_INPUTS)

        cleaned_batch = _clean_loaded_items_batch(loaded_list, allow_multiple=False)
        cleaned_sprites = [sp for sp, _cb, _cs in cleaned_batch]
        clip_flags = [(cb, cs) for _sp, cb, cs in cleaned_batch]
        hints = [ld.role_hint for ld in loaded_list]
        names = [ld.name for ld in loaded_list]

        assigned = _assign_multi_image_roles(
            cleaned_sprites,
            hints,
            None,
            clip_flags=clip_flags,
            names=names,
        )
        return _assemble_prepared_result(
            sprites=cleaned_sprites,
            clip_flags=clip_flags,
            names=names,
            assigned=assigned,
            raw_layout="faceted",
            mode="faceted",
            split_count=1,
            flip_side=flip_side,
        )

    # Auto / legacy mode with 1..16 inputs
    if len(raw_inputs) == 0:
        raise SmartImportError("MISSING_INPUT", MSG_MISSING_INPUT)
    if len(raw_inputs) > MAX_INPUTS:
        raise SmartImportError("TOO_MANY_INPUTS", MSG_TOO_MANY_INPUTS)

    loaded_list: list[LoadedImage] = []
    for idx, entry in enumerate(raw_inputs):
        p_str, name, hint = _parse_input_entry(entry, idx)
        loaded_list.append(_load_image_strict(p_str, name=name, role_hint=hint))

    # Single input inspection path
    if len(loaded_list) == 1:
        item0 = loaded_list[0]

        # 1) Multi-frame animated GIF/WebP
        if item0.is_animated and raw_layout in ("auto", "single-image"):
            if not _has_visible_foreground(item0.rgba, min_pixels=8):
                raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)
            preview_sp = _crop_tight(item0.rgba)
            preview_cell = normalize_view_cell(preview_sp)
            preview_url = _pil_to_data_url(preview_cell)
            return {
                "layout": raw_layout,
                "mode": "animated",
                "modeLabel": MODE_LABELS["animated"],
                "recommendedLayout": "single-image",
                "splitCount": 1,
                "viewCount": 1,
                "roleCounts": {r: (1 if r == "front" else 0) for r in VALID_ROLES},
                "warnings": [f"检测到 {item0.n_frames} 帧动态图，将完整保留原有动画。"],
                "suggestedColor": extract_suggested_color(preview_sp),
                "sideFacesRight": True,
                "rawSideFacesRight": True,
                "items": [{
                    "index": 0,
                    "name": item0.name,
                    "role": "animated",
                    "roleLabel": ROLE_LABELS["animated"],
                    "manualRole": "",
                    "isManual": False,
                    "isPrimaryAnchor": True,
                    "reason": "检测到多帧动态图，保留完整原生动画",
                    "confidence": 1.0,
                    "previewDataUrl": preview_url,
                }],
                "views": [
                    {"role": "front", "label": "正面", "dataUrl": preview_url},
                ],
                "front_cell": preview_cell,
                "side_right_cell": preview_cell,
                "side_left_cell": None,
                "back_cell": preview_cell,
                "top_cell": None,
                "face_closeup_cell": None,
                "has_real_side": False,
                "has_left_side": False,
                "has_right_side": False,
                "has_real_back": False,
                "extra_cells": [],
                "extra_clip_flags": [],
                "raw_sheet": item0.rgba,
            }

        # Key background once cleanly (allow_multiple=True so turnaround sheets keep 2..4 figures)
        orig_p0 = item0.path if item0.path.is_file() else None
        keyed0 = adaptive_remove_background(item0.rgba, orig_path=orig_p0, allow_multiple=True)
        if not _has_visible_foreground(keyed0):
            raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)

        detected_grid = _detect_grid_layout(keyed0) if raw_layout == "auto" else None

        # 2) 8x11 spritesheet
        if detected_grid == "grid-8x11" or raw_layout == "codex-v2-8x11":
            norm_atlas, first_sp = _normalize_existing_grid(keyed0, 8, 11, 176.0, 190.0, 200)
            front_cell = norm_atlas.crop((0, 0, CELL_W, CELL_H))
            side_cell = norm_atlas.crop((0, CELL_H, CELL_W, 2 * CELL_H))
            back_cell = norm_atlas.crop((0, 9 * CELL_H, CELL_W, 10 * CELL_H))
            has_side = _has_visible_foreground(side_cell, min_pixels=8)
            has_back = _has_visible_foreground(back_cell, min_pixels=8)
            if not has_side:
                side_cell = front_cell
            if not has_back:
                back_cell = front_cell
            views_g8 = [{"role": "front", "label": "正面", "dataUrl": _pil_to_data_url(front_cell)}]
            if has_side:
                views_g8.append({"role": "right_side", "label": "右侧面", "canFlip": True, "dataUrl": _pil_to_data_url(side_cell)})
            if has_back:
                views_g8.append({"role": "back", "label": "背面", "dataUrl": _pil_to_data_url(back_cell)})
            return {
                "layout": raw_layout,
                "mode": "grid-8x11",
                "modeLabel": MODE_LABELS["grid-8x11"],
                "recommendedLayout": "codex-v2-8x11",
                "splitCount": 1,
                "viewCount": 1,
                "roleCounts": {r: (1 if r == "front" else 0) for r in VALID_ROLES},
                "warnings": [],
                "suggestedColor": extract_suggested_color(first_sp),
                "sideFacesRight": True,
                "rawSideFacesRight": True,
                "items": [{
                    "index": 0,
                    "name": item0.name,
                    "role": "grid-8x11",
                    "roleLabel": ROLE_LABELS["grid-8x11"],
                    "manualRole": "",
                    "isManual": False,
                    "isPrimaryAnchor": True,
                    "reason": "检测到标准 8×11 完整动作精灵表",
                    "confidence": 0.99,
                    "previewDataUrl": _pil_to_data_url(front_cell),
                }],
                "views": views_g8,
                "front_cell": front_cell,
                "side_right_cell": side_cell,
                "side_left_cell": None,
                "back_cell": back_cell,
                "top_cell": None,
                "face_closeup_cell": None,
                "has_real_side": has_side,
                "has_left_side": False,
                "has_right_side": has_side,
                "has_real_back": has_back,
                "extra_cells": [],
                "extra_clip_flags": [],
                "prebaked_atlas": norm_atlas,
            }

        # 3) 4x3 spritesheet
        if detected_grid == "grid-4x3" or raw_layout == "compact-4x3":
            norm_atlas, first_sp = _normalize_existing_grid(keyed0, 4, 3, 172.0, 184.0, 196)
            front_cell = norm_atlas.crop((0, 0, CELL_W, CELL_H))
            side_cell = norm_atlas.crop((0, CELL_H, CELL_W, 2 * CELL_H))
            work_cell = norm_atlas.crop((0, 2 * CELL_H, CELL_W, 3 * CELL_H))
            has_side = _has_visible_foreground(side_cell, min_pixels=8)
            has_work = _has_visible_foreground(work_cell, min_pixels=8)
            if not has_side:
                side_cell = front_cell
            views_g4 = [{"role": "front", "label": "正面", "dataUrl": _pil_to_data_url(front_cell)}]
            if has_side:
                views_g4.append({"role": "right_side", "label": "右侧面", "canFlip": True, "dataUrl": _pil_to_data_url(side_cell)})
            if has_work:
                views_g4.append({"role": "action", "label": "动作姿态", "dataUrl": _pil_to_data_url(work_cell)})
            return {
                "layout": raw_layout,
                "mode": "grid-4x3",
                "modeLabel": MODE_LABELS["grid-4x3"],
                "recommendedLayout": "compact-4x3",
                "splitCount": 1,
                "viewCount": 1,
                "roleCounts": {r: (1 if r == "front" else 0) for r in VALID_ROLES},
                "warnings": [],
                "suggestedColor": extract_suggested_color(first_sp),
                "sideFacesRight": True,
                "rawSideFacesRight": True,
                "items": [{
                    "index": 0,
                    "name": item0.name,
                    "role": "grid-4x3",
                    "roleLabel": ROLE_LABELS["grid-4x3"],
                    "manualRole": "",
                    "isManual": False,
                    "isPrimaryAnchor": True,
                    "reason": "检测到 4×3 精灵图集",
                    "confidence": 0.98,
                    "previewDataUrl": _pil_to_data_url(front_cell),
                }],
                "views": views_g4,
                "front_cell": front_cell,
                "side_right_cell": side_cell,
                "side_left_cell": None,
                "back_cell": front_cell,
                "top_cell": None,
                "face_closeup_cell": None,
                "has_real_side": has_side,
                "has_left_side": False,
                "has_right_side": has_side,
                "has_real_back": False,
                "extra_cells": [],
                "extra_clip_flags": [],
                "prebaked_atlas": norm_atlas,
            }

        # 4) Combined 2..4 view turnaround sheet (1x2..1x4 or 2x2)
        split_views = _split_combined_views(keyed0)
        if len(split_views) in (2, 3, 4):
            hints_split = [""] * len(split_views)
            split_names = [f"视角 {idx + 1}" for idx in range(len(split_views))]
            split_clips = [(False, False)] * len(split_views)
            assigned_split = _assign_multi_image_roles(
                split_views,
                hints_split,
                order if isinstance(order, list) else None,
                clip_flags=split_clips,
                names=split_names,
            )
            return _assemble_prepared_result(
                sprites=split_views,
                clip_flags=split_clips,
                names=split_names,
                assigned=assigned_split,
                raw_layout=raw_layout,
                mode="three-view",
                split_count=len(split_views),
                flip_side=flip_side,
            )

        # 5) Single complete character — classify among 7 roles, honor role_hint 100%, synthesize full 11 rows
        sp0 = split_views[0]
        if not _has_visible_foreground(sp0):
            raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)

        clip_b0, clip_s0 = _measure_border_clipping(keyed0)
        pose_feat = _extract_pose_features(sp0, clipped_bottom=clip_b0, clipped_sides=clip_s0)
        if item0.role_hint == "side":
            faces_r, _m, orient_r = _detect_side_orientation_detail(sp0)
            detected_role = "right_side" if faces_r else "left_side"
            is_manual0 = True
            manual_r0 = "side"
            conf0 = 1.0
            reason0 = f"人工指定为侧面（{orient_r}）"
        elif item0.role_hint in VALID_ROLES:
            detected_role = item0.role_hint
            is_manual0 = True
            manual_r0 = detected_role
            conf0 = 1.0
            reason0 = f"人工指定为{ROLE_LABELS[detected_role]}"
        else:
            detected_role, conf0, reason0 = _classify_single_sprite_role(sp0, pose_feat, name=item0.name)
            is_manual0 = False
            manual_r0 = ""

        single_assigned = {
            "itemsMeta": [{
                "role": detected_role,
                "roleLabel": ROLE_LABELS.get(detected_role, "正面"),
                "manualRole": manual_r0,
                "isManual": is_manual0,
                "isPrimaryAnchor": True,
                "reason": reason0,
                "confidence": conf0,
            }],
            "roleGroups": {r: ([0] if r == detected_role else []) for r in VALID_ROLES},
            "primaryByRole": {detected_role: 0},
            "roleCounts": {r: (1 if r == detected_role else 0) for r in VALID_ROLES},
            "warnings": (
                []
                if detected_role == "front"
                else [f"检测到单张{ROLE_LABELS.get(detected_role, '')}图，已基于该画面稳妥补齐整套动作。"]
            ),
            "feats": [pose_feat],
        }
        res_single = _assemble_prepared_result(
            sprites=[sp0],
            clip_flags=[(clip_b0, clip_s0)],
            names=[item0.name],
            assigned=single_assigned,
            raw_layout=raw_layout,
            mode="single-char",
            split_count=1,
            flip_side=flip_side,
        )
        return res_single

    # Multi-image mode (2..16 images): never split individual photos; keep all same-role groups!
    cleaned_batch = _clean_loaded_items_batch(loaded_list, allow_multiple=False)
    cleaned_sprites: list[Image.Image] = [sp for sp, _cb, _cs in cleaned_batch]
    clip_flags: list[tuple[bool, bool]] = [(cb, cs) for _sp, cb, cs in cleaned_batch]
    hints: list[str] = [item.role_hint for item in loaded_list]
    names: list[str] = [item.name for item in loaded_list]

    assigned = _assign_multi_image_roles(
        cleaned_sprites,
        hints,
        order if isinstance(order, list) else None,
        clip_flags=clip_flags,
        names=names,
    )
    return _assemble_prepared_result(
        sprites=cleaned_sprites,
        clip_flags=clip_flags,
        names=names,
        assigned=assigned,
        raw_layout=raw_layout,
        mode="multi-view",
        split_count=1,
        flip_side=flip_side,
    )


def run_analyze(cfg: dict[str, Any]) -> dict[str, Any]:
    prep = _prepare_import(cfg)
    return {
        "ok": True,
        "layout": prep["layout"],
        "mode": prep["mode"],
        "modeLabel": prep["modeLabel"],
        "recommendedLayout": prep["recommendedLayout"],
        "splitCount": prep["splitCount"],
        "viewCount": prep["viewCount"],
        "roleCounts": prep.get("roleCounts", {}),
        "warnings": prep["warnings"],
        "suggestedColor": prep["suggestedColor"],
        "sideFacesRight": prep["sideFacesRight"],
        "rawSideFacesRight": prep["rawSideFacesRight"],
        "items": prep["items"],
        "views": prep["views"],
    }


def run_build(cfg: dict[str, Any]) -> dict[str, Any]:
    prep = _prepare_import(cfg)

    output_dir = Path(cfg["outputDir"]) if cfg.get("outputDir") else None
    atlas_path = Path(cfg["atlas_png"]) if cfg.get("atlas_png") else (
        output_dir / "spritesheet.png" if output_dir else Path("spritesheet.png")
    )
    thumb_path = Path(cfg["thumb"]) if cfg.get("thumb") else (
        output_dir / "thumb.png" if output_dir else Path("thumb.png")
    )

    front_cell: Image.Image = prep["front_cell"]
    side_right_cell: Image.Image = prep["side_right_cell"]
    side_left_cell: Image.Image | None = prep.get("side_left_cell")
    back_cell: Image.Image = prep["back_cell"]
    top_cell: Image.Image | None = prep.get("top_cell")
    face_closeup_cell: Image.Image | None = prep.get("face_closeup_cell")
    extra_cells: list[Image.Image] = prep["extra_cells"]

    _make_thumbnail(front_cell, thumb_path)

    if prep["mode"] == "animated" and cfg.get("preserveAnimated", True):
        return {
            "ok": True,
            "layout": prep["layout"],
            "mode": prep["mode"],
            "modeLabel": prep["modeLabel"],
            "recommendedLayout": "single-image",
            "preserveOriginalIndex": 0,
            "splitCount": 1,
            "viewCount": 1,
            "roleCounts": prep.get("roleCounts", {}),
            "warnings": prep["warnings"],
            "suggestedColor": prep["suggestedColor"],
            "sideFacesRight": prep["sideFacesRight"],
            "rawSideFacesRight": prep["rawSideFacesRight"],
            "thumbPng": str(thumb_path),
            "items": [{k: v for k, v in it.items() if k != "previewDataUrl"} for it in prep["items"]],
            "extraPlacements": [],
        }

    prebaked: Image.Image | None = prep.get("prebaked_atlas")
    extra_placements: list[dict[str, Any]] = []
    if prebaked is not None:
        atlas = prebaked
    else:
        atlas, extra_placements = _synthesize_8x11_atlas(
            front_cell,
            side_right_cell,
            back_cell,
            extra_cells,
            prep.get("extra_clip_flags"),
            has_real_side=bool(prep.get("has_real_side", True)),
            has_real_back=bool(prep.get("has_real_back", False)),
            side_left_cell=side_left_cell,
            has_left_side=bool(prep.get("has_left_side", False)),
            has_right_side=bool(prep.get("has_right_side", False)),
            top_cell=top_cell,
            face_closeup_cell=face_closeup_cell,
            action_cells=extra_cells,
            action_clip_flags=prep.get("extra_clip_flags"),
        )

    atlas_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(atlas_path, format="PNG")

    return {
        "ok": True,
        "layout": prep["layout"],
        "mode": prep["mode"],
        "modeLabel": prep["modeLabel"],
        "recommendedLayout": prep["recommendedLayout"],
        "splitCount": prep["splitCount"],
        "viewCount": prep["viewCount"],
        "roleCounts": prep.get("roleCounts", {}),
        "warnings": prep["warnings"],
        "suggestedColor": prep["suggestedColor"],
        "sideFacesRight": prep["sideFacesRight"],
        "rawSideFacesRight": prep["rawSideFacesRight"],
        "atlasPng": str(atlas_path),
        "thumbPng": str(thumb_path),
        "width": atlas.width,
        "height": atlas.height,
        "items": [{k: v for k, v in it.items() if k != "previewDataUrl"} for it in prep["items"]],
        "extraPlacements": extra_placements,
    }


CODEX_V2_ACTIVE_COLS = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]


def _shave_cell_fringe(cell: Image.Image) -> Image.Image:
    """Shave 1px light/noisy fringe around silhouette and purge tiny disconnected crumbs."""
    cleaned = filter_isolated_noise(cell.convert("RGBA"))
    arr = np.array(cleaned, dtype=np.uint8)
    alpha = arr[:, :, 3].astype(np.float32)
    vis = alpha > 8
    if not np.any(vis):
        return cleaned
    trans = ~vis
    edge1 = ndimage.binary_dilation(trans, iterations=1) & vis
    edge2 = ndimage.binary_dilation(trans, iterations=2) & vis & (~edge1)
    r, g, b = arr[:, :, 0].astype(np.float32), arr[:, :, 1].astype(np.float32), arr[:, :, 2].astype(np.float32)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    green_dom = g - np.maximum(r, b)
    # Erode bright white sticker halo or residual green fringe strictly on the outer 1-2px rim
    halo = edge1 & ((lum > 185.0) | (green_dom > 18.0) | (alpha < 185.0))
    alpha[halo] = 0.0
    soft = edge2 & ((lum > 205.0) | (green_dom > 24.0))
    alpha[soft] *= 0.35
    # Decontaminate remaining boundary RGB from interior dark ink/fur
    interior = (alpha >= 230.0) & (~edge1) & (~edge2)
    rim = (alpha > 8.0) & (edge1 | edge2)
    if np.any(interior) and np.any(rim):
        vf = interior.astype(np.float32)
        cnt = ndimage.uniform_filter(vf, size=5, mode="constant")
        has_ref = rim & (cnt > 1e-4)
        if np.any(has_ref):
            for ch in range(3):
                mfg = ndimage.uniform_filter(arr[:, :, ch].astype(np.float32) * vf, size=5, mode="constant")
                est = mfg[has_ref] / cnt[has_ref]
                arr[has_ref, ch] = np.clip(np.rint(arr[has_ref, ch] * 0.35 + est * 0.65), 0, 255).astype(np.uint8)
    arr[:, :, 3] = np.where(alpha <= 10.0, 0, np.clip(np.rint(alpha), 0, 255)).astype(np.uint8)
    arr[arr[:, :, 3] == 0] = (0, 0, 0, 0)
    return filter_isolated_noise(Image.fromarray(arr, "RGBA"))


def _transform_single_cell(
    cell: Image.Image,
    *,
    flip_x: bool = False,
    dx: int = 0,
    dy: int = 0,
    scale: float = 1.0,
    clean_edge: bool = False,
    fw: int = CELL_W,
    fh: int = CELL_H,
) -> Image.Image:
    cur = cell.convert("RGBA")
    if clean_edge:
        cur = _shave_cell_fringe(cur)
    if flip_x:
        cur = cur.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if abs(scale - 1.0) > 1e-3:
        bb = cur.getbbox()
        if bb:
            sp = cur.crop(bb)
            nw = max(1, round(sp.width * scale))
            nh = max(1, round(sp.height * scale))
            sp_r = sp.resize((nw, nh), Image.Resampling.LANCZOS)
            cx = round((bb[0] + bb[2]) * 0.5 - nw * 0.5)
            by = bb[3] - nh
            canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
            canvas.alpha_composite(sp_r, (max(-fw, min(fw, cx)), max(-fh, min(fh, by))))
            cur = canvas
    if dx != 0 or dy != 0:
        canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
        canvas.alpha_composite(cur, (int(dx), int(dy)))
        cur = canvas
    return cur


def _extract_strip_frames(keyed: Image.Image, target_count: int) -> list[Image.Image]:
    """Extract frames from a 1xN or 2x4 sprite strip, or return [single_pose] if 1 figure."""
    w, h = keyed.size
    aspect = w / max(1.0, float(h))
    det = _detect_grid_layout(keyed)
    if det == "grid-8x11":
        return [keyed.crop((c * w // 8, 0, (c + 1) * w // 8, h // 11)) for c in range(min(8, target_count))]

    # Check 2x4 grid when target_count == 8 and image is ~16:9 with 2 clear horizontal bands
    if target_count >= 6 and 1.35 <= aspect <= 2.25:
        arr_a = np.array(keyed)[:, :, 3] > 20
        row_proj = arr_a.sum(axis=1)
        mid0, mid1 = int(h * 0.40), int(h * 0.60)
        if mid1 > mid0 and int(row_proj[mid0:mid1].min()) <= max(2, int(w * 0.01)):
            top_has = bool(np.any(arr_a[:mid0, :]))
            bot_has = bool(np.any(arr_a[mid1:, :]))
            if top_has and bot_has:
                gy = mid0 + int(np.argmin(row_proj[mid0:mid1]))
                frames_2x4: list[Image.Image] = []
                for ry0, ry1 in ((0, gy), (gy + 1, h)):
                    for c in range(4):
                        cell = keyed.crop((round(c * w / 4), ry0, round((c + 1) * w / 4), ry1))
                        if _has_visible_foreground(cell, 12):
                            frames_2x4.append(_crop_tight(filter_isolated_noise(cell)))
                if len(frames_2x4) >= 4:
                    return frames_2x4

    split_figs = _split_combined_views(keyed)
    if len(split_figs) >= 2:
        return split_figs

    if aspect >= 2.15 and target_count >= 2:
        # Fallback equal column slicing for tight horizontal strips
        guess_n = min(8, max(2, round(aspect / 0.85)))
        if abs(guess_n - target_count) <= 1:
            guess_n = target_count
        sliced: list[Image.Image] = []
        for c in range(guess_n):
            cell = keyed.crop((round(c * w / guess_n), 0, round((c + 1) * w / guess_n), h))
            if _has_visible_foreground(cell, 12):
                sliced.append(_crop_tight(filter_isolated_noise(cell)))
        if len(sliced) >= 2:
            return sliced

    return [split_figs[0]] if split_figs else [_crop_tight(keyed)]


def run_edit_frame(cfg: dict[str, Any]) -> dict[str, Any]:
    """Modify 1 frame, 1 action row, 1 static thumb, or 1 single-image asset cleanly."""
    action = str(cfg.get("action") or "transform").strip().lower()
    scope = str(cfg.get("scope") or ("row" if action == "replace_row" else "cell")).strip().lower()
    layout = str(cfg.get("layout") or "codex-v2-8x11").strip()

    atlas_in_str = str(cfg.get("atlasInput") or "").strip()
    atlas_out_str = str(cfg.get("atlasOutput") or cfg.get("atlas_png") or "").strip()
    thumb_in_str = str(cfg.get("thumbInput") or "").strip()
    thumb_out_str = str(cfg.get("thumbOutput") or cfg.get("thumb") or "").strip()
    thumb_out = Path(thumb_out_str) if thumb_out_str else None

    if scope == "thumb":
        if thumb_out is None:
            raise SmartImportError("INVALID_ARGS", MSG_INTERNAL_ERROR)
        if action in ("replace_cell", "replace_row", "replace_thumb"):
            img_path_str = str(cfg.get("imagePath") or "").strip()
            loaded = _load_image_strict(img_path_str, name="头像图")
            orig_p = loaded.path if loaded.path.is_file() else None
            keyed = adaptive_remove_background(loaded.rgba, orig_path=orig_p, allow_multiple=False)
            if not _has_visible_foreground(keyed):
                raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)
            sp = _crop_tight(filter_isolated_noise(keyed))
            _make_thumbnail(sp, thumb_out)
        elif action == "transform":
            src_thumb_path = Path(thumb_in_str) if thumb_in_str else Path(atlas_in_str)
            if not src_thumb_path.is_file():
                raise SmartImportError("FILE_NOT_FOUND", MSG_FILE_NOT_FOUND)
            with Image.open(src_thumb_path) as tim:
                tim.load()
                t_rgba = tim.convert("RGBA")
            if t_rgba.size != (256, 256):
                t_rgba = t_rgba.resize((256, 256), Image.Resampling.LANCZOS)
            next_thumb = _transform_single_cell(
                t_rgba,
                flip_x=bool(cfg.get("flipX", False)),
                dx=int(cfg.get("dx") or 0),
                dy=int(cfg.get("dy") or 0),
                scale=float(cfg.get("scale") or 1.0),
                clean_edge=bool(cfg.get("cleanEdge", False)),
                fw=256,
                fh=256,
            )
            thumb_out.parent.mkdir(parents=True, exist_ok=True)
            next_thumb.save(thumb_out, format="PNG")
        else:
            raise SmartImportError("INVALID_ARGS", MSG_INTERNAL_ERROR)
        return {
            "ok": True,
            "action": action,
            "scope": scope,
            "row": 0,
            "col": 0,
            "activeCols": 1,
            "thumbPng": str(thumb_out),
        }

    atlas_in = Path(atlas_in_str)
    atlas_out = Path(atlas_out_str)
    if not atlas_in.is_file():
        raise SmartImportError("FILE_NOT_FOUND", MSG_FILE_NOT_FOUND)

    if layout == "single-image":
        with Image.open(atlas_in) as src_im:
            n_frames = int(getattr(src_im, "n_frames", 1) or 1)
            is_anim = n_frames > 1
            src_im.seek(0)
            src_im.load()
            single_rgba = src_im.convert("RGBA")

        if action in ("replace_cell", "replace_row", "replace_asset"):
            img_path_str = str(cfg.get("imagePath") or "").strip()
            loaded = _load_image_strict(img_path_str, name="替换图")
            orig_p = loaded.path if loaded.path.is_file() else None
            keyed = adaptive_remove_background(loaded.rgba, orig_path=orig_p, allow_multiple=False)
            if not _has_visible_foreground(keyed):
                raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)
            cleaned = _crop_tight(filter_isolated_noise(keyed))
            atlas_out.parent.mkdir(parents=True, exist_ok=True)
            cleaned.save(atlas_out, format="PNG")
            if thumb_out is not None:
                _make_thumbnail(cleaned, thumb_out)
        elif action == "transform":
            if is_anim:
                raise SmartImportError("UNSUPPORTED_FORMAT", "动态 GIF/WebP 暂不支持单帧平移翻转，请直接上传替换图。")
            sw, sh = single_rgba.size
            next_single = _transform_single_cell(
                single_rgba,
                flip_x=bool(cfg.get("flipX", False)),
                dx=int(cfg.get("dx") or 0),
                dy=int(cfg.get("dy") or 0),
                scale=float(cfg.get("scale") or 1.0),
                clean_edge=bool(cfg.get("cleanEdge", False)),
                fw=sw,
                fh=sh,
            )
            atlas_out.parent.mkdir(parents=True, exist_ok=True)
            next_single.save(atlas_out, format="PNG")
            if thumb_out is not None and _has_visible_foreground(next_single, 8):
                _make_thumbnail(_crop_tight(next_single), thumb_out)
        else:
            raise SmartImportError("INVALID_ARGS", MSG_INTERNAL_ERROR)
        return {
            "ok": True,
            "action": action,
            "scope": scope,
            "row": 0,
            "col": 0,
            "activeCols": 1,
            "atlasPng": str(atlas_out),
        }

    cols = int(cfg.get("cols") or (8 if layout == "codex-v2-8x11" else 4 if layout == "compact-4x3" else 1))
    rows = int(cfg.get("rows") or (11 if layout == "codex-v2-8x11" else 3 if layout == "compact-4x3" else 1))
    fw = int(cfg.get("frameWidth") or CELL_W)
    fh = int(cfg.get("frameHeight") or CELL_H)

    with Image.open(atlas_in) as src_im:
        src_im.load()
        atlas = src_im.convert("RGBA")
    if atlas.size != (cols * fw, rows * fh):
        atlas = atlas.resize((cols * fw, rows * fh), Image.Resampling.LANCZOS)

    row = max(0, min(rows - 1, int(cfg.get("row") or 0)))
    col = max(0, min(cols - 1, int(cfg.get("col") or 0)))
    row_code = str(cfg.get("rowCode") or "").strip().upper()
    raw_col_start = cfg.get("colStart")
    is_hold_subrow = (
        layout == "codex-v2-8x11"
        and row == 4
        and (
            row_code == "R04H"
            or (raw_col_start is not None and int(raw_col_start) == 5)
            or (raw_col_start is None and scope == "row" and col >= 5)
        )
    )
    if is_hold_subrow:
        col_start = 5
        active_n = 3
    else:
        col_start = max(0, min(cols - 1, int(raw_col_start or 0))) if raw_col_start is not None else 0
        default_active = (
            CODEX_V2_ACTIVE_COLS[row]
            if (layout == "codex-v2-8x11" and row < len(CODEX_V2_ACTIVE_COLS))
            else cols
        )
        raw_active = cfg.get("activeCols")
        active_n = max(1, min(cols - col_start, int(raw_active) if raw_active is not None else default_active))
    target_cols = [col_start + i for i in range(active_n)]

    def clear_and_put(r_i: int, c_i: int, tile: Image.Image) -> None:
        box = (c_i * fw, r_i * fh, (c_i + 1) * fw, (r_i + 1) * fh)
        atlas.paste((0, 0, 0, 0), box)
        if tile.size != (fw, fh):
            tile = tile.resize((fw, fh), Image.Resampling.LANCZOS)
        atlas.alpha_composite(tile, (c_i * fw, r_i * fh))

    if action in ("replace_cell", "replace_row"):
        img_path_str = str(cfg.get("imagePath") or "").strip()
        loaded = _load_image_strict(img_path_str, name="替换图")
        orig_p = loaded.path if loaded.path.is_file() else None

        if action == "replace_cell" and scope != "row":
            keyed = adaptive_remove_background(loaded.rgba, orig_path=orig_p, allow_multiple=False)
            if not _has_visible_foreground(keyed):
                raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)
            norm_tile = normalize_view_cell(
                _crop_tight(filter_isolated_noise(keyed)),
                target_h=fh * 0.885,
                max_w=fw * 0.885,
                bottom_excl=round(fh * 0.96),
            )
            if fw != CELL_W or fh != CELL_H:
                sp = _crop_tight(filter_isolated_noise(keyed))
                sc = min((fh * 0.88) / max(1, sp.height), (fw * 0.88) / max(1, sp.width))
                nw, nh = max(1, round(sp.width * sc)), max(1, round(sp.height * sc))
                norm_tile = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
                norm_tile.alpha_composite(sp.resize((nw, nh), Image.Resampling.LANCZOS), ((fw - nw) // 2, round(fh * 0.96) - nh))
            clear_and_put(row, col, norm_tile)
        else:
            keyed_multi = adaptive_remove_background(loaded.rgba, orig_path=orig_p, allow_multiple=True)
            if not _has_visible_foreground(keyed_multi):
                raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)
            frames = _extract_strip_frames(keyed_multi, active_n)
            # Clear only the target sub-row columns on row 4 (so R04 preserves R04H and vice versa)
            clear_cols = target_cols if (layout == "codex-v2-8x11" and row == 4) else list(range(cols))
            for c_i in clear_cols:
                atlas.paste((0, 0, 0, 0), (c_i * fw, row * fh, (c_i + 1) * fw, (row + 1) * fh))

            if len(frames) >= 2:
                # Normalize group with unified scale so multi-frame strips never bob/jitter in height!
                max_h_raw = max(max(1, f.height) for f in frames)
                max_w_raw = max(max(1, f.width) for f in frames)
                uni_scale = min((fh * 0.885) / max_h_raw, (fw * 0.885) / max_w_raw)
                norm_frames: list[Image.Image] = []
                for f in frames:
                    nw = max(1, round(f.width * uni_scale))
                    nh = max(1, round(f.height * uni_scale))
                    tile = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
                    tile.alpha_composite(
                        f.resize((nw, nh), Image.Resampling.LANCZOS),
                        ((fw - nw) // 2, round(fh * 0.96) - nh),
                    )
                    norm_frames.append(tile)
                for idx_i, c_i in enumerate(target_cols):
                    src_idx = min(len(norm_frames) - 1, round(idx_i * (len(norm_frames) - 1) / max(1, active_n - 1))) if len(norm_frames) != active_n else idx_i
                    clear_and_put(row, c_i, norm_frames[src_idx])
            else:
                # Single pose uploaded for an entire row -> synthesize that row's complete natural motion!
                pose_cell = normalize_view_cell(frames[0])
                has_side_pose = _is_single_pose_more_like_side(_extract_pose_features(frames[0]))
                synth_atlas, _ = _synthesize_8x11_atlas(
                    pose_cell,
                    pose_cell,
                    pose_cell,
                    [pose_cell],
                    [(False, False)],
                    has_real_side=has_side_pose,
                    has_real_back=False,
                )
                if layout == "codex-v2-8x11" and fw == CELL_W and fh == CELL_H:
                    for c_i in target_cols:
                        tile = synth_atlas.crop((c_i * CELL_W, row * CELL_H, (c_i + 1) * CELL_W, (row + 1) * CELL_H))
                        clear_and_put(row, c_i, tile)
                else:
                    for idx_i, c_i in enumerate(target_cols):
                        ang = math.sin(2.0 * math.pi * idx_i / max(1, active_n)) * 2.5
                        tile = _articulate_cell(pose_cell, angle_deg=ang, bottom_excl=200)
                        clear_and_put(row, c_i, tile)
    elif action == "transform":
        flip_x = bool(cfg.get("flipX", False))
        dx = int(cfg.get("dx") or 0)
        dy = int(cfg.get("dy") or 0)
        scale = float(cfg.get("scale") or 1.0)
        clean_edge = bool(cfg.get("cleanEdge", False))
        cols_to_xform = target_cols if scope == "row" else [col]
        for c_i in cols_to_xform:
            cur_tile = atlas.crop((c_i * fw, row * fh, (c_i + 1) * fw, (row + 1) * fh))
            next_tile = _transform_single_cell(
                cur_tile,
                flip_x=flip_x,
                dx=dx,
                dy=dy,
                scale=scale,
                clean_edge=clean_edge,
                fw=fw,
                fh=fh,
            )
            clear_and_put(row, c_i, next_tile)
    else:
        raise SmartImportError("INVALID_ARGS", MSG_INTERNAL_ERROR)

    atlas_out.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(atlas_out, format="PNG")
    if thumb_out is not None and row == 0 and ((scope == "row" and col_start == 0) or (scope == "cell" and col == 0)):
        cell0 = atlas.crop((0, 0, fw, fh))
        if _has_visible_foreground(cell0, 8):
            _make_thumbnail(cell0, thumb_out)

    return {
        "ok": True,
        "action": action,
        "scope": scope,
        "row": row,
        "col": col,
        "rowCode": "R04H" if is_hold_subrow else f"R{row:02d}",
        "colStart": col_start,
        "activeCols": active_n,
        "atlasPng": str(atlas_out),
    }


def _load_payload(args: argparse.Namespace) -> dict[str, Any]:
    cfg: dict[str, Any] = {}
    if args.config:
        cfg_path = Path(args.config)
        if not cfg_path.is_file():
            raise SmartImportError("FILE_NOT_FOUND", MSG_FILE_NOT_FOUND)
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise SmartImportError("INTERNAL_ERROR", MSG_INTERNAL_ERROR) from exc
    elif args.payload:
        raw = args.payload.strip()
        try:
            if raw == "-":
                cfg = json.loads(sys.stdin.read())
            elif raw.startswith("{"):
                cfg = json.loads(raw)
            elif Path(raw).is_file():
                cfg = json.loads(Path(raw).read_text(encoding="utf-8"))
            else:
                raise SmartImportError("INTERNAL_ERROR", MSG_INTERNAL_ERROR)
        except SmartImportError:
            raise
        except Exception as exc:
            raise SmartImportError("INTERNAL_ERROR", MSG_INTERNAL_ERROR) from exc

    if args.layout:
        cfg["layout"] = args.layout
    if args.input:
        cfg["inputs"] = list(args.input)
    if args.order:
        try:
            cfg["order"] = [int(x.strip()) for x in args.order.split(",") if x.strip() != ""]
        except ValueError:
            pass
    if args.flip_side:
        cfg["flipSide"] = True
    if args.front or args.side or args.back or args.extra:
        facets = cfg.get("facets") if isinstance(cfg.get("facets"), dict) else {}
        if args.front:
            facets["front"] = args.front
        if args.side:
            facets["side"] = args.side
        if args.back:
            facets["back"] = args.back
        if args.extra:
            facets["extras"] = list(args.extra)
        if args.flip_side:
            facets["flipSide"] = True
        cfg["facets"] = facets
        if not args.layout and "layout" not in cfg:
            cfg["layout"] = "faceted"
    if args.output_dir:
        cfg["outputDir"] = args.output_dir
    if args.atlas_png:
        cfg["atlas_png"] = args.atlas_png
    if args.thumb:
        cfg["thumb"] = args.thumb
    return cfg


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, exit_on_error=False)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--analyze", action="store_true", help="Analyze and classify smart import inputs")
    group.add_argument("--build", action="store_true", help="Build spritesheet atlas and 256x256 thumb")
    group.add_argument("--edit-frame", action="store_true", help="Modify a frame or action row in an existing atlas")
    parser.add_argument("payload", nargs="?", help="JSON config string or path (or '-' for stdin)")
    parser.add_argument("--config", help="Path to JSON config file")
    parser.add_argument("--layout", help="Import layout mode: auto | faceted | three-view | compact-4x3 | codex-v2-8x11 | single-image")
    parser.add_argument("--input", action="append", help="Input image path (repeatable up to 12)")
    parser.add_argument("--front", help="Front view path for faceted mode")
    parser.add_argument("--side", help="Side view path for faceted mode")
    parser.add_argument("--back", help="Back view path for faceted mode")
    parser.add_argument("--extra", action="append", help="Extra action view path (repeatable)")
    parser.add_argument("--order", help="Comma-separated index order e.g. 0,1,2")
    parser.add_argument("--flip-side", action="store_true", help="Flip detected side view horizontally")
    parser.add_argument("--output-dir", help="Output directory for build")
    parser.add_argument("--atlas-png", help="Output spritesheet PNG path for --build")
    parser.add_argument("--thumb", help="Output 256x256 PNG thumbnail path for --build")

    try:
        args = parser.parse_args()
        cfg = _load_payload(args)
        if args.analyze:
            result = run_analyze(cfg)
        elif args.edit_frame:
            result = run_edit_frame(cfg)
        else:
            result = run_build(cfg)
        print(json.dumps(result, ensure_ascii=False))
    except SmartImportError as exc:
        print(json.dumps({"ok": False, "code": exc.code, "error": exc.user_message}, ensure_ascii=False))
        sys.exit(1)
    except SystemExit as exc:
        if exc.code == 0:
            raise
        print(json.dumps({"ok": False, "code": "INVALID_ARGS", "error": MSG_INTERNAL_ERROR}, ensure_ascii=False))
        sys.exit(1)
    except argparse.ArgumentError:
        print(json.dumps({"ok": False, "code": "INVALID_ARGS", "error": MSG_INTERNAL_ERROR}, ensure_ascii=False))
        sys.exit(1)
    except Exception:
        print(json.dumps({"ok": False, "code": "INTERNAL_ERROR", "error": MSG_INTERNAL_ERROR}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
