"""Headless (or headed) SAC login: refresh ``~/.config/sac-hikes/cookie`` in one command.

Replaces the manual DevTools-copy step. SAC login is OAuth/OIDC against
``portal.sac-cas.ch``; this script drives Playwright Chromium through the
flow, then reads ``fe_typo_user`` from the browser's cookie store and saves
it via the existing ``save_cookie()`` helper in ``fetch_sac_route.py`` —
so the on-disk location is unchanged and the fetcher keeps working as-is.

Modes
-----
``--save-credentials``
    Persist credentials to ``~/.config/sac-hikes/credentials`` (mode 0600),
    then exit. Use this once. Prompts interactively when no flags are given.

default (no flags)
    Headless login. Requires credentials (flags, env, or saved file).

``--headed``
    Open a visible Chromium window at the login page. You type credentials
    (and handle any MFA/captcha) manually. The script polls cookies and
    saves as soon as ``fe_typo_user`` appears. No stored creds needed.

Credential loading order
------------------------
1. ``--username`` / ``--password`` flags
2. ``$SAC_USERNAME`` / ``$SAC_PASSWORD`` environment variables
3. ``~/.config/sac-hikes/credentials`` (two lines: username, password)

Storage
-------
Credentials and the cookie file both live under ``~/.config/sac-hikes/``
(mode 0600) — outside this repo. Nothing this script writes ends up in
``git status``.
"""
from __future__ import annotations

import argparse
import getpass
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_sac_route import DEFAULT_COOKIE_FILE, save_cookie  # noqa: E402

DEFAULT_CREDENTIALS_FILE = Path.home() / ".config" / "sac-hikes" / "credentials"

# Persistent Chromium profile dir for --persist mode. XDG cache convention:
# regenerable, per-machine, not synced. First login is interactive; cookies
# survive on disk so subsequent invocations refresh in 3-5 seconds without
# any human interaction.
DEFAULT_PROFILE_DIR = Path.home() / ".cache" / "sac-hikes" / "chromium-profile"

SAC_LOGIN_URL = "https://www.sac-cas.ch/en/login/"
SAC_HOME_URL = "https://www.sac-cas.ch/"

# Conservative deadlines. Headless: each step should be sub-second; 60s
# is "something is wrong, bail out." Headed: a human types credentials,
# possibly handles MFA, so allow 5 minutes.
DEFAULT_HEADLESS_TIMEOUT_S = 60
DEFAULT_HEADED_TIMEOUT_S = 300

# Selectors for the OAuth login form on portal.sac-cas.ch.
# Observed (2026-06): a Rails Devise-style form at
# https://portal.sac-cas.ch/de/users/sign_in?oauth=true with
#   #person_login_identity, #person_password, button[type="submit"]
# The generic fallbacks below cover the more common email-style template if
# SAC ever swaps the auth backend; `--headed` is the ultimate escape.
_USERNAME_SELECTORS = [
    '#person_login_identity',
    'input[name="person[login_identity]"]',
    'input[type="email"]',
    'input[name="username"]',
    'input[name="email"]',
    'input[autocomplete="username"]',
]
_PASSWORD_SELECTORS = [
    '#person_password',
    'input[name="person[password]"]',
    'input[type="password"]',
    'input[name="password"]',
]
_SUBMIT_SELECTORS = [
    'button[type="submit"]',
    'input[type="submit"]',
]
# Best-effort: read the inline error if creds are wrong. Optional.
_ERROR_SELECTORS = [
    '.alert-danger',
    '.error',
    '[role="alert"]',
]


@dataclass(frozen=True)
class Credentials:
    username: str
    password: str
    source: str  # human-readable description used in error/log output


def _load_credentials(args: argparse.Namespace) -> Credentials:
    """Resolve credentials per the documented loading order. Exits on failure."""
    sources_tried: list[str] = []

    if args.username and args.password:
        return Credentials(args.username, args.password, "command-line flags")
    if args.username or args.password:
        sys.exit("ERROR: --username and --password must be provided together.")
    sources_tried.append("--username/--password flags")

    env_u = os.environ.get("SAC_USERNAME", "").strip()
    env_p = os.environ.get("SAC_PASSWORD", "").strip()
    if env_u and env_p:
        return Credentials(env_u, env_p, "$SAC_USERNAME / $SAC_PASSWORD")
    sources_tried.append("$SAC_USERNAME / $SAC_PASSWORD")

    cred_file = args.credentials_file or DEFAULT_CREDENTIALS_FILE
    if cred_file.exists():
        try:
            lines = cred_file.read_text(encoding="utf-8").splitlines()
        except OSError as e:
            sys.exit(f"ERROR: cannot read credentials file {cred_file}: {e}")
        nonblank = [ln.strip() for ln in lines if ln.strip()]
        if len(nonblank) >= 2:
            return Credentials(nonblank[0], nonblank[1], str(cred_file))
        sys.exit(
            f"ERROR: credentials file {cred_file} must have two non-blank lines "
            "(username on line 1, password on line 2)."
        )
    sources_tried.append(str(cred_file))

    sys.exit(
        f"ERROR: no credentials found (tried: {', '.join(sources_tried)}).\n\n"
        "Save them once:\n"
        "    python scripts/login_sac.py --save-credentials\n"
        "or set $SAC_USERNAME and $SAC_PASSWORD, or pass --username/--password.\n"
    )


