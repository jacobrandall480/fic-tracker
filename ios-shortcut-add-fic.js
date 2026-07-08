(function () {
  var ORIGIN = 'https://fic-tracker.pages.dev';
  function finish(path) { completion(path ? (ORIGIN + path) : ''); }

  var m = location.pathname.match(/\/works\/(\d+)/);
  if (!m) { finish(''); return; }

  var workId = m[1];
  var canonicalUrl = 'https://archiveofourown.org/works/' + workId;

  try {
    var RATING_MAP = { 'Not Rated': 'NR', 'General Audiences': 'G', 'Teen And Up Audiences': 'T', 'Mature': 'M', 'Explicit': 'E' };
    var MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

    function txt(el) { return el ? el.textContent.trim() : ''; }
    function tagList(scope, cls) {
      return Array.from(scope.querySelectorAll('dd.' + cls + ' a.tag, dd.' + cls + ' li a.tag, dd.' + cls + ' li.' + cls + ' a.tag'))
        .map(function (a) { return a.textContent.trim(); });
    }
    function parseAo3Date(str) {
      if (!str) return null;
      str = str.trim();
      var iso = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
      var mm = str.match(/(\d+)\s+(\w+)\s+(\d{4})/);
      if (!mm) return null;
      var mon = MONTHS[mm[2]] || '01';
      return mm[3] + '-' + mon + '-' + ('0' + mm[1]).slice(-2);
    }
    function ddAfterDt(label) {
      var dts = document.querySelectorAll('dl.work.meta.group dt, dl.stats dt');
      for (var i = 0; i < dts.length; i++) {
        if (dts[i].textContent.trim().indexOf(label) === 0) {
          var dd = dts[i].nextElementSibling;
          if (dd && dd.tagName === 'DD') return dd;
        }
      }
      return null;
    }

    var titleEl = document.querySelector('h2.title.heading');
    var title = titleEl ? titleEl.textContent.trim() : '';
    var authorEl = document.querySelector('a[rel="author"]');
    var author = authorEl ? authorEl.textContent.trim() : '';
    if (!title || !author) { finish('/?add=' + encodeURIComponent(canonicalUrl)); return; }

    var summaryEl = document.querySelector('div.summary.module blockquote.userstuff');
    var summary = summaryEl ? summaryEl.textContent.trim().slice(0, 800) : '';

    var ratingDd = ddAfterDt('Rating');
    var ratingTag = ratingDd ? ratingDd.querySelector('a.tag') : null;
    var rating = ratingTag ? (RATING_MAP[ratingTag.textContent.trim()] || null) : null;

    var warningsDd = ddAfterDt('Archive Warning');
    var warnings = warningsDd ? Array.from(warningsDd.querySelectorAll('a.tag')).map(function (a) { return a.textContent.trim(); }) : [];
    var fandomDd = ddAfterDt('Fandom');
    var fandoms = fandomDd ? Array.from(fandomDd.querySelectorAll('a.tag')).map(function (a) { return a.textContent.trim(); }) : [];
    var relDd = ddAfterDt('Relationship');
    var relationships = relDd ? Array.from(relDd.querySelectorAll('a.tag')).map(function (a) { return a.textContent.trim(); }) : [];
    var charDd = ddAfterDt('Character');
    var characters = charDd ? Array.from(charDd.querySelectorAll('a.tag')).map(function (a) { return a.textContent.trim(); }) : [];
    var freeDd = ddAfterDt('Additional Tags');
    var tags = freeDd ? Array.from(freeDd.querySelectorAll('a.tag')).map(function (a) { return a.textContent.trim(); }) : [];

    var wordsDd = document.querySelector('dl.stats dd.words');
    var wordCount = wordsDd ? parseInt(wordsDd.textContent.replace(/[^\d]/g, '')) || 0 : 0;

    var chaptersDd = document.querySelector('dl.stats dd.chapters');
    var chapText = chaptersDd ? chaptersDd.textContent.trim() : '';
    var chapM = chapText.match(/(\d+)\/(\d+|\?)/);
    var chapterCurrent = chapM ? parseInt(chapM[1]) : null;
    var chapterTotal = chapM ? (chapM[2] === '?' ? null : parseInt(chapM[2])) : null;
    var ficStatus = (chapterTotal && chapterCurrent === chapterTotal) ? 'Complete' : (chapterTotal ? 'WIP' : null);

    var publishedDd = ddAfterDt('Published');
    var completedDd = ddAfterDt('Completed');
    var updatedDd = ddAfterDt('Updated');
    var published = publishedDd ? parseAo3Date(txt(publishedDd)) : null;
    var completed = completedDd ? parseAo3Date(txt(completedDd)) : null;
    var updatedRaw = updatedDd ? parseAo3Date(txt(updatedDd)) : null;

    var dateStarted = published, dateFinished = null, lastUpdated = null;
    if (chapterTotal === 1) {
      dateFinished = published;
    } else if (ficStatus === 'Complete') {
      dateFinished = completed || published;
    } else {
      lastUpdated = updatedRaw || published;
    }

    var seriesDd = ddAfterDt('Series');
    var seriesList = [];
    if (seriesDd) {
      var posSpans = seriesDd.querySelectorAll('span.position');
      for (var psi = 0; psi < posSpans.length; psi++) {
        var ps = posSpans[psi];
        var pm2 = ps.textContent.match(/Part\s*(\d+)\s*of/);
        var sl2 = ps.querySelector('a');
        if (sl2) {
          var href2 = sl2.getAttribute('href') || '';
          var link2 = href2.indexOf('http') === 0 ? href2 : 'https://archiveofourown.org' + href2;
          seriesList.push({ name: sl2.textContent.trim(), position: pm2 ? parseInt(pm2[1]) : null, link: link2 });
        }
      }
    }
    var seriesName = seriesList.length > 0 ? seriesList[0].name : null;
    var seriesPosition = seriesList.length > 0 ? seriesList[0].position : null;

    var data = {
      link: canonicalUrl, title: title, author: author,
      fandoms: fandoms, relationships: relationships, characters: characters,
      rating: rating, warnings: warnings, wordCount: wordCount,
      chapterCurrent: chapterCurrent, chapterTotal: chapterTotal, ficStatus: ficStatus,
      dateStarted: dateStarted, dateFinished: dateFinished, lastUpdated: lastUpdated,
      summary: summary, tags: tags,
      seriesName: seriesName, seriesPosition: seriesPosition, seriesList: seriesList
    };

    var json = JSON.stringify(data);
    var encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(json))));
    finish('/?addData=' + encoded);
  } catch (e) {
    finish('/?add=' + encodeURIComponent(canonicalUrl));
  }
})();
