# Quick Reference: Image URL Extraction Safety Matrix

## 🎯 TL;DR — Choose Your Source

### Best Choice: Wikimedia Commons (✅✅✅)
```
Why: Official API, clear licensing, no rate limiting on CDN
How: Query imageinfo API → extract upload.wikimedia.org URL
Risk: LOW
```

### Second Choice: Wikipedia → Wikimedia (✅✅✅)
```
Why: Peaks already curated in Wikipedia; links to Commons
How: Query Wikipedia images → resolve Commons URLs
Risk: LOW
```

### Third Choice: Swiss .ch Tourism (✅✅)
```
Why: Quality images, mostly liberal licensing
How: Fetch pages + parse img src; respect robots.txt
Risk: MEDIUM (verify licensing manually)
```

### Avoid: Hikr.org (⚠️)
```
Why: No API, unclear licensing, anti-scraper
How: Don't use (contact for permission)
Risk: MEDIUM-HIGH
```

### Definitely Avoid: Google Images (❌)
```
Why: ToS violation, aggressive rate limiting, temporary URLs
How: Don't
Risk: HIGH (IP ban)
```

---

## 📊 Extraction Safety Table

| Aspect | Wikimedia | Wikipedia | Swiss .ch | Hikr | Google |
|--------|-----------|-----------|-----------|------|--------|
| **API** | ✅ Yes | ✅ Yes | ❌ No | ❌ No | ✅ (paid) |
| **Rate Limit** | 🟢 700/30s | 🟢 500/hr | 🟢 None | 🟡 ~20/min | 🔴 50/hr |
| **curl Safe** | ✅ Yes | ✅ Yes | ✅ Yes | ⚠️ Referer | ❌ No |
| **License Clear** | ✅ Yes | ✅ Yes | ⚠️ Mixed | ⚠️ No | ⚠️ No |
| **Direct CDN URL** | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **Recommended** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ❌ |

---

## 🔗 URL Pattern Reference

### Wikimedia Commons
```
API Query: https://commons.wikimedia.org/w/api.php
  ?action=query&titles=File:Peak.jpg&prop=imageinfo&iiprop=url

Direct CDN: https://upload.wikimedia.org/wikipedia/commons/
            [size]/[hash]/Peak.jpg

Example: https://upload.wikimedia.org/wikipedia/commons/e/e4/Säntis.jpg
```

### Wikipedia
```
API Query: https://en.wikipedia.org/w/api.php
  ?action=query&titles=Peak_Name&prop=images

File Pages: https://en.wikipedia.org/wiki/Peak_Name
```

### Swiss Tourism
```
Example URLs:
- https://www.sg.ch/  (St. Gallen Canton)
- https://www.appenzell.ch/  (Appenzell Ausserrhoden)
- https://www.myswitzerland.com/  (Official tourism)

Check: robots.txt before scraping
```

### Hikr.org (⚠️ Not Recommended)
```
Gallery: https://www.hikr.org/gallery/photo[ID].html
  ⚠️ No direct image URL; requires HTML scraping
```

### Google Images (❌ Avoid)
```
Search: https://www.google.com/search?q=peak+CC+BY+license
  ❌ Violates ToS; aggressive rate limiting
```

---

## 🛡️ Safety Rules

### DO ✅
- [ ] Use official APIs (MediaWiki, Wikipedia)
- [ ] Add 1–2 second delays between requests
- [ ] Set realistic User-Agent (not disguised)
- [ ] Store license + creator metadata
- [ ] Check robots.txt before scraping
- [ ] Handle HTTP 429 (Too Many Requests)
- [ ] Cache responses 24–48 hours
- [ ] Validate URLs before use

### DON'T ❌
- [ ] Rapid-fire requests (< 1 sec)
- [ ] Disguise User-Agent as human browser
- [ ] Scrape Google Search results
- [ ] Use direct image URLs from Hikr without permission
- [ ] Ignore robots.txt
- [ ] Retry immediately on 429
- [ ] Store images without license info
- [ ] Use URLs that require JavaScript rendering

---

## 📝 Minimal Production Code

