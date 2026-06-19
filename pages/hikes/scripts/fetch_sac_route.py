"""Shared SAC session-cookie helpers + ``--save-cookie`` CLI.

This module is the single home for the SAC cookie loader/saver used by the v2
pipeline. The SAC route portal retired its monolithic JSON endpoint between
2026-05-22 and 2026-06-01, so the original v1 fetcher that lived here has been
removed. New hikes use ``fetch_sac_route_v2.py`` + ``scrape_sac_route_page.py``
(orchestrated by ``add_sac_hike_v2.py``), all of which import the cookie
helpers below.

Public surface
--------------
- ``DEFAULT_COOKIE_FILE`` — ``~/.config/sac-hikes/cookie`` (XDG-style per-user
  state; not synced via dotfiles, since cookies are per-machine and expire).
- ``_load_cookie(env_name, cookie_file)`` — resolves the cookie from
  ``--cookie-file`` / ``$ENV`` / ``DEFAULT_COOKIE_FILE`` in that order.
- ``save_cookie(value, target=None)`` — persists a cookie (raw value, header
  line, or Cookie-Editor JSON export) at mode 0600.
- ``main()`` — the ``--save-cookie`` CLI used by the Cookie-Editor workflow.

Cookie loading order:
  1. ``--cookie-file PATH`` (explicit override)
  2. ``$SAC_COOKIE`` environment variable
  3. ``~/.config/sac-hikes/cookie`` (default; written by ``--save-cookie``)

The cookie can be either the raw value of ``fe_typo_user``, a complete
``Cookie:`` header line (e.g. ``fe_typo_user=...; other=...``), or a JSON
array exported by the Chrome Cookie-Editor extension. ``--save-cookie``
auto-detects the JSON array form and reassembles a ``name=value; …``
header. Anything without an ``=`` is treated as the raw ``fe_typo_user``
value at load time.

Refreshing the cookie (Cookie-Editor workflow)
----------------------------------------------
1. Log in at https://www.sac-cas.ch in Chrome.
2. Click the Cookie-Editor toolbar icon → Export → Export as JSON.
3. Save the clipboard contents:

       pbpaste | python scripts/fetch_sac_route.py --save-cookie -

   The script writes ``~/.config/sac-hikes/cookie`` (mode 0600). Future
   scrapes pick the cookie up automatically — no env var needed.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
from pathlib import Path

# Default place to stash the session cookie. XDG-compliant per-user state —
# not synced via dotfiles (cookies are per-machine and expire).
DEFAULT_COOKIE_FILE = Path.home() / ".config" / "sac-hikes" / "cookie"


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
            "Refresh your SAC cookie:\n"
            "  1. Log in at https://www.sac-cas.ch in Chrome\n"
            "  2. Install the Cookie-Editor extension if you haven't already\n"
            "  3. Click Cookie-Editor → Export → Export as JSON (copies to clipboard)\n"
            "  4. Pipe it in to save (~/.config/sac-hikes/cookie, mode 0600):\n"
            "       pbpaste | python scripts/fetch_sac_route.py --save-cookie -\n\n"
            "Or pass the raw fe_typo_user value directly:\n"
            "    python scripts/fetch_sac_route.py --save-cookie '<value>'\n"
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
    with contextlib.suppress(OSError):
        path.chmod(0o600)
    return path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=(__doc__ or "").splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--save-cookie",
        metavar="VALUE",
        required=True,
        help=(
            f"Save cookie to {DEFAULT_COOKIE_FILE} (mode 0600) and exit. "
            "Use '-' to read the value from stdin."
        ),
    )
    args = p.parse_args(argv)

    raw = sys.stdin.read() if args.save_cookie == "-" else args.save_cookie
    path = save_cookie(raw)
    print(f"[save ] Wrote cookie to {path} (mode 0600)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
