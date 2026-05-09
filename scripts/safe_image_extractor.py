"""
Bot-Safe Image URL Extraction for Hiking Photos

This module provides safe, rate-limit-aware methods to extract image URLs
from hiking-related sources without triggering bot detection.

Recommended usage:
  - Wikimedia Commons (primary)
  - Swiss tourism sites (secondary)
  - Wikipedia-linked Wikimedia files (fallback)

Avoid:
  - Hikr.org (unclear licensing)
  - Google Images (rate limiting, ToS violation)
"""

import requests
import time
import json
from datetime import datetime, timedelta
from typing import Optional, Dict, List
from urllib.parse import urlencode
from dataclasses import dataclass


@dataclass
class ImageMetadata:
    """Safe image metadata with licensing info"""
    url: str
    source: str
    filename: str
    license: str
    creator: str
    retrieved_date: str
    attribution_required: bool
    peak_name: Optional[str] = None


class WikimediaImageExtractor:
    """
    Safest extraction method: Wikimedia Commons via official API.
    
    Rate limits: ~700 requests/30s (very generous)
    Licensing: Clear and available for all images
    """
    
    BASE_URL = "https://commons.wikimedia.org/w/api.php"
    UPLOAD_CDN = "https://upload.wikimedia.org"
    SAFE_LICENSES = ["CC BY", "CC BY-SA", "CC0", "PD"]
    
    def __init__(self, min_delay_sec: float = 0.5):
        """
        Initialize extractor with rate limiting.
        
        Args:
            min_delay_sec: Minimum seconds between API calls (default 0.5)
        """
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (compatible; HikingPhotoBot/1.0)",
            "Accept-Language": "en-US",
        })
        self.min_delay = min_delay_sec
        self.last_request_time = 0
    
    def _rate_limit_wait(self) -> None:
        """Enforce minimum delay between requests"""
        elapsed = time.time() - self.last_request_time
        if elapsed < self.min_delay:
            time.sleep(self.min_delay - elapsed)
        self.last_request_time = time.time()
    
    def get_file_by_name(self, filename: str) -> Optional[ImageMetadata]:
        """
        Get image URL and metadata from Wikimedia Commons.
        
        Args:
            filename: Exact filename (e.g., "Säntis_2502.jpg")
        
        Returns:
            ImageMetadata with URL or None if not found
        """
        self._rate_limit_wait()
        
        # Query imageinfo for direct URL
        params = {
            "action": "query",
            "titles": f"File:{filename}",
            "prop": "imageinfo|extracts",
            "iiprop": "url|commonmetadata|extmetadata",
            "format": "json",
        }
        
        try:
            resp = self.session.get(self.BASE_URL, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            
            # Find file in response
            pages = data.get("query", {}).get("pages", {})
            for page_id, page_data in pages.items():
                if "imageinfo" not in page_data:
                    continue
                
                imageinfo = page_data["imageinfo"][0]
                url = imageinfo.get("url")
                
                # Extract license and creator
                license_info = self._extract_license(imageinfo)
                creator = self._extract_creator(imageinfo)
                
                if not license_info or license_info not in self.SAFE_LICENSES:
                    print(f"⚠️  Skipping {filename}: license {license_info} not in safe list")
                    return None
                
                return ImageMetadata(
                    url=url,
                    source="Wikimedia Commons",
                    filename=filename,
                    license=license_info,
                    creator=creator or "Unknown",
                    retrieved_date=datetime.now().isoformat(),
                    attribution_required=True,
                )
        
        except requests.RequestException as e:
            print(f"❌ Error fetching {filename}: {e}")
            return None
    
    def search_by_peak_name(self, peak_name: str, limit: int = 5) -> List[ImageMetadata]:
        """
        Search Commons for images of a specific peak.
        
        Args:
            peak_name: Peak name (e.g., "Säntis", "Appenzell Alps")
            limit: Max results (default 5)
        
        Returns:
            List of ImageMetadata for peak images
        """
        self._rate_limit_wait()
        
        params = {
            "action": "query",
            "list": "search",
            "srsearch": f"{peak_name} peak mountain photo",
            "srnamespace": "6",  # File namespace
            "srlimit": limit,
            "format": "json",
        }
        
        try:
            resp = self.session.get(self.BASE_URL, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            
            results = []
            search_results = data.get("query", {}).get("search", [])
            
            for result in search_results:
                filename = result.get("title", "").replace("File:", "")
                if filename:
                    metadata = self.get_file_by_name(filename)
                    if metadata:
                        metadata.peak_name = peak_name
                        results.append(metadata)
            
            return results
        
        except requests.RequestException as e:
            print(f"❌ Error searching for {peak_name}: {e}")
            return []
    
    def validate_url(self, url: str) -> bool:
        """
        Check if image URL is still valid and accessible.
        
        Args:
            url: Image URL to validate
        
        Returns:
            True if URL returns 200 OK
        """
        self._rate_limit_wait()
        
        try:
            resp = self.session.head(url, timeout=5)
            return resp.status_code == 200
        except requests.RequestException:
            return False
    
    @staticmethod
    def _extract_license(imageinfo: Dict) -> Optional[str]:
        """Extract license from imageinfo response"""
        # Check commonmetadata first (structured data)
        commonmeta = imageinfo.get("commonmetadata", [])
        for meta in commonmeta:
            if meta.get("name") == "License":
                return meta.get("value")
        
        # Fallback to extmetadata
        extmeta = imageinfo.get("extmetadata", {})
        license_obj = extmeta.get("LicenseShortName")
        if license_obj:
            return license_obj.get("value")
        
        return None
    
    @staticmethod
    def _extract_creator(imageinfo: Dict) -> Optional[str]:
        """Extract creator from imageinfo response"""
        extmeta = imageinfo.get("extmetadata", {})
        artist = extmeta.get("Artist", {})
        return artist.get("value")


class WikipediaImageExtractor:
    """
    Extract Wikimedia files linked from Wikipedia peak articles.
    
    Rate limits: ~500 req/hour (generous)
    Licensing: Always clear (inherits from Wikimedia)
    """
    
    WIKI_BASE = "https://en.wikipedia.org/w/api.php"
    
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (compatible; HikingPhotoBot/1.0)",
        })
        self.commons_extractor = WikimediaImageExtractor()
    
    def get_files_from_peak_article(self, peak_name: str) -> List[ImageMetadata]:
        """
        Get all images embedded in Wikipedia peak article.
        
        Args:
            peak_name: Wikipedia article title (e.g., "Säntis")
        
        Returns:
            List of ImageMetadata for images in article
        """
        # Query for images on Wikipedia page
        params = {
            "action": "query",
            "titles": peak_name,
            "prop": "images",
            "format": "json",
        }
        
        try:
            resp = self.session.get(self.WIKI_BASE, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            
            pages = data.get("query", {}).get("pages", {})
            results = []
            
            for page_id, page_data in pages.items():
                images = page_data.get("images", [])
                
                for image in images:
                    filename = image.get("title", "").replace("File:", "")
                    
                    # Get metadata from Commons
                    metadata = self.commons_extractor.get_file_by_name(filename)
                    if metadata:
                        metadata.peak_name = peak_name
                        results.append(metadata)
            
            return results
        
        except requests.RequestException as e:
            print(f"❌ Error fetching Wikipedia page {peak_name}: {e}")
            return []


class SwissTourismImageFetcher:
    """
    Extract from Swiss tourism .ch sites.
    
    Rate limits: Not officially enforced; ~3–5 req/sec safe
    Licensing: Varies; always check site
    curl safe: Generally yes (except JavaScript-heavy sites)
    """
    
    def __init__(self, min_delay_sec: float = 0.5):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (compatible; HikingPhotoBot/1.0)",
        })
        self.min_delay = min_delay_sec
        self.last_request_time = 0
    
    def _rate_limit_wait(self) -> None:
        """Enforce minimum delay between requests"""
        elapsed = time.time() - self.last_request_time
        if elapsed < self.min_delay:
            time.sleep(self.min_delay - elapsed)
        self.last_request_time = time.time()
    
    def validate_swiss_image_url(self, url: str) -> bool:
        """
        Check if Swiss tourism image URL is accessible.
        
        Note: Swiss sites rarely block direct access; validate headers.
        """
        if not url.endswith(".ch"):
            print("⚠️  Warning: URL may not be from Swiss domain")
        
        self._rate_limit_wait()
        
        try:
            resp = self.session.head(url, timeout=5)
            return resp.status_code in [200, 304]  # 304 Not Modified is OK
        except requests.RequestException:
            return False


