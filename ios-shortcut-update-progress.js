(function () {
  var ORIGIN = 'https://fic-tracker.pages.dev';
  function finish(path) { completion(path ? (ORIGIN + path) : ''); }

  var m = location.pathname.match(/\/works\/(\d+)/);
  if (!m) { finish(''); return; }
  var workId = m[1];
  var canonicalUrl = 'https://archiveofourown.org/works/' + workId;
  var currentUrl = location.href.split('#')[0];

  var chapterNum = null;

  // 1) The chapter-select dropdown (only present on multi-chapter works, chapter-by-chapter view)
  var sel = document.querySelector('select#selected_id');
  if (sel && sel.selectedIndex >= 0) {
    var opt = sel.options[sel.selectedIndex];
    if (opt) {
      var om = opt.textContent.match(/^\s*(\d+)\s*\./);
      if (om) chapterNum = parseInt(om[1]);
    }
  }

  // 2) Any chapter-title heading on the page (AO3 always renders these as h3.title, but
  //    doesn't consistently wrap them in the same ancestor markup, so search broadly rather
  //    than pinning to one specific parent selector).
  if (!chapterNum) {
    var h3s = document.querySelectorAll('h3.title');
    for (var i = 0; i < h3s.length; i++) {
      var hm = h3s[i].textContent.match(/Chapter\s+(\d+)/i);
      if (hm) { chapterNum = parseInt(hm[1]); break; }
    }
  }

  // 3) document.title usually includes "Chapter N" too — cheap extra fallback.
  if (!chapterNum && document.title) {
    var tm = document.title.match(/Chapter\s+(\d+)/i);
    if (tm) chapterNum = parseInt(tm[1]);
  }

  // 4) Not a /chapters/ URL at all (oneshot, or "entire work" view) — treat as chapter 1.
  if (!chapterNum && !/\/chapters\//.test(location.pathname)) {
    chapterNum = 1;
  }

  var data = { link: canonicalUrl, chapterUrl: currentUrl };
  if (chapterNum) data.chapterNumber = chapterNum;
  // If we truly couldn't detect a chapter number, we still send link + chapterUrl with no
  // chapterNumber field — the app leaves your progress count untouched in that case rather
  // than silently resetting it, but still records where you were reading and opens instead
  // of dead-ending with nothing to open at all.

  var json = JSON.stringify(data);
  var encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(json))));
  finish('/?updateProgress=' + encoded);
})();
