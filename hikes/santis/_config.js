// hikes/_config.js
// Shared config for all hike-plan pages. Optional — pages work without it
// (the iframe-embedded transit map disappears; deep-link buttons remain).
// Provision a Google Maps Embed API key in Google Cloud Console, restrict it
// to HTTP referrers http://localhost:*/* and file:///*, then paste below.
window.HIKING_CONFIG = {
  mapsApiKey: "",                // empty = no embedded transit iframe
  defaultOrigin: "Zürich HB"     // origin for transit directions
};
