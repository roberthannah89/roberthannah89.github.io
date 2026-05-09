#!/bin/bash
# Safe curl commands for hiking peak photo extraction
# Reference: See image-extraction-strategies.md for detailed explanations

# ============================================================================
# 1. WIKIMEDIA COMMONS (✅ RECOMMENDED - curl safe, no rate limiting)
# ============================================================================

echo "=== WIKIMEDIA COMMONS ==="
echo ""

# Query image metadata via API (safe, official)
echo "📋 Query image metadata:"
curl -s \
  -H "User-Agent: Mozilla/5.0" \
  'https://commons.wikimedia.org/w/api.php?action=query&titles=File:Säntis_Appenzell.jpg&prop=imageinfo&iiprop=url|canonicaltitle&format=json' \
  | jq '.query.pages[].imageinfo[0].url'

# Validate image exists (headers only, fast)
echo ""
echo "🔍 Validate image exists (HEAD request):"
curl -I \
  -H "User-Agent: Mozilla/5.0" \
  'https://upload.wikimedia.org/wikipedia/commons/e/e4/Appenzell_sample.jpg'

# Download image directly from CDN (no rate limit)
echo ""
echo "⬇️  Download image from CDN (no rate limiting):"
curl -L \
  -H "User-Agent: Mozilla/5.0" \
  -o ~/peak_photo.jpg \
  'https://upload.wikimedia.org/wikipedia/commons/e/e4/Appenzell_sample.jpg'

# ============================================================================
# 2. WIKIPEDIA → WIKIMEDIA (✅ RECOMMENDED)
# ============================================================================

echo ""
echo "=== WIKIPEDIA PEAK ARTICLE → WIKIMEDIA FILES ==="
echo ""

# Get all images on Wikipedia peak article
echo "📋 List images on Wikipedia article:"
curl -s \
  'https://en.wikipedia.org/w/api.php?action=query&titles=Säntis&prop=images&format=json' \
  | jq '.query.pages[].images[] | .title'

# ============================================================================
# 3. SWISS TOURISM .CH SITES (⚠️  MEDIUM - Check robots.txt)
# ============================================================================

echo ""
echo "=== SWISS TOURISM .ch SITES ==="
echo ""

# Check robots.txt first
echo "🤖 Check robots.txt for scraping restrictions:"
curl -I https://www.appenzell.ch/robots.txt

# Fetch page with proper headers
echo ""
echo "📄 Fetch page with standard headers (safe):"
curl \
  -H "User-Agent: Mozilla/5.0 (compatible; HikingBot/1.0)" \
  -H "Referer: https://www.appenzell.ch/" \
  'https://www.appenzell.ch/tourism' \
  | grep -oP '<img[^>]+src="\K[^"]+' | head -5

# ============================================================================
# 4. HIKR.ORG (⚠️  RISKY - No API, anti-scraper measures)
# ============================================================================

echo ""
echo "=== HIKR.ORG (⚠️  USE CAUTION) ==="
echo ""

# Photo page (HTML scraping required)
# Note: Hikr blocks fast requests; use 3+ second delays
echo "⚠️  Hikr photo page (with referrer, slow):"
curl -s \
  -H "User-Agent: Mozilla/5.0" \
  -H "Referer: https://www.hikr.org/" \
  --compressed \
  'https://www.hikr.org/gallery/photo1234567.html' \
  | grep -oP 'https://s\.hikr\.org/[^"]+' | head -3

# ============================================================================
# 5. GOOGLE IMAGES (❌ NOT RECOMMENDED - Rate limiting, ToS violation)
# ============================================================================

echo ""
echo "=== GOOGLE IMAGES (❌ AVOID) ==="
echo ""

echo "❌ Direct extraction from Google Images violates ToS"
echo "❌ Rate limiting: 50-100 queries/hour → CAPTCHA → IP ban"
echo ""
echo "✅ Alternative: Use Google Custom Search API (paid)"
echo "✅ Or: Search source websites directly"

# ============================================================================
# HELPER FUNCTIONS FOR PRODUCTION
# ============================================================================

# Safe Wikimedia extraction with error handling
function get_wikimedia_image() {
    local filename="$1"
    
    curl -s \
      -H "User-Agent: Mozilla/5.0 (compatible; HikingBot/1.0)" \
      "https://commons.wikimedia.org/w/api.php?action=query&titles=File:${filename}&prop=imageinfo&iiprop=url&format=json" \
      | jq -r '.query.pages[].imageinfo[0].url // empty'
}

# Validate image URL (200 OK check)
function validate_image_url() {
    local url="$1"
    
    http_code=$(curl -s -o /dev/null -w "%{http_code}" -I "$url")
    
    if [ "$http_code" = "200" ] || [ "$http_code" = "304" ]; then
        echo "✅ Valid ($http_code)"
        return 0
    else
        echo "❌ Invalid ($http_code)"
        return 1
    fi
}

# Safe rate-limited fetch
function safe_fetch_with_backoff() {
    local url="$1"
    local max_retries=3
    local attempt=0
    
    while [ $attempt -lt $max_retries ]; do
        response=$(curl -s -w "\n%{http_code}" "$url")
        http_code=$(echo "$response" | tail -n 1)
        body=$(echo "$response" | head -n -1)
        
        case $http_code in
            200|304)
                echo "$body"
                return 0
                ;;
            429)
                # Rate limited; exponential backoff
                wait_time=$((2 ** attempt))
                echo "⚠️  Rate limited; waiting ${wait_time}s..." >&2
                sleep $wait_time
                ((attempt++))
                ;;
            *)
                echo "❌ HTTP $http_code" >&2
                return 1
                ;;
        esac
    done
    
    return 1
}

# ============================================================================
# EXAMPLES USING HELPER FUNCTIONS
# ============================================================================

echo ""
echo "=== HELPER FUNCTION EXAMPLES ==="
echo ""

# Example: Get image URL
echo "🎯 Get Wikimedia image URL:"
get_wikimedia_image "Säntis_Appenzell.jpg"

# Example: Validate URL
echo ""
echo "✅ Validate image URL:"
if validate_image_url "https://upload.wikimedia.org/wikipedia/commons/e/e4/Appenzell_sample.jpg"; then
    echo "   Image is accessible"
fi

# ============================================================================
# PRODUCTION DEPLOYMENT CHECKLIST
# ============================================================================

echo ""
echo "=== DEPLOYMENT CHECKLIST ==="
echo ""
cat << 'EOF'
□ Use MediaWiki API for Wikimedia (not direct CDN when possible)
□ Add delays between requests (1-2 seconds minimum)
□ Set proper User-Agent header (not disguised as browser)
□ Respect robots.txt (check before scraping any site)
□ Handle 429 (Too Many Requests) with exponential backoff
□ Cache responses (24-48 hour TTL)
□ Store license + attribution metadata with each image
□ Validate URLs before storing (curl -I check)
□ Log all errors and rate limiting events
□ Monitor error rates; alert if > 10% fail
□ Test with small dataset before production deploy
EOF

echo ""
echo "=== SAFE EXTRACTION SUMMARY ==="
echo ""
echo "✅ ALWAYS USE:"
echo "  • Wikimedia Commons API + upload.wikimedia.org CDN"
echo "  • Wikipedia → Commons extraction"
echo "  • Swiss .ch official tourism sites"
echo ""
echo "❌ NEVER USE:"
echo "  • Google Images direct extraction"
echo "  • Hikr.org without permission"
echo "  • Rapid scraping (< 1 second delays)"
echo "  • Disguised User-Agent headers"
