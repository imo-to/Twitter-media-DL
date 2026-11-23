// injected.js — MAINワールドで動作。fetch/XHRを傍受してTwitterの画像/動画URLを抽出する

(function () {
  if (window.__mediadlInjected) return;
  window.__mediadlInjected = true;

  const MEDIA_CHANNEL = '__mediadl_media__';

  const ENDPOINTS = [
    'TweetDetail', 'TweetResultByRestId',
    'HomeTimeline', 'HomeLatestTimeline',
    'SearchTimeline', 'UserTweets', 'UserTweetsAndReplies',
    'Likes', 'ListLatestTweetsTimeline',
  ];

  function isTarget(url) {
    return typeof url === 'string' && ENDPOINTS.some(ep => url.includes(ep));
  }

  // JSON から各ツイートの extended_entities.media（photo, video）を
  // ツイートID単位でまとめて再帰抽出（深さ制限付き）
  function extractPhotosByTweet(obj, depth, out) {
    if (depth > 20 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) extractPhotosByTweet(item, depth + 1, out);
      return;
    }
    const tweetId = obj.id_str || obj.rest_id || null;
    const extEntities = obj.extended_entities
      || (obj.legacy && obj.legacy.extended_entities);
    if (tweetId && extEntities && Array.isArray(extEntities.media)) {
      const photos = extEntities.media
        .filter(m => m.type === 'photo' && m.media_url_https)
        .map(m => m.media_url_https);
      const videos = extEntities.media
        .filter(m => m.type === 'video' || m.type === 'animated_gif')
        .map(m => {
          // videoとanimated_gifの両方でvariantsからMP4を抽出
          const variants = m.video_info?.variants || [];
          const mp4Variants = variants.filter(v => v.content_type === 'video/mp4');
          if (mp4Variants.length === 0) return null;
          // bitrateが最大のものを選択（animated_gifはbitrateが0または未定義のケースがある）
          mp4Variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          return mp4Variants[0]?.url || null;
        })
        .filter(url => url !== null);
      if (photos.length || videos.length) {
        out.push({ tweetId, photos, videos });
      }
    }
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === 'object') extractPhotosByTweet(val, depth + 1, out);
    }
  }

  function dispatch(json) {
    try {
      const photoGroups = [];
      extractPhotosByTweet(json, 0, photoGroups);
      if (photoGroups.length) {
        window.dispatchEvent(new CustomEvent(MEDIA_CHANNEL, { detail: photoGroups }));
      }
    } catch (_) {}
  }

  // fetch をラップ
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const res = await _fetch.apply(this, args);
    if (isTarget(url)) {
      try { res.clone().json().then(dispatch).catch(() => {}); } catch (_) {}
    }
    return res;
  };

  // XMLHttpRequest をラップ
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._xdlUrl = url || '';
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (isTarget(this._xdlUrl)) {
      this.addEventListener('load', function () {
        try { dispatch(JSON.parse(this.responseText)); } catch (_) {}
      });
    }
    return _send.apply(this, arguments);
  };
})();
