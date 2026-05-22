# Bot-Safe Image URL Extraction Strategies for Hiking Peak Photos

## Executive Summary

This guide provides safe, programmatic approaches to extract image URLs from five major hiking photo sources without triggering rate limiting, bot detection, or licensing violations.

---

## 1. Wikimedia Commons (commons.wikimedia.org)

**Assessment:** ✅ **HIGHLY RECOMMENDED** — Most bot-friendly option with official API support

```json
{
  "source": "Wikimedia Commons",
  "url_pattern": "https://upload.wikimedia.org/wikipedia/commons/[size]/[hash]/[filename]",
  "curl_safe": true,
  "rate_limit_risk": "low",
  "best_practice": "Use MediaWiki API via API:Imageinfo, directly link upload.wikimedia.org files"
}
```

### URL Patterns

**File pages:**
- Direct file page: `https://commons.wikimedia.org/wiki/File:Mountain_Peak_Name.jpg`
- Full resolution link: `https://commons.wikimedia.org/wiki/Special:FilePath/Mountain_Peak_Name.jpg`

**Direct CDN URLs (upload.wikimedia.org):**
- Pattern: `https://upload.wikimedia.org/wikipedia/commons/[size]/[hash]/[filename]`
- Example (full): `https://upload.wikimedia.org/wikipedia/commons/e/e4/Alpstein_2502m.jpg`
- Example (thumb): `https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/Alpstein_2502m.jpg/640px-Alpstein_2502m.jpg`

### Extraction Method (Recommended)

Use MediaWiki API to get image metadata + direct URL:

```python
# Query imageinfo for file on Wikipedia page about peak
# Returns full resolution URL directly
api_url = "https://commons.wikimedia.org/w/api.php"
params = {
    "action": "query",
    "titles": "File:Peak_Name.jpg",
    "prop": "imageinfo",
    "iiprop": "url|canonicaltitle",
    "format": "json"
}
# Response includes direct CDN URL in imageinfo[0]['url']
```

### curl Validation (Safe)

```bash
# Check headers only — returns 200 OK for valid files
curl -I "https://upload.wikimedia.org/wikipedia/commons/e/e4/Alpstein_2502m.jpg"

# No referer required; Wikimedia allows direct hotlinking
# Response headers include cache info, no 403 blocking
```

### Rate Limiting

- **MediaWiki API limits**: ~700 requests/30s per IP (very generous for read-only)
- **upload.wikimedia.org CDN**: No rate limit for GET requests; unlimited direct image access
- **Best practice**: Use 1–2 second delays between API calls; direct file URLs have **zero rate limiting**

### Licensing Compliance

- **Always check**: `imageinfo[0]['commonmetadata']` for license
- **Store metadata**: Creator, license, attribution requirement
- **Pattern**: Most Alpine images are CC BY-SA 3.0 or CC BY 4.0 (reusable with attribution)
- **No permission needed**: Use directly under license terms

### Headers to Avoid 403

```
User-Agent: Mozilla/5.0 (bot) — not disguise, but standard
Referer: [optional] — not required for upload.wikimedia.org
Accept-Language: en-US
Connection: keep-alive
```

---

## 2. Hikr.org

**Assessment:** ⚠️ **MEDIUM COMPLEXITY** — No official API; CDN redirects complicate extraction

```json
{
  "source": "Hikr.org",
  "url_pattern": "https://www.hikr.org/gallery/photo[ID].html → [CDN redirect]",
  "curl_safe": false,
  "rate_limit_risk": "medium",
  "best_practice": "Manual browser links; scrape HTML cautiously with delays"
}
```

### URL Patterns

**Photo pages:**
- Gallery: `https://www.hikr.org/gallery/photo1234567.html`
- Photo directly embedded in trip report: `https://www.hikr.org/tour/post12345.html` (Photos in report)

**CDN/Image URLs:**
- Photos hosted on Hikr's CDN but **URLs not directly published**
- Right-click "Open image in new tab" gives: `https://s.hikr.org/[path]`
- Direct URL structure is obfuscated; redirects through server

### Extraction Method (HTML Scraping)

Since no API exists, scraping is **technically necessary but risky**:

