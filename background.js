// background.js
//
// 役割:
//   ・Twitter用 content.js、および一般サイト用 content_generic.js から
//     依頼されたダウンロード・可視領域キャプチャ・画像バイト取得を仲介する。
//
// 保存先記憶の仕組み:
//   baseDir    = Chromeの「実際の」デフォルトダウンロード先（年月フォルダ等を含まない親フォルダ）
//   lastRelDir = baseDir から見た「前回保存したサブフォルダ」の相対パス
//
//   DL時: filename = lastRelDir + "/" + ファイル名 を渡す
//         → saveAs:true ダイアログが lastRelDir フォルダで開く
//   完了後: 実際に保存されたフォルダを lastRelDir として上書き記憶
//
//   baseDir が「2606」のように年月フォルダそのものになっていると、
//   2607に保存した結果が baseDir 配下と判定されず学習が機能しない。
//   その場合、baseDir 外に保存されたことを検知して自動補正する。

// ログ出力関数
function log(message, data = null) {
  const logMsg = `[Media DL Background] ${message}`;
  if (data !== null && data !== undefined) {
    console.log(logMsg, data);
  } else {
    console.log(logMsg);
  }
}

// =====================================================================
// メッセージ送信元検証
// -----------------------------------------------------------------------
// chrome.runtime.onMessage は、拡張機能内のcontent scriptだけでなく、
// 同一拡張機能内の他コンテキストからもメッセージを受け取れる。
// senderを検証して、想定外の送信元（他拡張、外部Webページ等）からの
// メッセージは無条件に信頼しないようにする。
// content scriptから来たメッセージは sender.tab と sender.id を持つ。
// - sender.id が chrome.runtime.id と一致することで、他拡張からの
//   外部メッセージ(externalMessage)ではないことを保証する。
// - sender.tab があることで、ページ内のcontent script経由であることを保証する。
// =====================================================================
function isTrustedSender(sender) {
  if (!sender) return false;
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  if (!sender.tab || !sender.tab.id) return false;
  const url = sender.tab.url || sender.url || '';
  // http(s)以外のURL（chrome://等）からのメッセージは受け付けない
  if (!/^https?:\/\//i.test(url)) return false;
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isTrustedSender(sender)) {
    log('信頼できない送信元からのメッセージを拒否');
    sendResponse({ success: false, error: 'untrusted sender' });
    return false;
  }

  log('メッセージ受信:', msg && msg.type);

  if (msg && (msg.type === 'DOWNLOAD_MEDIA' || msg.type === 'GENERIC_DOWNLOAD_MEDIA')) {
    log('DOWNLOAD_MEDIA処理開始');
    handleDownload(msg.payload || {})
      .then(result => {
        log('DOWNLOAD_MEDIA成功:', result);
        sendResponse(result);
      })
      .catch(err => {
        log('DOWNLOAD_MEDIAエラー:', err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // 文字ツイートのスクリーンショット保存機能用。
  //   content.js はページをスクロールしながら複数回この画面キャプチャを
  //   要求し、自前でcanvasに継ぎ合わせる（本メッセージは1回分のキャプチャのみ担当）。
  if (msg && msg.type === 'CAPTURE_VISIBLE_TAB') {
    log('CAPTURE_VISIBLE_TAB処理開始');
    const windowId = sender.tab && sender.tab.windowId;
    if (windowId === undefined) {
      log('ERROR: windowIdが未定義');
      sendResponse({ success: false, error: 'no windowId' });
      return true;
    }
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        log('ERROR: キャプチャ失敗:', chrome.runtime.lastError?.message || 'capture failed');
        sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'capture failed' });
        return;
      }
      log('キャプチャ成功');
      sendResponse({ success: true, dataUrl });
    });
    return true;
  }

  // フォルダ直接書き込み一括保存機能用。content script自体のfetchは
  //   ページと同じCORS制限を受けるため、host_permissionsによりCORSの
  //   影響を受けないbackground側で画像バイト列を取得し、base64にして返す。
  if (msg && msg.type === 'FETCH_IMAGE_BYTES') {
    log('FETCH_IMAGE_BYTES処理開始');
    (async () => {
      try {
        const url = msg.payload && msg.payload.url;
        // http(s) 以外のURL（chrome://, file:// 等）は取得対象外
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
          throw new Error('invalid url');
        }
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('http ' + resp.status);
        const buffer = await resp.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        log('FETCH_IMAGE_BYTES成功');
        sendResponse({ success: true, base64: btoa(binary) });
      } catch (e) {
        log('FETCH_IMAGE_BYTESエラー:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // 未知のメッセージタイプは無視
  return false;
});

// 依頼されたファイル名を強制するための待機表（URL → ファイル名）。
//   data:/blob: URL では Chrome が名前を「ダウンロード」等にしてしまうことがあるため、
//   onDeterminingFilename で明示的に指定し直す。
//
//   ★ onDeterminingFilename のリスナーは、ブラウザ内の「すべてのダウンロード」の
//     ファイル名決定で呼ばれる。他の拡張機能（Video DownloadHelper 等）の
//     ダウンロードまで巻き込んで「ファイルに名前を付けられない」エラーの
//     原因になりうるため、常時登録はせず、自分のダウンロード待ちがある間だけ
//     登録して、無くなったら即座に解除する。
const pendingFilenames = new Map();
let filenameListenerArmed = false;

function onDeterminingFilenameHandler(item, suggest) {
  try {
    if (item.byExtensionId !== chrome.runtime.id) return;
    const wanted = pendingFilenames.get(item.url) || pendingFilenames.get(item.finalUrl);
    if (!wanted) return;
    suggest({ filename: wanted, conflictAction: 'uniquify' });
  } catch (e) {
    // ファイル名決定を止めない（例外で他者のDLまで壊さない）
    log('onDeterminingFilenameエラー:', e && e.message);
  } finally {
    disarmFilenameListenerIfIdle();
  }
}

function armFilenameListener() {
  if (filenameListenerArmed) return;
  try {
    chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilenameHandler);
    filenameListenerArmed = true;
  } catch (e) { /* 登録済み等は無視 */ }
}

function disarmFilenameListenerIfIdle() {
  if (!filenameListenerArmed || pendingFilenames.size > 0) return;
  try {
    chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilenameHandler);
    filenameListenerArmed = false;
  } catch (e) { /* 解除済み等は無視 */ }
}

