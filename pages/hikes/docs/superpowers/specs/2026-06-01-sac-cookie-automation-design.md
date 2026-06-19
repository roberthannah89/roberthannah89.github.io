# SAC cookie automation — one-shot headless login

**Date:** 2026-06-01
**Status:** **Superseded** — `login_sac.py` was implemented as designed but SAC's bot detection on the OAuth callback made the headless path unreliable in practice. Current workflow uses the Chrome Cookie-Editor extension + `scripts/fetch_sac_route.py --save-cookie -` (see [`docs/workflows/SAC-EXTRACTION.md`](../../workflows/SAC-EXTRACTION.md#refreshing-the-sac-cookie-cookie-editor-workflow)). `login_sac.py` has been removed. Kept here for design context only.
**Scope:** Add a single command that logs into sac-cas.ch and saves the resulting `fe_typo_user` cookie to the location `fetch_sac_route.py` already reads from. Manual DevTools copy becomes optional.

---

## Background

`scripts/fetch_sac_route.py` fetches SAC route JSON over plain HTTPS using a session cookie stored at `~/.config/sac-hikes/cookie`. Today the only way to populate that cookie is the DevTools copy + `--save-cookie '<value>'` ritual. The cookie expires after a few days, so the ritual repeats often.

SAC login is OAuth/OIDC against `portal.sac-cas.ch` (verified: `GET /en/login/` returns a 302 to `portal.sac-cas.ch/oauth/authorize`). Reimplementing the OAuth+PKCE dance in `requests` would be fragile; `playwright` is already installed in `~/venvs/dev` (chromium 148, verified launchable). So a headless browser login is the realistic automation path.

---

## Goals

- One command refreshes the cookie: `python scripts/login_sac.py`.
- Credentials persist locally so the command needs no flags on the hot path.
- Nothing sensitive ever lives inside the git repo.
- A visible-browser fallback handles anything that breaks headless mode (layout changes, MFA, captcha).
- `fetch_sac_route.py` is **not** modified — login is an independent concern.

## Non-goals

- **Auto-refresh on cookie expiry.** Decided out of scope; user runs `login_sac.py` when needed.
- **Keyring / OS secret store integration.** Adds a dep that breaks on WSL.
- **MFA, OAuth refresh tokens, persistent browser context.** Covered by the headed fallback instead.
- **Changes to `fetch_sac_route.py`.** Login logic stays in its own script.

---

## Architecture

Standalone `scripts/login_sac.py`. Three modes:

1. `--save-credentials` (interactive prompt, or `--username U --password P`) → writes `~/.config/sac-hikes/credentials` (mode 0600), exits 0.
2. **Default headless** → requires credentials (from flags, env, or the credentials file — see Credential loading order). Launches Playwright chromium headless, completes the OAuth flow, waits for navigation back to a `www.sac-cas.ch/*` URL, reads `fe_typo_user` from the browser's cookie store, and persists it via the existing `save_cookie()` helper from `fetch_sac_route.py`. If no credentials are found, exits with the credentials error before launching the browser.
3. `--headed` → launches with `headless=False`, does **not** require credentials (user types them into the visible window), polls `context.cookies("https://www.sac-cas.ch/")` every 1 s up to a 5-minute deadline; saves and exits as soon as `fe_typo_user` appears. Polling is preferred over navigation-watching here because OAuth flows can chain through multiple redirects that are hard to enumerate.

`fetch_sac_route.py` is unchanged: it continues to read `~/.config/sac-hikes/cookie` exactly as it does today.

### Why standalone (not subcommand on `fetch_sac_route.py`)

- Different dep surface: login needs Playwright + creds; fetch needs cookies + GPX. Keeping them separate means one can break without the other.
- Smaller blast radius if SAC changes login (the file likeliest to break is the file we can delete and rewrite).
- Existing CLI surface for `fetch_sac_route.py` stays simple.

---

## Components

### `scripts/login_sac.py`

Single Python file, no new modules. Imports `save_cookie` and `DEFAULT_COOKIE_FILE` from `fetch_sac_route.py` so the cookie lands in exactly the place the fetcher reads.

**CLI surface:**
```
python scripts/login_sac.py                  # headless login, save cookie
python scripts/login_sac.py --headed          # visible browser, manual login
python scripts/login_sac.py --save-credentials                  # interactive prompt
python scripts/login_sac.py --save-credentials --username U --password P
```

