"""Fetch SAC route JSON without Playwright.

Replaces Phase 1 (browser scraping) of the SAC extraction workflow with a
direct authenticated HTTP request. The SAC route portal exposes its route
data as a TYPO3 page-type response at the same URL as the human page, with
`?type=1567765346410`. With a valid `fe_typo_user` session cookie the server
returns JSON instead of the HTML login wall.

Cookie loading order:
  1. ``--cookie-file PATH`` (explicit override)
  2. ``$SAC_COOKIE`` environment variable
  3. ``~/.config/sac-hikes/cookie`` (default; written by ``--save-cookie``)

The cookie can be either the raw value of ``fe_typo_user`` or a complete
``Cookie:`` header line (e.g. ``fe_typo_user=...; other=...``). Anything
without an ``=`` is treated as the raw ``fe_typo_user`` value.

Setup (one-time, per user)
--------------------------
1. Log in at https://www.sac-cas.ch in your browser
2. Open DevTools → Application/Storage → Cookies → www.sac-cas.ch
3. Copy the value of ``fe_typo_user``
4. Save it once:

       python scripts/fetch_sac_route.py --save-cookie '<value>'

   The script writes ``~/.config/sac-hikes/cookie`` (mode 0600). Future
   invocations pick it up automatically — no env var needed. Refresh by
   re-running ``--save-cookie`` when the session expires (typically a few
   days). You can also pipe the value in: ``... --save-cookie -``.

Usage
-----
    # Fetch JSON only
    python scripts/fetch_sac_route.py \\
        --url 'https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/zindlenspitz-2260/mountain-hiking/bruennelistock-rossaelplispitz-and-zindlenspitz-4567/' \\
        --slug zindlenspitz

    # Also resolve the peak hero image URL
    python scripts/fetch_sac_route.py --url ... --slug ... --peak-hero

    # Chain into the full extraction pipeline (replaces Playwright entirely)
    python scripts/fetch_sac_route.py --url ... --slug ... --peak-hero --extract --render
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Default place to stash the session cookie. XDG-compliant per-user state —
# not synced via dotfiles (cookies are per-machine and expire).
DEFAULT_COOKIE_FILE = Path.home() / ".config" / "sac-hikes" / "cookie"

# TYPO3 pageType that switches the route page to its JSON representation.
JSON_TYPE_PARAM = "1567765346410"

# 32-hex TYPO3 cache hash. Some installations require it on cacheable URLs;
# we scrape it from the page HTML if the first attempt comes back as HTML.
# The hash appears in the login-redirect URL, which is double-URL-encoded, so
# the literal `=` shows up as `%3D` (and could escalate further on retry).
_CHASH_RE = re.compile(r"cHash(?:=|%3D|%253D)([a-f0-9]{32})", re.IGNORECASE)

_TEASER_BLOCK_RE = re.compile(
    r'class="[^"]*c-teaser-destination__image[^"]*"(.*?)</',
    re.DOTALL,
)
_SRCSET_RE = re.compile(r'srcset="([^"]+)"')
_SRC_RE = re.compile(r'\bsrc="([^"]+)"')


def _load_cookie(env_name: str, cookie_file: Path | None) -> str:
    """Resolve the cookie from --cookie-file, $ENV, or the default file (in that order)."""
    sources_tried: list[str] = []

    if cookie_file:
        if not cookie_file.exists():
            sys.exit(f"ERROR: cookie file does not exist: {cookie_file}")
        cookie = cookie_file.read_text(encoding="utf-8").strip()
        sources_tried.append(str(cookie_file))
    else:
        cookie = os.environ.get(env_name, "").strip()
        sources_tried.append(f"${env_name}")
        if not cookie and DEFAULT_COOKIE_FILE.exists():
            cookie = DEFAULT_COOKIE_FILE.read_text(encoding="utf-8").strip()
            sources_tried.append(str(DEFAULT_COOKIE_FILE))

    if not cookie:
        sys.exit(
            f"ERROR: no cookie found (tried: {', '.join(sources_tried)}).\n\n"
            "Get your cookie:\n"
            "  1. Log in at https://www.sac-cas.ch\n"
            "  2. Open DevTools → Application → Cookies → www.sac-cas.ch\n"
            "  3. Copy the value of `fe_typo_user`\n\n"
            "Save it (writes ~/.config/sac-hikes/cookie, 0600):\n"
            "    python scripts/fetch_sac_route.py --save-cookie '<value>'\n"
            "or pipe it in: pbpaste | python scripts/fetch_sac_route.py --save-cookie -\n"
        )
    if "=" not in cookie:
        cookie = f"fe_typo_user={cookie}"
    return cookie


def save_cookie(value: str, target: Path | None = None) -> Path:
    """Persist a cookie (or cookies) to ``target`` (default: ``DEFAULT_COOKIE_FILE``).

    Accepted shapes (sniffed in this order):
      1. Cookie-Editor "Export → JSON" — a JSON array of ``{name, value, ...}``
         objects. Reassembled into a ``name1=value1; name2=value2`` header so
         multi-cookie auth (e.g. SAC sometimes needs ``__Secure-oidc_context``
         alongside ``fe_typo_user``) lands in one paste.
      2. A complete ``Cookie:`` header line (``name1=v1; name2=v2; …``). Kept
         as-is.
      3. A single ``name=value`` pair. Kept as-is.
      4. A raw value with no ``=``. Prefixed by the loader with ``fe_typo_user=``.

    Sets file mode 0600 where the filesystem supports it.
    """
    path = target or DEFAULT_COOKIE_FILE
    val = value.strip()
    if not val:
        sys.exit("ERROR: --save-cookie got an empty value.")

    # 1. JSON array (Cookie-Editor format).
    if val.startswith("["):
        try:
            parsed = json.loads(val)
        except json.JSONDecodeError as e:
            sys.exit(f"ERROR: value looked like JSON but didn't parse: {e}")
        if not isinstance(parsed, list):
            sys.exit("ERROR: JSON cookie input must be an array of cookie objects.")
        parts: list[str] = []
        for c in parsed:
            name = (c.get("name") or "").strip()
            cookie_value = (c.get("value") or "").strip()
            if name and cookie_value:
                parts.append(f"{name}={cookie_value}")
        if not parts:
            sys.exit("ERROR: JSON cookie input had no usable name/value pairs.")
        val = "; ".join(parts)

    # 2/3/4 fall through — store whatever we have. _load_cookie handles the
    # bare-value case by prefixing fe_typo_user= when there's no '=' present.
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(val + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def _add_query(url: str, **params: str) -> str:
    parts = urllib.parse.urlsplit(url)
    qs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    have = {k for k, _ in qs}
    for k, v in params.items():
        if k not in have:
            qs.append((k, v))
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(qs)))


def _extract_route_id(url: str) -> str:
    m = re.search(r"-(\d+)/?$", urllib.parse.urlsplit(url).path)
    if not m:
        sys.exit(f"ERROR: could not extract route ID from URL: {url}")
    return m.group(1)


def _derive_peak_url(route_url: str) -> str:
    """Strip the trailing route segment to get the peak page URL."""
    parts = urllib.parse.urlsplit(route_url)
    path = parts.path.rstrip("/")
    peak_path = path.rsplit("/", 1)[0] + "/"
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, peak_path, "", ""))


def _fetch(url: str, cookie: str, accept: str) -> tuple[int, bytes, str]:
    req = urllib.request.Request(url, headers={
        "Cookie": cookie,
        "User-Agent": "fetch_sac_route/1.0 (+https://github.com/roberthannah89/website)",
        "Accept": accept,
        "Accept-Language": "en-GB,en;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read(), resp.headers.get_content_type()
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get_content_type()


def _is_json_body(ctype: str, body: bytes) -> bool:
    if "json" in ctype:
        return True
    head = body.lstrip()[:1]
    return head in (b"{", b"[")


def fetch_route_json(route_url: str, cookie: str, out_dir: Path) -> Path:
    """Fetch the route JSON and save to ``out_dir/sac-route-<id>.json``."""
    route_id = _extract_route_id(route_url)
    json_url = _add_query(route_url, type=JSON_TYPE_PARAM)

    print(f"[fetch] GET {json_url}")
    status, body, ctype = _fetch(json_url, cookie, accept="application/json")

    # Retry with cHash if the server gave us HTML (likely the login wall or a
    # "cHash required" page). The cHash is embedded in the HTML response.
    if status == 200 and not _is_json_body(ctype, body):
        html = body.decode("utf-8", "replace")
        m = _CHASH_RE.search(html)
        if m:
            json_url_with_hash = _add_query(json_url, cHash=m.group(1))
            print(f"[fetch] HTML returned; retrying with cHash={m.group(1)[:8]}…")
            status, body, ctype = _fetch(json_url_with_hash, cookie, accept="application/json")

    if status != 200:
        sys.exit(f"ERROR: HTTP {status} from {json_url}\n{body[:300]!r}")

    if not _is_json_body(ctype, body):
        head = body[:200].decode("utf-8", "replace").replace("\n", " ")
        sys.exit(
            f"ERROR: Expected JSON, got {ctype}.\n"
            "Likely causes:\n"
            "  - Cookie expired or invalid → re-copy fe_typo_user from your browser\n"
            "  - URL needs a cHash that isn't present in the page HTML → copy the\n"
            "    full JSON request URL from DevTools → Network and pass it as --url\n"
            f"Response head: {head!r}"
        )

    try:
        data = json.loads(body)
    except json.JSONDecodeError as e:
        sys.exit(f"ERROR: body claimed to be JSON but failed to parse: {e}")

    # Authentication can fail silently — the server returns valid JSON with
    # empty `segments`. The docs flag this explicitly as a sign of bad auth.
    if not data.get("segments"):
        sys.exit(
            "ERROR: JSON has no `segments` — the cookie probably isn't authenticated\n"
            "for this paid route. Verify you can view the page in your browser, then\n"
            "re-copy `fe_typo_user`."
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"sac-route-{route_id}.json"
    # Match the format produced by the Playwright capture: minified, no trailing newline.
    out_path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[fetch] Wrote {out_path}  ({out_path.stat().st_size // 1024} KB, "
          f"{len(data.get('segments', []))} segments)")
    return out_path


def _largest_from_srcset(srcset: str) -> str:
    entries: list[tuple[int, str]] = []
    for item in srcset.split(","):
        item = item.strip()
        if not item:
            continue
        parts = item.split()
        url = parts[0]
        width = 0
        if len(parts) > 1 and parts[1].endswith("w"):
            try:
                width = int(parts[1][:-1])
            except ValueError:
                pass
        entries.append((width, url))
    entries.sort(reverse=True)
    return entries[0][1] if entries else ""


def fetch_peak_hero(route_url: str, cookie: str) -> str | None:
    """Fetch the peak overview page and return the largest hero image URL."""
    peak_url = _derive_peak_url(route_url)
    print(f"[hero ] GET {peak_url}")
    status, body, _ = _fetch(peak_url, cookie, accept="text/html")
    if status != 200:
        print(f"  WARN: HTTP {status} fetching peak page", file=sys.stderr)
        return None

    html = body.decode("utf-8", "replace")
    candidates: list[str] = []
    for block in _TEASER_BLOCK_RE.findall(html):
        m_srcset = _SRCSET_RE.search(block)
        url = _largest_from_srcset(m_srcset.group(1)) if m_srcset else ""
        if not url:
            m_src = _SRC_RE.search(block)
            url = m_src.group(1) if m_src else ""
        if url and not url.startswith("data:"):
            candidates.append(url)

    if not candidates:
        print("  WARN: no .c-teaser-destination__image candidate found in HTML", file=sys.stderr)
        return None

    hero = candidates[0]
    if hero.startswith("/"):
        hero = "https://www.sac-cas.ch" + hero
    print(f"[hero ] {hero}")
    return hero


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--url", help="SAC route page URL (human-readable)")
    p.add_argument("--slug", help="Folder slug under routes/")
    p.add_argument("--cookie-env", default="SAC_COOKIE",
                   help="Env var holding the cookie (default: SAC_COOKIE)")
    p.add_argument("--cookie-file", type=Path,
                   help="File containing the cookie (overrides env var and default file)")
    p.add_argument("--save-cookie", metavar="VALUE",
                   help=f"Save cookie to {DEFAULT_COOKIE_FILE} (mode 0600) and exit. "
                        "Use '-' to read the value from stdin.")
    p.add_argument("--peak-hero", action="store_true",
                   help="Also fetch the peak page and resolve the hero image URL")
    p.add_argument("--extract", action="store_true",
                   help="Chain into scripts/extract_sac_route.py after fetching")
    # Pass-through args for --extract
    p.add_argument("--region", default="TODO")
    p.add_argument("--canton", default="TODO")
    p.add_argument("--render", action="store_true",
                   help="Forwarded to extract_sac_route.py when --extract is set")
    args = p.parse_args(argv)

    if args.save_cookie is not None:
        raw = sys.stdin.read() if args.save_cookie == "-" else args.save_cookie
        target = args.cookie_file or DEFAULT_COOKIE_FILE
        path = save_cookie(raw, target)
        print(f"[save ] Wrote cookie to {path} (mode 0600)")
        return 0

    if not args.url or not args.slug:
        p.error("--url and --slug are required (unless using --save-cookie)")

    cookie = _load_cookie(args.cookie_env, args.cookie_file)
    out_dir = REPO_ROOT / "routes" / args.slug
    json_path = fetch_route_json(args.url, cookie, out_dir)

    hero_url = fetch_peak_hero(args.url, cookie) if args.peak_hero else None

    if args.extract:
        cmd = [
            sys.executable, str(Path(__file__).parent / "extract_sac_route.py"),
            "--json", str(json_path),
            "--slug", args.slug,
            "--region", args.region,
            "--canton", args.canton,
            "--route-url", args.url,
        ]
        if hero_url:
            cmd += ["--peak-hero", hero_url]
        if args.render:
            cmd.append("--render")
        print(f"\n[chain] {' '.join(cmd)}")
        return subprocess.call(cmd, cwd=str(REPO_ROOT))

    rel = json_path.relative_to(REPO_ROOT)
    print("\nNext step:")
    print(f"  python scripts/extract_sac_route.py \\")
    print(f"    --json {rel} \\")
    print(f"    --slug {args.slug} \\")
    if hero_url:
        print(f"    --peak-hero '{hero_url}' \\")
    print(f"    --route-url '{args.url}' --render")
    return 0


if __name__ == "__main__":
    sys.exit(main())
