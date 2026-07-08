(function () {
  var ORIGIN = 'https://fic-tracker.pages.dev';
  function finish(path) { completion(path ? (ORIGIN + path) : ''); }

  var RATING_MAP = { 'Not Rated': 'NR', 'General Audiences': 'G', 'Teen And Up Audiences': 'T', 'Mature': 'M', 'Explicit': 'E' };
  var MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

  function txt(el) { return el ? el.textContent.trim() : ''; }
  function tagList(li, cls) {
    return Array.from(li.querySelectorAll('ul.tags.commas li.' + cls + ' a.tag')).map(function (a) { return a.textContent.trim(); });
  }
  function parseDate(s) {
    var m = s.match(/(\d+)\s+(\w+)\s+(\d{4})/);
    if (!m) return null;
    var mn = MONTHS[m[2]] || '01';
    return m[3] + '-' + mn + '-' + ('0' + m[1]).slice(-2);
  }

  var isSeriesPage = /^\/series\/\d+/.test(location.pathname);
  var seriesPageTitle = '';
  var seriesPageLink = '';
  if (isSeriesPage) {
    var sTitleEl = document.querySelector('h2.heading');
    seriesPageTitle = sTitleEl ? sTitleEl.textContent.trim() : '';
    var sIdMatch = location.pathname.match(/\/series\/(\d+)/);
    seriesPageLink = sIdMatch ? 'https://archiveofourown.org/series/' + sIdMatch[1] : '';
  }

  var seriesPageCompleted = null;
  var seriesPageDescription = '';
  if (isSeriesPage) {
    var allDts = document.querySelectorAll('dt');
    for (var di = 0; di < allDts.length; di++) {
      var dtTxt = allDts[di].textContent.trim();
      if (dtTxt === 'Complete:') {
        var cdd = allDts[di].nextElementSibling;
        if (cdd && cdd.tagName === 'DD') {
          var ctxt = cdd.textContent.trim();
          seriesPageCompleted = ctxt === 'Yes' ? true : (ctxt === 'No' ? false : null);
        }
      } else if (dtTxt === 'Description:') {
        var ddd = allDts[di].nextElementSibling;
        if (ddd && ddd.tagName === 'DD') {
          var bq = ddd.querySelector('blockquote');
          seriesPageDescription = (bq || ddd).textContent.trim();
        }
      }
    }
  }

  var seriesPageIdx = 0;
  var entries = document.querySelectorAll('li.work.blurb.group,li.bookmark.blurb.group');
  if (!entries.length) { finish(''); return; }

  var works = [];
  entries.forEach(function (li) {
    var workId = null;
    var im = li.id.match(/work_(\d+)/);
    if (im) workId = im[1];
    else {
      var cm = li.className.match(/work-(\d+)/);
      if (cm) workId = cm[1];
    }
    if (!workId) return;

    var titleEl = li.querySelector('h4.heading a:not([rel="author"])');
    var title = titleEl ? titleEl.textContent.trim() : '';
    if (!title) return;

    var authorEl = li.querySelector('h4.heading a[rel="author"]');
    var ratingSpan = li.querySelector('ul.required-tags span[class*="rating-"]');
    var ratingTxt = ratingSpan ? ratingSpan.getAttribute('title') : '';
    var rating = RATING_MAP[ratingTxt] || null;
    var statusSpan = li.querySelector('ul.required-tags span[class*="complete-"]');
    var ficStatus = statusSpan ? (statusSpan.getAttribute('title') === 'Complete Work' ? 'Complete' : 'WIP') : null;
    var wordsEl = li.querySelector('dd.words');
    var wordCount = wordsEl ? parseInt(wordsEl.textContent.replace(/,/g, '')) || 0 : 0;
    var chapEl = li.querySelector('dd.chapters');
    var chapM = (chapEl ? chapEl.textContent.trim() : '').match(/(\d+)\/(\d+|\?)/);
    var chapterCurrent = chapM ? parseInt(chapM[1]) : null;
    var chapterTotal = chapM ? (chapM[2] === '?' ? null : parseInt(chapM[2])) : null;
    if (!ficStatus && chapterTotal) ficStatus = chapterCurrent === chapterTotal ? 'Complete' : 'WIP';

    var dateEl = li.querySelector('p.datetime');
    var dateStr = parseDate(txt(dateEl));
    var summaryEl = li.querySelector('blockquote.userstuff.summary');
    var summary = summaryEl ? summaryEl.textContent.trim().slice(0, 250) : '';

    var seriesName = null, seriesPosition = null, seriesLink = null;
    if (isSeriesPage) {
      seriesName = seriesPageTitle || null;
      seriesPageIdx++;
      seriesPosition = seriesPageIdx;
      seriesLink = seriesPageLink || null;
    } else {
      var seriesLi = li.querySelector('ul.series li');
      if (seriesLi) {
        var pm = seriesLi.textContent.match(/Part\s+(\d+)\s+of/);
        var sl = seriesLi.querySelector('a');
        seriesPosition = pm ? parseInt(pm[1]) : null;
        seriesName = sl ? sl.textContent.trim() : null;
        if (sl) {
          var href3 = sl.getAttribute('href') || '';
          seriesLink = href3.indexOf('http') === 0 ? href3 : 'https://archiveofourown.org' + href3;
        }
      }
    }

    works.push({
      link: 'https://archiveofourown.org/works/' + workId,
      title: title, author: txt(authorEl),
      fandoms: Array.from(li.querySelectorAll('h5.fandoms.heading a.tag')).map(function (a) { return a.textContent.trim(); }),
      relationships: tagList(li, 'relationships'), characters: tagList(li, 'characters'),
      rating: rating, warnings: tagList(li, 'warnings'), wordCount: wordCount,
      chapterCurrent: chapterCurrent, chapterTotal: chapterTotal, ficStatus: ficStatus,
      dateStarted: dateStr, dateFinished: ficStatus === 'Complete' ? dateStr : null,
      lastUpdated: ficStatus !== 'Complete' ? dateStr : null,
      summary: summary, tags: tagList(li, 'freeforms'),
      seriesName: seriesName, seriesPosition: seriesPosition, seriesLink: seriesLink
    });
  });

  if (!works.length) { finish(''); return; }

  var pageTitleEl = document.querySelector('h2.heading');
  var payload = {
    works: works,
    sourceTitle: pageTitleEl ? pageTitleEl.textContent.trim() : '',
    sourcePage: location.href,
    sourceCompleted: seriesPageCompleted,
    sourceDescription: seriesPageDescription
  };
  var json = JSON.stringify(payload);
  var encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(json))));

  if (encoded.length > 60000) {
    works.forEach(function (w) { w.summary = ''; });
    json = JSON.stringify({ works: works, sourceTitle: payload.sourceTitle, sourcePage: payload.sourcePage });
    encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(json))));
  }

  finish('/?addBulk=' + encoded);
})();
