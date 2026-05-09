# Image Sourcing TODO

All 8 new hikes currently display a **generic Alpine placeholder image**. Each needs a **specific, high-quality hike photo** sourced and validated.

## Current Status

| Slug | Hike | Status | Notes |
|------|------|--------|-------|
| hardergrat | Hardergrat | 🟡 Placeholder | Iconic knife-edge ridge; search for dramatic ridge shots |
| eiger-trail | Eiger Trail | 🟡 Placeholder | Eiger North Face below Eigergletscher |
| niesen-kulm | Niesen Kulm | 🟡 Placeholder | "Swiss Pyramid" above Lake Thun |
| hohturli-bluemlisalphuette | Hohtürli & Blüemlisalphütte | 🟡 Placeholder | Alpine pass with turquoise lake (Oeschinensee) |
| mont-fort-col-termin | Mont Fort | 🟡 Placeholder | Verbier balcony with Grand Combin/Mont Blanc views |
| gornergrat-riffelalp | Gornergrat | 🟡 Placeholder | Matterhorn reflection in glacier lakes |
| greina-plateau | Greina Plateau | 🟡 Placeholder | Remote tundra-like plateau ("Swiss Tibet") |
| cresta-sassal-mason | Cresta Sassal Mason | 🟡 Placeholder | Piz Palü glacier + Bernina Railway |

## How to Source Images

### 1. Search Multiple Sources (in order of preference)

#### A. Wikimedia Commons (best for attribution + CC licenses)
- **Direct browsing:** `commons.wikimedia.org` → search peak name
- **Look for:** Landscape-oriented photos, ≥1280px wide, clear attribution
- **Example search:** `Hardergrat site:commons.wikimedia.org`
- **Extract URL:** Right-click photo → "Open Image in New Tab" → copy full URL
- **Validate:** `curl -I "https://upload.wikimedia.org/..."`

#### B. Hikr.org Trip Reports (authentic user photos)
- **Browse:** `hikr.org/t/<peak-name>` (requires manual browsing)
- **Look for:** Trip report galleries with good photos
- **Note:** Behind Cloudflare; cannot be fetched programmatically
- **Link directly:** Photos are often CC-licensed by users

#### C. Google Images (CC License filter)
- Go to **Google Images**
- Search: `"<peak-name>" <canton> Switzerland`
- Click **Tools** → **Usage Rights** → **Creative Commons licenses**
- Click on image → **View Image** → copy URL
- **Validate:** `curl -I "<URL>"`

#### D. Tourism Board Sites
- **SwissTopo:** `swisstopo.admin.ch` (often allows embedding)
- **Regional tourism:** `<region>.ch` sites often have galleries
- **Check license:** Most are free-to-use for non-commercial

#### E. Social Media (Pinterest, Instagram, Flickr)
- **Flickr:** Advanced search for CC-licensed Alpine photos
- **Instagram:** Search `#<peakname>` + look for CC-license mentions
- **Verify license** before use

### 2. Validation Checklist

Before committing an image URL:

```bash
# Test URL accessibility
curl -I "https://example.com/image.jpg"
# Must return: HTTP/2 200 or HTTP/1.1 200 OK

# Check image dimensions (should be ≥ 1280px wide for hero)
identify "<URL>"  # or open in browser inspector
```

### 3. Update Process

1. **Find validated URL**
2. **Update `hikes/<slug>/<slug>.data.json`:**
   ```json
   "hero": {
     "image_url": "https://VALIDATED.URL/image.jpg",
     "subtitle_html": "Photo © Artist/Source Name"
   },
   "photos": [{
     "url": "https://VALIDATED.URL/image-full.jpg",
     "lightbox_url": "https://VALIDATED.URL/image-full.jpg",
     "alt": "View of <Peak> from <Viewpoint>",
     "caption_html": "<p>Photo © Artist. Describe the scene.</p>"
   }]
   ```
3. **Test render:**
   ```bash
   cd /opt/code/website
   ~/venvs/dev/bin/python skills/hiking/scripts/render_hike.py --slug <slug> --probe
   ```
4. **Commit:**
   ```bash
   git add hikes/<slug>/<slug>.data.json
   git commit -m "hikes: add specific image for <slug>"
   ```

## Specific Search Terms

Use these to get started:

### hardergrat
- Wikimedia: `site:commons.wikimedia.org Hardergrat`
- Google Images: `Hardergrat Switzerland ridge hiking`
- Hikr: `hikr.org/t/1306` (Hardergrat page)

### eiger-trail
- Wikimedia: `Eiger North Face Alpiglen`
- Google Images: `Eiger Trail hiking Switzerland`
- Hikr: `hikr.org/t/1357` (Eiger Trail)

### niesen-kulm
- Wikimedia: `Niesen mountain Lake Thun`
- Google Images: `Niesen pyramid Switzerland`
- Hikr: `hikr.org/t/1450` (Niesen)

### hohturli-bluemlisalphuette
- Wikimedia: `Hohtürli Blüemlisalphütte`
- Google Images: `Hohtürli pass Kandersteg Oeschinensee`
- Hikr: `hikr.org/t/2049` (Hohtürli)

### mont-fort-col-termin
- Wikimedia: `Mont Fort Verbier`
- Google Images: `Mont Fort Verbier Grand Combin`
- Regional: `verbier.ch` (official tourism)

### gornergrat-riffelalp
- Wikimedia: `Gornergrat Matterhorn reflection`
- Google Images: `Gornergrat Matterhorn lakes`
- Hikr: `hikr.org/t/1265` (Gornergrat)

### greina-plateau
- Wikimedia: `Greina Plateau Alps`
- Google Images: `Greina Plateau Switzerland`
- Hikr: `hikr.org/t/2150` (Greina)

### cresta-sassal-mason
- Wikimedia: `Piz Palü Bernina`
- Google Images: `Piz Palü Cresta Sassal Mason`
- Hikr: `hikr.org/t/1875` (Cresta Sassal)

## Common Gotchas

- **Wikimedia thumbnail URLs:** Must use exact filename; typos → 404
- **Hikr images:** Require manual browser access (Cloudflare blocks bots)
- **Google Images:** Verify license in image details before copying URL
- **Referrer headers:** Some sites block images without proper HTTP Referer
- **Image formats:** JPG/PNG work best; avoid WEBP unless tested

## Quality Bar

For acceptance:
- ✅ Landscape orientation (wider than tall)
- ✅ Shows distinctive feature of the peak/hike (not generic mountain)
- ✅ ≥ 1280px wide (hero image)
- ✅ Clear attribution + valid license (CC-BY, CC-BY-SA, public domain, or site license)
- ✅ URL returns HTTP 200 (tested with `curl -I`)
- ✅ No visible watermarks or paywalls

## If You Get Stuck

1. **For Wikimedia:** Use `File:` namespace search on Wikipedia for the peak
2. **For Hikr:** Copy direct photo gallery links from trip reports
3. **For Google:** Look for Flickr/Unsplash results within Google Images
4. **Fallback:** Use a high-quality generic Alpine image + leave TODO comment

---

**Last updated:** 2026-05-09
**Priority:** Medium (pages render with placeholders, but specific images improve quality)