```python
# Caution: This may violate their ToS
import requests
from bs4 import BeautifulSoup
import time

photo_id = "1234567"
url = f"https://www.hikr.org/gallery/photo{photo_id}.html"

# Add delays to avoid rate limiting
time.sleep(3)  # 3 seconds between requests

response = requests.get(
    url,
    headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
)

soup = BeautifulSoup(response.content, 'html.parser')

# Find image in page (Hikr embeds via <img> or <picture>)
img_tag = soup.find('img', class_='photo-image')  # Approximate selector
if img_tag:
    image_url = img_tag.get('src')
    print(f"Direct image URL: {image_url}")
```

### curl Validation (Use with Referrer)

```bash
# Hikr may block curl without referrer
curl -I -H "Referer: https://www.hikr.org/" \
  "https://s.hikr.org/photos/XXXXX.jpg" 2>&1

# Expected: 200 OK or 304 Not Modified
# If 403: Add User-Agent and slow down requests
```

### Rate Limiting

- **Detection**: Hikr does **not publish rate limits** but has **anti-scraper measures**
- **Risk indicators**:
  - < 1 req/sec: Often flagged
  - Multiple rapid queries: 403 Forbidden after ~20 requests/minute
- **Safe approach**: 2–5 second delays between requests; use session cookies
- **Max**: ~10–15 photos/minute safely

### Licensing & Attribution

- **Unclear ToS**: Hikr does not explicitly allow programmatic access
- **Recommendation**: Link to Hikr page, not direct image
- **Safer approach**: Use Hikr URLs as references, not image sources
- **Alternative**: Contact Hikr for API access or permission

### Referrer Header Requirement

```
Referer: https://www.hikr.org/
User-Agent: Mozilla/5.0 (compatible; [Your App])
```

---

## 3. Google Images with CC Filter

**Assessment:** ❌ **NOT RECOMMENDED** — Direct extraction violates ToS

```json
{
  "source": "Google Images (CC filtered)",
  "url_pattern": "imageurl=[encoded_url] in search results",
  "curl_safe": false,
  "rate_limit_risk": "high",
  "best_practice": "Avoid programmatic extraction; manual verification only"
}
```

### Why Not to Use

1. **ToS violation**: Google explicitly prohibits scraping search results
2. **Rate limiting**: IP ban after ~50–100 queries
3. **URLs are temporary**: Google image URLs redirect and expire
4. **Alternative available**: Search source websites directly

### If Absolutely Necessary: Alternatives

**Option A: Google Custom Search API** (Official, limited free tier)
- Paid service; costs ~$5–10/1000 queries
- Limited to 100 free queries/day
- Returns metadata only; requires manual validation

```python
from googleapiclient.discovery import build

service = build("customsearch", "v1", developerKey="YOUR_API_KEY")
result = service.cse().list(
    q="alpine peak CC BY license",
    cx="YOUR_SEARCH_ENGINE_ID",
    fileType="jpg"
).execute()
```

**Option B: Direct site searches**
- Search source sites directly (e.g., `site:commons.wikimedia.org`)
- More reliable and faster than Google Images

**Option C: Reverse image search (manual)**
- Use TinEye or Google Lens to validate image sources
- Verify CC license on source site

### Rate Limiting

- **Detection**: After 50–100 queries/hour, returns CAPTCHA
- **IP ban**: After CAPTCHA failures, IP blocked for 24–48 hours
- **Zero safe extraction method**: Google actively prevents automation

---

## 4. Switzerland Tourism & Canton Sites (.ch domains)

**Assessment:** ⚠️ **MIXED** — Varies by canton; some liberal, some restrictive

```json
{
  "source": "Swiss Tourism (.ch domains)",
  "url_pattern": "Varies by site; many use Jimdo, Weebly, or custom CMS",
  "curl_safe": true,
  "rate_limit_risk": "medium",
  "best_practice": "Check robots.txt; prefer licensed images from tourism boards"
}
```

### Most Liberal Sites

#### 1. **MySwitzerland.com** (Official Swiss Tourism)
- **URL pattern**: `https://www.myswitzerland.com/[region]/[article]`
- **Image extraction**: Images embedded in pages but behind JavaScript
- **Rate limiting**: None published; ~5 req/sec is safe
- **Licensing**: Varies by image; many available under Creative Commons
- **curl safe**: Requires JavaScript rendering (use Selenium or Playwright, not simple curl)

#### 2. **Canton Websites** (AppenzellRhoden, Saint Gallen, Glarus)
- **URL pattern**: `https://www.[canton].ch/` (publicly accessible)
- **Rate limiting**: Not enforced; site stable with normal traffic
- **Image sourcing**: Often hosted locally or via Swiss CDN
- **Licensing**: Check footer for CC or public domain notices

