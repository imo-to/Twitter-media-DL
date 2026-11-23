// content.js - Media DL拡張機能
// Twitterおよび一般ウェブサイトからのメディアダウンロード機能

(async function () {
  if (window.__mediadl_injected?.active) return;
  window.__mediadl_injected = { active: true };
  const gate = await chrome.storage.local.get([
    'disabledTwitter', 'siteOverrides',
    'hoverButtonPosition', 'textSaveFormat', 'minImageSize'
  ]);
  const globallyEnabled = !gate.disabledTwitter;
  const override = (gate.siteOverrides || {})[location.hostname];
  const enabled = override !== undefined ? override : globallyEnabled;
  if (!enabled) {
    window.__mediadl_injected.active = false;
    return;
  }

  let minImageSize = Number.isFinite(gate.minImageSize) && gate.minImageSize > 0
    ? gate.minImageSize : 80;

  // ホバー/モーダルDLボタンの表示位置。
  //   'bottom-right'（デフォルト）/ 'top-right' / 'bottom-left' / 'top-left'
  const VALID_BTN_POS = new Set(['bottom-right', 'top-right', 'bottom-left', 'top-left']);
  let hoverButtonPosition = VALID_BTN_POS.has(gate.hoverButtonPosition) ? gate.hoverButtonPosition : 'bottom-right';

  // 文字ツイート保存のデフォルト形式。 'screenshot'（デフォルト）/ 'text'
  let textSaveFormat = gate.textSaveFormat === 'text' ? 'text' : 'screenshot';

  function applyButtonPositionAttr() {
    document.documentElement.setAttribute('data-mediadl-btnpos', hoverButtonPosition);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.hoverButtonPosition) {
      const v = changes.hoverButtonPosition.newValue;
      hoverButtonPosition = VALID_BTN_POS.has(v) ? v : 'bottom-right';
      applyButtonPositionAttr();
    }
    if (changes.textSaveFormat) {
      textSaveFormat = changes.textSaveFormat.newValue === 'text' ? 'text' : 'screenshot';
    }
    if (changes.resetFsHandleRequested) {
      // ポップアップの「保存先フォルダをリセット」から発火
      resetFsParentDirHandle();
    }
    if (changes.minImageSize) {
      const value = changes.minImageSize.newValue;
      minImageSize = Number.isFinite(value) && value > 0 ? value : 80;
      rescanForMinImageSize();
    }
    if (changes.dimMode) {
      // Dimモード変更時にテーマ色を再適用
      window.__mediadl_dimMode = !!changes.dimMode.newValue;
      ThemeSync.applyThemeColor();
    }
    if (changes.disabledTwitter || changes.siteOverrides) {
      chrome.storage.local.get(['disabledTwitter', 'siteOverrides'], settings => {
        const override = (settings.siteOverrides || {})[location.hostname];
        const globallyEnabled = !settings.disabledTwitter;
        const nowEnabled = override !== undefined ? override : globallyEnabled;

        if (!nowEnabled) {
          cleanup();
        } else if (!window.__mediadl_injected?.active) {
          // 無効から有効になった場合は再注入
          window.__mediadl_injected = { active: true };
          processAll();
        }
      });
    }
  });

// ===== SVG（アクションバー用） =====
// currentColorで継承させ、ボタン側から色を制御
const ACTION_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" class="mediadl-action-svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1.25em;height:1.25em;">
  <path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-2"/>
  <path d="M8 11l4 4 4-4"/>
  <path d="M12 3.5v11"/>
</svg>`;

const HOVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
  <path d="M12 2a1 1 0 0 1 1 1v10.586l3.293-3.293a1 1 0 0 1 1.414 1.414l-5 5a1 1 0 0 1-1.414 0l-5-5a1 1 0 0 1 1.414-1.414L11 13.586V3a1 1 0 0 1 1-1zM4 19a1 1 0 1 0 0 2h16a1 1 0 1 0 0-2H4z"/>
</svg>`;

// 文字ツイート保存ボタン用アイコン（文書＋下矢印）
const TEXT_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" class="mediadl-action-svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1.25em;height:1.25em;">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
  <path d="M14 2v6h6"/>
  <path d="M9 15h3"/>
  <path d="M12 12v6"/>
