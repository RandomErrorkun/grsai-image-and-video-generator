# -*- coding: utf-8 -*-
"""Dump reference answers straight from the source project, as fixtures for the rewrite's tests.

Usage:
    <source python> -B scripts/dump_source_parity.py <source project dir> <output json>

Example:
    E:/ai/Grsai-Banana-dev/.pixi/envs/default/python.exe -B scripts/dump_source_parity.py \
        E:/ai/Grsai-Banana-dev src/core/__fixtures__/source_parity.json

The output is compared against the rewrite by src/core/sourceParity.test.ts. Re-run it
after adding models to both projects.

The source project stays read-only: the script switches to a throwaway temp working
directory before importing anything, writes no bytecode, and never reads a real config
file or API key. No network call is made, only pure functions are exercised.
"""
import json
import ntpath
import os
import sys
import tempfile

SOURCE_DIR = sys.argv[1]
OUT_PATH = sys.argv[2]

os.chdir(tempfile.mkdtemp(prefix="grsai_parity_"))
sys.dont_write_bytecode = True
sys.path.insert(0, SOURCE_DIR)

from core import comic_planner  # noqa: E402
from core.api_client import ApiClient  # noqa: E402
from core.comic_project_manager import _normalize_project_name  # noqa: E402
from core.config import Config  # noqa: E402
from core.model_catalog import BANANA_PRO_MODELS, GPT_IMAGE_MODELS, VIDEO_MODELS  # noqa: E402
from core.task_manager import _extension_for_url  # noqa: E402

out = {}


def error_of(callable_):
    """Run something that may raise and describe what happened."""
    try:
        return {"ok": callable_()}
    except Exception as error:  # noqa: BLE001 - the error itself is the answer we want
        return {"error": type(error).__name__, "message": str(error)}


# --- 1. request payloads: every model plus the clamps and fallbacks -------------------
api = ApiClient()
models = list(BANANA_PRO_MODELS) + list(GPT_IMAGE_MODELS) + list(VIDEO_MODELS)
models += ["gpt-image-1.5", "gemini-2.5-flash-image", "sora-2", "veo3.1-fast-1080p", "no-such-model"]
payload_cases = []
for model in models:
    payload_cases.append({"prompt": "p", "model": model})
for model in models:
    payload_cases.append({
        "prompt": "p", "model": model, "aspect_ratio": "", "image_size": "bogus",
        "quality": "bogus", "background": "transparent", "output_format": "svg",
        "duration": "x", "seed": None, "ref_image_urls": ["u1"], "ref_audios": ["a1"],
        "first_frame": "f", "last_frame": None, "ref_videos": None,
    })
payload_cases += [
    {"prompt": "p", "model": "nano-banana-pro", "aspect_ratio": "1:1", "image_size": "4K", "ref_image_urls": []},
    {"prompt": "p", "model": "nano-banana-2-4k-cl", "aspect_ratio": None, "image_size": None},
    {"prompt": "p", "model": "gpt-image-2.5-sunburst", "aspect_ratio": "9:21", "image_size": "1536x1536",
     "quality": "xhigh", "background": "transparent", "output_format": None},
    {"prompt": "p", "model": "gpt-image-2.6", "output_format": "svg", "background": None},
    {"prompt": "p", "model": "gpt-image-2.6-sunburst", "output_format": "png"},
    {"prompt": "p", "model": "gpt-image-2-vip", "quality": "high", "background": "opaque"},
    {"prompt": "p", "model": "minimax-h3", "aspect_ratio": "portrait", "image_size": "1080p",
     "duration": 20, "seed": 42, "ref_image_urls": None, "ref_audios": None},
    {"prompt": "p", "model": "minimax-h3", "aspect_ratio": "bad", "image_size": "bad",
     "duration": 0, "seed": "007", "first_frame": "ff", "last_frame": "lf"},
    {"prompt": "p", "model": "wan-3.0", "aspect_ratio": "21:9", "image_size": "1080p",
     "duration": 99, "seed": -5, "ref_image_urls": ["i"], "ref_audios": ["a"],
     "first_frame": "ff", "last_frame": None, "ref_videos": None},
    {"prompt": "p", "model": "agnes-video-2.5", "aspect_ratio": "9:16", "image_size": "2k",
     "duration": 1, "seed": 3.9, "ref_videos": ["v"], "first_frame": None, "last_frame": "lf"},
    {"prompt": "p", "model": "wan-3.0", "duration": 7.9, "seed": None},
    {"prompt": "p", "model": "no-such-model", "aspect_ratio": "1:1"},
]
out["payloads"] = [{"params": case, "payload": api.build_generate_payload(**case)} for case in payload_cases]