async function handleDownload({ url, filename }) {
  if (typeof url !== 'string' || !url) {
    throw new Error('invalid url');
  }
  if (typeof filename !== 'string' || !filename) {
    throw new Error('invalid filename');
  }

  const stored = await chrome.storage.local.get(['baseDir', 'lastRelDir']);
  const baseDir = (stored.baseDir || '').replace(/[/\\]+$/, '');
  const lastRelDir = stored.lastRelDir || null;

  let dlFilename = filename;
  if (baseDir && lastRelDir) {
    dlFilename = lastRelDir.replace(/\\/g, '/') + '/' + filename;
  }

  pendingFilenames.set(url, dlFilename);
  armFilenameListener();
  setTimeout(() => { pendingFilenames.delete(url); disarmFilenameListenerIfIdle(); }, 60000);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename: dlFilename, saveAs: true, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          // filename が不正（古い相対パスが無効になった等）→ リセットして再試行
          chrome.storage.local.remove(['lastRelDir']);
          pendingFilenames.set(url, filename);
          armFilenameListener();
          chrome.downloads.download(
            { url, filename, saveAs: true, conflictAction: 'uniquify' },
            (retryId) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              watchComplete(retryId);
              resolve({ success: true, downloadId: retryId });
            }
          );
          return;
        }
        watchComplete(downloadId);
        resolve({ success: true, downloadId });
      }
    );
  });
}

function watchComplete(downloadId) {
  const handler = (delta) => {
    if (delta.id !== downloadId) return;
    if (delta.error) {
      chrome.downloads.onChanged.removeListener(handler);
      return;
    }
    if (delta.state?.current !== 'complete') return;
    chrome.downloads.onChanged.removeListener(handler);

    chrome.downloads.search({ id: downloadId }, async ([item]) => {
      if (!item?.filename) return;
      await learnFromSavedPath(item.filename);
    });
  };
  chrome.downloads.onChanged.addListener(handler);
}

async function learnFromSavedPath(absFilePath) {
  const sep = absFilePath.includes('\\') ? '\\' : '/';
  const dirParts = absFilePath.split(/[/\\]/);
  dirParts.pop(); // ファイル名を除去
  const savedDir = dirParts.join(sep);

  const stored = await chrome.storage.local.get(['baseDir']);
  let baseDir = (stored.baseDir || '').replace(/[/\\]+$/, '');

  if (!baseDir) {
    // baseDir未設定 → 保存先の親フォルダをbaseDirとして初期化
    const parts = savedDir.split(/[/\\]/);
    parts.pop();
    baseDir = parts.join(sep);
    chrome.storage.local.set({ baseDir, lastRelDir: null });
    return;
  }

  if (savedDir.toLowerCase().startsWith(baseDir.toLowerCase())) {
    // baseDir配下に保存された → 通常どおり相対パスを記憶
    const rel = savedDir.slice(baseDir.length).replace(/^[/\\]/, '').replace(/\\/g, '/');
    chrome.storage.local.set({ lastRelDir: rel || null });
    return;
  }

  // baseDir配下でない場所に保存された
  // → baseDir自体が「年月フォルダ」等になっている可能性が高いので、
  //    保存先とbaseDirの共通の親フォルダを新baseDirとして自動補正する
  const newBase = findCommonParent(savedDir, baseDir, sep);
  if (newBase && newBase.split(/[/\\]/).filter(Boolean).length >= 2) {
    const rel = savedDir.slice(newBase.length).replace(/^[/\\]/, '').replace(/\\/g, '/');
    chrome.storage.local.set({ baseDir: newBase, lastRelDir: rel || null });
  } else {
    // 共通親が見つからない（別ドライブ等）→ 保存先の親をbaseDirとして再設定
    const parts = savedDir.split(/[/\\]/);
    parts.pop();
    const fallbackBase = parts.join(sep);
    chrome.storage.local.set({ baseDir: fallbackBase, lastRelDir: null });
  }
}

// 2つのパスの共通の親ディレクトリを返す
function findCommonParent(pathA, pathB, sep) {
  const a = pathA.split(/[/\\]/);
  const b = pathB.split(/[/\\]/);
  const minLen = Math.min(a.length, b.length);
  const common = [];
  for (let i = 0; i < minLen; i++) {
    if (a[i].toLowerCase() === b[i].toLowerCase()) common.push(a[i]);
    else break;
  }
  return common.join(sep);
}