def save_credentials(username: str, password: str, target: Path | None = None) -> Path:
    """Persist credentials to ``target`` (default: ``DEFAULT_CREDENTIALS_FILE``).

    Two lines, plaintext, mode 0600. The file mode is the only protection —
    the threat model assumes a trustworthy local user (same model as the
    cookie file we already save under the same directory).
    """
    if not username or not password:
        sys.exit("ERROR: username and password must both be non-empty.")
    path = target or DEFAULT_CREDENTIALS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{username}\n{password}\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def _interactive_save_credentials(target: Path) -> Path:
    """Prompt for credentials at the terminal and persist them."""
    if not sys.stdin.isatty():
        sys.exit(
            "ERROR: --save-credentials without --username/--password requires a TTY.\n"
            "Either pass --username U --password P, or run interactively."
        )
    print(f"Saving credentials to {target} (mode 0600).")
    username = input("SAC username (email): ").strip()
    password = getpass.getpass("SAC password: ").strip()
    return save_credentials(username, password, target)


def _try_fill(page, selectors: list[str], value: str, *, timeout_ms: int) -> bool:
    """Fill the first selector that becomes visible within ``timeout_ms``."""
    deadline = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < deadline:
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if loc.is_visible(timeout=200):
                    loc.fill(value)
                    return True
            except Exception:
                continue
        time.sleep(0.1)
    return False


def _try_click(page, selectors: list[str], *, timeout_ms: int) -> bool:
    deadline = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < deadline:
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if loc.is_visible(timeout=200):
                    loc.click()
                    return True
            except Exception:
                continue
        time.sleep(0.1)
    return False


def _read_error_text(page) -> str | None:
    for sel in _ERROR_SELECTORS:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=200):
                txt = loc.inner_text(timeout=500).strip()
                if txt:
                    return txt
        except Exception:
            continue
    return None


def _wait_for_typo_cookie(context, *, deadline_s: float) -> str | None:
    """Poll ``context.cookies`` until ``fe_typo_user`` appears (or deadline)."""
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        try:
            for c in context.cookies(SAC_HOME_URL):
                if c.get("name") == "fe_typo_user" and c.get("value"):
                    return c["value"]
        except Exception:
            # Context may briefly be in a bad state during navigation; retry.
            pass
        time.sleep(1.0)
    return None


def _import_playwright():
    try:
        from playwright.sync_api import sync_playwright  # noqa: PLC0415
    except ImportError as e:
        sys.exit(
            f"ERROR: playwright is not installed ({e}).\n"
            "Install it with:\n"
            "    pip install playwright\n"
            "    playwright install chromium\n"
        )
    return sync_playwright


