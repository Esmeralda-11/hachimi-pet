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
        bg_candidate = (alpha < 16) | ((dist <= 130.0) & (g_dom >= 44)) | (
            (g_dom >= 54) & (g >= 130) & (max_rb <= 200)
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
        if kg >= 180 and (kg - max(kr, kb)) >= 80:
            # Clear enclosed pure neon #00FF00 pockets between legs/tails while 100% protecting olive/sage-green eyes
            enclosed_exact_green = (~bg_mask) & (
                ((g >= 180) & (r <= 85) & (b <= 85) & (g_dom >= 95))
                | ((g >= 140) & (g_dom >= 55))
                | ((g >= 92) & (max_rb <= 68) & (g_dom >= 42))
            )
            if np.any(enclosed_exact_green):
                hole_ids = set(np.unique(labeled[enclosed_exact_green]).tolist())
                hole_ids.discard(0)
                if hole_ids:
                    bg_mask = bg_mask | np.isin(labeled, list(hole_ids))
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
        for mask, min_dom_cut, max_dist_cut in ((fringe_1, 12, 188.0), (fringe_2, 24, 148.0)):
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
                ramp = np.clip((f_dist[is_matte] - 34.0) / 115.0, 0.0, 1.0)
                a_vals = np.minimum(dom_alpha, ramp) * 255.0
                a_vals = np.where(a_vals <= 18.0, 0.0, a_vals)
                cur = new_alpha[mask]
                cur[is_matte] = np.minimum(cur[is_matte], a_vals)
                new_alpha[mask] = cur

        out = arr.copy()
        out[:, :, 3] = np.clip(np.rint(new_alpha), 0, 255).astype(np.uint8)
        out[out[:, :, 3] <= 18] = (0, 0, 0, 0)
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
    slim_from_seated: bool = True,
) -> Image.Image:
    """Synthesize slim elongated vertical scruff-held dangling pose anchored at top scruff with smooth pendulum sway.

    Sign convention:
      sway_deg > 0 -> lower body swings viewer-LEFT (c6, used when dragging right)
      sway_deg < 0 -> lower body swings viewer-RIGHT (c7, used when dragging left)
    """
    arr = np.array(cell.convert("RGBA"), dtype=np.uint8)
    x0, y0, x1, y1 = _cell_bbox(cell)
    bh = max(1.0, float(y1 - y0))
    bw = max(1.0, float(x1 - x0))
    vis = arr[:, :, 3] > 20

    # Anchor on upper head/torso center so a wide curled side tail never skews vertical plumb line
    head_y1 = max(y0 + 1, min(y1, int(round(y0 + 0.40 * bh))))
    _, head_xs = np.where(vis[y0:head_y1, :])
    if len(head_xs) >= 12:
        cx = float(np.median(head_xs))
        head_w = float(np.percentile(head_xs, 96) - np.percentile(head_xs, 4)) + 1.0
    else:
        cx = 0.5 * (x0 + x1)
        head_w = bw

    # Fit cleanly inside [top_margin, 198] so dangling feet/tail NEVER overflow ground baseline y=200 even during sway
    sway_margin = 6 if abs(sway_deg) > 1e-3 else 0
    max_h_avail = float(min(182 - sway_margin, CELL_H - 10 - top_margin - sway_margin))
    if slim_from_seated:
        # Target classic slim elongated dangling silhouette (~56..78px wide x ~178..182px tall)
        target_sy = min(max_h_avail / bh, max(sy, max_h_avail / bh))
        sx_head = float(np.clip(min(sx, 68.0 / max(1.0, head_w)), 0.54, 0.88))
        sx_lower = float(np.clip(min(sx_head * 0.78, 60.0 / max(1.0, bw)), 0.44, 0.68))
        sy = target_sy
    else:
        if bh * sy > max_h_avail:
            sy = max(0.75, max_h_avail / bh)
        sx_head = sx
        sx_lower = sx

    if abs(sway_deg) > 1e-3:
        rad = abs(sway_deg) * math.pi / 180.0
        half_span = 0.5 * max(head_w * sx_head, bw * sx_lower) + (0.86 * bh * sy) * math.sin(rad)
        if half_span > 88.0:
            shrink = 88.0 / half_span
            sx_head *= shrink
            sx_lower *= shrink
            sy *= shrink

    pm = _make_premul(arr)
    yy, xx = np.mgrid[0:CELL_H, 0:CELL_W].astype(np.float32)

    dst_cx = 0.5 * CELL_W
    dst_top = float(top_margin)
    py_base = (yy - dst_top) / max(0.2, sy) + float(y0)
    u_vert = np.clip((py_base - float(y0)) / bh, 0.0, 1.0)
    # Smooth neck-to-body slimming taper (head stays cute & readable; torso/legs hang slim and elongated)
    u_slim = np.clip((u_vert - 0.30) / 0.45, 0.0, 1.0)
    w_slim = u_slim * u_slim * (3.0 - 2.0 * u_slim)
    eff_sx = sx_head * (1.0 - w_slim) + sx_lower * w_slim
    px_base = (xx - dst_cx) / np.maximum(0.2, eff_sx) + cx

    if abs(sway_deg) > 1e-3:
        y_scruff = float(y0) + 0.16 * bh
        u = np.clip((py_base - y_scruff) / max(1.0, float(y1) - y_scruff), 0.0, 1.0)
        theta = (sway_deg * math.pi / 180.0) * (0.5 * (1.0 - np.cos(math.pi * u)))
        rx = px_base - cx
        ry = py_base - y_scruff
        cos_t = np.cos(theta)
        sin_t = np.sin(theta)
        src_x = cx + rx * cos_t + ry * sin_t
        src_y = y_scruff - rx * sin_t + ry * cos_t
    else:
        src_x, src_y = px_base, py_base

    out_im = _sample_premul(pm, src_x, src_y)
    # Guarantee bottom stays <= 199 (above ground baseline y=200) without clipping scruff top
    ox0, oy0, ox1, oy1 = _cell_bbox(out_im)
    if oy1 > 199:
        sp_fit = _crop_tight(out_im)
        avail = max(40, 199 - top_margin)
        if sp_fit.height > avail:
            fit_sc = avail / float(sp_fit.height)
            sp_fit = _resize_rgba_clean(sp_fit, (max(1, round(sp_fit.width * fit_sc)), avail))
        fitted = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
        dx_f = max(2, min(CELL_W - sp_fit.width - 2, round(0.5 * (ox0 + ox1) - 0.5 * sp_fit.width)))
        fitted.alpha_composite(sp_fit, (dx_f, top_margin))
        return fitted
    return out_im


def _apply_pendulum_sway(cell: Image.Image, *, sway_deg: float) -> Image.Image:
    """Apply smooth scruff-anchored pendulum sway (positive -> viewer-LEFT c6, negative -> viewer-RIGHT c7)."""
    if abs(sway_deg) < 1e-4:
        return cell
    arr = np.array(cell.convert("RGBA"), dtype=np.float32)
    vis = arr[:, :, 3] > 16
    if not np.any(vis):
        return cell
    ys, xs = np.where(vis)
    y0, y1 = float(ys.min()), float(ys.max())
    y_scruff = y0 + 0.18 * (y1 - y0)
    top_y1 = max(int(y0) + 1, int(y0 + 0.34 * (y1 - y0)))
    _, top_xs = np.where(arr[int(y0):top_y1, :, 3] > 20)
    cx = float(top_xs.mean()) if len(top_xs) else 96.0

    pm = _make_premul(arr.astype(np.uint8))
    yy, xx = np.mgrid[0:CELL_H, 0:CELL_W].astype(np.float32)
    u = np.clip((yy - y_scruff) / max(1.0, y1 - y_scruff), 0.0, 1.0)
    theta = (sway_deg * math.pi / 180.0) * (0.5 * (1.0 - np.cos(math.pi * u)))
    rx = xx - cx
    ry = yy - y_scruff
    cos_t, sin_t = np.cos(theta), np.sin(theta)
    src_x = cx + rx * cos_t + ry * sin_t
    src_y = y_scruff - rx * sin_t + ry * cos_t
    return _sample_premul(pm, src_x, src_y)


def _articulate_gaze_head_cell(
    front_cell: Image.Image,
    *,
    angle_rad: float,
    waist_frac: float = 0.54,
    neck_frac: float = 0.32,
) -> Image.Image:
    """Synthesize smooth head-only clockwise 16-dir gaze on a rock-steady seated front body.

    angle_rad: 0 = UP (12:00), pi/2 = RIGHT (3:00), pi = DOWN (6:00), 3*pi/2 = LEFT (9:00).
    Lower body (y >= waist) stays 100% locked to front_cell so there is NEVER a height jump or side-cat swap!
    """
    arr = np.array(front_cell.convert("RGBA"), dtype=np.uint8)
    x0, y0, x1, y1 = _cell_bbox(front_cell)
    bh = max(1.0, float(y1 - y0))
    bw = max(1.0, float(x1 - x0))
    vis = arr[:, :, 3] > 20

    # Locate head horizontal center cleanly (excluding side tail)
    hy1 = max(y0 + 1, min(y1, int(round(y0 + 0.46 * bh))))
    _, hxs = np.where(vis[y0:hy1, :])
    if len(hxs) >= 12:
        cx = float(np.median(hxs))
        head_w = max(24.0, float(np.percentile(hxs, 95) - np.percentile(hxs, 5)))
    else:
        cx = 0.5 * (x0 + x1)
        head_w = bw

    sin_t = math.sin(angle_rad)   # +1 right, -1 left
    cos_t = math.cos(angle_rad)   # +1 up,    -1 down

    # Clamp upward head lift so ear tips never clip at y=0
    max_up_lift = max(1.0, min(5.5, float(y0) - 3.0))
    head_dx = 6.2 * sin_t
    head_dy = -max_up_lift * cos_t if cos_t > 0 else -6.8 * cos_t
    roll_deg = 5.4 * sin_t

    pm = _make_premul(arr)
    yy, xx = np.mgrid[0:CELL_H, 0:CELL_W].astype(np.float32)

    y_waist = float(y0) + waist_frac * bh
    y_neck = float(y0) + neck_frac * bh
    u = np.clip((y_waist - yy) / max(1.0, y_waist - y_neck), 0.0, 1.0)
    w_head = 0.5 * (1.0 - np.cos(math.pi * u))

    # 1) Subtle head roll around neck pivot (cx, y_waist)
    theta = (roll_deg * math.pi / 180.0) * w_head
    rx = xx - cx
    ry = yy - y_waist
    cos_r = np.cos(-theta)
    sin_r = np.sin(-theta)
    px = cx + rx * cos_r - ry * sin_r
    py = y_waist + rx * sin_r + ry * cos_r

    # 2) Directional head translation (yaw + pitch)
    px = px - head_dx * w_head
    py = py - head_dy * w_head

    # 3) Mild 2.5D cylindrical face-interior shift so eyes/nose visibly glance toward angle_rad
    face_cy = float(y0) + 0.28 * bh
    face_ry = max(8.0, 0.18 * bh)
    face_rx = max(10.0, 0.42 * head_w)
    r2 = ((px - cx) / face_rx) ** 2 + ((py - face_cy) / face_ry) ** 2
    face_bell = np.exp(-1.45 * r2) * w_head
    px = px - (4.0 * sin_t) * face_bell
    py = py - (-3.2 * cos_t) * face_bell

    warped = _sample_premul(pm, px, py)
    # Lock lower body cleanly below y_waist + 4px to guarantee zero jitter on paws & tail
    out_arr = np.array(warped, dtype=np.uint8)
    lock_y = min(CELL_H, int(round(y_waist)) + 4)
    out_arr[lock_y:, :, :] = arr[lock_y:, :, :]
    return Image.fromarray(out_arr, "RGBA")


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


