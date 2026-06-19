#!/usr/bin/env python3
"""Auto-generate docs/prototypes/index.html from proto-* meta tags.

Each prototype HTML file in docs/prototypes/ can declare these meta tags:
  <meta name="proto-title"  content="Display Title">
  <meta name="proto-icon"   content="&#x1F5FA;&#xFE0F;">
  <meta name="proto-desc"   content="One-line description">
  <meta name="proto-source" content="API / data source name">
  <meta name="proto-order"  content="10">

Files without proto-title are silently skipped.
"""

from __future__ import annotations

import subprocess
import sys
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

PROTO_DIR = Path(__file__).resolve().parent.parent / "docs" / "prototypes"
INDEX_PATH = PROTO_DIR / "index.html"


def _git_first_commit_epoch(path: Path) -> float:
    """Return epoch seconds of the first commit that introduced `path`, or 0 if unknown."""
    try:
        out = subprocess.run(
            ["git", "log", "--diff-filter=A", "--follow", "--format=%at", "--", str(path)],
            cwd=path.parent, capture_output=True, text=True, timeout=5, check=False,
        ).stdout.strip().splitlines()
        return float(out[-1]) if out else 0.0
    except (subprocess.SubprocessError, OSError, ValueError):
        return 0.0


def _creation_epoch(path: Path) -> float:
    """Best-effort creation timestamp: git first-commit date, else file mtime."""
    return _git_first_commit_epoch(path) or path.stat().st_mtime


class _ProtoMetaParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta: dict[str, str] = {}
        self._in_head = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
        if tag == "head":
            self._in_head = True
        if tag == "meta" and self._in_head:
            d = dict(attrs)
            name = d.get("name") or ""
            content = d.get("content")
            if name.startswith("proto-") and content:
                self.meta[name] = content

    def handle_endtag(self, tag: str):
        if tag == "head":
            self._in_head = False


SCREENSHOTS_DIR = PROTO_DIR / "screenshots"


def discover_prototypes() -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    for html_file in sorted(PROTO_DIR.glob("*.html")):
        if html_file.name == "index.html":
            continue
        parser = _ProtoMetaParser()
        parser.feed(html_file.read_text(encoding="utf-8"))
        m = parser.meta
        if "proto-title" not in m:
            continue
        slug = html_file.stem
        screenshot = SCREENSHOTS_DIR / f"{slug}.png"
        pages.append({
            "href": html_file.name,
            "title": m["proto-title"],
            "icon": m.get("proto-icon", "&#x1F9EA;"),
            "desc": m.get("proto-desc", ""),
            "source": m.get("proto-source", ""),
            "screenshot": f"screenshots/{slug}.png" if screenshot.exists() else "",
            "_order": int(m.get("proto-order", "999")),
            "_created": _creation_epoch(html_file),
        })
    # Newest first by creation date; proto-order is the tiebreaker for files
    # that landed in the same commit.
    pages.sort(key=lambda p: (-p["_created"], p["_order"]))
    return pages


def render_card(p: dict[str, Any]) -> str:
    thumb = ""
    if p["screenshot"]:
        thumb = (
            f'    <div class="card-thumb">\n'
            f'      <img src="{escape(p["screenshot"])}" alt="{escape(p["title"])}" loading="lazy">\n'
            f'    </div>\n'
        )
    return (
        f'  <a class="card" href="{escape(p["href"])}">\n'
        f'{thumb}'
        f'    <div class="card-body">\n'
        f'      <div class="card-header">\n'
        f'        <span class="card-icon">{p["icon"]}</span>\n'
        f'        <span class="card-title">{escape(p["title"])}</span>\n'
        f'      </div>\n'
        f'      <div class="card-desc">{escape(p["desc"])}</div>\n'
        f'      <span class="card-source">{escape(p["source"])}</span>\n'
        f'    </div>\n'
        f'  </a>'
    )


# Long asset URLs hoisted out of TEMPLATE so the multi-line template string
# stays within the 120-char line-length budget.
_FONTS_HREF = (
    "https://fonts.googleapis.com/css2"
    "?family=Familjen+Grotesk:wght@400;600;700"
    "&family=IBM+Plex+Mono:wght@400;500;600"
    "&display=swap"
)
_NOISE_SVG_URL = (
    "data:image/svg+xml,"
    "%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E"
    "%3Cfilter id='n'%3E"
    "%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4'"
    " stitchTiles='stitch'/%3E"
    "%3C/filter%3E"
    "%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E"
    "%3C/svg%3E"
)


TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>API Prototypes</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="{fonts_href}" rel="stylesheet">
<style>
  :root {{
    --board-bg: #1a1810;
    --board-surface: #242118;
    --flap-bg: #2c2820;
    --flap-border: #3a3428;
    --amber: #e8a832;
    --amber-dim: #b8862a;
    --amber-glow: #e8a83240;
    --text-primary: #f0e8d8;
    --text-secondary: #a89878;
    --text-muted: #786848;
    --font-display: 'Familjen Grotesk', system-ui, sans-serif;
    --font-mono: 'IBM Plex Mono', 'Courier New', monospace;
  }}

  * {{ margin: 0; padding: 0; box-sizing: border-box; }}

  html, body {{
    min-height: 100%;
    background: var(--board-bg);
    color: var(--text-primary);
    font-family: var(--font-display);
  }}

  /* Noise overlay */
  body::before {{
    content: '';
    position: fixed;
    inset: 0;
    background: url("{noise_svg_url}");
    pointer-events: none;
    z-index: 10000;
  }}

  /* Title bar */
  .title-bar {{
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 24px;
    background: var(--board-surface);
    border-bottom: 2px solid var(--flap-border);
    position: sticky;
    top: 0;
    z-index: 1000;
  }}

  .title-icon {{
    width: 42px;
    height: 42px;
    background: var(--amber);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    flex-shrink: 0;
    box-shadow: 0 2px 12px var(--amber-glow);
  }}

  .title-text h1 {{
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: 0.5px;
  }}

  .title-text p {{
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
    letter-spacing: 0.3px;
  }}

  .title-count {{
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
    background: var(--flap-bg);
    border: 1px solid var(--flap-border);
    padding: 4px 10px;
    border-radius: 4px;
  }}

  /* Card grid */
  .grid {{
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 20px;
    padding: 24px;
    max-width: 1200px;
    margin: 0 auto;
  }}

  @media (max-width: 700px) {{
    .grid {{ grid-template-columns: 1fr; padding: 16px; }}
  }}

  /* Card */
  .card {{
    background: var(--flap-bg);
    border: 1px solid var(--flap-border);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s;
    text-decoration: none;
    color: inherit;
    cursor: pointer;
  }}

  .card:hover {{
    border-color: var(--amber-dim);
    box-shadow: 0 4px 24px rgba(232, 168, 50, 0.1);
    transform: translateY(-2px);
  }}

  .card-thumb {{
    width: 100%;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    background: var(--board-surface);
    border-bottom: 1px solid var(--flap-border);
  }}

  .card-thumb img {{
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top;
    display: block;
    filter: brightness(0.92) contrast(1.02);
    transition: transform 0.4s ease;
  }}

  .card:hover .card-thumb img {{
    transform: scale(1.03);
  }}

  .card-body {{
    padding: 16px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
  }}

  .card-header {{
    display: flex;
    align-items: center;
    gap: 12px;
  }}

  .card-icon {{
    font-size: 28px;
    line-height: 1;
    flex-shrink: 0;
  }}

  .card-title {{
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-primary);
  }}

  .card-desc {{
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
    flex: 1;
  }}

  .card-source {{
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    color: var(--amber);
    background: rgba(232, 168, 50, 0.12);
    padding: 3px 8px;
    border-radius: 4px;
    align-self: flex-start;
    letter-spacing: 0.3px;
  }}

  /* Footer */
  .footer {{
    text-align: center;
    padding: 24px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    border-top: 1px solid var(--flap-border);
    max-width: 1200px;
    margin: 16px auto 0;
  }}

  .footer a {{
    color: var(--amber);
    text-decoration: none;
  }}

  .footer a:hover {{
    text-decoration: underline;
  }}
</style>
</head>
<body>

<!-- Title bar -->
<div class="title-bar">
  <div class="title-icon">&#x1F9EA;</div>
  <div class="title-text">
    <h1>API Prototypes</h1>
    <p>Swiss hiking data &amp; weather layers</p>
  </div>
  <span class="title-count">{count} demos</span>
</div>

<!-- Card grid -->
<div class="grid">

{cards}

</div>

<!-- Footer -->
<div class="footer">
  Full API documentation: <a href="../APIS.md">docs/APIS.md</a>
</div>

</body>
</html>
"""


def main() -> None:
    protos = discover_prototypes()
    if not protos:
        print("No prototypes found with proto-* meta tags.", file=sys.stderr)
        sys.exit(1)

    cards = "\n\n".join(render_card(p) for p in protos)
    html = TEMPLATE.format(
        count=len(protos),
        cards=cards,
        fonts_href=_FONTS_HREF,
        noise_svg_url=_NOISE_SVG_URL,
    )
    INDEX_PATH.write_text(html, encoding="utf-8")
    print(f"Generated {INDEX_PATH.name} with {len(protos)} prototypes")


if __name__ == "__main__":
    main()