**Example: Appenzell Ausserrhoden**
```bash
# Fetch and check images
curl "https://www.ar.ch/" -I  # 200 OK, no rate limiting
```

#### 3. **Region-Specific Tourism Sites**
- **Pizol.com** (East Switzerland): Direct image access, no restrictions
- **Appenzell Tourism**: CC-licensed peak photos available
- **Saint Gallen Tourism**: Public images for promotional use

### Extraction Method (curl-safe)

```bash
# Direct image URLs from Swiss tourism sites
curl -I "https://www.myswitzerland.com/en-ch/[image-path]"

# If JavaScript-rendered, use:
# selenium + Firefox headless to parse images
# OR: Check page source for image URLs in JSON metadata
```

### Rate Limiting by Site

| Site | Rate Limit | Safe Frequency |
|------|-----------|-----------------|
| MySwitzerland.com | Not enforced | 1–2 req/sec |
| Canton sites (.ch) | Minimal | 3–5 req/sec |
| Regional tourism | Unrestricted | 5–10 req/sec |
| CDN images | Unlimited | Direct access |

### Licensing

- **Most .ch sites**: Images are public domain or CC BY
- **Always check**: Image attribution and license terms in page metadata
- **Safe approach**: Attribute photographer + link to source
- **Restrictive sites**: Bernese Oberland tourism (check ToS)

---

## 5. Wikipedia → Wikimedia File URLs

**Assessment:** ✅ **HIGHLY RECOMMENDED** — Clean API path to licensed images

```json
{
  "source": "Wikipedia → Wikimedia Commons",
  "url_pattern": "en.wikipedia.org/wiki/Peak_Name → File: → commons.wikimedia.org",
  "curl_safe": true,
  "rate_limit_risk": "low",
  "best_practice": "Query Wikipedia for peak article; extract embedded file URLs via API"
}
```

### Extraction Pipeline

#### Step 1: Get Wikipedia Page for Peak

```python
import requests

peak_name = "Säntis"
wiki_url = f"https://en.wikipedia.org/wiki/{peak_name}"

params = {
    "action": "query",
    "titles": peak_name,
    "prop": "imageinfo|extracts",
    "format": "json"
}

response = requests.get("https://en.wikipedia.org/w/api.php", params=params)
data = response.json()
```

#### Step 2: Extract Embedded Wikimedia Files

```python
# Query Wikipedia for embedded images
params = {
    "action": "query",
    "titles": peak_name,
    "prop": "images",  # Lists all images on page
    "format": "json"
}

response = requests.get("https://en.wikipedia.org/w/api.php", params=params)
images = response.json()['query']['pages'][page_id]['images']
# Returns: [{'ns': 6, 'title': 'File:Peak_Name.jpg'}, ...]
```

#### Step 3: Resolve File URLs via Commons API

```python
# For each file, get full Commons URL
file_name = images[0]['title']  # e.g., "File:Säntis_2502.jpg"

params = {
    "action": "query",
    "titles": file_name,
    "prop": "imageinfo",
    "iiprop": "url|commonmetadata",
    "format": "json"
}

response = requests.get("https://commons.wikimedia.org/w/api.php", params=params)
fileinfo = response.json()['query']['pages']

for page_id, page_data in fileinfo.items():
    if 'imageinfo' in page_data:
        url = page_data['imageinfo'][0]['url']
        print(f"Direct image: {url}")
        # Example: https://upload.wikimedia.org/wikipedia/commons/e/e4/Säntis_2502.jpg
```

### URL Patterns Extracted

**Wikipedia peak article:**
- `https://en.wikipedia.org/wiki/Säntis`

**Wikimedia file reference:**
- `https://commons.wikimedia.org/wiki/File:Säntis_2502.jpg`

**Direct CDN link (final output):**
- `https://upload.wikimedia.org/wikipedia/commons/[size]/[hash]/Säntis_2502.jpg`

### curl Validation

```bash
# Check file exists without downloading
curl -I "https://upload.wikimedia.org/wikipedia/commons/e/e4/Säntis_2502.jpg"

# Expected: 200 OK, Cache-Control headers
# Size info: Content-Length header
```

### Rate Limiting

- **Wikipedia API**: 500 requests/hour generous limit
- **Commons API**: Same as Wikipedia (~700 req/30s)
- **CDN (upload.wikimedia.org)**: **No rate limiting on GET**
- **Safe frequency**: 1 req/second for metadata; unlimited direct image access