def _draw_mini_butterfly(wing_open: float = 1.0) -> Image.Image:
    """Render a crisp, charming, clearly visible yellow butterfly with animated wing-flap spread."""
    scale = 4
    w, h = 22 * scale, 18 * scale
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    flap = float(np.clip(wing_open, 0.45, 1.0))
    top_lift = round((1.0 - flap) * 3.0 * scale)
    # Back upper wing
    draw.ellipse(
        [1 * scale, (1 + top_lift) * scale, 12 * scale, (11 + top_lift // 2) * scale],
        fill=(254, 226, 72, 255),
        outline=(42, 36, 32, 255),
        width=2 * scale,
    )
    # Front upper wing (slightly warmer golden yellow)
    draw.ellipse(
        [9 * scale, (2 + top_lift) * scale, 21 * scale, (12 + top_lift // 2) * scale],
        fill=(250, 204, 21, 255),
        outline=(42, 36, 32, 255),
        width=2 * scale,
    )
    # Lower wings
    draw.ellipse(
        [4 * scale, 9 * scale, 12 * scale, 16 * scale],
        fill=(254, 240, 138, 255),
        outline=(42, 36, 32, 255),
        width=2 * scale,
    )
    draw.ellipse(
        [10 * scale, 9 * scale, 18 * scale, 16 * scale],
        fill=(253, 224, 71, 255),
        outline=(42, 36, 32, 255),
        width=2 * scale,
    )
    # Tiny dark body & antennae
    draw.line([(10.5 * scale, 5 * scale), (10.5 * scale, 14 * scale)], fill=(42, 36, 32, 255), width=2 * scale)
    return im.resize((22, 18), Image.Resampling.LANCZOS)


# ---------------------------------------------------------------------------
# Battle-tested `#00FF00` AI Sprite Sheet Keyer, Valley Slicer & Lower-Body Lock
# (ported & generalized from production pet sprite pipelines)
# ---------------------------------------------------------------------------

def _sample_corner_key_rgb(rgb: np.ndarray) -> tuple[int, int, int]:
    h, w, _ = rgb.shape
    patch = max(2, min(h, w, 10))
    corners = np.concatenate(
        [
            rgb[:patch, :patch].reshape(-1, 3),
            rgb[:patch, w - patch :].reshape(-1, 3),
            rgb[h - patch :, :patch].reshape(-1, 3),
            rgb[h - patch :, w - patch :].reshape(-1, 3),
        ],
        axis=0,
    )
    med = np.rint(np.median(corners, axis=0)).astype(int)
    r, g, b = int(med[0]), int(med[1]), int(med[2])
    if g < max(r, b) + 45:
        return (0, 255, 0)
    return (r, g, b)


def _strip_grid_divider_bars_arr(buf: np.ndarray) -> np.ndarray:
    """Erase accidental straight grid divider lines or outer frame borders drawn across a full multi-cell sheet."""
    bh, bw = buf.shape[:2]
    fg_m = buf[:, :, 3] > 16
    if not np.any(fg_m):
        return buf
    out = buf.copy()

    def wipe_strips(cov: np.ndarray, limit: int, axis: int, lo_idx: int, hi_idx: int) -> None:
        if hi_idx < lo_idx:
            return
        # Strictly >= 94% full-sheet span so tall sprites inside cells are NEVER mistaken for divider lines!
        hits = np.where((cov >= 0.94) & (np.arange(len(cov)) >= lo_idx) & (np.arange(len(cov)) <= hi_idx))[0]
        if len(hits) == 0:
            return
        groups: list[tuple[int, int]] = []
        gs = ge = int(hits[0])
        for idx in hits[1:]:
            idx = int(idx)
            if idx <= ge + 2:
                ge = idx
            else:
                groups.append((gs, ge))
                gs = ge = idx
        groups.append((gs, ge))
        for s0, s1 in groups:
            if (s1 - s0 + 1) <= limit:
                p0 = max(0, s0 - 2)
                p1 = min(len(cov), s1 + 3)
                if axis == 0:
                    out[p0:p1, :, :] = 0
                else:
                    out[:, p0:p1, :] = 0

    row_cov = fg_m.mean(axis=1)
    col_cov = fg_m.mean(axis=0)
    max_bar_h = max(10, int(bh * 0.025))
    max_bar_w = max(10, int(bw * 0.025))
    # Outer edge frames
    wipe_strips(row_cov, max_bar_h, 0, 0, max_bar_h)
    wipe_strips(row_cov, max_bar_h, 0, bh - 1 - max_bar_h, bh - 1)
    wipe_strips(col_cov, max_bar_w, 1, 0, max_bar_w)
    wipe_strips(col_cov, max_bar_w, 1, bw - 1 - max_bar_w, bw - 1)
    # Interior divider lines across full width/height
    wipe_strips(row_cov, max_bar_h, 0, max_bar_h + 1, bh - 2 - max_bar_h)
    wipe_strips(col_cov, max_bar_w, 1, max_bar_w + 1, bw - 2 - max_bar_w)
    return out


def chroma_matte_green_safe(raw_tile: Image.Image, *, keep_yellow_butterfly: bool = False) -> np.ndarray:
    """Chroma-key `#00FF00` cleanly while 100% protecting olive/sage-green eyes, warm coats, and dark outlines."""
    rgba = raw_tile.convert("RGBA")
    arr = np.array(rgba, dtype=np.uint8)
    rgb = arr[:, :, :3].astype(np.int32)
    kr, kg, kb = _sample_corner_key_rgb(arr[:, :, :3])
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    dist = np.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2)
    max_rb = np.maximum(r, b)
    g_dom = g - max_rb

    # Background candidate strictly neon green (olive/sage irises have g_dom <= ~36 and warm R >= 70)
    bg_cand = (arr[:, :, 3] < 16) | ((dist <= 130.0) & (g_dom >= 46)) | ((g_dom >= 56) & (g >= 132) & (max_rb <= 198))
    struct8 = np.ones((3, 3), dtype=int)
    labeled, _ = ndimage.label(bg_cand, structure=struct8)

    border_ids: set[int] = set()
    border_ids.update(np.unique(labeled[0, :]).tolist())
    border_ids.update(np.unique(labeled[-1, :]).tolist())
    border_ids.update(np.unique(labeled[:, 0]).tolist())
    border_ids.update(np.unique(labeled[:, -1]).tolist())
    border_ids.discard(0)
    bg_mask = np.isin(labeled, list(border_ids)) if border_ids else np.zeros(labeled.shape, dtype=bool)

    # Clear enclosed pure neon `#00FF00` pockets between legs/tail/paws while protecting olive/sage-green eyes
    pure_neon_holes = (~bg_mask) & (
        ((g >= 180) & (r <= 85) & (b <= 85) & (g_dom >= 95))
        | ((g >= 140) & (g_dom >= 55))
        | ((g >= 92) & (max_rb <= 68) & (g_dom >= 42))
    )
    if np.any(pure_neon_holes):
        hole_ids = set(np.unique(labeled[pure_neon_holes]).tolist())
        hole_ids.discard(0)
        if hole_ids:
            bg_mask |= np.isin(labeled, list(hole_ids))
        bg_mask |= pure_neon_holes

    dil1 = ndimage.binary_dilation(bg_mask, iterations=1)
    fringe1 = dil1 & (~bg_mask)
    dil2 = ndimage.binary_dilation(bg_mask, iterations=2)
    fringe2 = dil2 & (~dil1)

    new_alpha = arr[:, :, 3].astype(np.float64)
    new_alpha[bg_mask] = 0.0
    for mask, min_dom_cut, max_dist_cut in ((fringe1, 12, 188.0), (fringe2, 24, 148.0)):
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
            ramp = np.clip((f_dist[is_matte] - 34.0) / 115.0, 0.0, 1.0)
            a_vals = np.minimum(dom_alpha, ramp) * 255.0
            a_vals = np.where(a_vals <= 20.0, 0.0, a_vals)
            cur = new_alpha[mask]
            cur[is_matte] = np.minimum(cur[is_matte], a_vals)
            new_alpha[mask] = cur

    arr[:, :, 3] = np.clip(np.rint(new_alpha), 0, 255).astype(np.uint8)
    arr[arr[:, :, 3] <= 20] = 0

    # Despill ONLY on 3px outer silhouette perimeter + dark-ink edge + pure neon stray pixels (NEVER interior eyes!)
    vis1 = arr[:, :, 3] > 0
    vis12 = arr[:, :, 3] > 16
    outer_edge = (vis1 & (~ndimage.binary_erosion(vis1, iterations=3))) | (
        vis12 & (~ndimage.binary_erosion(vis12, iterations=2))
    )
    ri, gi, bi = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)
    mrb = np.maximum(ri, bi)
    is_butterfly_gold = keep_yellow_butterfly & (ri >= 175) & (gi >= 155) & (bi <= 145) & ((gi - ri) <= 22)
    dark_ink_green = vis1 & (mrb <= 62) & ((gi - mrb) >= 18)
    pure_neon_px = vis1 & (gi > 188) & (ri < 88) & (bi < 88)
    spill = (outer_edge & (~is_butterfly_gold) & ((gi - mrb) > 3)) | dark_ink_green | pure_neon_px
    sy, sx = np.where(spill)
    if len(sy) > 0:
        arr[sy, sx, 1] = np.minimum(arr[sy, sx, 1], mrb[sy, sx].astype(np.uint8))
    return arr


def key_green_sprite_safe(
    raw_tile: Image.Image,
    *,
    keep_yellow_butterfly: bool = False,
    keep_pink_yarn: bool = False,
    purge_far_strays: bool = True,
    pre_matted: np.ndarray | None = None,
) -> Image.Image:
    """Chroma-key `#00FF00` on a single tile, protecting olive/sage-green eyes and optional butterfly/yarn."""
    arr = (
        pre_matted.copy()
        if pre_matted is not None
        else chroma_matte_green_safe(raw_tile, keep_yellow_butterfly=keep_yellow_butterfly)
    )
    struct8 = np.ones((3, 3), dtype=int)

    fg = arr[:, :, 3] > 20
    lbl, n = ndimage.label(fg, structure=struct8)
    if n == 0:
        raise ValueError("Empty sprite after #00FF00 chroma-key")
    counts = np.bincount(lbl.ravel())
    counts[0] = 0
    main_id = int(np.argmax(counts))
    keep = lbl == main_id
    mys, mxs = np.where(keep)
    mx0, mx1 = int(mxs.min()), int(mxs.max())
    my0, my1 = int(mys.min()), int(mys.max())
    main_h = max(1, my1 - my0 + 1)

    for cid in range(1, n + 1):
        if cid == main_id:
            continue
        area = int(counts[cid])
        mask_c = lbl == cid
        px = arr[mask_c]
        mr, mg, mb = float(px[:, 0].mean()), float(px[:, 1].mean()), float(px[:, 2].mean())
        if keep_yellow_butterfly and 18 <= area <= int(0.25 * counts[main_id]):
            if mr > 140 and mg > 120 and mb < 165:
                keep |= mask_c
                continue
        if keep_pink_yarn and area >= 100:
            if mr > 120 and (mr - mg) > 15:
                keep |= mask_c
                continue
        if area >= 90 and not (mg > mr + 18 and mg > mb + 18):
            if purge_far_strays:
                cys, cxs = np.where(mask_c)
                cx0, cx1 = int(cxs.min()), int(cxs.max())
                cy0, cy1 = int(cys.min()), int(cys.max())
                gap_x = max(0, max(cx0 - mx1, mx0 - cx1))
                gap_y = max(0, max(cy0 - my1, my0 - cy1))
                # Reject floating accidental `?` bubbles / stray text far from main body
                if max(gap_x, gap_y) > max(18, int(0.10 * main_h)):
                    continue
            keep |= mask_c
    arr[~keep] = 0

    im_out = Image.fromarray(arr, "RGBA")
    bb = im_out.getbbox()
    return im_out.crop(bb) if bb else im_out


def _find_valley_cuts(
    proj: np.ndarray,
    count: int,
    total_len: int,
    *,
    span_frac: float = 0.22,
) -> list[int]:
    """Locate cleanest `#00FF00` empty corridor cut lines near nominal grid subdivisions."""
    cuts = [0]
    for i in range(1, count):
        nom = round(i * total_len / count)
        span = max(8, round(total_len / count * span_frac))
        lo = max(cuts[-1] + 12, nom - span)
        hi = min(total_len - 12, nom + span)
        if lo > hi:
            cuts.append(max(cuts[-1] + 1, min(total_len - 1, nom)))
            continue
        win = proj[lo : hi + 1]
        zeros = np.where(win == 0)[0]
        if len(zeros) > 0:
            best_mid = nom
            best_score = -1e9
            runs = np.split(zeros, np.where(np.diff(zeros) != 1)[0] + 1)
            for run in runs:
                mid = lo + int((run[0] + run[-1]) // 2)
                score = float(len(run)) - 0.18 * abs(mid - nom)
                if score > best_score:
                    best_score = score
                    best_mid = mid
            cuts.append(best_mid)
        else:
            cuts.append(lo + int(np.argmin(win)))
    cuts.append(total_len)
    return cuts


def _slice_green_sheet_grid(sheet_im: Image.Image, cols: int, rows: int) -> list[Image.Image]:
    """Slice a `#00FF00` sprite sheet into `cols * rows` row-major raw RGB tiles along empty valleys."""
    im = sheet_im.convert("RGB")
    arr = np.array(im, dtype=np.int32)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    max_rb = np.maximum(r, b)
    fg = ~((g > 150) & ((g - max_rb) > 50))
    # Ignore thin accidental border/divider lines in projections (strictly >= 94% span)
    row_cov = fg.mean(axis=1)
    col_cov = fg.mean(axis=0)
    fg_clean = fg.copy()
    fg_clean[row_cov >= 0.94, :] = False
    fg_clean[:, col_cov >= 0.94] = False

    # Trim outer empty `#00FF00` margins when computing nominal valleys so generous AI borders never cut sprites,
    # while keeping outer tile boundaries at [0, width/height] so border flood-fill chroma-keying stays intact.
    if np.any(fg_clean):
        ys_f, xs_f = np.where(fg_clean)
        pad_x = min(16, max(4, int(im.width * 0.02)))
        pad_y = min(16, max(4, int(im.height * 0.02)))
        rx0 = max(0, int(xs_f.min()) - pad_x)
        rx1 = min(im.width, int(xs_f.max()) + 1 + pad_x)
        ry0 = max(0, int(ys_f.min()) - pad_y)
        ry1 = min(im.height, int(ys_f.max()) + 1 + pad_y)
    else:
        rx0, rx1, ry0, ry1 = 0, im.width, 0, im.height

    if rows > 1 and (ry1 - ry0) >= rows * 24:
        inner_y = _find_valley_cuts(fg_clean[ry0:ry1, :].sum(axis=1), rows, ry1 - ry0, span_frac=0.30)
        y_cuts = [0] + [ry0 + c for c in inner_y[1:-1]] + [im.height]
    else:
        y_cuts = _find_valley_cuts(fg_clean.sum(axis=1), rows, im.height, span_frac=0.28)

    tiles: list[Image.Image] = []
    for ri in range(rows):
        y0, y1 = y_cuts[ri], y_cuts[ri + 1]
        band_fg = fg_clean[y0:y1, :]
        if cols > 1 and (rx1 - rx0) >= cols * 24:
            inner_x = _find_valley_cuts(band_fg[:, rx0:rx1].sum(axis=0), cols, rx1 - rx0, span_frac=0.30)
            x_cuts = [0] + [rx0 + c for c in inner_x[1:-1]] + [im.width]
        else:
            x_cuts = _find_valley_cuts(band_fg.sum(axis=0), cols, im.width, span_frac=0.28)
        for ci in range(cols):
            x0, x1 = x_cuts[ci], x_cuts[ci + 1]
            tiles.append(im.crop((x0, y0, x1, y1)))
    return tiles


def _slice_nonempty_green_sprites(
    sheet_im: Image.Image,
    cols: int,
    rows: int,
    *,
    keep_yellow_butterfly: bool = False,
    keep_pink_yarn: bool = False,
    purge_far_strays: bool = True,
) -> list[Image.Image]:
    tiles = _slice_green_sheet_grid(sheet_im, cols, rows)
    sprites: list[Image.Image] = []
    for t in tiles:
        arr = chroma_matte_green_safe(t, keep_yellow_butterfly=keep_yellow_butterfly)
        if int((arr[:, :, 3] > 20).sum()) < 320:
            continue
        sprites.append(
            key_green_sprite_safe(
                t,
                keep_yellow_butterfly=keep_yellow_butterfly,
                keep_pink_yarn=keep_pink_yarn,
                purge_far_strays=purge_far_strays,
                pre_matted=arr,
            )
        )
    return sprites


def _isolate_dominant_run_sprite(sprite_im: Image.Image, facing_dir: str) -> Image.Image:
    """Keep ONLY the single dominant cat body (+ tightly attached fragments + front yellow butterfly)."""
    arr = np.array(sprite_im.convert("RGBA"), dtype=np.uint8)
    fg = arr[:, :, 3] > 20
    lbl, n = ndimage.label(fg, structure=np.ones((3, 3), dtype=int))
    if n <= 1:
        return sprite_im
    counts = np.bincount(lbl.ravel())
    counts[0] = 0
    main_id = int(np.argmax(counts))
    main_area = int(counts[main_id])
    mys, mxs = np.where(lbl == main_id)
    mx0, mx1 = int(mxs.min()), int(mxs.max())
    my0, my1 = int(mys.min()), int(mys.max())
    main_w = max(1, mx1 - mx0 + 1)
    main_h = max(1, my1 - my0 + 1)
    main_cx = float(mxs.mean())

    keep = lbl == main_id
    for cid in range(1, n + 1):
        if cid == main_id:
            continue
        area = int(counts[cid])
        if area < 18:
            continue
        mask_c = lbl == cid
        px = arr[mask_c]
        mr, mg, mb = float(px[:, 0].mean()), float(px[:, 1].mean()), float(px[:, 2].mean())
        ys, xs = np.where(mask_c)
        cx0, cx1 = int(xs.min()), int(xs.max())
        cy0, cy1 = int(ys.min()), int(ys.max())
        bx = float(xs.mean())
        is_yellow = (18 <= area <= min(4500, int(0.25 * main_area))) and (mr > 135 and mg > 115 and mb < 165 and (mg <= mr + 22))
        if is_yellow:
            in_front = (bx >= main_cx + 8) if facing_dir == "right" else (bx <= main_cx - 8)
            if in_front:
                keep |= mask_c
            continue
        if area <= int(0.35 * main_area) and not (mg > mr + 18 and mg > mb + 18):
            gap_x = max(0, max(cx0 - mx1, mx0 - cx1))
            gap_y = max(0, max(cy0 - my1, my0 - cy1))
            if gap_x <= max(20, int(0.14 * main_w)) and gap_y <= max(18, int(0.12 * main_h)):
                keep |= mask_c
    arr[~keep] = 0
    out_im = Image.fromarray(arr, "RGBA")
    bb = out_im.getbbox()
    return out_im.crop(bb) if bb else out_im


def _compute_run_row_scale(sprites: list[Image.Image]) -> float:
    """Robust uniform row scale for R01/R02 so one rare tall leap/outlier never shrinks all 8 frames."""
    widths = [max(1, sp.width) for sp in sprites]
    heights = [max(1, sp.height) for sp in sprites]
    med_w = float(np.median(widths))
    med_h = float(np.median(heights))
    p75_h = float(np.percentile(heights, 75))
    eff_max_w = min(float(max(widths)), max(med_w * 1.45, float(np.percentile(widths, 85))))
    eff_max_h = min(float(max(heights)), max(med_h * 1.28, p75_h * 1.18))
    return min(184.0 / max(1.0, eff_max_w), 126.0 / max(1.0, p75_h), 140.0 / max(1.0, eff_max_h))


def _split_run8_with_butterfly_sheet(
    sheet_im: Image.Image,
    facing_dir: str,
    cols: int = 4,
    rows: int = 2,
) -> list[Image.Image]:
    """Split a run sheet via row-wise component clustering so yellow butterflies NEVER sever across seams."""
    row_bands = _slice_green_sheet_grid(sheet_im, 1, rows)
    struct8 = np.ones((3, 3), dtype=int)
    out: list[Image.Image] = []
    for row_idx, row_band in enumerate(row_bands):
        arr = chroma_matte_green_safe(row_band, keep_yellow_butterfly=True)
        arr = _strip_grid_divider_bars_arr(arr)
        fg = arr[:, :, 3] > 20
        lbl, n = ndimage.label(fg, structure=struct8)
        counts = np.bincount(lbl.ravel())
        counts[0] = 0

        min_body_area = max(900, int(arr.shape[0] * arr.shape[1] * 0.008))
        big_ids = sorted(
            [cid for cid in range(1, n + 1) if int(counts[cid]) >= min_body_area],
            key=lambda cid: int(counts[cid]),
            reverse=True,
        )[:cols]

        if len(big_ids) != cols:
            sub_tiles = _slice_green_sheet_grid(sheet_im, cols, rows)[row_idx * cols : (row_idx + 1) * cols]
            for st in sub_tiles:
                st_arr = chroma_matte_green_safe(st, keep_yellow_butterfly=True)
                if int((st_arr[:, :, 3] > 20).sum()) < 320:
                    continue
                sp = key_green_sprite_safe(st, keep_yellow_butterfly=True, pre_matted=st_arr)
                if _looks_like_multi_figure_collage(sp):
                    sp = _isolate_dominant_run_sprite(sp, facing_dir)
                out.append(sp)
            continue

        cat_infos: list[dict[str, Any]] = []
        for cid in big_ids:
            ys, xs = np.where(lbl == cid)
            cat_infos.append(
                {
                    "cid": cid,
                    "area": int(counts[cid]),
                    "x0": int(xs.min()),
                    "x1": int(xs.max()),
                    "y0": int(ys.min()),
                    "y1": int(ys.max()),
                    "cx": float(xs.mean()),
                    "cy": float(ys.mean()),
                    "extra_ids": [],
                    "butterfly_ids": [],
                }
            )
        cat_infos.sort(key=lambda d: d["cx"])

        for cid in range(1, n + 1):
            if cid in big_ids:
                continue
            area = int(counts[cid])
            if area < 18:
                continue
            mask_c = lbl == cid
            px = arr[mask_c]
            mr, mg, mb = float(px[:, 0].mean()), float(px[:, 1].mean()), float(px[:, 2].mean())
            is_yellow = (18 <= area <= 4500) and (mr > 135 and mg > 115 and mb < 165 and (mg <= mr + 22))
            ys, xs = np.where(mask_c)
            bx = float(xs.mean())
            if is_yellow:
                best_cat = None
                best_score = 1e9
                for info in cat_infos:
                    if facing_dir == "right":
                        if bx < info["cx"] + 10:
                            continue
                        dx = bx - info["x1"]
                        if -30 <= dx <= 170:
                            dist_x = abs(dx - 24)
                            if dist_x < best_score:
                                best_score = dist_x
                                best_cat = info
                    else:
                        if bx > info["cx"] - 10:
                            continue
                        dx = info["x0"] - bx
                        if -30 <= dx <= 170:
                            dist_x = abs(dx - 24)
                            if dist_x < best_score:
                                best_score = dist_x
                                best_cat = info
                if best_cat is not None:
                    best_cat["butterfly_ids"].append(cid)
            elif area >= 80 and not (mg > mr + 18 and mg > mb + 18):
                # Strictly attach ONLY small nearby body fragments (paw/tail tip) — NEVER stack a detached
                # second cat or leaked upper-row limb vertically above/below a valid body!
                cx0, cx1 = int(xs.min()), int(xs.max())
                cy0, cy1 = int(ys.min()), int(ys.max())
                best_info = None
                best_gap = 1e9
                for info in cat_infos:
                    if area > int(0.35 * info["area"]):
                        continue
                    main_w = max(1, info["x1"] - info["x0"] + 1)
                    main_h = max(1, info["y1"] - info["y0"] + 1)
                    gap_x = max(0, max(cx0 - info["x1"], info["x0"] - cx1))
                    gap_y = max(0, max(cy0 - info["y1"], info["y0"] - cy1))
                    max_gx = max(22, int(0.14 * main_w))
                    max_gy = max(18, int(0.12 * main_h))
                    if gap_x <= max_gx and gap_y <= max_gy:
                        tot_gap = gap_x + gap_y
                        if tot_gap < best_gap:
                            best_gap = tot_gap
                            best_info = info
                if best_info is not None:
                    best_info["extra_ids"].append(cid)

        for info in cat_infos:
            body_keep = lbl == info["cid"]
            for eid in info["extra_ids"]:
                body_keep |= lbl == eid
            bys, bxs = np.where(body_keep)
            bx0, bx1 = int(bxs.min()), int(bxs.max())

            canvas = np.zeros_like(arr)
            canvas[body_keep] = arr[body_keep]
            for bid in info["butterfly_ids"]:
                bmask = lbl == bid
                ys_b, xs_b = np.where(bmask)
                ux0, ux1 = int(xs_b.min()), int(xs_b.max())
                shift_x = 0
                if facing_dir == "right":
                    gap = ux0 - bx1
                    if gap > 16:
                        shift_x = -(gap - 16)
                else:
                    gap = bx0 - ux1
                    if gap > 16:
                        shift_x = gap - 16
                nx = np.clip(xs_b + shift_x, 0, arr.shape[1] - 1)
                canvas[ys_b, nx] = arr[ys_b, xs_b]

            vis_c = canvas[:, :, 3] > 20
            ys_all, xs_all = np.where(vis_c)
            if len(xs_all) == 0:
                continue
            x0, x1 = max(0, int(xs_all.min())), min(arr.shape[1], int(xs_all.max()) + 1)
            y0, y1 = max(0, int(ys_all.min())), min(arr.shape[0], int(ys_all.max()) + 1)
            sp_out = Image.fromarray(canvas[y0:y1, x0:x1], "RGBA")
            if _looks_like_multi_figure_collage(sp_out):
                sp_out = _isolate_dominant_run_sprite(sp_out, facing_dir)
            out.append(sp_out)

    return out


def _resize_rgba_clean(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Premultiplied RGBA Lanczos resize eliminating dark/bright fringe."""
    arr = np.array(im.convert("RGBA"), dtype=np.uint8)
    arr[arr[:, :, 3] <= 14] = 0
    premul = Image.fromarray(arr, "RGBA").convert("RGBa")
    resized = premul.resize(size, Image.Resampling.LANCZOS).convert("RGBA")
    out = np.array(resized, dtype=np.uint8)
    out[out[:, :, 3] <= 16] = 0
    return Image.fromarray(out, "RGBA")


def _scale_sprite_uniform(sp: Image.Image, scale: float, *, max_w: int = CELL_W - 4, max_h: int = CELL_H - 4) -> Image.Image:
    nw = max(1, round(sp.width * scale))
    nh = max(1, round(sp.height * scale))
    if nw > max_w or nh > max_h:
        fit = min(max_w / max(1, sp.width), max_h / max(1, sp.height))
        nw = max(1, round(sp.width * fit))
        nh = max(1, round(sp.height * fit))
    out = _resize_rgba_clean(sp, (nw, nh))
    bb = out.getbbox()
    return out.crop(bb) if bb else out


def _measure_seated_torso_cx(sp: Image.Image) -> float:
    """Measure horizontal center of the seated torso (y in 44%..72% height, excluding any detached side tail)."""
    arr = np.array(sp.convert("RGBA"))
    h, w, _ = arr.shape
    y0, y1 = int(h * 0.44), max(int(h * 0.44) + 1, int(h * 0.72))
    band = arr[y0:y1, :, 3] > 25
    cxs: list[float] = []
    for y in range(band.shape[0]):
        xs = np.where(band[y])[0]
        if len(xs) >= 8:
            splits = np.where(np.diff(xs) > 3)[0] + 1
            segs = np.split(xs, splits)
            widest = max(segs, key=len)
            cxs.append(0.5 * float(widest[0] + widest[-1]))
    if cxs:
        return float(np.median(cxs))
    _, xs_all = np.where(arr[:, :, 3] > 20)
    return float(xs_all.mean()) if len(xs_all) else w / 2.0


def _place_in_cell_anchored(
    sp: Image.Image,
    *,
    bottom_excl: int | None = NORM_BOTTOM_EXCL,
    top_y: int | None = None,
    center_x: float = 96.0,
    anchor_band: str = "full",
) -> Image.Image:
    """Place a pre-scaled tight sprite into a 192x208 cell with precise horizontal & vertical anchoring."""
    arr = np.array(sp.convert("RGBA"))
    vis = arr[:, :, 3] > 20
    if anchor_band == "torso":
        cx = _measure_seated_torso_cx(sp)
    elif anchor_band == "top":
        band = vis[: max(1, int(sp.height * 0.34)), :]
        _, xs = np.where(band)
        cx = float(xs.mean()) if len(xs) else sp.width / 2.0
    elif anchor_band == "cat_body_no_butterfly":
        lbl, n = ndimage.label(vis, structure=np.ones((3, 3), dtype=int))
        if n > 1:
            cnt = np.bincount(lbl.ravel())
            cnt[0] = 0
            mc = int(np.argmax(cnt))
            _, xs = np.where(lbl == mc)
        else:
            _, xs = np.where(vis)
        cx = float(xs.mean()) if len(xs) else sp.width / 2.0
    elif anchor_band == "yarn_cat_body":
        sr, sg, sb = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)
        s_pink = vis & (sr >= 145) & ((sr - sg) >= 35) & (sb >= 70)
        _, xs = np.where(vis & (~s_pink))
        if len(xs) < 20:
            _, xs = np.where(vis)
        cx = float(xs.mean()) if len(xs) else sp.width / 2.0
    else:
        _, xs = np.where(vis)
        cx = float(xs.mean()) if len(xs) else sp.width / 2.0

    dx = max(2, min(CELL_W - sp.width - 2, round(center_x - cx)))
    if top_y is not None:
        dy = max(2, min(CELL_H - sp.height - 2, top_y))
    else:
        be = bottom_excl if bottom_excl is not None else NORM_BOTTOM_EXCL
        dy = max(2, min(CELL_H - sp.height - 2, be - sp.height))
    cell = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    cell.alpha_composite(sp, (dx, dy))
    return cell


def _measure_upper_neck_chest_cx(im: Image.Image) -> float:
    """Measure horizontal center of the upper neck/chest band (34%..48% height, strictly above lower haunch/tail flare)."""
    arr = np.array(im.convert("RGBA"))
    vis = arr[:, :, 3] > 25
    if not np.any(vis):
        return arr.shape[1] / 2.0
    ys_all, xs_all = np.where(vis)
    y0, y1 = int(ys_all.min()), int(ys_all.max()) + 1
    bh = max(1, y1 - y0)
    b0 = y0 + int(bh * 0.34)
    b1 = max(b0 + 1, y0 + int(bh * 0.48))
    cxs: list[float] = []
    for y in range(b0, min(arr.shape[0], b1)):
        xs = np.where(vis[y])[0]
        if len(xs) >= 6:
            splits = np.where(np.diff(xs) > 3)[0] + 1
            segs = np.split(xs, splits)
            widest = max(segs, key=len)
            cxs.append(0.5 * float(widest[0] + widest[-1]))
    if cxs:
        return float(np.median(cxs))
    return float(np.median(xs_all))


def _seated_haunch_skew_frac(im: Image.Image) -> float:
    """Return signed (lower_cx - head_cx) / width: positive = haunch/tail on viewer-RIGHT, negative = viewer-LEFT."""
    arr = np.array(im.convert("RGBA"))
    vis = arr[:, :, 3] > 25
    if not np.any(vis):
        return 0.0
    ys, xs = np.where(vis)
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    bh = max(1, y1 - y0)
    bw = max(1, x1 - x0)
    _, hxs = np.where(vis[y0 : max(y0 + 1, y0 + int(bh * 0.36)), :])
    _, lxs = np.where(vis[min(y1 - 1, y0 + int(bh * 0.56)) : y1, :])
    if len(hxs) < 10 or len(lxs) < 10:
        return 0.0
    return (float(np.median(lxs)) - float(np.median(hxs))) / float(bw)


def _composite_lower_body_lock(
    lower_anchor_cell: Image.Image,
    upper_pose_cell: Image.Image,
    *,
    split_frac: float = 0.54,
    band_half: int = 10,
    allow_right_nose: bool = False,
    allow_left_nose: bool = False,
) -> Image.Image:
    """Generalized seamless lower-body lock onto `R00 c0` aligned on the upper neck/chest band (immune to haunch/tail skew)."""
    a_low_u8 = np.array(lower_anchor_cell.convert("RGBA"), dtype=np.uint8)
    a_low = a_low_u8.astype(np.float32)
    a_top = np.array(upper_pose_cell.convert("RGBA"), dtype=np.float32)

    lx0, ly0, lx1, ly1 = _cell_bbox(lower_anchor_cell)
    bh_a = max(20.0, float(ly1 - ly0))
    split_y = max(72, min(CELL_H - band_half - 6, round(ly0 + split_frac * bh_a)))

    # 1. Measure main torso span at split_y for tail clearing/tapering, but align horizontal shift on
    #    the upper neck/chest band (34%..48% height) so a 3/4 haunch bulge NEVER pulls the head off-center!
    def _band_span(arr_f: np.ndarray, y_a: int, y_b: int) -> tuple[float, float, float]:
        s0, s1 = max(0, y_a), min(CELL_H, max(y_a + 1, y_b))
        x0s, x1s = [], []
        for y in range(s0, s1):
            xs = np.where(arr_f[y, :, 3] > 25)[0]
            if len(xs) >= 6:
                splits = np.where(np.diff(xs) > 3)[0] + 1
                segs = np.split(xs, splits)
                widest = max(segs, key=len)
                x0s.append(float(widest[0]))
                x1s.append(float(widest[-1]))
        if x0s:
            mx0, mx1 = float(np.median(x0s)), float(np.median(x1s))
            return mx0, mx1, 0.5 * (mx0 + mx1)
        return float(lx0), float(lx1), 0.5 * float(lx0 + lx1)

    neck_y0 = ly0 + round(0.34 * bh_a)
    neck_y1 = max(neck_y0 + 4, min(split_y - 2, ly0 + round(0.48 * bh_a)))
    _nx0_l, _nx1_l, ncx_l = _band_span(a_low, neck_y0, neck_y1)
    _nx0_t, _nx1_t, ncx_t = _band_span(a_top, neck_y0, neck_y1)
    tx0_l, tx1_l, tcx_l = _band_span(a_low, split_y - 8, split_y + 8)

    shift_x = round(ncx_l - ncx_t)
    if 0 < abs(shift_x) <= 22:
        shifted = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
        shifted.alpha_composite(upper_pose_cell, (shift_x, 0))
        a_top = np.array(shifted, dtype=np.float32)

    # 2. Strip any detached lower-tail islands in upper_pose_cell outside the main torso span
    y_tail_clear = max(ly0 + round(0.45 * bh_a), split_y - 24)
    left_cut = max(0, int(round(tx0_l)) - 14)
    right_cut = min(CELL_W, int(round(tx1_l)) + 14)
    for y in range(y_tail_clear, CELL_H):
        if right_cut < CELL_W:
            trans_r = np.where(a_top[y, max(0, int(tcx_l)):, 3] <= 20)[0]
            if len(trans_r) > 0:
                gap_r = max(0, int(tcx_l)) + int(trans_r[0])
                if gap_r >= int(round(tx1_l)) - 6:
                    a_top[y, gap_r:, :] = 0.0
        if left_cut > 0:
            trans_l = np.where(a_top[y, : min(CELL_W, int(tcx_l) + 1), 3] <= 20)[0]
            if len(trans_l) > 0:
                gap_l = int(trans_l[-1])
                if gap_l <= int(round(tx0_l)) + 6:
                    a_top[y, : gap_l + 1, :] = 0.0

    low_pm = np.concatenate([a_low[:, :, :3] * (a_low[:, :, 3:4] / 255.0), a_low[:, :, 3:4] / 255.0], axis=2)
    top_pm = np.concatenate([a_top[:, :, :3] * (a_top[:, :, 3:4] / 255.0), a_top[:, :, 3:4] / 255.0], axis=2)

    # 3. Smooth horizontal silhouette taper over ~28px above split_y so neck/shoulder seam is invisible
    y_taper_start = max(ly0 + round(0.34 * bh_a), split_y - 28)
    y_taper_end = min(CELL_H, split_y + band_half + 1)
    xs_grid = np.arange(CELL_W, dtype=np.float32)
    win_x0 = max(0, int(round(tx0_l)) - 18)
    win_x1 = min(CELL_W, int(round(tx1_l)) + 18)
    for y in range(y_taper_start, y_taper_end):
        u_w = np.clip((float(y) - float(y_taper_start)) / max(1.0, float(split_y - y_taper_start)), 0.0, 1.0)
        w_span = float(u_w * u_w * (3.0 - 2.0 * u_w))
        xl = np.where(a_low[y, win_x0:win_x1, 3] > 25)[0] + win_x0
        xt = np.where(a_top[y, win_x0:win_x1, 3] > 25)[0] + win_x0
        if len(xl) >= 6 and len(xt) >= 6:
            if allow_right_nose and y < split_y - 10 and int(xt.max()) > int(tx1_l) + 4:
                continue
            if allow_left_nose and y < split_y - 10 and int(xt.min()) < int(tx0_l) - 4:
                continue
            x0_l, x1_l = float(xl.min()), float(xl.max())
            x0_t, x1_t = float(xt.min()), float(xt.max())
            x0_m = (1.0 - w_span) * x0_t + w_span * x0_l
            x1_m = (1.0 - w_span) * x1_t + w_span * x1_l
            span_m = max(4.0, x1_m - x0_m)
            src_xt = x0_t + (xs_grid - x0_m) * ((x1_t - x0_t) / span_m)
            src_xl = x0_l + (xs_grid - x0_m) * ((x1_l - x0_l) / span_m)
            for ch in range(4):
                top_pm[y, :, ch] = np.interp(src_xt, xs_grid, top_pm[y, :, ch], left=0.0, right=0.0)
                low_pm[y, :, ch] = np.interp(src_xl, xs_grid, low_pm[y, :, ch], left=0.0, right=0.0)

    # 4. Smooth vertical premultiplied blend across [split_y - band_half, split_y + band_half]
    yy = np.arange(CELL_H, dtype=np.float32)[:, None, None]
    t_all = np.clip((yy - float(split_y - band_half)) / max(1.0, float(2 * band_half)), 0.0, 1.0)
    w_low = np.broadcast_to(t_all * t_all * (3.0 - 2.0 * t_all), (CELL_H, CELL_W, 1)).copy()

    # Preserve lower anchor's outer tail zone 100%
    low_tail_y = max(split_y, ly0 + round(0.70 * bh_a))
    if right_cut < CELL_W:
        w_low[low_tail_y:, right_cut - 6 :, 0] = 1.0
    if left_cut > 0:
        w_low[low_tail_y:, : left_cut + 6, 0] = 1.0

    mix = top_pm * (1.0 - w_low) + low_pm * w_low
    oa = np.clip(mix[:, :, 3], 0.0, 1.0)
    vis = oa > (18.0 / 255.0)
    sa = np.maximum(oa, 1e-5)
    out = np.zeros((CELL_H, CELL_W, 4), dtype=np.uint8)
    for ch in range(3):
        out[:, :, ch] = np.where(vis, np.clip(np.rint(mix[:, :, ch] / sa), 0, 255), 0).astype(np.uint8)
    out[:, :, 3] = np.where(vis, np.clip(np.rint(oa * 255.0), 0, 255), 0).astype(np.uint8)

    lock_y = min(CELL_H, split_y + band_half)
    out[lock_y:, :, :] = a_low_u8[lock_y:, :, :]
    return Image.fromarray(out, "RGBA")


def _has_upper_right_bubble(cell: Image.Image) -> bool:
    """Detect whether a cell already has a bright floating speech/? bubble in upper-right corner."""
    arr = np.array(cell.convert("RGBA"))
    sub = arr[4:64, 126:190]
    vis = sub[:, :, 3] > 180
    if int(vis.sum()) < 260:
        return False
    lum = 0.299 * sub[:, :, 0] + 0.587 * sub[:, :, 1] + 0.114 * sub[:, :, 2]
    bright = vis & (lum >= 205.0)
    return int(bright.sum()) >= 220


def _expand_4_to_6_smooth(
    frames4: list[Image.Image],
    *,
    bottom_excl: int = NORM_BOTTOM_EXCL,
    lock_anchor: Image.Image | None = None,
) -> list[Image.Image]:
    """Expand 4 crisp loop keyframes [f0, f1, f2, f3] smoothly into 6 distinct non-duplicate frames."""
    f0, f1, f2, f3 = frames4[0], frames4[1], frames4[2], frames4[3]
    f4 = _articulate_cell(f2, angle_deg=0.45, sx=1.003, sy=0.996, head_dy=0.4, waist_frac=0.52, bottom_excl=bottom_excl)
    f5 = _articulate_cell(f1, angle_deg=-0.35, sx=1.002, sy=0.998, head_dy=0.2, waist_frac=0.52, bottom_excl=bottom_excl)
    if lock_anchor is not None:
        f4 = _composite_lower_body_lock(lock_anchor, f4, split_frac=0.56, band_half=8)
        f5 = _composite_lower_body_lock(lock_anchor, f5, split_frac=0.56, band_half=8)
    return [f0, f1, f2, f3, f4, f5]


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
        resized = _resize_rgba_clean(sp, (nw, nh))
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
    sleep_cell: Image.Image | None = None,
    hold_cell: Image.Image | None = None,
) -> tuple[Image.Image, list[dict[str, Any]]]:
    """Build 1536x2288 codex-v2-8x11 spritesheet using real textured views with zero broken row swaps."""
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

    run_src_right = effective_side_right
    run_src_left = effective_side_left
    if not has_any_side and extras:
        for ei, ex in enumerate(extras):
            cb, cs = extras_flags[ei] if ei < len(extras_flags) else (False, False)
            if not cb and not cs and 0.78 <= _cell_aspect(ex) <= 1.65:
                run_src_right = ex
                run_src_left = ex
                break

    run_base_right = normalize_view_cell(_crop_tight(run_src_right), target_h=168.0, max_w=166.0)
    run_base_left_flipped = normalize_view_cell(
        _crop_tight(run_src_left).transpose(Image.Transpose.FLIP_LEFT_RIGHT),
        target_h=168.0,
        max_w=166.0,
    )

    q_bubble = _load_or_draw_question_bubble()
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
    work_ei: int | None = None

    # Strictly require a wide, low curled/loaf resting silhouette for R06 (NEVER grab a paw-wave or upright pose!)
    if sleep_cell is None:
        resting_candidates = [
            ei for ei in candidate_eids
            if _cell_aspect(extras[ei]) >= max(1.18, front_aspect * 1.45)
            and _cell_aspect(extras[ei]) <= 2.60
            and ex_feats[ei].top_heavy_ratio <= 1.05
            and ex_feats[ei].facial_contrast >= 0.14
            and ex_feats[ei].bottom_contrast <= max(0.24, ex_feats[ei].facial_contrast * 1.35)
        ]
        if resting_candidates:
            wait_ei = max(
                resting_candidates,
                key=lambda ei: ex_feats[ei].body_mirror_iou + 0.50 * min(2.0, _cell_aspect(extras[ei]) / max(0.3, front_aspect)),
            )
            used_eids.add(wait_ei)

    # For R07 yarn play: only pick an extra action if it clearly shows facial features (never a back view!)
    work_candidates = [
        ei for ei in candidate_eids
        if ei not in used_eids
        and (0.68 * front_aspect <= _cell_aspect(extras[ei]) <= 1.50 * front_aspect)
        and ex_feats[ei].facial_contrast >= 0.28
        and ex_feats[ei].head_mirror_iou >= 0.52
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
        (0.5, 1.004, 0.994, 0.3),
        (1.1, 1.008, 0.988, 0.7),
        (1.4, 1.010, 0.985, 0.9),
        (0.8, 1.005, 0.991, 0.5),
        (0.3, 1.002, 0.997, 0.2),
    ]
    for c_idx, (ang, sx, sy, hdy) in enumerate(idle_specs):
        cell = (
            front_cell
            if c_idx == 0
            else _articulate_cell(front_cell, angle_deg=ang, sx=sx, sy=sy, head_dy=hdy, waist_frac=0.56, bottom_excl=200)
        )
        put(0, c_idx, cell)

    # Helper to place flapping yellow butterfly cleanly in front of runner without overlapping body
    def _place_butterfly_clean(cell_im: Image.Image, bx: int, by: int, wing_open: float, *, facing_left: bool = False) -> None:
        bf = _draw_mini_butterfly(wing_open)
        if facing_left:
            bf = bf.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        bw_b, bh_b = bf.size
        c_arr = np.array(cell_im)[:, :, 3] > 20
        best_xy = (max(2, min(CELL_W - bw_b - 2, bx)), max(4, min(CELL_H - bh_b - 4, by)))
        best_ov = 10**9
        for dy_try in (0, -8, -16, 6, -24):
            for dx_try in (0, 4, -4, 8, -8):
                tx = max(2, min(CELL_W - bw_b - 2, bx + dx_try))
                ty = max(4, min(CELL_H - bh_b - 4, by + dy_try))
                ov = int(c_arr[ty : ty + bh_b, tx : tx + bw_b].sum())
                if ov < best_ov:
                    best_ov = ov
                    best_xy = (tx, ty)
                    if ov == 0:
                        break
            if best_ov == 0:
                break
        if best_ov <= 16:
            cell_im.alpha_composite(bf, best_xy)

    # Row 1: running-right (cols 0..7) & Row 2: running-left (independent left_side if present, else mirror)
    if has_any_side:
        # Lively 8-frame sinusoidal gallop with real airborne lift, forward pitch & stride scissor + flapping yellow butterfly
        run_specs: list[tuple[float, float, float, float, float, float, float, tuple[int, int], float]] = []
        for c_idx in range(8):
            ph = 2.0 * math.pi * c_idx / 8.0
            lean = 3.2 + 4.2 * math.sin(ph)
            stride = 13.5 * math.sin(ph + 0.35)
            scissor = -9.2 * math.sin(ph + 0.35)
            sx = 1.040 + 0.042 * math.sin(ph)
            sy = 0.960 - 0.038 * math.cos(ph)
            dx = -3.0 + 2.4 * math.sin(ph)
            dy = -8.0 + 9.2 * math.cos(ph)
            bx = round(164 + 3.0 * math.sin(ph))
            by = round(42 - 9.0 * math.sin(ph + 0.4))
            wing_open = 0.55 + 0.45 * abs(math.sin(ph * 2.0 + 0.3))
            run_specs.append((lean, stride, scissor, sx, sy, dx, dy, (bx, by), wing_open))

        for c_idx, (lean, stride, scissor, sx, sy, dx, dy, bf_xy, wing_open) in enumerate(run_specs):
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
            _place_butterfly_clean(rcell, bf_xy[0], bf_xy[1], wing_open, facing_left=False)
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
                _place_butterfly_clean(lcell_tmp, bf_xy[0], bf_xy[1], wing_open, facing_left=False)
                put(2, c_idx, lcell_tmp.transpose(Image.Transpose.FLIP_LEFT_RIGHT))
            else:
                put(2, c_idx, rcell.transpose(Image.Transpose.FLIP_LEFT_RIGHT))
    else:
        # Missing side views -> energetic 8-frame bound/hop cycle chasing flapping yellow butterfly
        for c_idx in range(8):
            ph = 2.0 * math.pi * c_idx / 8.0
            ang_r = 2.2 + 4.4 * math.sin(ph)
            sx = 1.020 - 0.048 * math.sin(ph)
            sy = 0.980 + 0.048 * math.sin(ph)
            dx_r = -2.0 + 3.0 * math.sin(ph)
            dy = -8.5 - 9.5 * math.sin(ph)
            bx = round(164 + 3.0 * math.sin(ph))
            by = round(42 - 8.5 * math.sin(ph))
            wing_open = 0.55 + 0.45 * abs(math.sin(ph * 2.0 + 0.3))
            rcell_r = _articulate_cell(run_base_right, angle_deg=ang_r, sx=sx, sy=sy, dx=dx_r, dy=dy, bottom_excl=196)
            rcell_l = _articulate_cell(run_base_right, angle_deg=-ang_r, sx=sx, sy=sy, dx=-dx_r, dy=dy, bottom_excl=196)
            _place_butterfly_clean(rcell_r, bx, by, wing_open, facing_left=False)
            _place_butterfly_clean(rcell_l, CELL_W - bx - 22, by, wing_open, facing_left=True)
            put(1, c_idx, rcell_r)
            put(2, c_idx, rcell_l)

    # Row 3: polite gentle head nod (cols 0..3) — lower body locked strictly below waist, clear friendly nod arc
    front_arr_u8 = np.array(front_cell.convert("RGBA"), dtype=np.uint8)
    _fx0, _fy0, _fx1, _fy1 = _cell_bbox(front_cell)
    _fbh = max(1.0, float(_fy1 - _fy0))
    _front_lock_y = min(CELL_H, int(round(_fy0 + 0.56 * _fbh)))

    wave_specs = [
        (0.0, 1.000, 1.000, 0.0),
        (1.6, 1.003, 0.992, 4.8),
        (2.4, 1.005, 0.986, 7.6),
        (0.8, 1.002, 0.996, 2.2),
    ]
    for c_idx, (ang, sx, sy, hdy) in enumerate(wave_specs):
        if c_idx == 0:
            cell = front_cell
        else:
            cell = _articulate_cell(
                front_cell,
                angle_deg=ang,
                sx=sx,
                sy=sy,
                head_dy=hdy,
                waist_frac=0.50,
                neck_frac=0.28,
                bottom_excl=200,
            )
            c_arr = np.array(cell, dtype=np.uint8)
            c_arr[_front_lock_y:, :, :] = front_arr_u8[_front_lock_y:, :, :]
            cell = Image.fromarray(c_arr, "RGBA")
        put(3, c_idx, cell)

    # Row 4: 5-stage natural jump (c0 crouch -> c1 launch -> c2 apex -> c3 descent -> c4 soft landing)
    # Pre-normalized to 156px height so apex dy=-26 achieves genuine airtime without ceiling clipping!
    jump_base = normalize_view_cell(_crop_tight(front_cell), target_h=156.0, max_w=156.0, bottom_excl=200)
    jump_specs = [
        (0.0,  1.10, 0.84,  0.0,  4.0),   # c0: CROUCH (coiled low)
        (-2.5, 0.90, 1.12, -12.0, -2.0),  # c1: LAUNCH (tall stretch takeoff)
        (0.0,  0.96, 0.96, -26.0, -2.0),  # c2: APEX (clearly airborne mid-air)
        (2.5,  0.93, 1.08, -10.0,  1.0),  # c3: DESCENT (reaching down)
        (0.0,  1.09, 0.86,  0.0,  3.5),   # c4: LAND (cushioned low landing)
    ]
    for c_idx, (ang, sx, sy, dy, hdy) in enumerate(jump_specs):
        put(4, c_idx, _articulate_cell(jump_base, angle_deg=ang, sx=sx, sy=sy, dy=dy, head_dy=hdy, bottom_excl=200))

    # Row 4 (cols 5..7): R04H classic slim vertical scruff-held dangle & pendulum sway
    # c5=plumb neutral, c6=viewer-LEFT sway (+9.5°), c7=viewer-RIGHT sway (-9.5°)
    if hold_cell is not None and _has_visible_foreground(hold_cell, min_pixels=40):
        hold_base = normalize_view_cell(_crop_tight(hold_cell), target_h=182.0, max_w=118.0, bottom_excl=196)
        hold_slim = False
        hold_sx, hold_sy = 1.0, 1.0
    else:
        hold_base = front_cell
        hold_slim = True
        hold_sx, hold_sy = 0.86, 1.06
    hold_specs = [
        (5,  0.0),   # c5: plumb straight dangle
        (6,  9.5),   # c6: lower body swings viewer-LEFT
        (7, -9.5),   # c7: lower body swings viewer-RIGHT
    ]
    for c_idx, sway_deg in hold_specs:
        put(
            4,
            c_idx,
            _articulate_hold_cell(
                hold_base,
                sway_deg=sway_deg,
                sx=hold_sx,
                sy=hold_sy,
                top_margin=14,
                slim_from_seated=hold_slim,
            ),
        )

    # Row 5: failed / puzzled smooth single-peak head-only tilt + crisp ? bubble on c3, c4, c7 (ZERO stutter!)
    # Matches FAILED_DURATIONS_MS = [220, 170, 170, 170, 170, 170, 170, 360]
    # Max step <= 4°, wraps c7 (-4°) -> c0 (0°) cleanly! Tilts viewer-left leaving upper-right clear for ? bubble.
    fail_specs = [
        (0.0,   0.0, False),  # c0: 0° upright alert
        (-4.0, -0.7, False),  # c1: -4° gentle start
        (-8.0, -1.4, False),  # c2: -8° mid tilt
        (-12.0, -2.1, True),  # c3: -12° deeper puzzled tilt + ?
        (-15.0, -2.8, True),  # c4: -15° peak puzzled tilt + ?
        (-11.0, -2.0, False), # c5: -11° smooth ease back
        (-7.0, -1.2, False),  # c6: -7° continuing return
        (-4.0, -0.7, True),   # c7: -4° lingering tilt + ? -> smooth 4° wrap to c0!
    ]
    for c_idx, (ang, hdx, has_q) in enumerate(fail_specs):
        if c_idx == 0:
            cell = front_cell.copy()
        else:
            cell = _articulate_cell(
                front_cell,
                angle_deg=ang,
                head_dx=hdx,
                waist_frac=0.47,
                neck_frac=0.26,
                bottom_excl=200,
            )
            c_arr = np.array(cell, dtype=np.uint8)
            c_arr[_front_lock_y:, :, :] = front_arr_u8[_front_lock_y:, :, :]
            cell = Image.fromarray(c_arr, "RGBA")
        if has_q:
            cell = _overlay_bubble_smart(cell, q_bubble, prefer_xy=(135, 12), x_range=(126, 143), y_range=(6, 24))
        put(5, c_idx, cell)

    # Row 6: waiting / resting / curled sleep (cols 0..5) — NEVER use paw-wave!
    if sleep_cell is not None and _has_visible_foreground(sleep_cell, min_pixels=40):
        wait_src = normalize_view_cell(_crop_tight(sleep_cell), target_h=126.0, max_w=176.0, bottom_excl=199)
        use_loaf_synth = False
    elif wait_ei is not None:
        wait_src = normalize_view_cell(_crop_tight(extras[wait_ei]), target_h=130.0, max_w=176.0, bottom_excl=199)
        use_loaf_synth = False
    elif top_cell is not None and _cell_aspect(top_cell) >= 1.15:
        wait_src = normalize_view_cell(_crop_tight(top_cell), target_h=130.0, max_w=174.0, bottom_excl=199)
        use_loaf_synth = False
    else:
        # Synthesize cozy settled low-loaf resting posture cleanly from front_cell (never upright paw-wave!)
        wait_src = front_cell
        use_loaf_synth = True

    if use_loaf_synth:
        wait_specs = [
            (0.0, 1.090, 0.820, 4.0),
            (0.4, 1.098, 0.808, 5.0),
            (0.8, 1.106, 0.796, 6.0),
            (1.0, 1.110, 0.790, 6.4),
            (0.6, 1.100, 0.804, 5.2),
            (0.2, 1.093, 0.815, 4.4),
        ]
    else:
        wait_specs = [
            (0.0, 1.003, 0.994, 0.0),
            (0.4, 1.010, 0.984, 0.6),
            (0.8, 1.016, 0.974, 1.2),
            (1.0, 1.018, 0.970, 1.4),
            (0.6, 1.011, 0.982, 0.8),
            (0.2, 1.005, 0.991, 0.3),
        ]
    for c_idx, (ang, sx, sy, hdy) in enumerate(wait_specs):
        if wait_ei is not None and sleep_cell is None:
            extra_placements.append({"extraIndex": wait_ei, "row": 6, "col": c_idx})
        cell = _articulate_cell(wait_src, angle_deg=ang, sx=sx, sy=sy, head_dy=hdy, waist_frac=0.52, bottom_excl=199)
        put(6, c_idx, cell)

    # Row 7: working state with 3D rotating pink yarn ball (cols 0..5, lively lean & rolling yarn)
    work_src = extras[work_ei] if work_ei is not None else front_cell
    work_arr = np.array(work_src)
    lower_fg = work_arr[162:202, :, 3] > 20
    _, lower_xs = np.where(lower_fg)
    paw_x0 = int(lower_xs.min()) if len(lower_xs) > 0 else 44
    base_orb_x = max(8, min(58, paw_x0 - 16))
    work_specs = [
        (-2.0, 1.005, 0.990, 1.4, (base_orb_x + 2, 174), 0.0),
        (-4.0, 1.012, 0.976, 3.2, (max(6, base_orb_x - 4), 172), 45.0),
        (-2.2, 1.008, 0.984, 2.0, (max(6, base_orb_x - 2), 171), 90.0),
        (1.2,  1.010, 0.982, 1.2, (base_orb_x + 4, 174), 135.0),
        (2.4,  1.014, 0.974, 2.8, (max(6, base_orb_x - 1), 173), 180.0),
        (-0.6, 1.004, 0.993, 0.8, (base_orb_x + 1, 174), 225.0),
    ]
    for c_idx, (ang, sx, sy, hdy, orb_xy, orb_phase) in enumerate(work_specs):
        if work_ei is not None:
            extra_placements.append({"extraIndex": work_ei, "row": 7, "col": c_idx})
        cell = _articulate_cell(
            work_src,
            angle_deg=ang,
            sx=sx,
            sy=sy,
            dx=0.0,
            dy=0.0,
            head_dy=hdy,
            waist_frac=0.46,
            neck_frac=0.26,
            shear_x=0.0,
            bottom_excl=200,
        )
        orb_im = _draw_mini_yarn_orb(orb_phase)
        cell.alpha_composite(orb_im, orb_xy)
        put(7, c_idx, cell)

    # Row 8: calm attentive downward reading / review (cols 0..5) — ALWAYS front-facing, NEVER back view!
    review_specs = [
        (0.0,  1.002, 0.996, 1.6),
        (1.4,  1.004, 0.992, 3.4),
        (2.2,  1.006, 0.989, 4.8),
        (1.2,  1.005, 0.991, 3.8),
        (-1.2, 1.004, 0.993, 2.8),
        (-0.5, 1.002, 0.997, 1.8),
    ]
    for c_idx, (ang, sx, sy, hdy) in enumerate(review_specs):
        cell = _articulate_cell(
            front_cell,
            angle_deg=ang,
            sx=sx,
            sy=sy,
            head_dy=hdy,
            waist_frac=0.46,
            neck_frac=0.26,
            bottom_excl=200,
        )
        c_arr = np.array(cell, dtype=np.uint8)
        c_arr[_front_lock_y:, :, :] = front_arr_u8[_front_lock_y:, :, :]
        put(8, c_idx, Image.fromarray(c_arr, "RGBA"))

    # Rows 9-10: 16-direction clockwise seated gaze (0° UP -> 90° RIGHT -> 180° DOWN -> 270° LEFT -> 337.5° UP-L)
    # NEVER swap to half-height side-walking cat or back view! Keep seated front body locked & rotate head/face smoothly.
    for idx16 in range(16):
        r = 9 + (idx16 // 8)
        c = idx16 % 8
        th = 2.0 * math.pi * idx16 / 16.0
        tile = _articulate_gaze_head_cell(front_cell, angle_rad=th, waist_frac=0.54, neck_frac=0.32)
        put(r, c, tile)

    out_arr = np.array(atlas, dtype=np.uint8)
    out_arr[out_arr[:, :, 3] <= 8] = (0, 0, 0, 0)
    return Image.fromarray(out_arr, "RGBA"), extra_placements


def _looks_like_multi_figure_collage(cell: Image.Image) -> bool:
    """Detect whether a sprite/cell accidentally contains >=2 spatially separated figures (e.g. an unsplit 2x2 quad)."""
    arr = np.array(cell.convert("RGBA"), dtype=np.uint8)
    fg = arr[:, :, 3] > 16
    total_fg = int(fg.sum())
    if total_fg < 200:
        return False

    ys_all, xs_all = np.where(fg)
    fx0, fx1 = int(xs_all.min()), int(xs_all.max()) + 1
    fy0, fy1 = int(ys_all.min()), int(ys_all.max()) + 1
    bw = max(1, fx1 - fx0)
    bh = max(1, fy1 - fy0)

    labeled, num = ndimage.label(fg, structure=np.ones((3, 3), dtype=int))
    if num < 2:
        return False

    sizes = np.bincount(labeled.ravel())
    sizes[0] = 0
    max_area = int(sizes.max())
    if max_area <= 0:
        return False
    # Single figure dominating >=80% of foreground (e.g. cat + yarn ball / butterfly / ? bubble) is NOT a collage
    if max_area / float(total_fg) >= 0.80:
        return False

    min_body_area = max(120, int(total_fg * 0.10))
    min_dim = max(12, int(0.18 * min(bw, bh)))
    slices = ndimage.find_objects(labeled)
    mid_x = 0.5 * float(fx0 + fx1)
    mid_y = 0.5 * float(fy0 + fy1)

    bodies: list[dict[str, Any]] = []
    for cid in range(1, num + 1):
        area = int(sizes[cid])
        if area < min_body_area or area < 0.22 * max_area:
            continue
        sl = slices[cid - 1]
        if sl is None:
            continue
        y0_c, y1_c = int(sl[0].start), int(sl[0].stop)
        x0_c, x1_c = int(sl[1].start), int(sl[1].stop)
        if max(y1_c - y0_c, x1_c - x0_c) < min_dim:
            continue
        sub_m = labeled[sl] == cid
        ly, lx = np.where(sub_m)
        cx = float(x0_c + lx.mean())
        cy = float(y0_c + ly.mean())
        bodies.append({
            "cid": cid,
            "area": area,
            "x0": x0_c,
            "y0": y0_c,
            "x1": x1_c,
            "y1": y1_c,
            "cx": cx,
            "cy": cy,
            "quad": (cx >= mid_x, cy >= mid_y),
        })

    if len(bodies) < 2:
        return False

    distinct_quads = {b["quad"] for b in bodies}
    if len(bodies) >= 3 and len(distinct_quads) >= 3:
        return True

    h_tol = max(3, int(0.04 * bw))
    v_tol = max(3, int(0.04 * bh))
    min_v_only_gap = max(10, int(0.08 * bh))
    for i in range(len(bodies)):
        a = bodies[i]
        for j in range(i + 1, len(bodies)):
            b = bodies[j]
            if a["quad"] == b["quad"]:
                continue
            dx = abs(a["cx"] - b["cx"])
            dy = abs(a["cy"] - b["cy"])
            h_sep = (a["x1"] <= b["x0"] + h_tol or b["x1"] <= a["x0"] + h_tol) and dx >= 0.30 * bw
            v_gap = max(b["y0"] - a["y1"], a["y0"] - b["y1"])
            # For purely vertical pairs at similar x, require a genuine empty gutter (>=8% height)
            # so a white-collar gap on a single cat never false-triggers.
            if dx < 0.25 * bw:
                v_sep = v_gap >= min_v_only_gap and dy >= 0.32 * bh
            else:
                v_sep = (a["y1"] <= b["y0"] + v_tol or b["y1"] <= a["y0"] + v_tol) and dy >= 0.30 * bh
            if h_sep or v_sep:
                return True

    return False


def _isolate_top_left_figure(cell: Image.Image) -> Image.Image:
    """Isolate ONLY the Top-Left major body cluster (+ its nearby tiny fragments) from a multi-figure collage."""
    arr = np.array(cell.convert("RGBA"), dtype=np.uint8)
    fg = arr[:, :, 3] > 16
    total_fg = int(fg.sum())
    if total_fg < 120:
        return cell

    ys_all, xs_all = np.where(fg)
    fx0, fx1 = int(xs_all.min()), int(xs_all.max()) + 1
    fy0, fy1 = int(ys_all.min()), int(ys_all.max()) + 1
    fw = max(1, fx1 - fx0)
    fh = max(1, fy1 - fy0)

    labeled, num = ndimage.label(fg, structure=np.ones((3, 3), dtype=int))
    if num < 2:
        return cell

    sizes = np.bincount(labeled.ravel())
    sizes[0] = 0
    max_area = int(sizes.max())
    min_major = max(80, int(total_fg * 0.06))
    slices = ndimage.find_objects(labeled)

    majors: list[dict[str, Any]] = []
    for cid in range(1, num + 1):
        area = int(sizes[cid])
        if area < min_major or area < 0.18 * max_area:
            continue
        sl = slices[cid - 1]
        if sl is None:
            continue
        sub_m = labeled[sl] == cid
        ly, lx = np.where(sub_m)
        cx = float(sl[1].start + lx.mean())
        cy = float(sl[0].start + ly.mean())
        majors.append({
            "cid": cid,
            "area": area,
            "nx": (cx - fx0) / float(fw),
            "ny": (cy - fy0) / float(fh),
        })

    if len(majors) < 2:
        return cell

    tl_cands = [m for m in majors if m["nx"] < 0.55 and m["ny"] < 0.55]
    if tl_cands:
        chosen = min(tl_cands, key=lambda m: m["nx"] + m["ny"])
    else:
        chosen = min(majors, key=lambda m: m["nx"] * m["nx"] + m["ny"] * m["ny"])
    chosen_cid = int(chosen["cid"])

    hh, ww = fg.shape
    ds = 2 if max(hh, ww) >= 600 else 1
    major_cids = [int(m["cid"]) for m in majors]
    chosen_idx = major_cids.index(chosen_cid)
    dist_stack = np.stack(
        [ndimage.distance_transform_edt(~((labeled == cid)[::ds, ::ds])) for cid in major_cids],
        axis=0,
    )
    max_frag_dist = max(24.0, 0.10 * max(fw, fh)) / ds

    keep_mask = labeled == chosen_cid
    major_set = set(major_cids)
    for cid in range(1, num + 1):
        if cid in major_set:
            continue
        sl = slices[cid - 1]
        if sl is None:
            continue
        fmask = labeled[sl] == cid
        fy_f, fx_f = np.where(fmask)
        if len(fy_f) == 0:
            continue
        ny_f = np.clip((sl[0].start + fy_f) // ds, 0, dist_stack.shape[1] - 1)
        nx_f = np.clip((sl[1].start + fx_f) // ds, 0, dist_stack.shape[2] - 1)
        dists = [float(dist_stack[k, ny_f, nx_f].min()) for k in range(len(major_cids))]
        if int(np.argmin(dists)) == chosen_idx and dists[chosen_idx] <= max_frag_dist:
            keep_mask[sl] |= fmask

    out_arr = np.where(keep_mask[:, :, None], arr, 0).astype(np.uint8)
    return _crop_tight(Image.fromarray(out_arr, "RGBA"))


def _apply_ai_sheets_to_atlas(
    atlas: Image.Image,
    front_cell: Image.Image,
    ai_sheets: dict[str, Any],
    *,
    asymmetric: bool = False,
) -> dict[str, Any]:
    """Assemble multi-sheet `#00FF00` AI sprites cleanly into an existing 8x11 fallback atlas.

    Each row/sheet is processed independently inside its own guard so if any single sheet is
    missing or fails extraction, ONLY that row gracefully keeps its upgraded fallback synthesis!
    """
    applied_rows: dict[str, str] = {}
    fallback_rows: list[dict[str, str]] = []
    q_bubble = _load_or_draw_question_bubble()

    r00_c0 = atlas.crop((0, 0, CELL_W, CELL_H))
    if not _has_visible_foreground(r00_c0, min_pixels=24):
        r00_c0 = front_cell
    _rx0, _ry0, _rx1, _ry1 = _cell_bbox(r00_c0)
    r00_h = max(48.0, float(_ry1 - _ry0))
    r00_torso_cx = 0.5 * float(_rx0 + _rx1)
    r00_neck_cx = _measure_upper_neck_chest_cx(r00_c0)
    r00_haunch_skew = _seated_haunch_skew_frac(r00_c0)
    r00_anchor_repaired = False

    def _entry_path_grid(key: str, default_cols: int, default_rows: int) -> tuple[Path | None, int, int]:
        raw = ai_sheets.get(key)
        if not raw:
            return None, default_cols, default_rows
        if isinstance(raw, str):
            p = Path(raw)
            return (p if p.is_file() else None), default_cols, default_rows
        if isinstance(raw, dict):
            p_str = str(raw.get("path") or raw.get("file") or "").strip()
            p = Path(p_str) if p_str else None
            c = int(raw.get("cols") or default_cols)
            r = int(raw.get("rows") or default_rows)
            return (p if (p is not None and p.is_file()) else None), c, r
        return None, default_cols, default_rows

    def _replace_cells(r: int, cols_list: list[int], tiles: list[Image.Image]) -> None:
        for c_i, tile in zip(cols_list, tiles):
            atlas.paste((0, 0, 0, 0), (c_i * CELL_W, r * CELL_H, (c_i + 1) * CELL_W, (r + 1) * CELL_H))
            atlas.alpha_composite(tile, (c_i * CELL_W, r * CELL_H))

    def _align_seated_orientation(sp: Image.Image) -> Image.Image:
        """For non-directional seated rows (R00/R03/R08) on symmetric pets, un-mirror if haunch/tail is on the opposite side from R00 c0."""
        if asymmetric or abs(r00_haunch_skew) < 0.05:
            return sp
        sp_skew = _seated_haunch_skew_frac(sp)
        if sp_skew * r00_haunch_skew < 0.0 and abs(sp_skew) >= 0.05:
            return sp.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        return sp

    def _place_seated(sp: Image.Image, scale: float) -> Image.Image:
        scaled = _scale_sprite_uniform(sp, scale, max_w=CELL_W - 4, max_h=CELL_H - 4)
        sc_cx = _measure_upper_neck_chest_cx(scaled)
        dx = max(2, min(CELL_W - scaled.width - 2, round(r00_neck_cx - sc_cx)))
        dy = max(2, min(CELL_H - scaled.height - 2, NORM_BOTTOM_EXCL - scaled.height))
        cell = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
        cell.alpha_composite(scaled, (dx, dy))
        return cell

    # 1. R00 (idle blink) & R03 (polite nod + blink): supports combined 4x2 `r00_r03` or standalone `r00` / `r03`
    r00_r03_path, c_03, r_03 = _entry_path_grid("r00_r03", 4, 2)
    r00_sprites: list[Image.Image] = []
    r03_sprites: list[Image.Image] = []
    if r00_r03_path is not None:
        try:
            with Image.open(r00_r03_path) as im:
                im.load()
                tiles_03 = _slice_green_sheet_grid(im, c_03, r_03)
            if len(tiles_03) >= 8:
                top4, bot4 = [], []
                for t in tiles_03[:4]:
                    arr_t = chroma_matte_green_safe(t)
                    if int((arr_t[:, :, 3] > 20).sum()) >= 320:
                        top4.append(key_green_sprite_safe(t, purge_far_strays=True, pre_matted=arr_t))
                for t in tiles_03[4:8]:
                    arr_t = chroma_matte_green_safe(t)
                    if int((arr_t[:, :, 3] > 20).sum()) >= 320:
                        bot4.append(key_green_sprite_safe(t, purge_far_strays=True, pre_matted=arr_t))
                if len(top4) == 4:
                    r00_sprites = top4
                else:
                    fallback_rows.append({"row": "R00", "reason": f"r00_r03 top row yielded {len(top4)}/4 frames"})
                if len(bot4) == 4:
                    r03_sprites = bot4
                else:
                    fallback_rows.append({"row": "R03", "reason": f"r00_r03 bottom row yielded {len(bot4)}/4 frames"})
        except Exception as exc:
            fallback_rows.append({"row": "R00+R03", "reason": str(exc)})

    if not r00_sprites:
        p_r00, gc, gr = _entry_path_grid("r00", 3, 2)
        if p_r00 is not None:
            try:
                with Image.open(p_r00) as im:
                    im.load()
                    r00_sprites = _slice_nonempty_green_sprites(im, gc, gr, purge_far_strays=True)
            except Exception as exc:
                fallback_rows.append({"row": "R00", "reason": str(exc)})

    if not r03_sprites:
        p_r03, gc, gr = _entry_path_grid("r03", 2, 2)
        if p_r03 is not None:
            try:
                with Image.open(p_r03) as im:
                    im.load()
                    asp = im.width / max(1.0, float(im.height))
                    if asp >= 2.2:
                        gc, gr = 4, 1
                    r03_sprites = _slice_nonempty_green_sprites(im, gc, gr, purge_far_strays=True)
            except Exception as exc:
                fallback_rows.append({"row": "R03", "reason": str(exc)})

    # Downstream defense-in-depth: if r00_c0 still looks like a multi-figure collage (e.g. an unsplit
    # Stage A 2x2 quad), replace it with clean placed r00_r03 top4[0] (or r03[0] / isolated TL figure)
    # BEFORE locking R00/R03/R05/R08/R09/R10 and clean up any collage-poisoned fallback rows!
    if _looks_like_multi_figure_collage(r00_c0):
        clean_anchor_sp: Image.Image | None = None
        if r00_sprites and not _looks_like_multi_figure_collage(r00_sprites[0]):
            clean_anchor_sp = r00_sprites[0]
        elif r03_sprites and not _looks_like_multi_figure_collage(r03_sprites[0]):
            clean_anchor_sp = r03_sprites[0]
        else:
            iso_tl = _isolate_top_left_figure(r00_c0)
            if _has_visible_foreground(iso_tl, min_pixels=40) and not _looks_like_multi_figure_collage(iso_tl):
                clean_anchor_sp = iso_tl

        if clean_anchor_sp is not None:
            # Capture ALL poisoned fallback cells across the full 8x11 atlas BEFORE replacing cell (0, 0),
            # keeping clean non-collage fallback rows/sub-rows (e.g. real side/sleep/hold anchors) intact.
            row_slices: list[tuple[int, list[int]]] = []
            for r_chk in range(ROWS):
                if r_chk == 4:
                    row_slices.append((4, list(range(5))))
                    row_slices.append((4, [5, 6, 7]))
                else:
                    n_act = CODEX_V2_ACTIVE_COLS[r_chk] if r_chk < len(CODEX_V2_ACTIVE_COLS) else COLS
                    row_slices.append((r_chk, list(range(n_act))))

            dirty_cells: set[tuple[int, int]] = set()
            for r_chk, cols_chk in row_slices:
                slice_dirty = (r_chk == 0)
                if not slice_dirty:
                    for c_chk in cols_chk:
                        cell_chk = atlas.crop((c_chk * CELL_W, r_chk * CELL_H, (c_chk + 1) * CELL_W, (r_chk + 1) * CELL_H))
                        if _has_visible_foreground(cell_chk, min_pixels=24) and _looks_like_multi_figure_collage(cell_chk):
                            slice_dirty = True
                            break
                if slice_dirty:
                    for c_chk in cols_chk:
                        dirty_cells.add((r_chk, c_chk))
            # Also sweep any remaining non-empty cell across full ROWS x COLS
            for r_chk in range(ROWS):
                for c_chk in range(COLS):
                    if (r_chk, c_chk) in dirty_cells:
                        continue
                    cell_chk = atlas.crop((c_chk * CELL_W, r_chk * CELL_H, (c_chk + 1) * CELL_W, (r_chk + 1) * CELL_H))
                    if _has_visible_foreground(cell_chk, min_pixels=24) and _looks_like_multi_figure_collage(cell_chk):
                        dirty_cells.add((r_chk, c_chk))

            r00_c0 = normalize_view_cell(clean_anchor_sp)
            _rx0, _ry0, _rx1, _ry1 = _cell_bbox(r00_c0)
            r00_h = max(48.0, float(_ry1 - _ry0))
            r00_torso_cx = 0.5 * float(_rx0 + _rx1)
            r00_neck_cx = _measure_upper_neck_chest_cx(r00_c0)
            r00_haunch_skew = _seated_haunch_skew_frac(r00_c0)
            _replace_cells(0, [0], [r00_c0])
            r00_anchor_repaired = True

            # Repair ALL pre-synthesized fallback cells that were poisoned by the multi-figure front_cell
            if dirty_cells:
                try:
                    clean_fb_atlas, _ = _synthesize_8x11_atlas(
                        r00_c0,
                        r00_c0,
                        r00_c0,
                        [],
                        [],
                        has_real_side=False,
                        has_real_back=False,
                    )
                    by_row: dict[int, list[int]] = {}
                    for r_fix, c_fix in sorted(dirty_cells):
                        by_row.setdefault(r_fix, []).append(c_fix)
                    for r_fix, cols_fix in by_row.items():
                        fb_tiles = [
                            clean_fb_atlas.crop((c_i * CELL_W, r_fix * CELL_H, (c_i + 1) * CELL_W, (r_fix + 1) * CELL_H))
                            for c_i in cols_fix
                        ]
                        _replace_cells(r_fix, cols_fix, fb_tiles)
                except Exception:
                    pass

    if len(r00_sprites) >= 4:
        try:
            sps0 = [_align_seated_orientation(sp) for sp in r00_sprites[:6]]
            sc_00 = min(r00_h / max(f.height for f in sps0), 166.0 / max(f.width for f in sps0))
            locked_00 = [
                _composite_lower_body_lock(r00_c0, _place_seated(sp, sc_00), split_frac=0.54, band_half=10)
                for sp in sps0
            ]
            if len(locked_00) >= 6:
                r00_final = [r00_c0, locked_00[1], locked_00[2], locked_00[3], locked_00[4], locked_00[5]]
            else:
                b_in = _articulate_cell(r00_c0, angle_deg=0.4, sx=1.003, sy=0.996, head_dy=0.3, waist_frac=0.56, bottom_excl=200)
                b_out = _articulate_cell(r00_c0, angle_deg=-0.3, sx=1.002, sy=0.998, head_dy=0.15, waist_frac=0.56, bottom_excl=200)
                # [open anchor, gentle breath, half-blink, closed-blink, opening-blink, soft settle]
                r00_final = [r00_c0, b_in, locked_00[1], locked_00[2], locked_00[3], b_out]
            _replace_cells(0, list(range(6)), r00_final)
            applied_rows["R00"] = "ai"
        except Exception as exc:
            fallback_rows.append({"row": "R00", "reason": str(exc)})

    if len(r03_sprites) >= 4:
        try:
            sps = [_align_seated_orientation(sp) for sp in r03_sprites[:4]]
            sc_03 = min(r00_h / max(f.height for f in sps), 166.0 / max(f.width for f in sps))
            r03_final = [
                _composite_lower_body_lock(r00_c0, _place_seated(sp, sc_03), split_frac=0.55, band_half=10)
                for sp in sps
            ]
            _replace_cells(3, list(range(4)), r03_final)
            applied_rows["R03"] = "ai"
        except Exception as exc:
            fallback_rows.append({"row": "R03", "reason": str(exc)})

    # 2. R01 (run right 8f + yellow butterfly) & R02 (run left 8f, independent if provided/asymmetric else clean mirror)
    run_bottoms = [196, 193, 189, 188, 191, 193, 195, 196]
    r01_cells: list[Image.Image] = []
    p_r01, gc1, gr1 = _entry_path_grid("r01", 4, 2)
    if p_r01 is not None:
        try:
            with Image.open(p_r01) as im:
                im.load()
                asp = im.width / max(1.0, float(im.height))
                if asp >= 3.6:
                    gc1, gr1 = 8, 1
                r1_sp = _split_run8_with_butterfly_sheet(im, "right", cols=gc1, rows=gr1)
            if len(r1_sp) >= 8:
                r1_sp = r1_sp[:8]
                sc_run = _compute_run_row_scale(r1_sp)
                for c, sp in enumerate(r1_sp):
                    scaled = _scale_sprite_uniform(sp, sc_run)
                    cell = _place_in_cell_anchored(
                        scaled,
                        bottom_excl=run_bottoms[c],
                        center_x=96.0,
                        anchor_band="cat_body_no_butterfly",
                    )
                    r01_cells.append(cell)
                _replace_cells(1, list(range(8)), r01_cells)
                applied_rows["R01"] = "ai"
            else:
                fallback_rows.append({"row": "R01", "reason": f"expected 8 run frames, got {len(r1_sp)}"})
        except Exception as exc:
            fallback_rows.append({"row": "R01", "reason": str(exc)})

    p_r02, gc2, gr2 = _entry_path_grid("r02", 4, 2)
    r02_done = False
    if p_r02 is not None:
        try:
            with Image.open(p_r02) as im:
                im.load()
                asp = im.width / max(1.0, float(im.height))
                if asp >= 3.6:
                    gc2, gr2 = 8, 1
                r2_sp = _split_run8_with_butterfly_sheet(im, "left", cols=gc2, rows=gr2)
            if len(r2_sp) >= 8:
                r2_sp = r2_sp[:8]
                sc_run2 = _compute_run_row_scale(r2_sp)
                r02_cells = []
                for c, sp in enumerate(r2_sp):
                    scaled = _scale_sprite_uniform(sp, sc_run2)
                    r02_cells.append(
                        _place_in_cell_anchored(
                            scaled,
                            bottom_excl=run_bottoms[c],
                            center_x=96.0,
                            anchor_band="cat_body_no_butterfly",
                        )
                    )
                _replace_cells(2, list(range(8)), r02_cells)
                applied_rows["R02"] = "ai_independent"
                r02_done = True
            else:
                fallback_rows.append({"row": "R02", "reason": f"expected 8 left-run frames, got {len(r2_sp)}"})
        except Exception as exc:
            fallback_rows.append({"row": "R02", "reason": str(exc)})

    if not r02_done and len(r01_cells) == 8:
        r02_mirrored = [c_im.transpose(Image.Transpose.FLIP_LEFT_RIGHT) for c_im in r01_cells]
        _replace_cells(2, list(range(8)), r02_mirrored)
        applied_rows["R02"] = "ai_mirrored_r01" if not asymmetric else "ai_mirrored_fallback"

    # 3. R04 (5-stage natural jump, row 4 cols 0..4)
    p_r04, gc4, gr4 = _entry_path_grid("r04", 3, 2)
    if p_r04 is not None:
        try:
            with Image.open(p_r04) as im:
                im.load()
                asp = im.width / max(1.0, float(im.height))
                if asp >= 2.6:
                    gc4, gr4 = 5, 1
                jump_sp = _slice_nonempty_green_sprites(im, gc4, gr4, purge_far_strays=True)
            if len(jump_sp) >= 5:
                jump_sp = jump_sp[:5]
                sc_jump = min(180.0 / max(f.width for f in jump_sp), 184.0 / max(f.height for f in jump_sp))
                jump_bottoms = [199, 187, 178, 190, 199]
                r04_cells = [
                    _place_in_cell_anchored(_scale_sprite_uniform(sp, sc_jump), bottom_excl=jump_bottoms[c], center_x=96.0, anchor_band="full")
                    for c, sp in enumerate(jump_sp)
                ]
                _replace_cells(4, list(range(5)), r04_cells)
                applied_rows["R04"] = "ai"
            else:
                fallback_rows.append({"row": "R04", "reason": f"expected 5 jump frames, got {len(jump_sp)}"})
        except Exception as exc:
            fallback_rows.append({"row": "R04", "reason": str(exc)})

    # 4. R04H (3-frame classic slim vertical scruff-held dangle & sway, row 4 cols 5..7)
    p_r04h, gc4h, gr4h = _entry_path_grid("r04h", 3, 1)
    if p_r04h is not None:
        try:
            with Image.open(p_r04h) as im:
                im.load()
                hold_sp = _slice_nonempty_green_sprites(im, gc4h, gr4h, purge_far_strays=True)
            if len(hold_sp) >= 3:
                hold_sp = hold_sp[:3]
                hold_placed: list[Image.Image] = []
                for sp in hold_sp:
                    sc_h = min(184.0 / max(1, sp.height), 130.0 / max(1, sp.width))
                    scaled = _scale_sprite_uniform(sp, sc_h)
                    hold_placed.append(
                        _place_in_cell_anchored(scaled, bottom_excl=None, top_y=14, center_x=95.0, anchor_band="top")
                    )

                def _lower_cx(im_c: Image.Image) -> float:
                    arr_h = np.array(im_c)
                    _, xs_h = np.where(arr_h[95:, :, 3] > 20)
                    if len(xs_h) == 0:
                        _, xs_h = np.where(arr_h[:, :, 3] > 20)
                    return float(xs_h.mean()) if len(xs_h) else 95.0

                lcxs = [_lower_cx(hc) for hc in hold_placed]
                if lcxs[1] + 1.5 < lcxs[0] < lcxs[2] - 1.5:
                    c5_plumb, c6_left, c7_right = hold_placed[0], hold_placed[1], hold_placed[2]
                else:
                    order_idx = np.argsort(lcxs).tolist()
                    c5_plumb = hold_placed[order_idx[1]]
                    c6_left = hold_placed[order_idx[0]]
                    c7_right = hold_placed[order_idx[2]]
                    if not (_lower_cx(c6_left) + 2.0 < _lower_cx(c5_plumb) < _lower_cx(c7_right) - 2.0):
                        c6_left = _apply_pendulum_sway(c5_plumb, sway_deg=9.5)
                        c7_right = _apply_pendulum_sway(c5_plumb, sway_deg=-9.5)
                _replace_cells(4, [5, 6, 7], [c5_plumb, c6_left, c7_right])
                applied_rows["R04H"] = "ai"
            else:
                fallback_rows.append({"row": "R04H", "reason": f"expected 3 hold frames, got {len(hold_sp)}"})
        except Exception as exc:
            fallback_rows.append({"row": "R04H", "reason": str(exc)})

    # 5. R05 (8-frame smooth puzzled head-tilt + crisp native 47x45 `?` bubble on c3, c4, c7)
    p_r05, gc5, gr5 = _entry_path_grid("r05", 4, 2)
    if p_r05 is not None:
        try:
            with Image.open(p_r05) as im:
                im.load()
                tilt_sp = _slice_nonempty_green_sprites(im, gc5, gr5, purge_far_strays=True)
            if len(tilt_sp) >= 8:
                tilt_sp = tilt_sp[:8]
                sc_tilt = min(r00_h / max(f.height for f in tilt_sp), 166.0 / max(f.width for f in tilt_sp))
                r05_cells: list[Image.Image] = []
                for c, sp in enumerate(tilt_sp):
                    placed = _place_seated(sp, sc_tilt)
                    locked = _composite_lower_body_lock(r00_c0, placed, split_frac=0.53, band_half=10)
                    if c in (3, 4, 7) and not _has_upper_right_bubble(locked):
                        locked = _overlay_bubble_smart(locked, q_bubble, prefer_xy=(135, 12), x_range=(126, 143), y_range=(6, 22))
                    r05_cells.append(locked)
                _replace_cells(5, list(range(8)), r05_cells)
                applied_rows["R05"] = "ai"
            else:
                fallback_rows.append({"row": "R05", "reason": f"expected 8 puzzled frames, got {len(tilt_sp)}"})
        except Exception as exc:
            fallback_rows.append({"row": "R05", "reason": str(exc)})

    # 6. R06 (curled sleep/rest) & R08 (calm front-seated downward reading + blink): `r06_r08` (4x2) or standalone
    r06_sprites: list[Image.Image] = []
    r08_sprites: list[Image.Image] = []
    p_r06_08, c_68, r_68 = _entry_path_grid("r06_r08", 4, 2)
    if p_r06_08 is not None:
        try:
            with Image.open(p_r06_08) as im:
                im.load()
                tiles_68 = _slice_green_sheet_grid(im, c_68, r_68)
            if len(tiles_68) >= 8:
                top4, bot4 = [], []
                for t in tiles_68[:4]:
                    arr_t = chroma_matte_green_safe(t)
                    if int((arr_t[:, :, 3] > 20).sum()) >= 320:
                        top4.append(key_green_sprite_safe(t, purge_far_strays=True, pre_matted=arr_t))
                for t in tiles_68[4:8]:
                    arr_t = chroma_matte_green_safe(t)
                    if int((arr_t[:, :, 3] > 20).sum()) >= 320:
                        bot4.append(key_green_sprite_safe(t, purge_far_strays=True, pre_matted=arr_t))
                if len(top4) == 4:
                    r06_sprites = top4
                else:
                    fallback_rows.append({"row": "R06", "reason": f"r06_r08 top row yielded {len(top4)}/4 frames"})
                if len(bot4) == 4:
                    r08_sprites = bot4
                else:
                    fallback_rows.append({"row": "R08", "reason": f"r06_r08 bottom row yielded {len(bot4)}/4 frames"})
        except Exception as exc:
            fallback_rows.append({"row": "R06+R08", "reason": str(exc)})

    if not r06_sprites:
        p_r06, gc6, gr6 = _entry_path_grid("r06", 3, 2)
        if p_r06 is not None:
            try:
                with Image.open(p_r06) as im:
                    im.load()
                    r06_sprites = _slice_nonempty_green_sprites(im, gc6, gr6, purge_far_strays=True)
            except Exception as exc:
                fallback_rows.append({"row": "R06", "reason": str(exc)})

    if not r08_sprites:
        p_r08, gc8, gr8 = _entry_path_grid("r08", 3, 2)
        if p_r08 is not None:
            try:
                with Image.open(p_r08) as im:
                    im.load()
                    r08_sprites = _slice_nonempty_green_sprites(im, gc8, gr8, purge_far_strays=True)
            except Exception as exc:
                fallback_rows.append({"row": "R08", "reason": str(exc)})

    if len(r06_sprites) >= 4:
        try:
            sps = r06_sprites[:6] if len(r06_sprites) >= 6 else r06_sprites[:4]
            med_asp = float(np.median([f.width / max(1.0, float(f.height)) for f in sps]))
            max_h_target = 136.0 if med_asp >= 1.15 else 168.0
            sc_06 = min(176.0 / max(f.width for f in sps), max_h_target / max(f.height for f in sps))
            placed_06 = [
                _place_in_cell_anchored(_scale_sprite_uniform(sp, sc_06), bottom_excl=199, center_x=96.0, anchor_band="full")
                for sp in sps
            ]
            r06_final = placed_06[:6] if len(placed_06) >= 6 else _expand_4_to_6_smooth(placed_06, bottom_excl=199)
            _replace_cells(6, list(range(6)), r06_final)
            applied_rows["R06"] = "ai"
        except Exception as exc:
            fallback_rows.append({"row": "R06", "reason": str(exc)})

    r08_down_anchor: Image.Image | None = None
    if len(r08_sprites) >= 4:
        try:
            raw_sps = r08_sprites[:6] if len(r08_sprites) >= 6 else r08_sprites[:4]
            sps = [_align_seated_orientation(sp) for sp in raw_sps]
            sc_08 = min(r00_h / max(f.height for f in sps), 166.0 / max(f.width for f in sps))
            locked_08 = [
                _composite_lower_body_lock(r00_c0, _place_seated(sp, sc_08), split_frac=0.56, band_half=10)
                for sp in sps
            ]
            r08_down_anchor = locked_08[1] if len(locked_08) > 1 else locked_08[0]
            r08_final = locked_08[:6] if len(locked_08) >= 6 else _expand_4_to_6_smooth(locked_08, bottom_excl=200, lock_anchor=r00_c0)
            _replace_cells(8, list(range(6)), r08_final)
            applied_rows["R08"] = "ai"
        except Exception as exc:
            fallback_rows.append({"row": "R08", "reason": str(exc)})

    # 7. R07 (6-frame active pink yarn ball play)
    p_r07, gc7, gr7 = _entry_path_grid("r07", 3, 2)
    if p_r07 is not None:
        try:
            with Image.open(p_r07) as im:
                im.load()
                yarn_sp = _slice_nonempty_green_sprites(im, gc7, gr7, keep_pink_yarn=True, purge_far_strays=False)
            if len(yarn_sp) >= 6:
                yarn_sp = yarn_sp[:6]
                sc_yarn = min(186.0 / max(f.width for f in yarn_sp), 158.0 / max(f.height for f in yarn_sp))
                r07_cells = [
                    _place_in_cell_anchored(
                        _scale_sprite_uniform(sp, sc_yarn),
                        bottom_excl=NORM_BOTTOM_EXCL,
                        center_x=98.0,
                        anchor_band="yarn_cat_body",
                    )
                    for sp in yarn_sp
                ]
                _replace_cells(7, list(range(6)), r07_cells)
                applied_rows["R07"] = "ai"
            else:
                fallback_rows.append({"row": "R07", "reason": f"expected 6 yarn frames, got {len(yarn_sp)}"})
        except Exception as exc:
            fallback_rows.append({"row": "R07", "reason": str(exc)})

    # 8. R09 (right semicircle 0°..157.5°) & R10 (left semicircle 180°..337.5°) 16-dir clockwise seated gaze
    raw_gaze_by_row: dict[int, tuple[list[Image.Image], float]] = {}
    for key_g, target_r, allow_r, allow_l in (("r09", 9, True, False), ("r10", 10, False, True)):
        p_g, gcg, grg = _entry_path_grid(key_g, 4, 2)
        if p_g is None:
            continue
        try:
            with Image.open(p_g) as im:
                im.load()
                gaze_sp = _slice_nonempty_green_sprites(im, gcg, grg, purge_far_strays=True)
            if len(gaze_sp) >= 8:
                gaze_sp = gaze_sp[:8]
                sc_g = min(r00_h / max(f.height for f in gaze_sp), 166.0 / max(f.width for f in gaze_sp))
                raw_gaze_by_row[target_r] = (gaze_sp, sc_g)
                g_cells: list[Image.Image] = []
                for c, sp in enumerate(gaze_sp):
                    placed = _place_seated(sp, sc_g)
                    is_bowed = (target_r == 9 and c >= 6) or (target_r == 10 and c <= 2)
                    locked = _composite_lower_body_lock(
                        r00_c0,
                        placed,
                        split_frac=0.57 if is_bowed else 0.52,
                        band_half=10,
                        allow_right_nose=allow_r,
                        allow_left_nose=allow_l,
                    )
                    g_cells.append(locked)
                _replace_cells(target_r, list(range(8)), g_cells)
                applied_rows[f"R{target_r:02d}"] = "ai"
            else:
                fallback_rows.append({"row": f"R{target_r:02d}", "reason": f"expected 8 gaze frames, got {len(gaze_sp)}"})
        except Exception as exc:
            fallback_rows.append({"row": f"R{target_r:02d}", "reason": str(exc)})

    # Symmetric compass resilience: if !asymmetric and one gaze semicircle succeeded while the other failed/missing,
    # synthesize the missing semicircle by mirroring the compass head-turns (c1..c7 = mirror of c7..c1) + locking R00 c0 lower body!
    if not asymmetric:
        if 9 in raw_gaze_by_row and "R10" not in applied_rows:
            try:
                r9_sps, sc_9 = raw_gaze_by_row[9]
                c0_down = r08_down_anchor if r08_down_anchor is not None else _articulate_gaze_head_cell(r00_c0, angle_rad=math.pi)
                r10_mirror_cells = [c0_down]
                # Exact clockwise angle mirror: R09 c7(157.5°) -> R10 c1(202.5°), ..., R09 c1(22.5°) -> R10 c7(337.5°)
                for c_dst, src_idx in enumerate((7, 6, 5, 4, 3, 2, 1), start=1):
                    mir_sp = r9_sps[src_idx].transpose(Image.Transpose.FLIP_LEFT_RIGHT)
                    placed = _place_seated(mir_sp, sc_9)
                    locked = _composite_lower_body_lock(
                        r00_c0,
                        placed,
                        split_frac=0.54 if c_dst <= 2 else 0.49,
                        band_half=9,
                        allow_right_nose=False,
                        allow_left_nose=True,
                    )
                    r10_mirror_cells.append(locked)
                _replace_cells(10, list(range(8)), r10_mirror_cells)
                applied_rows["R10"] = "ai_mirrored_r09_fallback"
                fallback_rows.append({"row": "R10", "reason": "r10 sheet missing; mirrored from r09 head + R00 lower-body lock"})
            except Exception as exc:
                fallback_rows.append({"row": "R10", "reason": str(exc)})
        elif 10 in raw_gaze_by_row and "R09" not in applied_rows:
            try:
                r10_sps, sc_10 = raw_gaze_by_row[10]
                c0_up = _articulate_gaze_head_cell(r00_c0, angle_rad=0.0)
                r09_mirror_cells = [c0_up]
                # Exact clockwise angle mirror: R10 c7(337.5°) -> R09 c1(22.5°), ..., R10 c1(202.5°) -> R09 c7(157.5°)
                for c_dst, src_idx in enumerate((7, 6, 5, 4, 3, 2, 1), start=1):
                    mir_sp = r10_sps[src_idx].transpose(Image.Transpose.FLIP_LEFT_RIGHT)
                    placed = _place_seated(mir_sp, sc_10)
                    locked = _composite_lower_body_lock(
                        r00_c0,
                        placed,
                        split_frac=0.54 if c_dst >= 6 else 0.49,
                        band_half=9,
                        allow_right_nose=True,
                        allow_left_nose=False,
                    )
                    r09_mirror_cells.append(locked)
                _replace_cells(9, list(range(8)), r09_mirror_cells)
                applied_rows["R09"] = "ai_mirrored_r10_fallback"
                fallback_rows.append({"row": "R09", "reason": "r09 sheet missing; mirrored from r10 head + R00 lower-body lock"})
            except Exception as exc:
                fallback_rows.append({"row": "R09", "reason": str(exc)})

    # Ensure every unapplied canonical row is explicitly reported in fallbackRows for accurate telemetry
    recorded_fallback_keys = {str(item.get("row") or "") for item in fallback_rows}
    for row_key in ("R00", "R01", "R02", "R03", "R04", "R04H", "R05", "R06", "R07", "R08", "R09", "R10"):
        if row_key not in applied_rows and row_key not in recorded_fallback_keys:
            fallback_rows.append({"row": row_key, "reason": "ai sheet not provided"})

    out_arr = np.array(atlas, dtype=np.uint8)
    out_arr[out_arr[:, :, 3] <= 8] = (0, 0, 0, 0)
    atlas.paste(Image.fromarray(out_arr, "RGBA"))
    return {
        "appliedRows": applied_rows,
        "fallbackRows": fallback_rows,
        "appliedCount": len(applied_rows),
        "fallbackCount": len(fallback_rows),
        "r00AnchorRepaired": r00_anchor_repaired,
    }


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

    if prep["mode"] == "animated" and cfg.get("preserveAnimated", True):
        _make_thumbnail(front_cell, thumb_path)
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
    ai_sheets = cfg.get("aiSheets") if isinstance(cfg.get("aiSheets"), dict) else (
        cfg.get("ai_sheets") if isinstance(cfg.get("ai_sheets"), dict) else None
    )
    asymmetric = bool(cfg.get("asymmetric", False))
    ai_report: dict[str, Any] | None = None

    def _load_optional_anchor_cell(key: str) -> Image.Image | None:
        if not ai_sheets or not ai_sheets.get(key):
            return None
        raw = ai_sheets.get(key)
        p_str = raw.get("path") if isinstance(raw, dict) else (raw if isinstance(raw, str) else "")
        if not p_str:
            return None
        p = Path(str(p_str))
        if not p.is_file():
            return None
        try:
            with Image.open(p) as im:
                im.load()
                rgba = im.convert("RGBA")
            _is_t, _bg, _p90, bg_kind = _sample_border_background(np.array(rgba, dtype=np.uint8))
            if bg_kind == "green":
                sp = key_green_sprite_safe(rgba, purge_far_strays=True)
            else:
                sp = _crop_tight(filter_isolated_noise(adaptive_remove_background(rgba, orig_path=p, allow_multiple=False)))
            if _has_visible_foreground(sp, min_pixels=40):
                return normalize_view_cell(sp)
        except Exception:
            return None
        return None

    if prebaked is not None:
        atlas = prebaked
    else:
        sleep_anchor_cell = _load_optional_anchor_cell("anchor_sleep")
        hold_anchor_cell = _load_optional_anchor_cell("anchor_hold")
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
            sleep_cell=sleep_anchor_cell,
            hold_cell=hold_anchor_cell,
        )
        if ai_sheets:
            ai_report = _apply_ai_sheets_to_atlas(atlas, front_cell, ai_sheets, asymmetric=asymmetric)

    final_r00_c0 = atlas.crop((0, 0, CELL_W, CELL_H))
    if _has_visible_foreground(final_r00_c0, min_pixels=24):
        _make_thumbnail(final_r00_c0, thumb_path)
    else:
        _make_thumbnail(front_cell, thumb_path)

    atlas_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(atlas_path, format="PNG")

    result_payload: dict[str, Any] = {
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
    if ai_report is not None:
        result_payload["aiReport"] = ai_report
    return result_payload


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


def _slice_alpha_grid_valleys(keyed: Image.Image, cols: int, rows: int) -> list[Image.Image]:
    """Slice a keyed RGBA sprite sheet into `cols x rows` cells via trimmed-foreground valley cuts.

    Verifies that every interior cut lands in a genuine deep valley (<= 18% of adjacent peaks) so a
    single-figure image is NEVER sliced in half.
    """
    w, h = keyed.size
    arr = np.array(keyed.convert("RGBA"), dtype=np.uint8)
    fg = arr[:, :, 3] > 20
    total_fg = int(fg.sum())
    if total_fg < 160:
        return []

    ys_f, xs_f = np.where(fg)
    fx0, fx1 = int(xs_f.min()), int(xs_f.max()) + 1
    fy0, fy1 = int(ys_f.min()), int(ys_f.max()) + 1
    fg_w = fx1 - fx0
    fg_h = fy1 - fy0
    if fg_w < max(16, cols * 12) or fg_h < max(16, rows * 12):
        return []

    pad_x = min(12, max(2, int(w * 0.02)))
    pad_y = min(12, max(2, int(h * 0.02)))
    rx0, rx1 = max(0, fx0 - pad_x), min(w, fx1 + pad_x)
    ry0, ry1 = max(0, fy0 - pad_y), min(h, fy1 + pad_y)

    def _cuts_are_deep_valleys(proj: np.ndarray, cuts: list[int]) -> bool:
        for idx in range(1, len(cuts) - 1):
            c = cuts[idx]
            prev_c = cuts[idx - 1]
            next_c = cuts[idx + 1]
            if c <= prev_c + 2 or next_c <= c + 2:
                return False
            lo_w = max(prev_c, c - 2)
            hi_w = min(next_c - 1, c + 2)
            val = int(proj[lo_w : hi_w + 1].min())
            left_pk = int(proj[prev_c:c].max()) if c > prev_c else 0
            right_pk = int(proj[c:next_c].max()) if next_c > c else 0
            min_pk = min(left_pk, right_pk)
            if min_pk == 0:
                if val > 2:
                    return False
            elif val > max(3, int(0.18 * min_pk)):
                return False
        return True

    row_proj_full = fg.sum(axis=1)
    if rows > 1:
        inner_y = _find_valley_cuts(row_proj_full[ry0:ry1], rows, ry1 - ry0, span_frac=0.30)
        y_cuts = [0] + [ry0 + c for c in inner_y[1:-1]] + [h]
        if not _cuts_are_deep_valleys(row_proj_full, y_cuts):
            return []
        for ri in range(rows):
            band_fg = int(fg[y_cuts[ri] : y_cuts[ri + 1], :].sum())
            if band_fg < max(120, int(0.12 * total_fg / rows)):
                return []
    else:
        y_cuts = [0, h]

    frames: list[Image.Image] = []
    valid_col_cuts_any = False
    for ri in range(rows):
        y0, y1 = y_cuts[ri], y_cuts[ri + 1]
        col_proj_band = fg[y0:y1, :].sum(axis=0)
        if cols > 1:
            inner_x = _find_valley_cuts(col_proj_band[rx0:rx1], cols, rx1 - rx0, span_frac=0.30)
            x_cuts = [0] + [rx0 + c for c in inner_x[1:-1]] + [w]
            if not _cuts_are_deep_valleys(col_proj_band, x_cuts):
                return []
            valid_col_cuts_any = True
        else:
            x_cuts = [0, w]
            valid_col_cuts_any = True
        for ci in range(cols):
            x0, x1 = x_cuts[ci], x_cuts[ci + 1]
            cell = keyed.crop((x0, y0, x1, y1))
            if int((np.array(cell)[:, :, 3] > 20).sum()) >= 120 and _has_visible_foreground(cell, 24):
                frames.append(_crop_tight(filter_isolated_noise(cell)))

    return frames if valid_col_cuts_any else []


def _extract_strip_frames(keyed: Image.Image, target_count: int) -> list[Image.Image]:
    """Extract frames from a layout-aware 1xN / Nx1 / 2x2 / 3x2 / 4x2 sprite strip, or [single_pose]."""
    w, h = keyed.size
    aspect = w / max(1.0, float(h))
    det = _detect_grid_layout(keyed)
    if det == "grid-8x11":
        return [keyed.crop((c * w // 8, 0, (c + 1) * w // 8, h // 11)) for c in range(min(8, target_count))]

    # Layout-aware valley slicing matching target_count (4x2/8x1, 3x2/6x1/5x1, 2x2/4x1, 3x1/1x3)
    candidates: list[tuple[int, int, int]] = []
    if target_count >= 8:
        candidates = [((8, 1, 6) if aspect >= 3.6 else (4, 2, 6))]
    elif target_count in (5, 6):
        candidates = [((target_count, 1, max(4, target_count - 1)) if aspect >= 2.6 else (3, 2, 4))]
    elif target_count == 4:
        candidates = [((4, 1, 3) if aspect >= 2.2 else (2, 2, 3))]
    elif target_count == 3:
        candidates = [((3, 1, 3) if aspect >= 1.15 else (1, 3, 3))]
    elif target_count == 2:
        candidates = [((2, 1, 2) if aspect >= 1.1 else (1, 2, 2))]

    for g_cols, g_rows, min_frames in candidates:
        sliced_grid = _slice_alpha_grid_valleys(keyed, g_cols, g_rows)
        if len(sliced_grid) >= min_frames:
            return sliced_grid

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
            raw_arr_in = np.array(loaded.rgba, dtype=np.uint8)
            _ist_m, _bg_m, _p90_m, bg_kind_m = _sample_border_background(raw_arr_in)
            frames: list[Image.Image] = []
            if bg_kind_m == "green" and layout == "codex-v2-8x11" and fw == CELL_W and fh == CELL_H:
                try:
                    asp_in = loaded.rgba.width / max(1.0, float(loaded.rgba.height))
                    if row in (1, 2) and active_n == 8:
                        g_c, g_r = (8, 1) if asp_in >= 3.6 else (4, 2)
                        frames = _split_run8_with_butterfly_sheet(loaded.rgba, "right" if row == 1 else "left", cols=g_c, rows=g_r)
                    elif is_hold_subrow:
                        g_c, g_r = (3, 1) if asp_in >= 1.15 else (1, 3)
                        frames = _slice_nonempty_green_sprites(loaded.rgba, g_c, g_r, purge_far_strays=True)
                    elif row == 4 and not is_hold_subrow:
                        g_c, g_r = (5, 1) if asp_in >= 2.6 else (3, 2)
                        frames = _slice_nonempty_green_sprites(loaded.rgba, g_c, g_r, purge_far_strays=True)
                    elif row == 7:
                        g_c, g_r = (6, 1) if asp_in >= 3.2 else (3, 2)
                        frames = _slice_nonempty_green_sprites(loaded.rgba, g_c, g_r, keep_pink_yarn=True, purge_far_strays=False)
                    elif active_n == 8:
                        g_c, g_r = (8, 1) if asp_in >= 3.6 else (4, 2)
                        frames = _slice_nonempty_green_sprites(loaded.rgba, g_c, g_r, purge_far_strays=True)
                    elif active_n == 6:
                        g_c, g_r = (6, 1) if asp_in >= 3.2 else (3, 2)
                        frames = _slice_nonempty_green_sprites(loaded.rgba, g_c, g_r, purge_far_strays=True)
                    elif active_n == 4:
                        g_c, g_r = (4, 1) if asp_in >= 2.2 else (2, 2)
                        frames = _slice_nonempty_green_sprites(loaded.rgba, g_c, g_r, purge_far_strays=True)
                except Exception:
                    frames = []

            if len(frames) < 2:
                keyed_multi = adaptive_remove_background(loaded.rgba, orig_path=orig_p, allow_multiple=True)
                if not _has_visible_foreground(keyed_multi):
                    raise SmartImportError("EMPTY_IMAGE", MSG_EMPTY_IMAGE)
                frames = _extract_strip_frames(keyed_multi, active_n)

            # Clear only the target sub-row columns on row 4 (so R04 preserves R04H and vice versa)
            clear_cols = target_cols if (layout == "codex-v2-8x11" and row == 4) else list(range(cols))
            for c_i in clear_cols:
                atlas.paste((0, 0, 0, 0), (c_i * fw, row * fh, (c_i + 1) * fw, (row + 1) * fh))

            asymmetric = bool(cfg.get("asymmetric", False))
            if len(frames) >= 2:
                is_std_8x11 = (layout == "codex-v2-8x11" and fw == CELL_W and fh == CELL_H)
                r00_anchor_cell = atlas.crop((0, 0, CELL_W, CELL_H)) if is_std_8x11 else None
                has_r00_anchor = bool(r00_anchor_cell is not None and _has_visible_foreground(r00_anchor_cell, min_pixels=24))
                r00_h_ref = float(_cell_bbox(r00_anchor_cell)[3] - _cell_bbox(r00_anchor_cell)[1]) if has_r00_anchor else 184.0
                r00_cx_ref = _measure_upper_neck_chest_cx(r00_anchor_cell) if has_r00_anchor else 96.0
                r00_skew_ref = _seated_haunch_skew_frac(r00_anchor_cell) if has_r00_anchor else 0.0

                if is_std_8x11 and row == 0:
                    # Dedicated R00 idle breathing/blink placement: align upper neck/chest and lock c1..c5 lower body to c0
                    sps0 = frames[:active_n]
                    new_r00_c0 = normalize_view_cell(sps0[0])
                    _x0, _y0, _x1, _y1 = _cell_bbox(new_r00_c0)
                    new_r00_h = max(48.0, float(_y1 - _y0))
                    new_r00_cx = _measure_upper_neck_chest_cx(new_r00_c0)
                    new_r00_skew = _seated_haunch_skew_frac(new_r00_c0)
                    if not asymmetric and abs(new_r00_skew) >= 0.05:
                        sps0 = [
                            sps0[0],
                            *[
                                (f.transpose(Image.Transpose.FLIP_LEFT_RIGHT) if (_seated_haunch_skew_frac(f) * new_r00_skew < 0.0 and abs(_seated_haunch_skew_frac(f)) >= 0.05) else f)
                                for f in sps0[1:]
                            ],
                        ]
                    sc_00 = min(new_r00_h / max(f.height for f in sps0), 166.0 / max(f.width for f in sps0))
                    locked_00: list[Image.Image] = [new_r00_c0]
                    for sp in sps0[1:]:
                        sc_sp = _scale_sprite_uniform(sp, sc_00, max_w=CELL_W - 4, max_h=CELL_H - 4)
                        sc_cx = _measure_upper_neck_chest_cx(sc_sp)
                        dx_0 = max(2, min(CELL_W - sc_sp.width - 2, round(new_r00_cx - sc_cx)))
                        dy_0 = max(2, min(CELL_H - sc_sp.height - 2, NORM_BOTTOM_EXCL - sc_sp.height))
                        placed0 = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
                        placed0.alpha_composite(sc_sp, (dx_0, dy_0))
                        locked_00.append(_composite_lower_body_lock(new_r00_c0, placed0, split_frac=0.54, band_half=10))
                    if len(locked_00) == 4 and active_n == 6:
                        b_in = _articulate_cell(new_r00_c0, angle_deg=0.4, sx=1.003, sy=0.996, head_dy=0.3, waist_frac=0.56, bottom_excl=200)
                        b_out = _articulate_cell(new_r00_c0, angle_deg=-0.3, sx=1.002, sy=0.998, head_dy=0.15, waist_frac=0.56, bottom_excl=200)
                        r00_final = [new_r00_c0, b_in, locked_00[1], locked_00[2], locked_00[3], b_out]
                        for c_i, tile in zip(target_cols, r00_final):
                            clear_and_put(row, c_i, tile)
                    else:
                        for idx_i, c_i in enumerate(target_cols):
                            src_i = min(len(locked_00) - 1, round(idx_i * (len(locked_00) - 1) / max(1, active_n - 1))) if len(locked_00) != active_n else idx_i
                            clear_and_put(row, c_i, locked_00[src_i])
                elif is_std_8x11 and is_hold_subrow:
                    # Preserve top-scruff anchor (top_y=14) and verify c6 < c5 < c7 pendulum ordering!
                    hold_placed: list[Image.Image] = []
                    for f in frames[:3]:
                        sc_h = min(184.0 / max(1, f.height), 130.0 / max(1, f.width))
                        hold_placed.append(
                            _place_in_cell_anchored(_scale_sprite_uniform(f, sc_h), bottom_excl=None, top_y=14, center_x=95.0, anchor_band="top")
                        )
                    while len(hold_placed) < 3:
                        hold_placed.append(hold_placed[-1])
                    def _l_cx(im_c: Image.Image) -> float:
                        ah = np.array(im_c)
                        _, xh = np.where(ah[95:, :, 3] > 20)
                        if len(xh) == 0:
                            _, xh = np.where(ah[:, :, 3] > 20)
                        return float(xh.mean()) if len(xh) else 95.0
                    lcxs = [_l_cx(hc) for hc in hold_placed]
                    if lcxs[1] + 1.5 < lcxs[0] < lcxs[2] - 1.5:
                        ordered_h = [hold_placed[0], hold_placed[1], hold_placed[2]]
                    else:
                        ord_i = np.argsort(lcxs).tolist()
                        c5_p, c6_l, c7_r = hold_placed[ord_i[1]], hold_placed[ord_i[0]], hold_placed[ord_i[2]]
                        if not (_l_cx(c6_l) + 2.0 < _l_cx(c5_p) < _l_cx(c7_r) - 2.0):
                            c6_l = _apply_pendulum_sway(c5_p, sway_deg=9.5)
                            c7_r = _apply_pendulum_sway(c5_p, sway_deg=-9.5)
                        ordered_h = [c5_p, c6_l, c7_r]
                    for c_i, tile in zip(target_cols, ordered_h):
                        clear_and_put(row, c_i, tile)
                elif is_std_8x11 and row == 4 and not is_hold_subrow:
                    # Preserve 5-stage jump airtime vertical arc!
                    sps = frames[:active_n]
                    sc_j = min(180.0 / max(f.width for f in sps), 184.0 / max(f.height for f in sps))
                    jump_bottoms = [199, 187, 178, 190, 199]
                    for idx_i, c_i in enumerate(target_cols):
                        src_i = min(len(sps) - 1, round(idx_i * (len(sps) - 1) / max(1, active_n - 1))) if len(sps) != active_n else idx_i
                        bot = jump_bottoms[idx_i] if idx_i < len(jump_bottoms) else 199
                        tile = _place_in_cell_anchored(_scale_sprite_uniform(sps[src_i], sc_j), bottom_excl=bot, center_x=96.0, anchor_band="full")
                        clear_and_put(row, c_i, tile)
                elif is_std_8x11 and row in (1, 2):
                    # Preserve butterfly & lively gallop vertical rhythm with outlier-resistant uniform scaling!
                    sps = frames[:active_n]
                    sc_r = _compute_run_row_scale(sps)
                    run_bots = [196, 193, 189, 188, 191, 193, 195, 196]
                    for idx_i, c_i in enumerate(target_cols):
                        src_i = min(len(sps) - 1, round(idx_i * (len(sps) - 1) / max(1, active_n - 1))) if len(sps) != active_n else idx_i
                        bot = run_bots[idx_i] if idx_i < len(run_bots) else 195
                        tile = _place_in_cell_anchored(_scale_sprite_uniform(sps[src_i], sc_r), bottom_excl=bot, center_x=96.0, anchor_band="cat_body_no_butterfly")
                        clear_and_put(row, c_i, tile)
                elif is_std_8x11 and row == 6:
                    # Dedicated R06 curled sleep/rest sizing matching _apply_ai_sheets_to_atlas
                    sps = frames[:active_n]
                    med_asp = float(np.median([f.width / max(1.0, float(f.height)) for f in sps]))
                    max_h_target = 136.0 if med_asp >= 1.15 else 168.0
                    sc_06 = min(176.0 / max(f.width for f in sps), max_h_target / max(f.height for f in sps))
                    placed_06 = [
                        _place_in_cell_anchored(_scale_sprite_uniform(sp, sc_06), bottom_excl=199, center_x=96.0, anchor_band="full")
                        for sp in sps
                    ]
                    if len(placed_06) == 4 and active_n == 6:
                        r06_final = _expand_4_to_6_smooth(placed_06, bottom_excl=199)
                        for c_i, tile in zip(target_cols, r06_final):
                            clear_and_put(row, c_i, tile)
                    else:
                        for idx_i, c_i in enumerate(target_cols):
                            src_i = min(len(placed_06) - 1, round(idx_i * (len(placed_06) - 1) / max(1, active_n - 1))) if len(placed_06) != active_n else idx_i
                            clear_and_put(row, c_i, placed_06[src_i])
                elif is_std_8x11 and row == 7:
                    sps = frames[:active_n]
                    sc_y = min(186.0 / max(f.width for f in sps), 158.0 / max(f.height for f in sps))
                    for idx_i, c_i in enumerate(target_cols):
                        src_i = min(len(sps) - 1, round(idx_i * (len(sps) - 1) / max(1, active_n - 1))) if len(sps) != active_n else idx_i
                        tile = _place_in_cell_anchored(_scale_sprite_uniform(sps[src_i], sc_y), bottom_excl=NORM_BOTTOM_EXCL, center_x=98.0, anchor_band="yarn_cat_body")
                        clear_and_put(row, c_i, tile)
                elif is_std_8x11 and row in (3, 5, 8, 9, 10) and has_r00_anchor and r00_anchor_cell is not None:
                    sps = frames[:active_n]
                    if row in (3, 8) and not asymmetric and abs(r00_skew_ref) >= 0.05:
                        sps = [
                            (f.transpose(Image.Transpose.FLIP_LEFT_RIGHT) if (_seated_haunch_skew_frac(f) * r00_skew_ref < 0.0 and abs(_seated_haunch_skew_frac(f)) >= 0.05) else f)
                            for f in sps
                        ]
                    sc_s = min(r00_h_ref / max(f.height for f in sps), 166.0 / max(f.width for f in sps))
                    q_bub_edit = _load_or_draw_question_bubble() if row == 5 else None
                    for idx_i, c_i in enumerate(target_cols):
                        src_i = min(len(sps) - 1, round(idx_i * (len(sps) - 1) / max(1, active_n - 1))) if len(sps) != active_n else idx_i
                        sc_sp = _scale_sprite_uniform(sps[src_i], sc_s, max_w=CELL_W - 4, max_h=CELL_H - 4)
                        sc_cx = _measure_upper_neck_chest_cx(sc_sp)
                        dx_s = max(2, min(CELL_W - sc_sp.width - 2, round(r00_cx_ref - sc_cx)))
                        dy_s = max(2, min(CELL_H - sc_sp.height - 2, NORM_BOTTOM_EXCL - sc_sp.height))
                        placed = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
                        placed.alpha_composite(sc_sp, (dx_s, dy_s))
                        is_bowed = (row == 8) or (row == 9 and c_i >= 6) or (row == 10 and c_i <= 2)
                        tile = _composite_lower_body_lock(
                            r00_anchor_cell,
                            placed,
                            split_frac=0.57 if is_bowed else 0.53,
                            band_half=10,
                            allow_right_nose=(row == 9),
                            allow_left_nose=(row == 10),
                        )
                        if row == 5 and c_i in (3, 4, 7) and q_bub_edit is not None and not _has_upper_right_bubble(tile):
                            tile = _overlay_bubble_smart(tile, q_bub_edit, prefer_xy=(135, 12), x_range=(126, 143), y_range=(6, 22))
                        clear_and_put(row, c_i, tile)
                else:
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
                            _resize_rgba_clean(f, (nw, nh)),
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
                    hold_cell=pose_cell if is_hold_subrow else None,
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
