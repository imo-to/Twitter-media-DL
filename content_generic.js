// content_generic.js - 一般ウェブサイト用メディアダウンロード機能
// Twitter以外のウェブサイトで画像ホバー時にDLボタンを表示

(async function () {
  if (window.__mediadl_generic_injected?.active) return;
  window.__mediadl_generic_injected = { active: true };

  // ログ出力関数
  function log(message, data) {
    if (data !== undefined) console.log('[Media DL]', message, data);
    else console.log('[Media DL]', message);
  }

  // =====================================================================
  // トースト通知システム
  // -----------------------------------------------------------------------
  // 旧実装は message を innerHTML に直接埋め込んでいたため、外部由来の
  // 文字列（サイトのタイトル、エラーメッセージ等）に <script> や
  // <img onerror=...> が含まれるとXSSが起きる可能性があった。
  // 新実装は DOM API と textContent を使い、HTMLを一切解釈しない形に修正。
  // =====================================================================
  function showToast(message, type = 'info', duration = 5000) {
    log('Toast:', { message: String(message), type });

    // 既存のトーストを削除
    const existingToast = document.querySelector('.mediadl-toast');
    if (existingToast) {
      existingToast.remove();
    }

    // トースト要素を作成
    const toast = document.createElement('div');
    toast.className = 'mediadl-toast';

    // アイコン設定
    let icon = '';
    switch (type) {
      case 'success':    icon = '✅'; break;
      case 'error':      icon = '❌'; break;
      case 'loading':    icon = '⏳'; break;
      case 'processing': icon = '📡'; break;
      case 'downloading':icon = '⬇️'; break;
      default:           icon = 'ℹ️';
    }

    // アイコンとメッセージを textContent で組み立てる（XSS対策）
    const iconEl = document.createElement('div');
    iconEl.className = 'mediadl-toast-icon';
    iconEl.textContent = icon;

    const msgEl = document.createElement('div');
    msgEl.className = 'mediadl-toast-message';
    // 改行を <br> ではなく white-space:pre-line で表現するため textContent で十分
    msgEl.textContent = String(message == null ? '' : message);

    toast.appendChild(iconEl);
    toast.appendChild(msgEl);

    // スタイルを追加
    if (!document.getElementById('mediadl-toast-styles')) {
      const style = document.createElement('style');
      style.id = 'mediadl-toast-styles';
      style.textContent = `
        .mediadl-toast {
          position: fixed;
          bottom: 20px;
          right: 20px;
          background: white;
          border-radius: 12px;
          padding: 16px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
          display: flex;
          align-items: center;
          gap: 12px;
          z-index: 1000000;
          max-width: 400px;
          animation: slideIn 0.3s ease-out;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 14px;
          line-height: 1.4;
        }
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0); opacity: 1; }
        }
        .mediadl-toast-icon {
          font-size: 20px;
          flex-shrink: 0;
        }
        .mediadl-toast-message {
          color: #1c1c1e;
          word-break: break-word;
          white-space: pre-line;
        }
        .mediadl-toast.error       { border-left: 4px solid #ff3b30; }
        .mediadl-toast.success     { border-left: 4px solid #34c759; }
        .mediadl-toast.loading,
        .mediadl-toast.processing,
        .mediadl-toast.downloading { border-left: 4px solid #007aff; }
      `;
      document.head.appendChild(style);
    }

    // タイプに応じたクラスを追加
    if (type === 'error') toast.classList.add('error');
    else if (type === 'success') toast.classList.add('success');
    else if (['loading', 'processing', 'downloading'].includes(type)) toast.classList.add(type);

    document.body.appendChild(toast);

    // 自動削除（loading系以外）
    if (!['loading', 'processing', 'downloading'].includes(type)) {
      setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease-out reverse';
        setTimeout(() => toast.remove(), 300);
      }, duration);
    }

    return toast;
  }

  const gate = await chrome.storage.local.get([
    'disabledTwitter', 'genericGloballyEnabled', 'siteOverrides',
    'hoverButtonPosition', 'textSaveFormat', 'minImageSize'
  ]);
  const genericGloballyEnabled = gate.genericGloballyEnabled === true; // デフォルトfalse
  const override = (gate.siteOverrides || {})[location.hostname];

  const enabled = override !== undefined ? override : genericGloballyEnabled;

  if (!enabled) {
    window.__mediadl_generic_injected.active = false;
    return;
  }

  let minImageSize = Number.isFinite(gate.minImageSize) && gate.minImageSize > 0
    ? gate.minImageSize : 150;

  // ホバー/モーダルDLボタンの表示位置。
  //   'bottom-right'（デフォルト）/ 'top-right' / 'bottom-left' / 'top-left'
  const VALID_BTN_POS = new Set(['bottom-right', 'top-right', 'bottom-left', 'top-left']);
  let hoverButtonPosition = VALID_BTN_POS.has(gate.hoverButtonPosition) ? gate.hoverButtonPosition : 'bottom-right';

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
    if (changes.minImageSize) {
      const value = changes.minImageSize.newValue;
      minImageSize = Number.isFinite(value) && value > 0 ? value : 150;
      rescanForMinImageSize();
    }
    if (changes.genericGloballyEnabled || changes.siteOverrides) {
      chrome.storage.local.get(['genericGloballyEnabled', 'siteOverrides'], settings => {
        const override = (settings.siteOverrides || {})[location.hostname];
        const genericEnabled = settings.genericGloballyEnabled === true;
        const nowEnabled = override !== undefined ? override : genericEnabled;

        if (!nowEnabled) {
          cleanup();
        } else if (!window.__mediadl_generic_injected?.active) {
          // 無効から有効になった場合は再注入
          window.__mediadl_generic_injected.active = true;
          processAll();
        }
      });
    }
  });

  // ホバーボタンのSVGは静的な自作リテラルなのでinnerHTML挿入で問題なし
  const HOVER_SVG = `<svg class="mediadl-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
    <path d="M12 2a1 1 0 0 1 1 1v10.586l3.293-3.293a1 1 0 0 1 1.414 1.414l-5 5a1 1 0 0 1-1.414 0l-5-5a1 1 0 0 1 1.414-1.414L11 13.586V3a1 1 0 0 1 1-1zM4 19a1 1 0 1 0 0 2h16a1 1 0 1 0 0-2H4z"/>
  </svg>`;

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

  async function downloadMedia(url, filename) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          { type: 'GENERIC_DOWNLOAD_MEDIA', payload: { url, filename } },
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
        // 拡張機能の更新/再読み込み直後は sendMessage が同期的に例外を
        // 投げることがある（Extension context invalidated）。未処理
        // エラーにせず { success: false } として穏やかに失敗させる。
        resolve({ success: false });
      }
    });
  }

  // =====================================================================
  // 保存ファイル名（Twitter側と統一形式）
  // -----------------------------------------------------------------------
  //   形式:  <サイト名>_<保存日YYMMDD>_<元のファイル名>.<拡張子>
  //   例:    example.com_261103_Mococo.jpg
  //   Twitter側の <ユーザーID>_<投稿日YYMMDD>_<本文> と同じ並びにする。
  //   一般サイトには投稿日・本文がないため、日付は保存日、本文の位置には
  //   画像URLの元のファイル名（取れなければページタイトル先頭）を使う。
  //   旧形式（hostname_Date.now() のタイムスタンプ）は使わない。
  // =====================================================================
  function sanitizeFilenamePart(str) {
    if (!str) return '';
    return String(str)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\x00-\x1F\x7F]/g, '')
      .replace(/[ \t\r\n]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/[. ]+$/g, '');
  }

  function formatYYMMDDGeneric(d) {
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
  }

  function buildGenericFilename(url, ext) {
    const site = sanitizeFilenamePart(location.hostname) || 'site';
    const datePart = formatYYMMDDGeneric(new Date());
    let base = '';
    try {
      const u = new URL(url, location.href);
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      base = last.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    } catch (_) { /* blob: 等で取れない場合はタイトルにフォールバック */ }
    let namePart = sanitizeFilenamePart(Array.from(base).slice(0, 20).join(''));
    if (!namePart) {
      namePart = sanitizeFilenamePart(Array.from(document.title || '').slice(0, 20).join(''));
    }
    return `${site}_${datePart}_${namePart || 'media'}.${ext}`;
  }

  function processAll() {
    // 一般サイトでは画像にホバーボタンを表示
    document.querySelectorAll('img').forEach(img => {
      if (!isBigEnough(img)) return;
      const existing = img.closest('[data-mediadl-hover]');
      if (existing) return;

      const container = img.parentElement;
      if (!container) return;

      // 既に処理済みならスキップ
      if (container.hasAttribute('data-mediadl-processed')) return;
      container.setAttribute('data-mediadl-processed', '1');

      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mediadl-btn mediadl-hover-btn';
      btn.title = '画像をダウンロード';
      btn.innerHTML = HOVER_SVG; // 静的リテラル

      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const url = img.src;
        if (!url) return;
        // GIFの判定を強化 - URLにgifが含まれる場合は優先
        let ext = 'jpg';
        if (url.toLowerCase().includes('.gif')) {
          ext = 'gif';
        } else {
          const fmt = url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
          ext = fmt ? fmt[1].toLowerCase() : 'jpg';
        }
        const filename = buildGenericFilename(url, ext);
        await downloadMedia(url, filename);
      });

      container.appendChild(btn);
    });

    // 動画にもボタンを表示
    document.querySelectorAll('video').forEach(video => {
      const existing = video.closest('[data-mediadl-hover]');
      if (existing) return;

      const container = video.parentElement;
      if (!container) return;

      // 既に処理済みならスキップ
      if (container.hasAttribute('data-mediadl-processed')) return;
      container.setAttribute('data-mediadl-processed', '1');

      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mediadl-btn mediadl-hover-btn';
      btn.title = '動画をダウンロード';
      btn.innerHTML = HOVER_SVG; // 静的リテラル

      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        const url = video.src || video.querySelector('source')?.src;
        if (!url) return;
        const fmt = url.match(/\.(mp4|webm|gif)(\?|$)/i);
        const ext = fmt ? fmt[1].toLowerCase() : 'mp4';
        const filename = buildGenericFilename(url, ext);
        await downloadMedia(url, filename);
      });

      container.appendChild(btn);
    });
  }

  function rescanForMinImageSize() {
    document.querySelectorAll('.mediadl-hover-btn').forEach(btn => btn.remove());
    document.querySelectorAll('[data-mediadl-processed]').forEach(el => el.removeAttribute('data-mediadl-processed'));
    document.querySelectorAll('[data-mediadl-hover]').forEach(el => el.removeAttribute('data-mediadl-hover'));
    processAll();
  }

  function cleanup() {
    document.querySelectorAll('.mediadl-hover-btn').forEach(btn => btn.remove());
    document.querySelectorAll('[data-mediadl-processed]').forEach(el => el.removeAttribute('data-mediadl-processed'));
    document.querySelectorAll('[data-mediadl-hover]').forEach(el => el.removeAttribute('data-mediadl-hover'));
    try { observer.disconnect(); } catch (_) {}
    window.__mediadl_generic_injected.active = false;
  }

  // 初期化
  injectStyles();
  applyButtonPositionAttr();

  // ページが完全にロードされた後に処理を実行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(processAll, 100);
    });
  } else {
    setTimeout(processAll, 100);
  }

  // MutationObserver for dynamically loaded images
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.tagName === 'IMG' && isBigEnough(node)) {
            processAll();
            break;
          }
          const images = node.querySelectorAll?.('img');
          if (images && images.length) {
            processAll();
            break;
          }
        }
      }
    }
  });

  // document.bodyが存在しない場合に備えて遅延開始
  const startObserver = () => {
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    } else {
      setTimeout(startObserver, 100);
    }
  };
  startObserver();

  function injectStyles() {
    if (document.getElementById('mediadl-styles')) return;
    const s = document.createElement('style');
    s.id = 'mediadl-styles';
    s.textContent = `
      .mediadl-btn {
        position: absolute;
        background: rgba(255, 255, 255, 0.95);
        border: 1px solid rgba(0, 0, 0, 0.1);
        border-radius: 50%;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.2s;
        z-index: 9999;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        padding: 0;
        margin: 0;
        box-sizing: border-box;
      }
      .mediadl-icon {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
        display: block;
        margin: auto;
      }
      [data-mediadl-processed]:hover .mediadl-btn {
        opacity: 1;
      }
      .mediadl-btn:hover {
        background: rgb(255, 147, 240);
        border-color: rgb(255, 147, 240);
      }
      .mediadl-btn:active {
        transform: scale(0.95);
      }
      /* ホバーボタン位置カスタム機能 */
      :root[data-mediadl-btnpos="top-left"] .mediadl-btn {
        top: 8px; left: 8px; bottom: auto; right: auto;
      }
      :root[data-mediadl-btnpos="top-right"] .mediadl-btn {
        top: 8px; right: 8px; bottom: auto; left: auto;
      }
      :root[data-mediadl-btnpos="bottom-left"] .mediadl-btn {
        bottom: 8px; left: 8px; top: auto; right: auto;
      }
      :root[data-mediadl-btnpos="bottom-right"] .mediadl-btn {
        bottom: 8px; right: 8px; top: auto; left: auto;
      }
    `;
    document.head.appendChild(s);
  }
})();