# --- 2. config migration ---------------------------------------------------------------
old_configs = [
    {},
    {"last_aspect_ratio": "16:9", "last_image_size": "2K",
     "api_base_url": "https://generativelanguage.googleapis.com/v1",
     "last_model": "gpt-image-1.5", "comic_image_model": "gemini-2.5-flash-image",
     "last_model_Banana 1": "sora-image", "last_tab": "Banana 1",
     "last_model_tab_banana_1": "gpt-image-1.5"},
    {"last_tab": "banana_1", "last_model_tab_banana_1": "nano-banana-pro",
     "last_model_tab_banana_pro": "nano-banana-2", "last_model_Banana Pro": "sora-image",
     "last_model_GPT Image": "x", "last_model_other": "gpt-image-1.5"},
    {"last_tab": "GPT Image", "last_model_x": "nano-banana", "extra_key": 1, "max_retries": 9,
     "theme": None, "last_model": 7, "comic_image_model": None},
    {"last_tab": "Banana Pro", "api_base_url": None},
    {"last_tab": "Banana Pro", "api_base_url": "https://grsai.dakka.com.cn"},
    {"last_model": ["unhashable"]},
    {"last_tab": ["unhashable"]},
    ["not", "a", "dict"],
    {"last_model_tab_banana_1": {"un": "hashable"}, "last_tab": "banana_1"},
]
migrator = object.__new__(Config)
out["config_migration"] = [
    {"old": old, "result": error_of(lambda old=old: migrator._migrate_config(old))}
    for old in old_configs
]

# --- 3. comic planning messages and plan parsing ----------------------------------------
with open("ref_one.png", "wb") as handle:
    handle.write(b"\x89PNG fake")
with open("ref_two.PNG", "wb") as handle:
    handle.write(b"\x89PNG fake")

original_get_language = comic_planner.get_language
comic_planner.get_language = lambda: "en"
out["planning_messages"] = [error_of(lambda: comic_planner.build_planning_messages(
    "  A lonely lighthouse keeper  ", "", 3, []))]
out["planning_messages"].append(error_of(lambda: comic_planner.build_planning_messages(
    "Story\nlines", "  ink wash  ", 5, ["ref_one.png", "missing.png", "ref_two.PNG"])))
comic_planner.get_language = lambda: "zh"
out["planning_messages"].append(error_of(lambda: comic_planner.build_planning_messages(
    "故事", "水墨", 4, ["ref_two.PNG"])))
comic_planner.get_language = original_get_language

plan_contents = [
    '```json\n{"title": " 灯塔 ", "style_notes": "水彩", "pages": [{"page_number": 1, "title": "T", '
    '"story_beat": "S", "narration": "", "dialogue": ["A: hi", "  ", 3], "scene_description": "sea", '
    '"camera_direction": "wide", "panel_layout": "3 panels", "reference_targets": [1, 2, 2, 9], '
    '"image_prompt": " full prompt "}, {"title": "Second", "dialogue": "- a\\n• b\\n\\nc", '
    '"reference_targets": "1，3"}]}\n```',
    'Here you go: {"pages": [{"page_number": "4", "image_prompt": "x"}], "style_notes": null} hope it helps',
    '{"pages": []}',
    '{"pages": "oops"}',
    '[]',
    '',
    'no json at all',
    '{"pages": [1, "two", null], "title": "Only bad pages"}',
    '{"pages": [{"page_number": "x", "image_prompt": "y"}]}',
]
out["comic_plans"] = [
    {"content": content, "page_count": 3, "reference_count": 4,
     "result": error_of(lambda c=content: comic_planner.parse_comic_plan(c, 3, 4))}
    for content in plan_contents
]

