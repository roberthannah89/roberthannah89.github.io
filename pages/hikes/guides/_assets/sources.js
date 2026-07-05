// Populate the photographer + route-author grids on the sources page from
// window.PHOTO_CREDITS / window.ROUTE_AUTHOR_CREDITS / window.CREDIT_TOTALS
// (all emitted by scripts/gen_credits.py into guides/sources-credits.js).
//
// Also picks a random photographer's sample as the hero image so the page
// feels alive from run to run.

(function () {
  var photos = window.PHOTO_CREDITS || [];
  var authors = window.ROUTE_AUTHOR_CREDITS || [];
  var totals = window.CREDIT_TOTALS || {};

  var FEATURED_PHOTO_COUNT = 12;   // photographer cards with sample thumbnails
  var HERO_POOL_TOP_N = 8;         // pick hero from top N photographers

  // Hero image + credit
  if (photos.length) {
    var pool = photos.slice(0, Math.min(HERO_POOL_TOP_N, photos.length));
    var choice = pool[Math.floor(Math.random() * pool.length)];
    var img = document.getElementById("hero-photo");
    var caption = document.getElementById("hero-credit");
    if (img && choice.sample && choice.sample.url) {
      img.src = choice.sample.url;
      img.alt = choice.sample.alt || "";
    }
    if (caption && choice.sample) {
      var hikeHref = "../routes/" + choice.sample.hike_slug + "/" + choice.sample.hike_slug + ".html";
      caption.innerHTML =
        "© " + escapeHtml(choice.name) +
        (choice.sample.credit_date ? " · " + escapeHtml(choice.sample.credit_date) : "") +
        " · <a href=\"" + hikeHref + "\">" + escapeHtml(choice.sample.hike_name) + "</a>";
    }
  }

  // Section counts
  setText("ph-count",
    (totals.photographers || photos.length) + " photographers · " +
    (totals.photos || 0) + " photos across " +
    (totals.hikes || 0) + " hikes"
  );
  setText("ra-count",
    (totals.route_authors || authors.length) + " authors · " +
    (totals.hikes || 0) + " hikes"
  );

  // Photographer grid — featured cards with sample thumbnails
  var grid = document.getElementById("photo-grid");
  if (grid) {
    var featured = photos.slice(0, FEATURED_PHOTO_COUNT);
    featured.forEach(function (p) {
      grid.appendChild(renderPhotoCard(p));
    });
    var tail = photos.slice(FEATURED_PHOTO_COUNT);
    var tailNode = document.getElementById("photo-tail");
    if (tailNode && tail.length) {
      tailNode.innerHTML = "Plus " + tail.length + " more: " +
        tail.map(function (p) {
          return "<span class=\"name\">" + escapeHtml(p.name) +
                 " <em style=\"color:var(--fg-dim);font-style:normal\">·&nbsp;" + p.count + "</em></span>";
        }).join(" ");
    }
  }

  // Route author grid — portrait + bio
  var authorGrid = document.getElementById("author-grid");
  if (authorGrid) {
    authors.forEach(function (a) {
      authorGrid.appendChild(renderAuthorCard(a));
    });
  }

  // -----------------------------------------------------------------

  function renderPhotoCard(p) {
    var card = document.createElement("article");
    card.className = "credit-card";
    var href = p.sample && p.sample.hike_slug
      ? "../routes/" + p.sample.hike_slug + "/" + p.sample.hike_slug + ".html"
      : null;
    var inner =
      "<div class=\"credit-card-photo\"" +
        (p.sample && p.sample.url ? " style=\"background-image:url('" + p.sample.url + "');\"" : "") +
      "></div>" +
      "<div class=\"credit-card-body\">" +
        "<p class=\"credit-card-name\">" + escapeHtml(p.name) + "</p>" +
        "<p class=\"credit-card-meta\"><span class=\"count\">" + p.count + "</span> photo" +
          (p.count === 1 ? "" : "s") +
          (p.sample && p.sample.hike_name ? " · sample from " + escapeHtml(p.sample.hike_name) : "") +
        "</p>" +
      "</div>";
    if (href) {
      var link = document.createElement("a");
      link.href = href;
      link.setAttribute("title", "See " + p.name + "'s photo on " + p.sample.hike_name);
      link.innerHTML = inner;
      card.appendChild(link);
    } else {
      card.innerHTML = inner;
    }
    return card;
  }

  function renderAuthorCard(a) {
    var card = document.createElement("article");
    card.className = "author-card";
    var bio = a.bio_html || "";
    card.innerHTML =
      "<div class=\"author-portrait\"" +
        (a.portrait_url ? " style=\"background-image:url('" + a.portrait_url + "');\"" : "") +
      "></div>" +
      "<div class=\"author-body\">" +
        "<p class=\"author-name\">" + escapeHtml(a.name) + "</p>" +
        "<p class=\"author-count\"><span class=\"count\">" + a.count + "</span> route" +
          (a.count === 1 ? "" : "s") + " described on SAC</p>" +
        (bio ? "<p class=\"author-bio\">" + bio + "</p>" : "") +
      "</div>";
    return card;
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
})();