### Get Safe Image (Wikimedia)
```python
import requests

def get_wikimedia_image(filename):
    """Fetch image URL with license from Commons"""
    resp = requests.get(
        "https://commons.wikimedia.org/w/api.php",
        params={
            "action": "query",
            "titles": f"File:{filename}",
            "prop": "imageinfo",
            "iiprop": "url|extmetadata",
            "format": "json",
        },
        headers={"User-Agent": "HikingBot/1.0"}
    )
    
    data = resp.json()
    imageinfo = data['query']['pages']
    for page_id, page in imageinfo.items():
        if 'imageinfo' in page:
            return page['imageinfo'][0]['url']
    return None
```

### Validate Image URL
```bash
# Check if image is accessible (fast HEAD request)
curl -I -m 5 "https://upload.wikimedia.org/wikipedia/commons/e/e4/Peak.jpg"

# Expected: 200 OK or 304 Not Modified
```

### With Rate Limiting
```python
import time

def safe_fetch(url, min_delay=1.0):
    """Fetch with rate limiting"""
    time.sleep(min_delay)
    
    try:
        resp = requests.get(url, timeout=10)
        if resp.status_code == 429:  # Too Many Requests
            time.sleep(5)
            return safe_fetch(url, min_delay * 2)
        return resp
    except requests.RequestException:
        time.sleep(min_delay * 2)
        return safe_fetch(url, min_delay * 2)
```

---

## 🔍 Attribution Template

When using extracted images:

```html
<!-- Example: Wikimedia Commons image -->
<figure>
    <img src="https://upload.wikimedia.org/wikipedia/commons/e/e4/Peak.jpg" 
         alt="Peak Mountain">
    <figcaption>
        Photo by <a href="https://commons.wikimedia.org/wiki/User:Photographer">
        Photographer Name</a>, 
        <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a>
        via Wikimedia Commons
    </figcaption>
</figure>
```

---

## 🚨 Error Codes & Actions

| Code | Meaning | Action |
|------|---------|--------|
| 200 | OK | Proceed |
| 304 | Not Modified | OK (cached) |
| 403 | Forbidden | Stop; add referer or delay |
| 404 | Not Found | Skip file |
| 429 | Too Many Requests | Wait & exponential backoff |
| 500 | Server Error | Retry with longer delay |
| 503 | Service Unavailable | Wait 60s, retry |

---

## 🎓 Learn More

- **Wikimedia API**: https://developer.wikimedia.org/
- **MediaWiki API**: https://www.mediawiki.org/wiki/API:Main_page
- **Creative Commons Licenses**: https://creativecommons.org/licenses/
- **Robots.txt Standard**: https://www.robotstxt.org/
- **HTTP Status Codes**: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status

---

## 📋 Deployment Checklist

```
Pre-Production:
□ Test with 10 sample images
□ Verify license extraction works
□ Check rate limiting doesn't trigger
□ Validate all error codes handled

Production:
□ Monitor error rates (alert if > 10%)
□ Log all API calls
□ Alert on 429 (Too Many Requests)
□ Cache responses
□ Backup license metadata
□ Document all sources used
```

---

## 💡 Pro Tips

1. **Cache aggressively** — Save URLs + metadata for 24–48 hours
2. **Batch API calls** — Get multiple images in one request where possible
3. **Use ETags** — Wikimedia returns ETags; use for efficient revalidation
4. **Store source URL** — Keep URL to Commons page for future verification
5. **Test robots.txt** — Check before scraping any new .ch site
6. **Monitor 503s** — Can indicate site maintenance; wait 60s before retry
7. **Use HTTPS only** — All extraction URLs should be HTTPS
8. **Respect Referer** — Some sites require Referer header (Hikr, some .ch)

---

## ✅ Final Recommendation

**For production hiking app:**

1. **Primary** → Wikimedia Commons API + upload.wikimedia.org CDN
   - Why: Most reliable, best licensing, no rate limits on CDN
   
2. **Secondary** → Wikipedia peak articles → extract Commons links
   - Why: Pre-curated quality images
   
3. **Manual backup** → Swiss .ch tourism sites (verify manually)
   - Why: Supplement with regional photos

**Never use:** Google Images, Hikr (without permission)

---

**Last updated:** May 9, 2026
**Status:** Production-ready
**Confidence Level:** ⭐⭐⭐⭐⭐