def login_headless(creds: Credentials, *, timeout_s: int, cookie_file: Path | None,
                   debug: bool) -> int:
    sync_playwright = _import_playwright()
    print(f"[login] headless mode, credentials from {creds.source}")
    deadline = time.monotonic() + timeout_s

    def remaining_ms() -> int:
        return max(0, int((deadline - time.monotonic()) * 1000))

    try:
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(headless=True)
            except Exception as e:
                sys.exit(
                    f"ERROR: failed to launch chromium ({e}).\n"
                    "If chromium isn't installed: playwright install chromium\n"
                )
            context = browser.new_context()
            page = context.new_page()
            page.goto(SAC_LOGIN_URL, wait_until="domcontentloaded",
                      timeout=remaining_ms() or 30_000)

            if not _try_fill(page, _USERNAME_SELECTORS, creds.username,
                             timeout_ms=remaining_ms()):
                sys.exit(
                    "ERROR: couldn't find the username field within the timeout.\n"
                    "Try --headed to complete login manually."
                )
            if not _try_fill(page, _PASSWORD_SELECTORS, creds.password,
                             timeout_ms=remaining_ms()):
                sys.exit(
                    "ERROR: couldn't find the password field within the timeout.\n"
                    "Try --headed to complete login manually."
                )
            if not _try_click(page, _SUBMIT_SELECTORS, timeout_ms=remaining_ms()):
                sys.exit(
                    "ERROR: couldn't find the submit button within the timeout.\n"
                    "Try --headed to complete login manually."
                )

            # Wait for either the auth cookie or a visible error banner.
            cookie_value = _wait_for_typo_cookie(context, deadline_s=remaining_ms() / 1000.0)
            if not cookie_value:
                err = _read_error_text(page)
                if err:
                    sys.exit(f"ERROR: SAC rejected the login: {err}")
                # Snapshot for debugging selector / flow issues.
                try:
                    cur_url = page.url
                    cur_title = page.title()
                    all_cookies = context.cookies()
                    cookie_names = sorted({c["name"] for c in all_cookies}) or ["(none)"]
                    print(f"  debug: final URL = {cur_url}", file=sys.stderr)
                    print(f"  debug: title    = {cur_title!r}", file=sys.stderr)
                    print(f"  debug: cookies  = {', '.join(cookie_names)}", file=sys.stderr)
                except Exception as snap_err:
                    print(f"  debug: snapshot failed: {snap_err}", file=sys.stderr)
                sys.exit(
                    "ERROR: headless login finished but no fe_typo_user cookie appeared.\n"
                    "Try --headed to complete login manually."
                )

            target = cookie_file or DEFAULT_COOKIE_FILE
            path = save_cookie(cookie_value, target)
            print(f"[login] OK — cookie saved to {path}")
            browser.close()
            return 0
    except SystemExit:
        raise
    except Exception as e:
        if debug:
            raise
        sys.exit(f"ERROR: unexpected failure during headless login: {e}\nRe-run with --debug for a traceback.")


def login_persist(*, profile_dir: Path, timeout_s: int, cookie_file: Path | None,
                  headless: bool, debug: bool) -> int:
    """Use a persistent Chromium profile so the SAC session sticks across runs.

    First invocation: profile is empty → open a visible window at the SAC
    login page → user logs in once → cookie auto-saved → browser closes.
    Subsequent invocations: profile is already authenticated → opening
    https://www.sac-cas.ch/ surfaces the existing ``fe_typo_user`` cookie
    immediately → script saves it and exits in 3-5 seconds with no user
    interaction.

    The profile keeps SAC's session alive on its own as long as you run
    this command occasionally; you should only have to log in manually
    when SAC genuinely invalidates the session (rare — weeks at a time).
    """
    sync_playwright = _import_playwright()
    profile_dir.mkdir(parents=True, exist_ok=True)
    fresh_profile = not any(profile_dir.iterdir())
    print(f"[login] persist mode, profile={profile_dir} "
          f"({'fresh — log in once when window opens' if fresh_profile else 'reusing existing session'})")

    try:
        with sync_playwright() as pw:
            try:
                # Persistent context: cookies/localStorage live in profile_dir.
                context = pw.chromium.launch_persistent_context(
                    user_data_dir=str(profile_dir),
                    headless=headless,
                )
            except Exception as e:
                sys.exit(
                    f"ERROR: failed to launch chromium with persistent profile ({e}).\n"
                    "If chromium isn't installed: playwright install chromium\n"
                )

            page = context.pages[0] if context.pages else context.new_page()
            # If we already have a valid session, hitting the home page
            # surfaces fe_typo_user immediately (no redirect through OAuth).
            # If we don't, the page itself shows the login link and the user
            # navigates from there.
            target_url = SAC_HOME_URL if not fresh_profile else SAC_LOGIN_URL
            try:
                page.goto(target_url, wait_until="domcontentloaded", timeout=30_000)
            except Exception as nav_err:
                # Don't abort — the user might still log in manually even
                # if the initial navigation failed.
                print(f"  warn: initial nav failed ({nav_err}); waiting for cookie anyway",
                      file=sys.stderr)

            # Short poll first: if the session is already authenticated, the
            # cookie is there in seconds. Only after that do we fall back to
            # the full headed-login budget.
            quick_deadline = 5.0 if not fresh_profile else 1.0
            cookie_value = _wait_for_typo_cookie(context, deadline_s=quick_deadline)
            if not cookie_value:
                if headless:
                    sys.exit(
                        "ERROR: no fe_typo_user cookie in profile and --persist-headless was set.\n"
                        "Re-run without --persist-headless to log in manually."
                    )
                print(f"[login] no existing session; please log in manually "
                      f"(up to {timeout_s}s)…")
                cookie_value = _wait_for_typo_cookie(context, deadline_s=timeout_s)

            if not cookie_value:
                sys.exit(
                    "ERROR: timed out waiting for fe_typo_user cookie. Did login complete?"
                )

            target = cookie_file or DEFAULT_COOKIE_FILE
            path = save_cookie(cookie_value, target)
            print(f"[login] OK — cookie saved to {path}")
            print(f"        profile preserved at {profile_dir}; next run should be instant")
            context.close()
            return 0
    except SystemExit:
        raise
    except Exception as e:
        if debug:
            raise
        sys.exit(f"ERROR: persist-mode login failed: {e}\nRe-run with --debug for a traceback.")