Optional flags:
- `--credentials-file PATH` — override the default credentials location.
- `--cookie-file PATH` — override where the cookie is saved (passed through to `save_cookie`).
- `--timeout SECONDS` — overall budget for login completion (default 60 s headless, 300 s headed).

**Credential loading order** (matches cookie pattern in `fetch_sac_route.py`):
1. `--username` / `--password` flags
2. `$SAC_USERNAME` / `$SAC_PASSWORD` environment variables
3. `~/.config/sac-hikes/credentials` file (two lines: username, password)
4. Error with the same one-liner help shown by the cookie loader.

### `~/.config/sac-hikes/credentials`

Two lines, plaintext, mode 0600:
```
<username>
<password>
```

Plaintext is acceptable because the file mode restricts read access to the owner, the directory is outside any tracked git tree, and the threat model (local attacker reading `$HOME`) is the same as for the cookie file we already accepted. Encryption via `keyring` was considered and rejected (WSL compatibility, added dep).

### Cookie capture

In both headless and headed modes, after the OAuth callback lands on `www.sac-cas.ch`, the script:
1. Calls `context.cookies("https://www.sac-cas.ch/")`.
2. Filters for the cookie with `name == "fe_typo_user"`.
3. Passes the value to `save_cookie(value)` (which already handles `name=value` stripping and mode 0600).

---

## Data flow

```
[user] --save-credentials--> credentials file (~/.config/sac-hikes/credentials, 0600)
                                              |
                                              v
[user] login_sac.py ----------------------> reads credentials
                                              |
                                              v
                                       launches Playwright chromium
                                              |
                                              v
                              navigates to https://www.sac-cas.ch/en/login/
                                              |
                                              v
                                fills OAuth form on portal.sac-cas.ch
                                              |
                                              v
                              follows redirect back to www.sac-cas.ch
                                              |
                                              v
                              reads fe_typo_user from cookie store
                                              |
                                              v
                              save_cookie() -> ~/.config/sac-hikes/cookie (0600)

[later] fetch_sac_route.py reads cookie unchanged.
```

---

## Error handling

| Failure | Behavior |
|---|---|
| No credentials anywhere | Print loading order + `--save-credentials` hint, exit 2. |
| `fe_typo_user` never appears within timeout (headless) | Exit 3 with: "Headless login didn't produce a cookie. Try `--headed` to log in manually." |
| OAuth form selector not found | Same as above. |
| Invalid credentials (SAC error banner) | Read the banner text via Playwright, print it, exit 4. |
| Playwright import / browser missing | Print install hint (`playwright install chromium`), exit 5. |
| User closes the headed window without logging in | Exit 6 with "no cookie captured". |
| Credentials file unreadable | Exit 7 with path + permissions hint. |

All exits print a single-line error first, then a short remediation hint. No tracebacks unless `--debug` is passed.

---

## Testing

- **Headless login (live):** Manual happy path against real SAC with valid creds. Verify `~/.config/sac-hikes/cookie` is written, mode 0600, and `fetch_sac_route.py --url ... --slug ...` succeeds immediately after.
- **Headed login (live):** Manual happy path with `--headed`; verify same end state.
- **Credential loading order:** Unit-test `_load_credentials()` with combinations of flags, env vars, file presence. Same approach as the existing cookie-loader checks already in this session.
- **Bad creds:** Run headless with wrong password; verify exit code 4 and that the SAC error banner is in the output.
- **Missing browser:** Mock `from playwright.sync_api import sync_playwright` to raise `ImportError`; verify exit code 5 and the install hint.

No automated end-to-end test against SAC — too brittle and requires shared credentials.

---

## Out of scope (.gitignore belt-and-suspenders)

User declined the extra `.gitignore` patterns. The credentials and cookie files both live outside the repo, so no entries are needed. (If we ever change the storage location to anywhere under the repo root, this decision must be revisited.)

---

## Open questions

None as of approval.

---

## Risks

- **SAC changes login layout.** Mitigation: `--headed` fallback always works regardless of selector changes. Worst case, the user goes back to manual cookie copy until selectors are updated.
- **OAuth flow adds MFA.** Mitigation: `--headed` mode handles MFA naturally (user completes the challenge in the visible window).
- **Playwright chromium upgrades break the script.** Mitigation: `playwright` version is pinned via `~/venvs/dev`; upgrades are deliberate.
- **Credentials file leaked.** Mitigation: mode 0600, outside repo, plaintext is a known tradeoff documented above. No further mitigation in this design.