</svg>`;

const ATTR = 'data-mediadl-injected';
const TWITTER_EPOCH = 1288834974657n;

// =====================================================================
// テーマカラー同期モジュール（本ファイルの心臓部）
// -----------------------------------------------------------------------
// 目的:
//   隣接するTwitter純正アイコン（返信/RT/いいね等）の"実描画色"を安定して
//   拾い、全DLボタンに反映する。旧実装のように「注入時1回コピー」では
//   タイミング依存で稀に古い/薄い/未継承値が焼き付いてしまうため、
//   CSS変数を単一の真実の源(single source of truth)とする。
// =====================================================================
const ThemeSync = (() => {
  const ROOT = document.documentElement;
  const VAR_COLOR = '--mediadl-icon-color';

  // 背景色 → アイコン色の対応表（固定値、opacityは常に1固定）
  const BG_TO_ICON_MAP = {
    'rgb(0, 0, 0)': 'rgb(113, 118, 123)',      // ダークモード（黒背景）
    'rgb(255, 255, 255)': 'rgb(83, 100, 113)', // ライトモード（白背景）
  };
  const DIM_COLOR = 'rgb(139, 152, 165)';       // Dimモード時の色
  const FALLBACK_COLOR = 'rgb(113, 118, 123)';

  let lastAppliedColor = null;

  // 背景色を取得（bodyのstyle属性を優先、空ならcomputedStyleにフォールバック）
  function getCurrentBgColor() {
    const bodyStyle = document.body.style.backgroundColor;
    if (bodyStyle && bodyStyle.trim()) {
      return bodyStyle.trim();
    }
    return getComputedStyle(document.body).backgroundColor.trim();
  }

  // 背景色文字列を正規化（空白差異を吸収して数値部分のみ抽出）
  function normalizeColor(colorStr) {
    // rgb(r, g, b) または rgba(r, g, b, a) 形式を正規化
    const match = colorStr.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/);
    if (match) {
      return `rgb(${match[1]}, ${match[2]}, ${match[3]})`;
    }
    return colorStr;
  }

  // 背景色に対応するアイコン色を適用
  function applyThemeColor() {
    // URL末尾が/photo/1の場合は全テーマ共通で白
    if (window.location.href.endsWith('/photo/1')) {
      const photoColor = 'rgb(255, 255, 255)';
      if (lastAppliedColor === photoColor) return;
      ROOT.style.setProperty(VAR_COLOR, photoColor);
      lastAppliedColor = photoColor;
      return;
    }

    const bgColor = normalizeColor(getCurrentBgColor());
    let iconColor = BG_TO_ICON_MAP[bgColor] || FALLBACK_COLOR;

    // Dimモードで黒背景の場合はDim用の色を適用
    if (window.__mediadl_dimMode && bgColor === 'rgb(0, 0, 0)') {
      iconColor = DIM_COLOR;
    }

    // 値が変わっていない場合は再セットしない
    if (lastAppliedColor === iconColor) return;

    ROOT.style.setProperty(VAR_COLOR, iconColor);
    lastAppliedColor = iconColor;
  }

  // 初期化: 即実行 + 背景色変化検知
  function init() {
    // Dimモード設定を読み込み
    chrome.storage.local.get(['dimMode'], (result) => {
      window.__mediadl_dimMode = !!result.dimMode;
      applyThemeColor();
    });

    // documentElementとbodyのattributes（class, style）変化を監視
    const themeObserver = new MutationObserver(() => applyThemeColor());
    themeObserver.observe(ROOT, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-color-mode', 'data-nightmode'],
    });
    if (document.body) {
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    }

    // URL変化を監視（photo/1判定用）
    let lastUrl = window.location.href;
    const urlCheckInterval = setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        applyThemeColor();
      }
    }, 500);
  }

  return {
    init,
    applyThemeColor,
  };
})();

// =====================================================================
// GraphQLメディアキャッシュ
// =====================================================================
const mediadlTweetMediaCache = new Map(); // tweetId -> { photos: [], videos: [] }

// =====================================================================
// セキュリティ: __mediadl_media__ イベントの送信元検証
// -----------------------------------------------------------------------
// このCustomEventはMAIN world(injected.js)からISOLATED world(本ファイル)へ
// window経由で渡されるが、window.dispatchEventはページ内の他スクリプトからも
// 発火可能で送信元を保証できない(CWE-346)。injected.jsが実際に抽出するURLは
// 常にTwitterのメディアCDN(twimg.com、manifest.jsonのhost_permissionsで
// 既に許可されているドメイン)のみのため、それ以外のURLはキャッシュに
// 取り込まない。DOM構造・既存の抽出ロジック・呼び出し側APIは変更しない。
// =====================================================================
const TWIMG_MEDIA_HOST_RE = /^https:\/\/[a-z0-9-]+\.twimg\.com\//i;
function isTrustedMediaUrl(u) {
  return typeof u === 'string' && TWIMG_MEDIA_HOST_RE.test(u);
}

window.addEventListener('__mediadl_media__', (e) => {
  try {
    const groups = e.detail || [];
    groups.forEach(({ tweetId, photos, videos }) => {
      if (!tweetId) return;
      const existing = mediadlTweetMediaCache.get(tweetId) || { photos: [], videos: [] };

      const safePhotos = Array.isArray(photos) ? photos.filter(isTrustedMediaUrl) : [];
      if (safePhotos.length) {
        const mergedPhotos = Array.from(new Set([...existing.photos, ...safePhotos]));
        existing.photos = mergedPhotos;
      }

      const safeVideos = Array.isArray(videos) ? videos.filter(isTrustedMediaUrl) : [];
      if (safeVideos.length) {
        const mergedVideos = Array.from(new Set([...existing.videos, ...safeVideos]));
        existing.videos = mergedVideos;
      }

      if (existing.photos.length || existing.videos.length) {
        mediadlTweetMediaCache.set(tweetId, existing);
      }
    });
  } catch (_) {}
});

function rawMediaUrlToOrig(mediaUrlHttps) {
  const m = mediaUrlHttps.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i);
  const ext = m ? m[1].toLowerCase() : 'jpg';
  const base = mediaUrlHttps.replace(/\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i, '');
  return { url: `${base}?format=${ext}&name=orig`, ext };
}

// ===== ユーティリティ =====
// =====================================================================
// sanitize() 再設計
// -----------------------------------------------------------------------
// 旧実装は #%&{}~`!@$^[]';,+= のような、Windowsでも実際には使用可能な
// 記号まで無差別に "_" へ置換しており、絵文字や記号のみの本文が
// ほぼ全て "_" の羅列に潰れてしまっていた。
// 新実装は「Windowsのファイル名として本当に使用できない文字」だけを
// 置換対象とし、日本語・絵文字・記号・英数字は可能な限りそのまま残す。
//   使用不可: \ / : * ? " < > |  (Windows予約文字)
//   使用不可: 制御文字 (0x00-0x1F, 0x7F)
//   末尾に置けない: "." と半角スペース（Windowsの仕様）
// =====================================================================
const WINDOWS_RESERVED_CHARS = /[\\/:*?"<>|]/g;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

function sanitize(str) {
  if (!str) return '';
  let s = String(str)
    .replace(WINDOWS_RESERVED_CHARS, '_')
    .replace(CONTROL_CHARS, '')
    // 改行・タブ・連続空白は1つの"_"にまとめる（可読性のため）
    .replace(/[ \t\r\n]+/g, '_')
    .replace(/_+/g, '_')
    // 先頭/末尾の"_"、および末尾の"."・空白（Windows非許可）を除去
    .replace(/^_+|_+$/g, '')
    .replace(/[. ]+$/g, '');
  return s;
}

// 文字列を「Unicodeコードポイント単位」で先頭N文字に切り詰める。
// 通常の.slice()はUTF-16のサロゲートペア単位で切るため、絵文字の
// 途中で分断され文字化けする場合がある。Array.fromで分割することで
// サロゲートペア（大半の絵文字を含む）を壊さずに切り詰められる。
function sliceByCodePoint(str, maxLen) {
  const chars = Array.from(str);
  return chars.slice(0, maxLen).join('');
}

function tweetIdToDate(tweetId) {
  if (!tweetId) return null;
  try {
    const id = BigInt(String(tweetId));
    const ms = (id >> 22n) + TWITTER_EPOCH;
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return null;
    return d;
  } catch (_) {
    return null;
  }
}

function formatYYMMDD(d) {
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

// =====================================================================
// ファイル名の「本文部分」を組み立てる
// -----------------------------------------------------------------------
// 本文の状態によって3パターンに分岐する:
//   1) 本文が本当に存在しない（画像のみツイート）
//        → "media" 固定。
//   2) 本文が空白文字のみ
//        → "media" にはせず、空白のみであることが分かる固定文言にする。
//          （空白のみツイートは稀だが、"media" と誤認しないよう区別）
//   3) 本文がある（絵文字のみ・記号のみを含む）
//        → 従来通り本文の先頭20文字（コードポイント単位）を使用。
//          絵文字・記号は削除せずそのまま使う。
// =====================================================================
function buildBodyPart(tweetText, tweetId) {
  const raw = tweetText || '';

  // 1) 本文が本当に存在しない（画像のみツイート）
  if (raw.length === 0) {
    return 'media';
  }

  // 2) 空白文字のみの本文
  if (raw.trim().length === 0) {
    return '空白';
  }

  // 3) 通常の本文（絵文字のみ・記号のみも含む）
  const trimmed = raw.trim();
  const head20 = sliceByCodePoint(trimmed, 20);
  const sanitized = sanitize(head20);
  // 記号のみの本文がWindows予約文字だけで構成されていた等、極めて稀な
  // ケースでsanitize後に空になった場合のみ、フォールバックとして
  // "media"ではなく本文由来であることが分かる文言を使う。
  return sanitized || '本文';
}

// =====================================================================
// 保存ファイル名の統一形式（全ボタン共通・唯一の生成経路）
// -----------------------------------------------------------------------
//   形式:  <ユーザーID>_<投稿日YYMMDD>_<本文先頭20文字>[_連番].<拡張子>
//   例:    O_ayanami_261103_Mococo.jpg
//            （ユーザーID=O_ayanami / 投稿日=2026-11-03 / 本文=Mococo…）
//   ・連番は「そのツイート内に複数メディアがある場合にだけ」ツイート内の
//     順番で付ける。単体保存では付けない。
//   ・画像 / 動画 / スクリーンショット(PNG) / テキスト / モーダル /
//     ホバー / スレッド一括、どのボタンから保存しても必ずこの関数を
//     通すこと（_threadNN やタイムスタンプ等の別形式は作らない）。
//   ・同名衝突時のみ、保存処理側の uniquify が _2 や (1) を付ける。
// =====================================================================
function buildFilename(userId, tweetText, index, ext, tweetId) {
  const posted = tweetIdToDate(tweetId);
  const datePart = formatYYMMDD(posted || new Date());
  const suffix = index != null ? `_${index}` : '';
  const bodyPart = buildBodyPart(tweetText, tweetId);
  return `${sanitize(userId) || 'unknown'}_${datePart}_${bodyPart}${suffix}.${ext}`;
}

// ===== ツイート情報取得 =====
function parseStatusLink(a) {
  const href = a.getAttribute('href') || '';
  let m = href.match(/^\/([^/?#]+)\/status\/(\d+)/);
  if (m) return { userId: m[1], tweetId: m[2] };
  m = (a.href || '').match(/(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)/);
  if (m) return { userId: m[1], tweetId: m[2] };
  return null;
}

// 引用ツイート内に埋め込まれた子 article 等。タイムライン上の独立ツイートではない。
function isNestedTweetArticle(articleEl) {
  let parent = articleEl.parentElement;
  while (parent) {
    if (parent !== articleEl && parent.matches?.('article[data-testid="tweet"]')) return true;
    parent = parent.parentElement;
  }
  return false;
}

function getQuoteTweetContainers(articleEl) {
  const containers = [];
  articleEl.querySelectorAll('[data-testid="quoteTweet"]').forEach(el => containers.push(el));
  articleEl.querySelectorAll('article[data-testid="tweet"]').forEach(el => {
    if (el !== articleEl && articleEl.contains(el)) containers.push(el);
  });
  return containers;
}

function isInsideQuoteEmbed(node, quoteContainers) {
  return quoteContainers.some(c => c.contains(node));
}

function getTweetInfo(articleEl) {
  let userId = 'unknown', tweetText = '', tweetId = null;
  const quoteContainers = getQuoteTweetContainers(articleEl);
  const ctx = getUrlStatusContext();
  const candidates = [];

  articleEl.querySelectorAll('a[href*="/status/"]').forEach(a => {
    if (isInsideQuoteEmbed(a, quoteContainers)) return;
    const parsed = parseStatusLink(a);
    if (parsed) candidates.push(parsed);
  });

  if (ctx && candidates.length) {
    const match = candidates.find(c =>
      String(c.tweetId) === String(ctx.tweetId) &&
      String(c.userId).toLowerCase() === String(ctx.userId).toLowerCase()
    );
    if (match) {
      userId = match.userId;
      tweetId = match.tweetId;
    }
  }

  if (!tweetId && candidates.length) {
    userId = candidates[0].userId;
    tweetId = candidates[0].tweetId;
  }

  if (!tweetId) {
    const m = location.pathname.match(/\/([^/?#]+)\/status\/(\d+)/);
    if (m) {
      if (userId === 'unknown') userId = m[1];
      tweetId = m[2];
    }
  }

  for (const textEl of articleEl.querySelectorAll('[data-testid="tweetText"]')) {
    if (isInsideQuoteEmbed(textEl, quoteContainers)) continue;
    tweetText = textEl.innerText || textEl.textContent || '';
    break;
  }

  return { userId, tweetText, tweetId };
}

// ===== 画像/動画検出 =====
function hasImages(articleEl) {
  // 画像を検出
  const hasPhoto = Array.from(articleEl.querySelectorAll('img[src*="pbs.twimg.com/media/"]')).some(isBigEnough);
  if (hasPhoto) return true;
  
  // 動画を検出（video要素またはdata-testid="video"）
  const hasVideo = articleEl.querySelector('video') || 
                   articleEl.querySelector('[data-testid="videoPlayer"]') ||
                   articleEl.querySelector('[data-testid="video"]');
  if (hasVideo) return true;
  
  // GraphQLキャッシュもチェック（DOMに現れる前の動画検出用）
  const { tweetId } = getTweetInfo(articleEl);
  if (tweetId && mediadlTweetMediaCache.has(tweetId)) {
    const cached = mediadlTweetMediaCache.get(tweetId);
    const videos = Array.isArray(cached) ? [] : (cached.videos || []);
    if (videos.length > 0) return true;
  }
  
  return false;
}

// X側も汎用サイト側と同じ判定を使う。レイアウト前は自然サイズ/属性値にフォールバックする。
function isBigEnough(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width >= minImageSize && rect.height >= minImageSize) return true;
  if (el.naturalWidth && el.naturalHeight) {
    return el.naturalWidth >= minImageSize && el.naturalHeight >= minImageSize;
  }
  const width = parseInt(el.getAttribute('width') || '', 10);
  const height = parseInt(el.getAttribute('height') || '', 10);
  return width >= minImageSize && height >= minImageSize;
}

function getImages(articleEl) {
  const seen = new Set(), items = [];
  articleEl.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach(img => {
    if (!isBigEnough(img)) return;
    let url = img.src.replace(/([?&]name=)[^&]+/, '$1orig');
    if (!/[?&]name=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'name=orig';
    if (seen.has(url)) return;
    seen.add(url);
    const fmt = url.match(/[?&]format=(\w+)/);
    items.push({ url, ext: fmt ? fmt[1] : 'jpg' });
  });
  return items;
}

function getAllImagesForTweet(tweetId, scopeEl) {
  const map = new Map();

  if (scopeEl) {
    scopeEl.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach(img => {
      let url = img.src.replace(/([?&]name=)[^&]+/, '$1orig');
      if (!/[?&]name=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'name=orig';
      const key = url.split('?')[0];
      if (map.has(key)) return;
      const fmt = url.match(/[?&]format=(\w+)/);
      map.set(key, { url, ext: fmt ? fmt[1] : 'jpg' });
    });
  }

  if (tweetId && mediadlTweetMediaCache.has(tweetId)) {
    const cached = mediadlTweetMediaCache.get(tweetId);
    const photos = Array.isArray(cached) ? cached : (cached.photos || []);
    photos.forEach(rawUrl => {
      const { url, ext } = rawMediaUrlToOrig(rawUrl);
      const key = url.split('?')[0];
      if (!map.has(key)) map.set(key, { url, ext });
    });
  }

  return Array.from(map.values());
}

function getAllVideosForTweet(tweetId) {
  if (!tweetId || !mediadlTweetMediaCache.has(tweetId)) return [];
  
  const cached = mediadlTweetMediaCache.get(tweetId);
  const videos = Array.isArray(cached) ? [] : (cached.videos || []);
  
  return videos.map(url => {
    // 動画URLから拡張子を抽出（injected.jsでMP4 URLを返すよう統合済み）
    const extMatch = url.match(/\.(\w+)(?:\?|$)/);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4';
    return { url, ext };
  });
}

// =====================================================================
// スレッド走査ユーティリティ（②③④で共用）
// =====================================================================

// URLが個別ツイート表示（/ユーザー名/status/数字）かどうかを判定し、
// そうであれば {userId, tweetId} を返す。
function getUrlStatusContext() {
  const m = location.pathname.match(/^\/([^/?#]+)\/status\/(\d+)/);
  if (!m) return null;
  return { userId: m[1], tweetId: m[2] };
}

// このarticleが「今開いている個別ツイート表示ページの本体ツイート」
// （＝スレッドの起点）かどうか。
function isMainThreadArticle(articleEl) {
  const ctx = getUrlStatusContext();
  if (!ctx || isNestedTweetArticle(articleEl)) return false;
  const { tweetId, userId } = getTweetInfo(articleEl);
  if (tweetId &&
      String(tweetId) === String(ctx.tweetId) &&
      String(userId).toLowerCase() === String(ctx.userId).toLowerCase()) {
    return true;
  }
  const articles = getPrimaryColumnArticles();
  return articles.length > 0 && articles[0] === articleEl;
}

// 現在ページのメインカラム内の全ツイートarticleを、DOM順（≒表示順）で取得。
function getPrimaryColumnArticles() {
  const col = document.querySelector('div[data-testid="primaryColumn"]') || document.body;
  return Array.from(col.querySelectorAll('article[data-testid="tweet"]'))
    .filter(art => !isNestedTweetArticle(art));
}

// ②用: 投稿者一致のツイートを「打ち切らずに」全て集める。
//   漫画スレ等では、投稿者の連続ツイートの間に他ユーザーの返信が
//   挟まることがあるため、他ユーザーのツイートは単にスキップするだけで
//   走査自体は最後まで続ける。これにより、離れた位置にある投稿者本人の
//   続きツイートも取りこぼさない。他ユーザーの画像は info.userIdが
//   一致しないため、この時点で完全に除外される（誤検知防止）。
function collectAuthorMatchingArticles(authorUserId) {
  return getPrimaryColumnArticles()
    .map(art => ({ art, info: getTweetInfo(art) }))
    .filter(({ info }) => info.userId === authorUserId);
}

// ④用: mainArticleから連続している投稿者本人のツイートだけを集める。
//   他人のツイート（他人の返信、または投稿者による他人への返信の後に
//   割り込む他人のツイート等）に当たった時点で走査を打ち切る、②より
//   保守的な方式。これにより「他人のリプライ」「他人への返信」を
//   確実に除外する（連続が途切れた時点で以降は一切含めない）。
function collectAuthorThreadArticles(mainArticle, authorUserId) {
  const all = getPrimaryColumnArticles();
  const startIdx = all.indexOf(mainArticle);
  if (startIdx === -1) return [];
  const result = [];
  for (let i = startIdx; i < all.length; i++) {
    const info = getTweetInfo(all[i]);
    if (info.userId !== authorUserId) break;
    result.push({ art: all[i], info });
  }
  return result;
}

// Xのタイムラインは仮想化され、スクロール済みのarticleをDOMから捨てる。
// そのため「最後にDOMをまとめて読む」のではなく、画面に現れた時点で投稿情報と
// 画像URLを確定して保持する。スクリーンショット用には同じ進行で可視領域も保存する。
async function collectAuthorThreadWhileScrolling(mainArticle, authorUserId, captureScreenshots = false, options = {}) {
  // strictChain（スクショ通常クリック用）:
  //   本体ツイートの直後から連続する「投稿者本人の、自分へのリプ」
  //   （＝続きのツイート）だけを集める。他人のツイートが1件でも
  //   挟まった時点で打ち切り、以降の投稿者ツイート（他人リプへの
  //   返信など）は含めない。スクショは範囲の縦切り画像になるため、
  //   間に他人が挟まるものを集めると他人のツイートまで写ってしまう。
  //   strictChain でない従来動作（ミドルクリックの一括保存）は、
  //   他人のツイートを飛ばしながら投稿者本人のものを最後まで集める。
  const strictChain = !!(options && options.strictChain);
  const ctx = getUrlStatusContext();
  const mainInfo = getTweetInfo(mainArticle);
  const anchorTweetId = ctx?.tweetId || mainInfo.tweetId;
  if (!anchorTweetId) return { records: [], snapshots: null };

  const records = new Map();
  let snapshots = null;
  if (captureScreenshots) {
    await prepareThreadSnapshotStart(mainArticle);
    snapshots = createThreadSnapshotCollector(mainArticle);
  }
  let unchangedRounds = 0;
  let lastThreadBottom = null;
  let passedMainArticle = false;
  let chainBroken = false;

  // そのツイートの「返信先: @…」表示から宛先ユーザーIDを拾う。
  //   本文中の @メンションと混同しないよう、本文(tweetText)の中は見ず、
  //   「返信先 / Replying to」で始まる短い要素だけを対象にする。
  //   表示が無い場合（スレッド表示では省略されることがある）は空配列。
  const getReplyingToUsers = (article) => {
    let best = null;
    article.querySelectorAll('div, span, a').forEach(el => {
      if (el.closest('[data-testid="tweetText"]')) return;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 120) return;
      // 「返信先: @…」「Replying to @…」型と、「@…さんへの返信」型の両方
      const isReplyContext = /^(返信先|Replying to)/.test(t)
        || (/^@[A-Za-z0-9_]+/.test(t) && /への返信/.test(t));
      if (!isReplyContext) return;
      if (!best || t.length < best.length) best = t;
    });
    if (!best) return [];
    return Array.from(best.matchAll(/@([A-Za-z0-9_]+)/g), m => m[1]);
  };

  // 投稿者本人以外の誰かへの返信なら true（＝続きのツイートではない）。
  const isReplyToOther = (article) => {
    const authorKey = String(authorUserId).toLowerCase();
    return getReplyingToUsers(article).some(u => u.toLowerCase() !== authorKey);
  };

  const collectVisible = () => {
    let changed = false;
    for (const article of getPrimaryColumnArticles()) {
      if (strictChain && chainBroken) break;
      const info = getTweetInfo(article);
      const isAnchor = String(info.tweetId) === String(anchorTweetId);
      if (isAnchor) passedMainArticle = true;
      if (!passedMainArticle) continue;
      if (!info.tweetId || String(info.userId).toLowerCase() !== String(authorUserId).toLowerCase()) {
        // 本体より後ろで「他人のツイートだと確定できるもの」に当たったら、
        // 厳密モードではそこで連投は終わったものとして以降を一切含めない。
        // （IDやユーザーが取れないだけの要素では打ち切らない）
        if (strictChain && !isAnchor && info.tweetId && info.userId && info.userId !== 'unknown') chainBroken = true;
        continue;
      }
      // 本人のツイートでも、他人のリプへの返信は続きツイートではない。
      if (strictChain && !isAnchor && isReplyToOther(article)) {
        chainBroken = true;
        continue;
      }

      const imageMap = new Map();
      getAllImagesForTweet(info.tweetId, article).forEach(image => imageMap.set(image.url.split('?')[0], image));
      
      // 動画も追加
      const videos = getAllVideosForTweet(info.tweetId);
      videos.forEach(video => imageMap.set(video.url.split('?')[0], video));
      
      const existing = records.get(String(info.tweetId));
      if (!existing) {
        records.set(String(info.tweetId), { info, images: imageMap });
        changed = true;
      } else {
        imageMap.forEach((image, key) => {
          if (!existing.images.has(key)) {
            existing.images.set(key, image);
            changed = true;
          }
        });
      }

      const rect = article.getBoundingClientRect();
      if (rect.height > 0) lastThreadBottom = rect.bottom + window.scrollY;
    }
    return changed;
  };

  // 文字ツイート（長文本文）は新しい投稿やアプリケーション画像が
  // 見つからないため、collectVisible()のchangedが早々にfalseのままとなり
  // unchangedRoundsだけで打ち切ると、記事の実際の高さ（lastThreadBottom）に
  // 届く前にスクリーンショットのキャプチャが止まってしまう
  //（＝キャンバス下部が未描画のまま＝「途中で切れる」不具合の原因）。
  // スクショ撮影中は、まだ撮り切れていない範囲が残っている間は
  // unchangedRoundsの条件だけでループを終了させない。
  const captureRemaining = () => {
    if (!snapshots || lastThreadBottom == null) return false;
    return snapshots.getCapturedBottom() < lastThreadBottom - 1;
  };

  for (let round = 0; round < 40 && (unchangedRounds < 3 || captureRemaining()); round++) {
    const changed = collectVisible();
    if (snapshots) await snapshots.captureVisible();
    if (changed) unchangedRounds = 0;
    else unchangedRounds++;

    // 厳密モード: 連投の終わりが見えていて、そこまで撮り切れたら
    // それより下（他人のリプ等）へは進まない。
    if (strictChain && chainBroken && !captureRemaining()) break;

    // 亀裂防止のため、オーバーラップさせてスクロール
    window.scrollBy(0, Math.max(1, Math.floor(window.innerHeight * 0.65)));
    await waitNextFrame();
    await sleep(150);
    // captureVisibleTab の連続呼び出しを従来のスクリーンショットと同じ穏やかな間隔にする。
    await sleep(400);
  }

  // 最終位置で遅延ロード直後の投稿・画像をもう一度取り込む。
  collectVisible();
  if (snapshots) {
    await snapshots.captureVisible();
    snapshots.finish(lastThreadBottom);
  }
  return { records: Array.from(records.values()), snapshots };
}

// ②: スレッド一括画像DL本体
async function downloadThreadImagesBulk(mainArticle, btn) {
  const ctx = getUrlStatusContext();
  if (!ctx) return;

  const originalX = window.scrollX;
  const originalY = window.scrollY;
  try {
    await withButtonLoadingState(btn, async () => {
      const { records: matches } = await collectAuthorThreadWhileScrolling(mainArticle, ctx.userId);
      if (!matches.length) {
        alert('投稿者本人のツイートが見つかりませんでした。');
        return;
      }

      // ツイート順 → ツイート内の画像順、で一列に並べる。
      //   collectAuthorThreadWhileScrolling の images には動画も既に
      //   含まれているため、ここで動画を足し直すと二重保存になる。
      //   ファイル名も一括専用の _threadNN 形式にはせず、他のボタンと
      //   同じ統一形式にする。連番はツイート内の順番（複数メディアの
      //   ときだけ）で、各ツイートの情報をそのまま名前に使う。
      const items = [];
      for (const { info, images } of matches) {
        const seenUrls = new Set();
        const media = Array.from(images.values()).filter(img => {
          const key = String(img.url || '').split('?')[0];
          if (!key || seenUrls.has(key)) return false;
          seenUrls.add(key);
          return true;
        });
        media.forEach((img, i) => {
          items.push({
            url: img.url,
            filename: buildFilename(info.userId, info.tweetText, media.length > 1 ? i + 1 : null, img.ext, info.tweetId),
          });
        });
      }

      if (!items.length) {
        alert('ダウンロード中にエラーが発生しました。ツイートをクリックし、再度ダウンロードをお願いします');
        return;
      }

      // まずフォルダ直接書き込みを試み、失敗したら従来方式にフォールバック
      const fsResult = await saveImagesToLocalFolder(items);
      if (fsResult.success) {
        // スレッド一括DL成功時は各ツイートIDをDL用として記録
        for (const { info } of matches) {
          await savedTweetsIdbSet(info.tweetId, 'dl');
        }
        return;
      }

      for (const it of items) {
        await downloadMedia(it.url, it.filename);
      }
      // フォールバック方式でも成功した場合は各ツイートIDを記録（DL用）
      for (const { info } of matches) {
        await savedTweetsIdbSet(info.tweetId, 'dl');
      }
    });
  } finally {
    window.scrollTo(originalX, originalY);
  }
}

async function downloadMedia(url, filename) {
  // data: URL は chrome.downloads でファイル名指定が無視され
  // 「ダウンロード」という名前になる場合があるため、blob: URL に変換して渡す。
  let blobUrl = null;
  if (typeof url === 'string' && url.startsWith('data:')) {
    try {
      const blob = await (await fetch(url)).blob();
      blobUrl = URL.createObjectURL(blob);
      url = blobUrl;
    } catch (_) {}
  }
  const result = await new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(
        { type: 'DOWNLOAD_MEDIA', payload: { url, filename } },
        res => {
          try {
            if (chrome.runtime.lastError) resolve({ success: false });
            else resolve(res || { success: false });
          } catch (_) {
            resolve({ success: false });
          }
        }
      );
    } catch (_) {
      // 拡張機能の更新/再読み込み直後など、開いたままのタブに残った
      // 古い content script から呼ぶと sendMessage が同期的に例外を
      // 投げる（Extension context invalidated）。requestImageBytes と
      // 同じく、未処理エラーにせず { success: false } として穏やかに
      // 失敗させる。ページを再読み込みすれば新しい script が動く。
      resolve({ success: false });
    }
  });
  if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  return result;
}

// =====================================================================
// ボタン生成
// -----------------------------------------------------------------------
// applyNativeIconAppearance() を廃止。色はCSS変数
// --mediadl-icon-color / --mediadl-icon-opacity から全ボタンが継承。
// ボタン単位の色コピーは行わないので、注入タイミングに一切依存しない。
// 新しいボタンが生成された瞬間、テーマ更新をトリガー(念のためrefresh)
// してCSS変数を最新化する（既に最新なら何もしない冪等操作）。
// =====================================================================
function createNativeActionButton(actionBar, onClick) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-mediadl-wrapper', '1');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'DL');
  btn.setAttribute('role', 'button');
  btn.setAttribute('data-mediadl', 'btn');
  btn.className = 'mediadl-clean';
  btn.innerHTML = ACTION_SVG;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    onClick(e, btn);
  });

  wrapper.appendChild(btn);

  // 挿入直後にテーマ色を適用（冪等・軽量）
  ThemeSync.applyThemeColor();

  return { wrapper, btn };
}

// =====================================================================
// ボタン状態管理ヘルパー
// -----------------------------------------------------------------------
async function withButtonLoadingState(btn, asyncFn) {
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.4';
  }
  try {
    return await asyncFn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '';
    }
  }
}

// =====================================================================
// ミドルクリック一括DLユーティリティ
// -----------------------------------------------------------------------
// 通常クリック＝単体DL、ミドルクリック（ホイールクリック）＝一括DL。
// auxclick で発火し、mousedown では autoscroll 等のデフォルト動作を抑止する。
// =====================================================================
function attachMiddleClickBulk(el, onMiddleClick) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener('auxclick', async (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    await onMiddleClick(e);
  });
}

// =====================================================================
// ツイート内の画像を全て一括DLする共通処理
// -----------------------------------------------------------------------
// 既存のアクションバーボタン（クリック時）と、画像ホバーボタンの
// ミドルクリック（③）の両方から呼ばれる共通ロジック。
// =====================================================================
// =====================================================================
//  File System Access APIによる「フォルダ直接書き込み」一括保存
// -----------------------------------------------------------------------
// ZIPを経由せず、選んだ親フォルダの下に「保存を実行した日」基準の
// 月別サブフォルダ(YYMM)を自動生成し、画像をそのままのファイルとして
// 書き込む。親フォルダの選択ダイアログは初回のみで、以降はIndexedDBに
// 保存したハンドルを再利用する（権限が切れていた場合のみ再確認）。
// 失敗した場合は呼び出し元で従来のchrome.downloads方式にフォールバックする。
// =====================================================================

const FS_DB_NAME = 'mediadl-fs';
const FS_STORE_NAME = 'handles';
const FS_HANDLE_KEY = 'parentDir';
const SAVED_TWEETS_STORE_NAME = 'savedTweets';

function fsIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FS_DB_NAME, 2);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // 既存のhandlesストア（バージョン1で作成）
      if (!db.objectStoreNames.contains(FS_STORE_NAME)) {
        db.createObjectStore(FS_STORE_NAME);
      }
      // 新しいsavedTweetsストア（バージョン2で追加）
      if (!db.objectStoreNames.contains(SAVED_TWEETS_STORE_NAME)) {
        db.createObjectStore(SAVED_TWEETS_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function fsIdbGet(key) {
  const db = await fsIdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE_NAME, 'readonly');
    const req = tx.objectStore(FS_STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function fsIdbSet(key, value) {
  const db = await fsIdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE_NAME, 'readwrite');
    tx.objectStore(FS_STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function fsIdbDelete(key) {
  const db = await fsIdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE_NAME, 'readwrite');
    tx.objectStore(FS_STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 保存済みツイートIDの操作用ヘルパー関数（役割別管理）
async function savedTweetsIdbGet(tweetId, role = 'dl') {
  const db = await fsIdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SAVED_TWEETS_STORE_NAME, 'readonly');
    const key = `${tweetId}_${role}`;
    const req = tx.objectStore(SAVED_TWEETS_STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function savedTweetsIdbSet(tweetId, role = 'dl', value = true) {
  const db = await fsIdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SAVED_TWEETS_STORE_NAME, 'readwrite');
    const key = `${tweetId}_${role}`;
    tx.objectStore(SAVED_TWEETS_STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 親フォルダのハンドルを取得する。IndexedDBに保存済みならそれを使い、
// 権限が切れていれば再確認する。無ければshowDirectoryPicker()で選ばせ、
// 選んだハンドルを保存する。使えない/失敗した場合はnullを返す。
async function getOrPickParentDirHandle() {
  if (!window.showDirectoryPicker) return null;

  let handle = null;
  try {
    handle = await fsIdbGet(FS_HANDLE_KEY);
  } catch (_) { /* IndexedDB未使用可 or 破損 → 選び直しにフォールバック */ }

  if (handle) {
    try {
      let perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        perm = await handle.requestPermission({ mode: 'readwrite' });
      }
      if (perm === 'granted') return handle;
    } catch (_) { /* ハンドル自体が無効になっている等 → 選び直し */ }
  }

  try {
    const picked = await window.showDirectoryPicker({ mode: 'readwrite' });
    await fsIdbSet(FS_HANDLE_KEY, picked);
    return picked;
  } catch (_) {
    return null; // ユーザーがキャンセル、またはユーザー操作起因でないため拒否された等
  }
}

// ポップアップの「保存先フォルダをリセット」から呼ばれる。
async function resetFsParentDirHandle() {
  try { await fsIdbDelete(FS_HANDLE_KEY); } catch (_) {}
}

// 保存を実行した日（=ダウンロード実行日）基準のYYMM文字列。
function formatYYMM(d) {
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${yy}${mm}`;
}

// background.js経由で画像バイト列(base64)を取得する。
// content script自体のfetchはページと同じCORS制限を受けるため、
// host_permissionsでCORSの影響を受けないbackground側に取りに行かせる。
function requestImageBytes(url) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_BYTES', payload: { url } }, res => {
        if (chrome.runtime.lastError) resolve({ success: false });
        else resolve(res || { success: false });
      });
    } catch (_) {
      // 拡張機能がリロードされた直後など、sendMessageが同期的に例外を
      // 投げるケース（Extension context invalidated 等）を吸収し、
      // 他の失敗パターンと同じく { success: false } で穏やかに失敗させる。
      resolve({ success: false });
    }
  });
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 同名ファイルが既にあれば "_2" "_3" ... と番号を振って衝突を避ける
// （chrome.downloadsのconflictAction:'uniquify'相当の挙動）。
async function getUniqueFileHandle(dirHandle, filename) {
  let candidate = filename;
  let n = 1;
  for (;;) {
    try {
      await dirHandle.getFileHandle(candidate, { create: false });
    } catch (_) {
      // 存在しない = このファイル名で新規作成してよい
      return dirHandle.getFileHandle(candidate, { create: true });
    }
    n++;
    const dot = filename.lastIndexOf('.');
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    candidate = `${base}_${n}${ext}`;
  }
}

// items: [{url, filename}] を、選択済み(or選択させた)親フォルダ配下の
// 月別サブフォルダへ書き込む。1件でも失敗したら{success:false}を返し、
// 呼び出し元で従来のchrome.downloads方式へフォールバックできるようにする。
async function saveImagesToLocalFolder(items) {
  const parentHandle = await getOrPickParentDirHandle();
  if (!parentHandle) return { success: false, reason: 'no_handle' };

  let subDir;
  try {
    subDir = await parentHandle.getDirectoryHandle(formatYYMM(new Date()), { create: true });
  } catch (_) {
    return { success: false, reason: 'subdir_failed' };
  }

  for (const item of items) {
    const res = await requestImageBytes(item.url);
    if (!res || !res.success) return { success: false, reason: 'fetch_failed' };
    try {
      const bytes = base64ToUint8Array(res.base64);
      const fileHandle = await getUniqueFileHandle(subDir, item.filename);
      const writable = await fileHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
    } catch (_) {
      return { success: false, reason: 'write_failed' };
    }
  }

  // 保存先フォルダを記録（省略形で）
  try {
    const yymm = formatYYMM(new Date());
    // 省略形で保存（例: Pictures\2607）
    chrome.storage.local.set({
      baseDir: 'Pictures',
      lastRelDir: yymm
    });
  } catch (_) {}

  return { success: true };
}

async function downloadAllImagesForArticle(articleEl, btn) {
  await withButtonLoadingState(btn, async () => {
    const { userId, tweetText, tweetId } = getTweetInfo(articleEl);
    const images = getAllImagesForTweet(tweetId, articleEl);
    const videos = getAllVideosForTweet(tweetId);

    if (!images.length && !videos.length) {
      alert('ダウンロード中にエラーが発生しました。ツイートをクリックし、再度ダウンロードをお願いします');
      return;
    }

    // 画像＋動画を通した連番にする（画像と動画で別々に数えると
    // 同じ名前が重なって uniquify 任せの別形式になってしまうため）。
    const allMedia = [...images, ...videos];
    const items = allMedia.map((item, i) => ({
      url: item.url,
      filename: buildFilename(userId, tweetText, allMedia.length > 1 ? i + 1 : null, item.ext, tweetId),
    }));

    // まずフォルダ直接書き込み（保存ダイアログ1回、月別自動振り分け）
    //   を試み、失敗したら従来のchrome.downloads方式にフォールバックする。
    const fsResult = await saveImagesToLocalFolder(items);
    if (fsResult.success) {
      // 保存成功時にtweetIdを記録（DL用）
      await savedTweetsIdbSet(tweetId, 'dl');
      if (btn) btn.setAttribute('data-mediadl-saved-dl', '1');
      return;
    }

    for (const it of items) {
      await downloadMedia(it.url, it.filename);
    }
    // フォールバック方式でも成功した場合は記録（DL用）
    await savedTweetsIdbSet(tweetId, 'dl');
    if (btn) btn.setAttribute('data-mediadl-saved-dl', '1');
  });
}

// ===== ツイートへのボタン注入 =====
function injectBtn(articleEl) {
  const cur = articleEl.getAttribute(ATTR);
  if (cur === '1' || cur === 'no-media') return;

  const actionBars = articleEl.querySelectorAll('[role="group"]');
  const actionBar = actionBars[actionBars.length - 1] || null;

  if (!actionBar) {
    articleEl.setAttribute(ATTR, 'pending');
    return;
  }

  if (!hasImages(articleEl)) {
    articleEl.setAttribute(ATTR, 'no-media');
    return;
  }

  if (actionBar.querySelector('[data-mediadl-role="download"]')) {
    articleEl.setAttribute(ATTR, '1');
    return;
  }

  articleEl.setAttribute(ATTR, '1');

  // このツイートが「個別ツイート表示ページ」のURL上のツイート本体
  //         （＝スレッドの起点）である場合のみ、ミドルクリックで
  //         スレッド一括DL（そのツイート主による画像をツイート順に
  //         全て集めて保存）を発火できる。
  const { wrapper, btn } = createNativeActionButton(actionBar, async () => {
    await downloadAllImagesForArticle(articleEl, btn);
  });
  btn.title = 'DL';
  attachMiddleClickBulk(btn, async () => {
    if (isMainThreadArticle(articleEl)) {
      await downloadThreadImagesBulk(articleEl, btn);
    } else {
      await downloadAllImagesForArticle(articleEl, btn);
    }
  });
  wrapper.setAttribute('data-mediadl-role', 'download');

  actionBar.appendChild(wrapper);

  // 保存済みチェック（DLボタン用）
  const { tweetId } = getTweetInfo(articleEl);
  if (tweetId) {
    savedTweetsIdbGet(tweetId, 'dl').then(saved => {
      if (saved) {
        btn.setAttribute('data-mediadl-saved-dl', '1');
      }
    });
  }
}

// ===== 画像ホバーボタン注入 =====
function injectHoverBtns(articleEl) {
  if (articleEl.getAttribute(ATTR) !== '1') return;

  articleEl.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach(img => {
    if (!isBigEnough(img)) return;
    const c = img.closest('[data-testid="tweetPhoto"]') || img.parentElement;
    if (!c || c.hasAttribute('data-mediadl-hover')) return;
    c.setAttribute('data-mediadl-hover', '1');
    if (getComputedStyle(c).position === 'static') c.style.position = 'relative';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mediadl-btn mediadl-hover-base mediadl-hover-btn';
    btn.title = 'DL';
    btn.innerHTML = HOVER_SVG;

    // ミドルクリックで「このツイート内の画像すべて」を一括DL。
    attachMiddleClickBulk(btn, async () => {
      await downloadAllImagesForArticle(articleEl, btn);
    });

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await withButtonLoadingState(btn, async () => {
        const { userId, tweetText, tweetId } = getTweetInfo(articleEl);
        let url = img.src.replace(/([?&]name=)[^&]+/, '$1orig');
        if (!/[?&]name=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'name=orig';
        const fmt = url.match(/[?&]format=(\w+)/);
        // 複数画像ツイートでは、この画像が何枚目かを連番にする。
        // 無条件に連番なしで保存すると全枚が同名になり、uniquify の
        // 「 (1)」形式に化けて統一形式から外れてしまうため。
        const tweetImages = getAllImagesForTweet(tweetId, articleEl);
        const urlKey = url.split('?')[0];
        const pos = tweetImages.findIndex(it => it.url.split('?')[0] === urlKey);
        const idx = tweetImages.length > 1 && pos >= 0 ? pos + 1 : null;
        await downloadMedia(url, buildFilename(userId, tweetText, idx, fmt ? fmt[1] : 'jpg', tweetId));
        await savedTweetsIdbSet(tweetId, 'dl');
        btn.setAttribute('data-mediadl-saved-dl', '1');
      });
    });

    c.appendChild(btn);
  });

  // 動画にもボタンを追加
  articleEl.querySelectorAll('video').forEach(video => {
    const c = video.closest('[data-testid="videoPlayer"]') || video.parentElement;
    if (!c || c.hasAttribute('data-mediadl-hover')) return;
    c.setAttribute('data-mediadl-hover', '1');
    if (getComputedStyle(c).position === 'static') c.style.position = 'relative';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mediadl-btn mediadl-hover-base mediadl-hover-btn';
    btn.title = 'DL';
    btn.innerHTML = HOVER_SVG;

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await withButtonLoadingState(btn, async () => {
        const { userId, tweetText, tweetId } = getTweetInfo(articleEl);
        const videos = getAllVideosForTweet(tweetId);

        if (!videos.length) {
          alert('ダウンロード可能な動画が見つかりませんでした。');
          return;
        }

        const items = videos.map((item, i) => {
          const idx = videos.length > 1 ? i + 1 : null;
          return { url: item.url, filename: buildFilename(userId, tweetText, idx, item.ext, tweetId) };
        });

        const fsResult = await saveImagesToLocalFolder(items);
        if (fsResult.success) {
          await savedTweetsIdbSet(tweetId, 'dl');
          return;
        }

        for (const it of items) {
          await downloadMedia(it.url, it.filename);
        }
        await savedTweetsIdbSet(tweetId, 'dl');
        btn.setAttribute('data-mediadl-saved-dl', '1');
      });
    });

    c.appendChild(btn);
  });
}

// =====================================================================
// 文字ツイート保存機能
// =====================================================================

function requestCaptureVisibleTab() {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }, res => {
        try {
          if (chrome.runtime.lastError) resolve({ success: false });
          else resolve(res || { success: false });
        } catch (_) {
          resolve({ success: false });
        }
      });
    } catch (_) {
      // downloadMedia と同じ理由（Extension context invalidated 等）で
      // 同期例外を吸収し、{ success: false } として穏やかに失敗させる。
      resolve({ success: false });
    }
  });
}

function loadImageEl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = dataUrl;
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function waitNextFrame() { return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }

async function scrollToDocumentY(docY) {
  window.scrollTo(0, Math.max(0, docY));
  await waitNextFrame();
  await sleep(120);
}

// スクリーンショット開始前に起点ツイートの上端をビューポート上端へ合わせる。
// 引用ツイート等で下部のアクションバーから保存した場合、上部が画面外に
// あると最初のキャプチャが scrollY から始まり、canvas 上部が透過のまま残る。
async function prepareThreadSnapshotStart(mainArticle) {
  const rect = mainArticle.getBoundingClientRect();
  await scrollToDocumentY(rect.top + window.scrollY);
}

// スレッドを通過しながら、未取得部分だけを1画面ずつ記録して最後に結合する。
// DOMが後で間引かれても、既に取得した画面データには影響しない。
// オーバーラップさせて亀裂を防止
function createThreadSnapshotCollector(mainArticle) {
  const rect = mainArticle.getBoundingClientRect();
  const docTop = rect.top + window.scrollY;
  const cropLeft = Math.max(0, rect.left);
  const cropWidth = Math.max(1, Math.min(window.innerWidth, rect.right) - cropLeft);
  const dpr = window.devicePixelRatio || 1;
  const fragments = [];
  let nextDocY = docTop;
  let docBottom = null;
  const overlapPixels = Math.round(50 * dpr); // 50pxオーバーラップで亀裂防止

  return {
    async captureVisible() {
      if (nextDocY < window.scrollY - 1) {
        await scrollToDocumentY(nextDocY);
      }
      const scrollY = window.scrollY;
      const viewportBottom = scrollY + window.innerHeight;
      const start = Math.max(nextDocY, scrollY);
      if (start >= viewportBottom - 1) return;
      const res = await requestCaptureVisibleTab();
      if (!res?.success) return;
      fragments.push({ dataUrl: res.dataUrl, start, end: viewportBottom, scrollY });
      nextDocY = viewportBottom - 50; // 50pxオーバーラップ
    },
    finish(lastBottom) {
      docBottom = Math.max(docTop, lastBottom || nextDocY);
    },
    // 現在までにキャプチャ済みの範囲の下端（ドキュメント座標）。
    // 呼び出し側が「まだ撮り切れていない領域が残っているか」を判定するために使う。
    getCapturedBottom() {
      return nextDocY;
    },
    async toDataUrl() {
      if (!fragments.length || !docBottom || docBottom <= docTop) return null;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(cropWidth * dpr);
      canvas.height = Math.round((docBottom - docTop) * dpr);
      const ctx = canvas.getContext('2d');
      try {
        for (const fragment of fragments) {
          const start = Math.max(fragment.start, docTop);
          const end = Math.min(fragment.end, docBottom);
          if (end <= start) continue;
          const img = await loadImageEl(fragment.dataUrl);
          const srcX = Math.max(0, Math.round(cropLeft * dpr));
          const srcY = Math.max(0, Math.round((start - fragment.scrollY) * dpr));
          const srcW = Math.min(Math.round(cropWidth * dpr), img.width - srcX);
          const srcH = Math.min(Math.round((end - start) * dpr), img.height - srcY);
          if (srcW <= 0 || srcH <= 0) continue;
          ctx.drawImage(img, srcX, srcY, srcW, srcH,
            0, Math.round((start - docTop) * dpr), srcW, srcH);
        }
        return canvas.toDataURL('image/png');
      } catch (_) {
        return null;
      }
    },
  };
}

// ページを自動スクロールしながら chrome.tabs.captureVisibleTab を複数回
// 呼び出し、対象articleたち（mainArticle〜連続する本人リプライ）が
// 収まる範囲を1枚のcanvasに継ぎ合わせる。
//   ・固定ヘッダー等は隠さないため、スクロール量が大きいと継ぎ目に
//     ヘッダーが重複して映り込むことがある（既知の制限）。
//   ・失敗時（キャプチャ権限エラー等）はnullを返し、呼び出し側で
//     テキスト保存にフォールバックする。
// 画面上部付近に実際に描画されている要素をサンプリングし、
//   position:sticky / fixed なものを検出する（「戻る／ツイートする」バー等）。
//   特定のセレクタに依存せず、見た目上ぶつかっている要素を直接拾う方式。
//   ツイート本文（article内）が誤って引っかからないよう除外する。
function findOverlayHeaderElements() {
  const found = new Set();
  const w = window.innerWidth;
  const xs = [40, Math.floor(w / 2), Math.max(40, w - 40)];
  const ys = [4, 20, 40, 60, 80];
  for (const x of xs) {
    for (const y of ys) {
      const stack = document.elementsFromPoint(x, y);
      for (const el of stack) {
        if (!(el instanceof Element)) continue;
        if (el.closest('article[data-testid="tweet"]')) continue; // 本文自体は対象外
        const cs = getComputedStyle(el);
        if (cs.position === 'sticky' || cs.position === 'fixed') {
          found.add(el);
        }
      }
    }
  }
  return Array.from(found);
}

// 渡された要素群を一時的に visibility:hidden にし、元に戻す関数を返す。
// display:none だとレイアウトが動いて座標計算がズレる可能性があるため
// visibility を使う（占有スペースは維持される）。
function hideElementsTemporarily(elements) {
  const saved = elements.map(el => ({ el, prev: el.style.visibility }));
  saved.forEach(({ el }) => { el.style.visibility = 'hidden'; });
  return () => {
    saved.forEach(({ el, prev }) => { el.style.visibility = prev; });
  };
}

// スクリーンショット中はポインターイベントを遮断し、カーソル下のツイート
// ホバー色が変わってキャプチャの見た目が崩れるのを防ぐ。
function setCaptureInteractionLock(enabled) {
  if (enabled) document.documentElement.setAttribute('data-mediadl-capturing', '1');
  else document.documentElement.removeAttribute('data-mediadl-capturing');
}

async function captureThreadScreenshot(articles) {
  if (!articles.length) return null;
  const originalX = window.scrollX;
  const originalY = window.scrollY;
  let restoreSticky = null;

  try {
    // 固定/スティッキーな重なり要素をキャプチャ中だけ非表示にする
    const overlayEls = findOverlayHeaderElements();
    restoreSticky = hideElementsTemporarily(overlayEls);
    await waitNextFrame();

    const firstRect = articles[0].getBoundingClientRect();
    const lastRect = articles[articles.length - 1].getBoundingClientRect();
    const docTop = firstRect.top + window.scrollY;
    const docBottom = lastRect.bottom + window.scrollY;
    const totalHeight = Math.ceil(docBottom - docTop);
    if (totalHeight <= 0) return null;

    // 横方向もarticle群の実際の幅・左端に合わせてクロップする
    //   （document全幅ではなく、ツイートカードの実寸に合わせることで
    //   左右の無駄な余白をなくす）
    const lefts = articles.map(a => a.getBoundingClientRect().left);
    const rights = articles.map(a => a.getBoundingClientRect().right);
    const cropLeft = Math.max(0, Math.min(...lefts));
    const cropRight = Math.min(document.documentElement.clientWidth, Math.max(...rights));
    const cropWidth = Math.max(1, Math.ceil(cropRight - cropLeft));

    const dpr = window.devicePixelRatio || 1;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cropWidth * dpr);
    canvas.height = Math.round(totalHeight * dpr);
    const ctx = canvas.getContext('2d');

    let captured = 0;
    const viewportHeight = window.innerHeight;
    const MAX_SLICES = 40; // 無限ループ防止の安全弁
    let slices = 0;

    while (captured < totalHeight && slices < MAX_SLICES) {
      window.scrollTo(0, docTop + captured);
      await waitNextFrame();
      await sleep(120); // レイアウト安定待ち

      const actualScrollY = window.scrollY;
      const res = await requestCaptureVisibleTab();
      if (!res || !res.success) return null;
      const img = await loadImageEl(res.dataUrl);

      const sliceDocTop = docTop + captured;
      const offsetCss = sliceDocTop - actualScrollY;
      const remainingCss = totalHeight - captured;
      const availableCss = viewportHeight - offsetCss;
      const sliceHeightCss = Math.max(0, Math.min(availableCss, remainingCss));
      if (sliceHeightCss <= 0.5) break;

      const srcY = Math.max(0, Math.round(offsetCss * dpr));
      const srcH = Math.max(1, Math.round(sliceHeightCss * dpr));
      const srcX = Math.max(0, Math.round(cropLeft * dpr));
      const srcW = Math.max(1, Math.min(Math.round(cropWidth * dpr), img.width - srcX));

      ctx.drawImage(
        img,
        srcX, srcY, srcW, srcH,
        0, Math.round(captured * dpr), srcW, srcH
      );

      captured += sliceHeightCss;
      slices++;
      await sleep(350); // captureVisibleTabのレート制限(約2回/秒)対策
    }

    if (captured < totalHeight - 2) return null; // 取りこぼしが大きい場合は失敗扱い
    return canvas.toDataURL('image/png');
  } catch (_) {
    return null;
  } finally {
    window.scrollTo(originalX, originalY);
    if (restoreSticky) restoreSticky();
  }
}

function buildThreadTextContent(threadItems) {
  const lines = [];
  threadItems.forEach(({ info }, idx) => {
    const d = tweetIdToDate(info.tweetId);
    const label = idx === 0 ? '本文' : `リプライ${idx}`;
    lines.push(`----- ${label} (@${info.userId}) -----`);
    if (d) lines.push(`投稿日時: ${d.toLocaleString('ja-JP')}`);
    lines.push(info.tweetText || '(本文なし)');
    lines.push('');
  });
  return lines.join('\n');
}

function textToDataUrl(text) {
  const base64 = btoa(unescape(encodeURIComponent(text)));
  return `data:text/plain;charset=utf-8;base64,${base64}`;
}

async function saveTextTweet(mainArticle, btn, options = {}) {
  const ctx = getUrlStatusContext();
  if (!ctx) return;

  const originalX = window.scrollX;
  const originalY = window.scrollY;
  let restoreSticky = null;
  let restoreCaptureLock = null;
  try {
    await withButtonLoadingState(btn, async () => {
      if (textSaveFormat === 'screenshot') {
        setCaptureInteractionLock(true);
        restoreCaptureLock = () => setCaptureInteractionLock(false);
        restoreSticky = hideElementsTemporarily(findOverlayHeaderElements());
        await waitNextFrame();
      }
      const { records: threadItems, snapshots } = await collectAuthorThreadWhileScrolling(
        mainArticle, ctx.userId, textSaveFormat === 'screenshot', options
      );
      if (!threadItems.length) {
        alert('保存対象のツイートが見つかりませんでした。');
        return;
      }
      const mainInfo = threadItems[0].info;

      if (textSaveFormat === 'screenshot') {
        const dataUrl = await snapshots?.toDataUrl();
        if (dataUrl) {
          const filename = buildFilename(mainInfo.userId, mainInfo.tweetText, null, 'png', mainInfo.tweetId);
          await downloadMedia(dataUrl, filename);
          await savedTweetsIdbSet(mainInfo.tweetId, 'textsave');
          if (btn) btn.setAttribute('data-mediadl-saved-textsave', '1');
          return;
        }
        // スクリーンショット失敗 → テキスト保存に自動フォールバック
      }

      const text = buildThreadTextContent(threadItems);
      const filename = buildFilename(mainInfo.userId, mainInfo.tweetText, null, 'txt', mainInfo.tweetId);
      await downloadMedia(textToDataUrl(text), filename);
      await savedTweetsIdbSet(mainInfo.tweetId, 'textsave');
      if (btn) btn.setAttribute('data-mediadl-saved-textsave', '1');
    });
  } finally {
    window.scrollTo(originalX, originalY);
    if (restoreSticky) restoreSticky();
    if (restoreCaptureLock) restoreCaptureLock();
  }
}

// =====================================================================
// スクリーンショット保存のクリック割り当て（injectTextSaveBtn）
// -----------------------------------------------------------------------
// 通常クリック: 本体ツイート＋本人が自分のツイートに付けたリプ
//   （続きのツイート／自己リプ連投）までを1枚に撮影する。
//   → saveTextTweet(..., { strictChain: true })
//   他人のツイートが挟まった時点で連投は終わりとみなし、それより
//   後ろは含めない。本人のツイートでも「他人のリプへの返信」は
//   続きツイートではないので含めない。
//   続きツイートが無ければ、結果的に本体1件だけの画像になる。
// ミドルクリック: 従来どおり、間に他人が挟まっても投稿者本人の
//   ツイートを最後まで集める広いスレッド保存（saveTextTweet()）。
// =====================================================================

// 個別ツイート表示ページ（写真モーダルを除く）の、URL上のツイート本体
// にのみ、本文保存ボタンを追加する。画像の有無に関わらず対象。
function injectTextSaveBtn(articleEl) {
  if (isPhotoModalRoute()) return;
  if (isNestedTweetArticle(articleEl)) return;
  if (!isMainThreadArticle(articleEl)) return;

  const actionBars = articleEl.querySelectorAll('[role="group"]');
  const actionBar = actionBars[actionBars.length - 1] || null;
  if (!actionBar) return;
  if (actionBar.querySelector('[data-mediadl-role="textsave"]')) return;

  // 通常クリック: 本体＋本人の続きツイート（自己リプ連投）まで保存。
  // 他人のリプや、他人のリプへの本人の返信は含めない（strictChain）。
  const { wrapper, btn } = createNativeActionButton(actionBar, async () => {
    await saveTextTweet(articleEl, btn, { strictChain: true });
  });
  wrapper.setAttribute('data-mediadl-role', 'textsave');
  btn.title = 'スクリーンショット（自分の続きツイートまで）';
  btn.setAttribute('aria-label', 'スクリーンショット');
  btn.innerHTML = TEXT_SVG;

  // ミドルクリック: 間に他人が挟まっても投稿者本人のツイートを
  // 最後まで集める、従来の広いスレッド保存
  attachMiddleClickBulk(btn, async () => {
    await saveTextTweet(articleEl, btn);
  });

  actionBar.appendChild(wrapper);

  // 保存済みチェック（スクリーンショットボタン用）
  const { tweetId } = getTweetInfo(articleEl);
  if (tweetId) {
    savedTweetsIdbGet(tweetId, 'textsave').then(saved => {
      if (saved) {
        btn.setAttribute('data-mediadl-saved-textsave', '1');
      }
    });
  }
}

// ===== スタイル =====
// 色は全てCSS変数(--mediadl-icon-color)から取得。
// ボタン側にinline styleは書かないため、ThemeSync一箇所を
// 更新すれば全ボタンが即座に追従する。
function injectStyles() {
  if (document.getElementById('mediadl-styles')) return;
  const s = document.createElement('style');
  s.id = 'mediadl-styles';
  s.textContent = `
    [data-mediadl-wrapper="1"] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 34px;
      min-height: 34px;
      margin: 0;
      padding: 0;
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      flex-shrink: 0;
    }

    /* DLボタンとスクリーンショットボタンの挿入順（DOM順）は
       actionBarの再レンダリングタイミング次第で入れ替わることがあるため、
       flexのorderで見た目の位置を固定する。DLボタンを常に一番右に。 */
    [data-mediadl-role="textsave"] {
      order: 998;
    }
    [data-mediadl-role="download"] {
      order: 999;
    }

    [data-mediadl="btn"] {
      all: unset;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      /* CSS変数経由。変数未定義時のフォールバックも保険で指定 */
      color: var(--mediadl-icon-color, rgb(139, 152, 165));
      cursor: pointer;
      border: none !important;
      background: transparent;
      box-shadow: none !important;
      border-radius: 9999px;
      transition: color .15s ease, background-color .15s ease, opacity .15s ease;
      -webkit-tap-highlight-color: transparent;
    }

    [data-mediadl="btn"] svg {
      pointer-events: none;
      flex-shrink: 0;
    }

    [data-mediadl="btn"]:hover,
    [data-mediadl-wrapper="1"]:hover [data-mediadl="btn"] {
      color: rgb(255, 148, 241) !important;
      background-color: rgba(255, 148, 241, 0.1) !important;
    }

    /* 本文保存も通常時は他のアクションと同じ色。専用色はホバー時だけ使う。 */
    [data-mediadl-role="textsave"] [data-mediadl="btn"]:hover,
    [data-mediadl-role="textsave"]:hover [data-mediadl="btn"] {
      color: rgb(165, 110, 255) !important;
      background-color: rgba(165, 110, 255, 0.1) !important;
    }

    [data-mediadl="btn"]:active {
      transform: scale(0.96);
    }

    [data-mediadl="btn"]:disabled {
      cursor: default;
      transform: none;
    }

    /* 保存済み状態の表示（DLボタン用） */
    [data-mediadl-saved-dl="1"] {
      color: rgb(255, 148, 241) !important;
    }

    /* 保存済み状態の表示（スクリーンショットボタン用） */
    [data-mediadl-saved-textsave="1"] {
      color: rgb(165, 110, 255) !important;
    }

    /* 画像オーバーレイ用ホバーボタン */
    .mediadl-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border: none;
      background: transparent;
      border-radius: 50%;
      cursor: pointer;
      color: rgb(113, 118, 123);
      padding: 0;
      transition: color .15s ease, background-color .15s ease;
      flex-shrink: 0;
    }
    .mediadl-btn:hover {
      color: rgb(255, 148, 241);
      background-color: rgba(255, 148, 241, 0.1);
    }
    .mediadl-btn:disabled { cursor: default; }

    /* 保存済み状態の表示（ホバーボタン用） */
    .mediadl-btn[data-mediadl-saved-dl="1"] {
      color: rgb(255, 148, 241);
    }
    .mediadl-btn svg { pointer-events: none; }

    /* ホバーボタン共通ベース */
    .mediadl-hover-base {
      position: absolute !important;
      border-radius: 50% !important;
      opacity: 0;
      transition: opacity .15s ease, color .15s ease, background-color .15s ease !important;
      color: #fff !important;
    }
    .mediadl-hover-base:hover {
      color: rgb(255, 148, 241) !important;
      background-color: rgba(0, 0, 0, 0.85) !important;
    }

    /* 画像ホバーボタン（タイムライン用） */
    .mediadl-hover-btn {
      bottom: 8px;
      right: 8px;
      width: 32px !important;
      height: 32px !important;
      background-color: rgba(0, 0, 0, 0.6) !important;
      z-index: 10;
    }
    [data-mediadl-hover]:hover .mediadl-hover-btn {
      opacity: 1;
    }

    /* ホバーボタン位置カスタム機能。
       documentElement の data-mediadl-btnpos 属性を単一の真実の源とし、
       CSSだけで切り替える（bottom-right は上のデフォルト値のまま）。 */
    :root[data-mediadl-btnpos="top-left"] .mediadl-hover-btn {
      top: 8px; left: 8px; bottom: auto; right: auto;
    }
    :root[data-mediadl-btnpos="top-right"] .mediadl-hover-btn {
      top: 8px; right: 8px; bottom: auto; left: auto;
    }
    :root[data-mediadl-btnpos="bottom-left"] .mediadl-hover-btn {
      bottom: 8px; left: 8px; top: auto; right: auto;
    }

    /* 本文保存スクショ中: ツイートのホバー反応を抑え、見た目を統一する */
    :root[data-mediadl-capturing] article[data-testid="tweet"],
    :root[data-mediadl-capturing] article[data-testid="tweet"] * {
      pointer-events: none !important;
    }
    :root[data-mediadl-capturing] article[data-testid="tweet"]:hover {
      background-color: transparent !important;
    }
  `;
  document.head.appendChild(s);
}

// ===== 差分処理 =====
function processTweet(articleEl) {
  if (isNestedTweetArticle(articleEl)) return;
  injectBtn(articleEl);
  injectHoverBtns(articleEl);
  injectTextSaveBtn(articleEl); // ④: 画像の有無に関わらず判定するため独立して呼ぶ
}

function processAll() {
  document
    .querySelectorAll(`article[data-testid="tweet"][${ATTR}="pending"]`)
    .forEach(el => el.removeAttribute(ATTR));

  document
    .querySelectorAll(`article[data-testid="tweet"]:not([${ATTR}="1"]):not([${ATTR}="no-media"])`)
    .forEach(processTweet);

  document
    .querySelectorAll(`article[data-testid="tweet"][${ATTR}="1"]`)
    .forEach(injectHoverBtns);

  // ④: 画像の有無に関わらず全articleを対象に確認（冪等処理なので重複追加はしない）
  document
    .querySelectorAll('article[data-testid="tweet"]')
    .forEach(injectTextSaveBtn);

  processModal();
}

// 設定変更時だけ実行する再判定。通常のMutationObserver経路には入れない。
function rescanForMinImageSize() {
  document.querySelectorAll('.mediadl-hover-btn').forEach(btn => btn.remove());
  document.querySelectorAll('[data-mediadl-hover]').forEach(el => el.removeAttribute('data-mediadl-hover'));
  document.querySelectorAll('[data-mediadl-role="download"]').forEach(el => el.remove());
  document.querySelectorAll(`article[data-testid="tweet"][${ATTR}]`).forEach(el => el.removeAttribute(ATTR));
  processAll();
}

// =====================================================================
// 写真ビューア対応（変更なし）
// =====================================================================

function isPhotoModalRoute() {
  return /\/status\/\d+\/photo\/\d+/.test(location.pathname);
}

function getModalRoot() {
  return document.querySelector('div[aria-modal="true"][role="dialog"]')
    || document.querySelector('div[aria-modal="true"]');
}

function dedupeModalImages(modalRoot) {
  const seen = new Set(), items = [];
  modalRoot.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach(img => {
    let url = img.src.replace(/([?&]name=)[^&]+/, '$1orig');
    if (!/[?&]name=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'name=orig';
    const key = url.split('?')[0];
    if (seen.has(key)) return;
    seen.add(key);
    const fmt = url.match(/[?&]format=(\w+)/);
    items.push({ img, url, ext: fmt ? fmt[1] : 'jpg' });
  });
  return items;
}

function getActiveModalImage(modalRoot) {
  const imgs = Array.from(modalRoot.querySelectorAll('img[src*="pbs.twimg.com/media/"]'));
  if (!imgs.length) return null;
  if (imgs.length === 1) return imgs[0];

  let best = null, bestArea = -1;
  const vw = window.innerWidth, vh = window.innerHeight;
  for (const img of imgs) {
    const r = img.getBoundingClientRect();
    const visibleW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visibleH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = visibleW * visibleH;
    if (area > bestArea) {
      bestArea = area;
      best = img;
    }
  }
  return best;
}

function getModalTweetInfo(modalRoot) {
  const articleEl = modalRoot.querySelector('article[data-testid="tweet"]');
  if (articleEl) return getTweetInfo(articleEl);

  let userId = 'unknown', tweetId = null;
  const m = location.pathname.match(/\/([^/?#]+)\/status\/(\d+)/);
  if (m) {
    userId = m[1];
    tweetId = m[2];
  }
  return { userId, tweetText: '', tweetId };
}

function injectModalImageBtn(modalRoot) {
  const activeImg = getActiveModalImage(modalRoot);
  if (!activeImg) return;

  const container = activeImg.closest('[data-testid="tweetPhoto"]') || activeImg.parentElement;
  if (!container) return;

  modalRoot.querySelectorAll('[data-mediadl-modal-img-btn="1"]').forEach(btn => {
    if (btn.parentElement !== container) btn.remove();
  });
  modalRoot.querySelectorAll('[data-mediadl-modal-hover="1"]').forEach(el => {
    if (el !== container) el.removeAttribute('data-mediadl-modal-hover');
  });

  container.setAttribute('data-mediadl-modal-hover', '1');

  if (container.querySelector('[data-mediadl-modal-img-btn="1"]')) return;

  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mediadl-btn mediadl-hover-base mediadl-modal-img-btn';
  btn.setAttribute('data-mediadl-modal-img-btn', '1');
  btn.title = 'この画像をダウンロード';
  btn.innerHTML = HOVER_SVG;

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    await withButtonLoadingState(btn, async () => {
      const { userId, tweetText, tweetId } = getModalTweetInfo(modalRoot);
      const items = dedupeModalImages(modalRoot);
      const curIdx = items.findIndex(it => it.img === activeImg);
      const item = items[curIdx] || items[0];
      if (!item) return;
      const indexSuffix = items.length > 1 ? (curIdx >= 0 ? curIdx + 1 : null) : null;
      await downloadMedia(item.url, buildFilename(userId, tweetText, indexSuffix, item.ext, tweetId));
      await savedTweetsIdbSet(tweetId, 'dl');
      btn.setAttribute('data-mediadl-saved-dl', '1');
    });
  });

  container.appendChild(btn);
}

function injectModalActionBarBtn(modalRoot) {
  const replyBtn = modalRoot.querySelector('[data-testid="reply"]');
  const actionBar = replyBtn ? replyBtn.closest('[role="group"]') : null;
  if (!actionBar) return;

  if (actionBar.querySelector('[data-mediadl-wrapper="1"]')) return;

  const { wrapper, btn } = createNativeActionButton(actionBar, async () => {
    await withButtonLoadingState(btn, async () => {
      const { userId, tweetText, tweetId } = getModalTweetInfo(modalRoot);
      const images = getAllImagesForTweet(tweetId, modalRoot);
      const videos = getAllVideosForTweet(tweetId);

      if (!images.length && !videos.length) {
        alert('ダウンロード中にエラーが発生しました。ツイートをクリックし、再度ダウンロードをお願いします');
        return;
      }

      // 画像＋動画を通した連番（downloadAllImagesForArticle と同じ規則）
      const allMedia = [...images, ...videos];
      const items = allMedia.map((item, i) => ({
        url: item.url,
        filename: buildFilename(userId, tweetText, allMedia.length > 1 ? i + 1 : null, item.ext, tweetId),
      }));

      for (const it of items) {
        await downloadMedia(it.url, it.filename);
      }
      await savedTweetsIdbSet(tweetId, 'dl');
      btn.setAttribute('data-mediadl-saved-dl', '1');
    });
  });

  actionBar.appendChild(wrapper);
}

function injectModalStyles() {
  if (document.getElementById('mediadl-modal-styles')) return;
  const s = document.createElement('style');
  s.id = 'mediadl-modal-styles';
  s.textContent = `
    /* モーダル画像ボタン（共通ベースを継承） */
    .mediadl-modal-img-btn {
      bottom: 14px;
      right: 14px;
      width: 36px !important;
      height: 36px !important;
      background-color: rgba(0, 0, 0, 0.65) !important;
      z-index: 50;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
    }
    [data-mediadl-modal-hover]:hover .mediadl-modal-img-btn {
      opacity: 1;
    }

    /* モーダル内DLボタンも同じ位置設定に追従させる */
    :root[data-mediadl-btnpos="top-left"] .mediadl-modal-img-btn {
      top: 14px; left: 14px; bottom: auto; right: auto;
    }
    :root[data-mediadl-btnpos="top-right"] .mediadl-modal-img-btn {
      top: 14px; right: 14px; bottom: auto; left: auto;
    }
    :root[data-mediadl-btnpos="bottom-left"] .mediadl-modal-img-btn {
      bottom: 14px; left: 14px; top: auto; right: auto;
    }
  `;
  document.head.appendChild(s);
}

function processModal() {
  if (!isPhotoModalRoute()) return;
  const modalRoot = getModalRoot();
  if (!modalRoot) return;
  injectModalImageBtn(modalRoot);
  injectModalActionBarBtn(modalRoot);
}

// ===== 初期化 =====
injectStyles();
injectModalStyles();
applyButtonPositionAttr();  // ボタン位置の初期反映
ThemeSync.init();   // CSS変数の初期化＆テーマ変更監視を開始
processAll();

// MutationObserver
const observer = new MutationObserver(mutations => {
  let sawActionBar = false;

  for (const m of mutations) {
    if (m.addedNodes && m.addedNodes.length) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;

        if (node.matches?.('article[data-testid="tweet"]')) {
          processTweet(node);
        }

        const tweets = node.querySelectorAll?.('article[data-testid="tweet"]');
        if (tweets && tweets.length) {
          tweets.forEach(processTweet);
        }

        if (node.matches?.('[role="group"]') || node.querySelector?.('[role="group"]')) {
          sawActionBar = true;
          const pendings = document.querySelectorAll(
            `article[data-testid="tweet"][${ATTR}="pending"]`
          );
          pendings.forEach(art => {
            art.removeAttribute(ATTR);
            processTweet(art);
          });
        }

        if (
          node.matches?.('img[src*="pbs.twimg.com/media/"]') ||
          node.querySelector?.('img[src*="pbs.twimg.com/media/"]')
        ) {
          const art = node.closest?.('article[data-testid="tweet"]')
            || node.querySelector?.('article[data-testid="tweet"]');
          if (art) {
            if (art.getAttribute(ATTR) === 'no-media') art.removeAttribute(ATTR);
            processTweet(art);
          } else {
            let p = node.parentElement;
            while (p) {
              if (p.matches?.('article[data-testid="tweet"]')) {
                if (p.getAttribute(ATTR) === 'no-media') p.removeAttribute(ATTR);
                processTweet(p);
                break;
              }
              p = p.parentElement;
            }
          }
        }

        // タイムラインの動画/GIFは、まずプレースホルダーのみ描画され、
        // 実際の<video>要素は少し遅れて挿入される（IntersectionObserver等による遅延生成）。
        // その時点で既にATTR="1"が付与済みだと injectHoverBtns が再実行されず、
        // ホバーDLボタンが動画上に付かないままになる（個別ツイートを開いて
        // 戻ると付くのは、DOMが作り直されて<video>が最初から存在するため）。
        // <video>要素の挿入自体を検知して該当articleを再処理することで、
        // タイムライン表示時点から即座にボタンを反映させる。
        if (
          node.matches?.('video') || node.querySelector?.('video') ||
          node.matches?.('[data-testid="videoPlayer"]') || node.querySelector?.('[data-testid="videoPlayer"]')
        ) {
          const art = node.closest?.('article[data-testid="tweet"]')
            || node.querySelector?.('article[data-testid="tweet"]');
          if (art) {
            if (art.getAttribute(ATTR) === 'no-media') art.removeAttribute(ATTR);
            processTweet(art);
          } else {
            let p = node.parentElement;
            while (p) {
              if (p.matches?.('article[data-testid="tweet"]')) {
                if (p.getAttribute(ATTR) === 'no-media') p.removeAttribute(ATTR);
                processTweet(p);
                break;
              }
              p = p.parentElement;
            }
          }
        }
      }
    }
  }

  processModal();

  // 新しいアクションバーが現れた = 背景色が変わった可能性
  if (sawActionBar) {
    ThemeSync.applyThemeColor();
  }
});

const observerTarget = document.body || document.documentElement;
observer.observe(observerTarget, { childList: true, subtree: true });

const modalTimer = setInterval(() => {
  processModal();
}, 900);

function cleanup() {
  observer.disconnect();
  clearInterval(modalTimer);
  document.querySelectorAll('[data-mediadl-wrapper="1"], .mediadl-hover-btn, [data-mediadl-modal-img-btn="1"]').forEach(el => el.remove());
  document.querySelectorAll('[data-mediadl-hover], [data-mediadl-modal-hover]').forEach(el => {
    el.removeAttribute('data-mediadl-hover');
    el.removeAttribute('data-mediadl-modal-hover');
  });
  document.querySelectorAll(`article[data-testid="tweet"][${ATTR}]`).forEach(el => el.removeAttribute(ATTR));
  document.getElementById('mediadl-styles')?.remove();
  document.getElementById('mediadl-modal-styles')?.remove();
  document.documentElement.removeAttribute('data-mediadl-btnpos');
  window.__mediadl_injected.active = false;
}

// SPA遷移検知
(function patchHistoryForReprocess() {
  const fire = () => {
    if (!window.__mediadl_injected?.active) return;
    processAll();
    ThemeSync.applyThemeColor();   // 遷移直後もテーマ色を再適用
    Promise.resolve().then(processAll);
  };
  const _ps = history.pushState;
  history.pushState = function () {
    const r = _ps.apply(this, arguments);
    fire();
    return r;
  };
  const _rs = history.replaceState;
  history.replaceState = function () {
    const r = _rs.apply(this, arguments);
    fire();
    return r;
  };
  window.addEventListener('popstate', fire);
})();

})();