# --- 4. small helpers -------------------------------------------------------------------
urls = [
    "https://x/a.PNG", "https://x/a.b.jpg?sig=1&x=2", "https://x/v.mp4?token=.png", "https://x/noext",
    "https://x/archive.tar.gz", "https://x/.webp", "https://x/clip.MOV#frag", None, "",
]
out["extension_for_url"] = [
    {"url": url, "default": default, "result": _extension_for_url(url, default)}
    for url in urls for default in ("png", "mp4")
]

names = ["My Comic", "  a/b:c*d?e|f\\g<h>i\"j  ", "...name...", "。。", "   ", "", None, "A  B\tC\nD", "_._x_._"]
out["normalize_project_name"] = [{"name": name, "result": _normalize_project_name(name)} for name in names]

base = r"C:\Users\someone\Grsai Banana"
path_cases = ["output", ".\\output", "output\\..\\input", "..\\..\\x", "C:\\other\\y", "", "a//b/./c"]
out["ntpath"] = {
    "join": [{"parts": parts, "result": ntpath.join(*parts)} for parts in
             [[base, "output"], [base, "", "pages"], ["C:\\abs", "rel", "D:\\z"], [base, "x"], ["", "y"]]],
    "absolute": [{"base": base, "path": case, "result": ntpath.abspath(ntpath.join(base, case))}
                 for case in path_cases],
    "relative": [{"from": frm, "to": to, "result": error_of(lambda f=frm, t=to: ntpath.relpath(t, f))}
                 for frm, to in [
                     (base, base + r"\project\pages\a.png"),
                     (base + r"\project", base + r"\project\reference_images\ref_01.png"),
                     (base + r"\project\pages", base + r"\project"),
                     (base + r"\project\pages", base + r"\other\b.png"),
                     (base + r"\a\b\c", base + r"\a\x"),
                     (base, base),
                     (base, r"D:\elsewhere"),
                 ]],
    "splitext": [{"path": case, "result": list(ntpath.splitext(case))} for case in
                 [base + r"\ref_01.PNG", base + r"\.hidden", base + r"\dir.d\file", base + r"\noext",
                  base + r"\trailing.", "archive.tar.gz"]],
    "basename": [{"path": case, "result": ntpath.basename(case)} for case in
                 [base + r"\a.png", base + r"\dir\\", "plain.png", base + r"\\", r"C:\name.exe"]],
}

values = [None, True, False, 0, 1, -3, 2.5, 10000000000000000.0, "a b", "", [1, "a", None],
          {"k": "v", "n": None, "b": True, "list": [1, 2]}]
out["py_str"] = [{"value": value, "result": str(value)} for value in values]
int_inputs = [None, True, False, 5, 5.9, -5.9, 0.0, "7", " 8 ", "+6", "-2", "3.5", "abc", "", 1000.0, "0x10", "１２"]
out["py_int"] = [{"value": value, "result": error_of(lambda v=value: int(v))} for value in int_inputs]
out["py_splitlines"] = "a\r\nb\nc\rd\x0be\x0cf\x1cg\x85h\u2028i\u2029j".splitlines()
out["py_strip"] = [
    {"text": "  - item one  ", "result": "  - item one  ".strip().lstrip("-").lstrip("\u2022").strip()},
    {"text": "--\u2022- two ", "result": "--\u2022- two ".strip().lstrip("-").lstrip("\u2022").strip()},
]

with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(out, handle, ensure_ascii=False, indent=2)
    handle.write("\n")

print("payloads:", len(out["payloads"]), "| migrations:", len(out["config_migration"]),
      "| plans:", len(out["comic_plans"]))
