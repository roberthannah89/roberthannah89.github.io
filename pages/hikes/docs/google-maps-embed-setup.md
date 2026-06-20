# Google Maps Embed API — setup for the transit widget's "Compare" pane

The transit widget on each hike page can show a side-by-side Google Maps
transit-directions iframe (the "Compare with Google Maps" disclosure at the
bottom of the widget). It needs a Google Maps Embed API key — Google requires
one even though the Embed API has a generous free tier.

This guide walks you through getting a key, restricting it so it can't be
abused, and dropping it into the local config.

---

## 1. Create a Google Cloud project (or pick an existing one)

1. Open <https://console.cloud.google.com/projectcreate>.
2. Sign in with the Google account you want to be billed under (more on
   billing below — the free tier covers all realistic personal-site use).
3. Name the project something like `hike-website`. Click **Create**.
4. After it finishes, the project picker at the top of the console should
   show your new project. Make sure it's selected for the rest of the steps.

## 2. Enable billing on the project

The Embed API has a free tier of **28,500 map loads per month** (as of
2026-06). Google still requires a billing account be attached, even to
projects that only use the free tier.

1. Console → **Billing** → **Link a billing account**.
2. Add a card. You won't be charged unless usage exceeds the free tier.
3. **Recommended:** set a budget alert (Billing → Budgets & alerts) for
   something low like CHF 5/month so any unexpected usage warns you early.

## 3. Enable the Maps Embed API

1. Console → **APIs & Services → Library**.
2. Search for "Maps Embed API" → click it → **Enable**.

> [!NOTE]
> Only enable the **Embed** API. Do NOT enable Maps JavaScript API, Places
> API, etc. — they're separately billable and the widget doesn't use them.

## 4. Create a restricted API key

1. Console → **APIs & Services → Credentials → Create credentials → API
   key**.
2. Copy the key (starts with `AIza…`). You'll paste it into the local config
   in step 5.
3. Immediately click **Restrict key** (or **Edit key** if you skip past).

### Application restrictions — HTTP referrers

Choose **Websites**. Add the referrer patterns for everywhere the key
should work. For this project that's roughly:

```
http://127.0.0.1:8769/*
http://localhost:*/*
file:///*                  # for local file:// browsing during dev
https://your-published-domain.example/*   # once you publish
```

If you skip restrictions, anyone who views your page source can copy the
key and run up your bill. **Always restrict.**

### API restrictions

Choose **Restrict key** and tick only:

- [x] Maps Embed API

Click **Save**.

## 5. Drop the key into the local config

The widget reads the key from `window.HIKING_CONFIG.googleMapsApiKey`. We
ship an example file; copy it to the real filename and paste your key in.

```bash
cd pages/hikes
cp local-config.example.js local-config.js
$EDITOR local-config.js   # paste your AIza… key
```

`local-config.js` is git-ignored, so the key never gets committed.

Reload any hike page → scroll to the transit widget → expand "Compare with
Google Maps" → the iframe should appear.

## 6. Verify nothing got committed

```bash
git status
# local-config.js should NOT appear (it's in .gitignore).
# If it does, check pages/hikes/.gitignore.
```

---

## Free-tier math

- Free tier: **28,500 map loads per month** per billing account.
- The widget loads the iframe **only when the user clicks "Compare"** — so
  a typical visitor produces 0 loads, only the curious ones produce 1.
- Realistic estimate for a personal hike site (~500 visitors/month, ~5%
  click rate): ~25 loads/month. Three orders of magnitude under the limit.

If you hit the limit, Google charges $7 per 1000 additional loads.

## Caveats of the Embed API vs the SBB view above it

- **No departure-time parameter.** The Embed API does not accept
  `departure_time` or `arrival_time` — it always shows "leave now"
  connections. Our SBB view supports both ("arrive by start" / "depart
  after end"), so the Embed view is for visual comparison only.
- **Fixed height (~450 px) and Google styling.** Can't restyle to match
  the site.
- **One direction at a time** (outbound only — for the return you'd need a
  second iframe or a swap button).
- **Requires network** — won't work offline. Our SBB view degrades to a
  cached snapshot.

## Revoking a leaked key

If the key ever shows up somewhere it shouldn't (committed by accident,
posted in a screenshot, etc.):

1. Console → **APIs & Services → Credentials → Delete** the key.
2. Create a new restricted key (steps 4–5 above).
3. `git filter-repo` or `bfg-repo-cleaner` to scrub it from history if it
   landed in a commit. (And rotate the key first; cleaning history alone
   doesn't help if a clone already exists.)