def login_headed(*, timeout_s: int, cookie_file: Path | None, debug: bool) -> int:
    sync_playwright = _import_playwright()
    print(f"[login] headed mode — a Chromium window will open; log in manually. "
          f"Polling for fe_typo_user (timeout: {timeout_s}s).")

    try:
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(headless=False)
            except Exception as e:
                sys.exit(
                    f"ERROR: failed to launch chromium ({e}).\n"
                    "If chromium isn't installed: playwright install chromium\n"
                )
            context = browser.new_context()
            page = context.new_page()
            page.goto(SAC_LOGIN_URL, wait_until="domcontentloaded", timeout=30_000)

            cookie_value = _wait_for_typo_cookie(context, deadline_s=timeout_s)
            if not cookie_value:
                sys.exit(
                    "ERROR: timed out waiting for fe_typo_user cookie. Did login complete?"
                )

            target = cookie_file or DEFAULT_COOKIE_FILE
            path = save_cookie(cookie_value, target)
            print(f"[login] OK — cookie saved to {path}")
            browser.close()
            return 0
    except SystemExit:
        raise
    except Exception as e:
        if debug:
            raise
        # Most likely cause: user closed the window.
        sys.exit(f"ERROR: headed login failed: {e}\nRe-run with --debug for a traceback.")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--save-credentials", action="store_true",
                   help=f"Persist credentials to {DEFAULT_CREDENTIALS_FILE} and exit. "
                        "Prompts interactively unless --username/--password given.")
    p.add_argument("--persist", action="store_true",
                   help="Reuse a Chromium profile so the SAC session sticks across runs. "
                        f"Profile lives at {DEFAULT_PROFILE_DIR}. First run: log in manually "
                        "once; future runs auto-extract the cookie in ~3s.")
    p.add_argument("--profile-dir", type=Path,
                   help=f"Override --persist profile location (default: {DEFAULT_PROFILE_DIR}).")
    p.add_argument("--headed", action="store_true",
                   help="Open a visible browser; log in manually. No stored creds needed.")
    p.add_argument("--username", help="SAC username/email (overrides env + file).")
    p.add_argument("--password", help="SAC password (overrides env + file).")
    p.add_argument("--credentials-file", type=Path,
                   help=f"Override credentials path (default: {DEFAULT_CREDENTIALS_FILE}).")
    p.add_argument("--cookie-file", type=Path,
                   help=f"Override cookie output path (default: {DEFAULT_COOKIE_FILE}).")
    p.add_argument("--timeout", type=int,
                   help=f"Overall budget in seconds (default: {DEFAULT_HEADLESS_TIMEOUT_S} "
                        f"headless, {DEFAULT_HEADED_TIMEOUT_S} headed).")
    p.add_argument("--debug", action="store_true",
                   help="Re-raise unexpected exceptions instead of catching them.")
    args = p.parse_args(argv)

    if args.save_credentials:
        target = args.credentials_file or DEFAULT_CREDENTIALS_FILE
        if args.username and args.password:
            path = save_credentials(args.username, args.password, target)
        elif args.username or args.password:
            sys.exit("ERROR: --username and --password must be provided together.")
        else:
            path = _interactive_save_credentials(target)
        print(f"[save ] Wrote credentials to {path} (mode 0600)")
        return 0

    if args.persist:
        profile = args.profile_dir or DEFAULT_PROFILE_DIR
        timeout = args.timeout or DEFAULT_HEADED_TIMEOUT_S
        return login_persist(profile_dir=profile, timeout_s=timeout,
                             cookie_file=args.cookie_file, headless=False, debug=args.debug)

    if args.headed:
        timeout = args.timeout or DEFAULT_HEADED_TIMEOUT_S
        return login_headed(timeout_s=timeout, cookie_file=args.cookie_file, debug=args.debug)

    creds = _load_credentials(args)
    timeout = args.timeout or DEFAULT_HEADLESS_TIMEOUT_S
    return login_headless(creds, timeout_s=timeout, cookie_file=args.cookie_file,
                          debug=args.debug)


if __name__ == "__main__":
    sys.exit(main())