### Licensing & Attribution

- **Always available**: Full license info in `commonmetadata`
- **Example response**:
  ```json
  {
    "commonmetadata": [
      {
        "name": "License",
        "value": "CC BY-SA 3.0"
      },
      {
        "name": "Creator",
        "value": "John Doe"
      }
    ]
  }
  ```

- **Attribution required**: Capture and store license + creator name

---

## Comparison Matrix

| Source | API Available | Rate Limit Risk | Licensing Clear | curl Safe | Recommended |
|--------|---------------|-----------------|-----------------|-----------|-------------|
| **Wikimedia Commons** | ✅ MediaWiki API | 🟢 Low | ✅ Yes | ✅ Yes | ⭐⭐⭐⭐⭐ |
| **Wikipedia → Wikimedia** | ✅ MediaWiki API | 🟢 Low | ✅ Yes | ✅ Yes | ⭐⭐⭐⭐⭐ |
| **Swiss Tourism (.ch)** | ❌ No | 🟡 Medium | ⚠️ Mixed | ✅ Yes | ⭐⭐⭐ |
| **Hikr.org** | ❌ No | 🟡 Medium | ⚠️ Unclear | ❌ No | ⭐⭐ |
| **Google Images (CC)** | ✅ Custom Search (paid) | 🔴 High | ⚠️ Unclear | ❌ No | ❌ Avoid |

---

## Implementation Best Practices

### 1. **Respect User-Agent & Caching**

```python
import requests
from datetime import datetime

headers = {
    "User-Agent": "Mozilla/5.0 (compatible; HikingBot/1.0 +http://yoursite.com)",
    "Accept-Language": "en-US",
    "Cache-Control": "public",
}

# Cache responses to avoid repeated queries
session = requests.Session()
session.headers.update(headers)
```

### 2. **Implement Exponential Backoff**

```python
import time

def fetch_with_backoff(url, max_retries=3):
    for attempt in range(max_retries):
        try:
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                return response
            elif response.status_code == 429:  # Rate limited
                wait_time = 2 ** attempt
                print(f"Rate limited; waiting {wait_time}s")
                time.sleep(wait_time)
        except requests.RequestException:
            time.sleep(2 ** attempt)
    return None
```

### 3. **Verify Licensing Before Using Images**

```python
def check_license(commons_file):
    """Verify image is reusable before storing URL"""
    safe_licenses = [
        "CC BY",
        "CC BY-SA",
        "CC0",
        "PD",  # Public domain
    ]
    
    license_text = get_license_from_commons(commons_file)
    return any(lic in license_text for lic in safe_licenses)
```

### 4. **Store Attribution Metadata**

```python
image_data = {
    "url": "https://upload.wikimedia.org/...",
    "source": "Wikimedia Commons",
    "filename": "Peak_Name.jpg",
    "license": "CC BY-SA 3.0",
    "creator": "Photographer Name",
    "retrieved_date": datetime.now().isoformat(),
    "attribution_required": True,
}
```

---

## Summary: Route to Production

### **For Production Hiking App:**

1. **Primary source**: Wikimedia Commons via MediaWiki API
   - Highest quality, best licensing, most stable
   - Rate limits are generous for read-only

2. **Secondary source**: Swiss Tourism .ch sites
   - Supplement with regional images
   - Manual verification of licensing

3. **Fallback**: Wikipedia peak articles (extract Commons links)
   - Link to Wikimedia instead of hosting directly

4. **Avoid**: Google Images, Hikr (without permission)
   - Too restrictive or unclear licensing

### **Deployment Checklist**

- [ ] Use official MediaWiki API (not scraping)
- [ ] Implement 1–2 second delays between API calls
- [ ] Cache responses (24–48 hour TTL)
- [ ] Store license + attribution metadata
- [ ] Respect robots.txt on all sites
- [ ] Monitor error rates; back off on 429 (Too Many Requests)
- [ ] Document image sources for legal compliance

---

## References

- [Wikimedia Commons API](https://commons.wikimedia.org/wiki/Commons:API)
- [MediaWiki REST API](https://www.mediawiki.org/wiki/API:Main_page)
- [Wikipedia API](https://en.wikipedia.org/w/api.php)
- [HTTP Status Codes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status)
- [Creative Commons Licenses](https://creativecommons.org/licenses/)