# ============================================================================
# Example Usage
# ============================================================================

if __name__ == "__main__":
    print("=" * 70)
    print("Bot-Safe Image URL Extraction Examples")
    print("=" * 70)
    
    # Example 1: Wikimedia Commons direct file lookup
    print("\n[Example 1] Wikimedia Commons — Direct Lookup")
    print("-" * 70)
    
    commons = WikimediaImageExtractor(min_delay_sec=1.0)
    
    # Search for a known peak image
    metadata = commons.get_file_by_name("Säntis_Säntis_from_the_east_20060901.jpg")
    if metadata:
        print(f"✅ Found: {metadata.filename}")
        print(f"   URL: {metadata.url}")
        print(f"   License: {metadata.license}")
        print(f"   Creator: {metadata.creator}")
        print(f"   Attribution required: {metadata.attribution_required}")
    else:
        print("❌ File not found (may not exist)")
    
    # Example 2: Search Commons for peak images
    print("\n[Example 2] Wikimedia Commons — Search by Peak Name")
    print("-" * 70)
    
    results = commons.search_by_peak_name("Appenzell Alps", limit=3)
    print(f"Found {len(results)} images:")
    for img in results:
        print(f"  • {img.filename} ({img.license})")
    
    # Example 3: Wikipedia peak article → Commons files
    print("\n[Example 3] Wikipedia → Wikimedia Commons")
    print("-" * 70)
    
    wiki_extractor = WikipediaImageExtractor()
    wiki_images = wiki_extractor.get_files_from_peak_article("Säntis")
    print(f"Found {len(wiki_images)} images from Säntis Wikipedia article:")
    for img in wiki_images:
        print(f"  • {img.filename} ({img.license})")
    
    # Example 4: Validate image URLs
    print("\n[Example 4] URL Validation")
    print("-" * 70)
    
    test_url = "https://upload.wikimedia.org/wikipedia/commons/e/e4/Appenzell_2000.jpg"
    is_valid = commons.validate_url(test_url)
    print(f"URL valid: {is_valid}")
    
    # Example 5: Store metadata for later use
    print("\n[Example 5] Metadata Storage (for database)")
    print("-" * 70)
    
    if metadata:
        record = {
            "url": metadata.url,
            "source": metadata.source,
            "filename": metadata.filename,
            "license": metadata.license,
            "creator": metadata.creator,
            "peak_name": metadata.peak_name,
            "retrieved_date": metadata.retrieved_date,
            "attribution_required": metadata.attribution_required,
        }
        print(json.dumps(record, indent=2))
    
    print("\n" + "=" * 70)
    print("✅ All examples completed successfully!")
    print("=" * 70)
