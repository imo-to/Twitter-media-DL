// popup.js - Media DL拡張機能設定画面

document.addEventListener('DOMContentLoaded', () => {
  const twitterToggle = document.getElementById('twitter-toggle');
  const genericToggle = document.getElementById('generic-toggle');
  const thisSiteToggle = document.getElementById('this-site-toggle');
  const thisSiteLabel = document.getElementById('this-site-label');
  const minImageSize = document.getElementById('min-image-size');
  const folderInfo = document.getElementById('folder-info');
  const resetFolder = document.getElementById('reset-folder');
  const textSaveFormat = document.getElementById('text-save-format');
  const posPickerInputs = document.querySelectorAll('input[name="btnpos"]');
  const dimToggle = document.getElementById('dim-toggle');

  let currentHost = null;

  function isTwitterHost(host) {
    return /(^|\.)(x|twitter)\.com$/i.test(host || '');
  }

  // 現在のタブのホスト名を取得
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    let host = '';
    try {
      host = tab && tab.url ? new URL(tab.url).hostname : '';
    } catch (_) {}
    currentHost = host || null;
    thisSiteToggle.disabled = !host;
    if (thisSiteLabel) {
      const displayHost = (currentHost || '').replace(/^www\./i, '');
      thisSiteLabel.textContent = displayHost ? `${displayHost} で表示する` : 'このサイトで表示する';
    }
    loadSettings();
  });

  function loadSettings() {
    chrome.storage.local.get(
      ['disabledTwitter', 'genericGloballyEnabled', 'siteOverrides', 'minImageSize', 'hoverButtonPosition', 'textSaveFormat', 'baseDir', 'lastRelDir', 'dimMode'],
      (result) => {
        const disabledTwitter = !!result.disabledTwitter;
        const genericGloballyEnabled = result.genericGloballyEnabled === true; // デフォルトfalse
        const siteOverrides = result.siteOverrides || {};

        twitterToggle.checked = !disabledTwitter;
        genericToggle.checked = genericGloballyEnabled;

        // このサイトの実効状態
        if (currentHost) {
          let globalDefaultForHost;
          if (isTwitterHost(currentHost)) {
            globalDefaultForHost = !disabledTwitter;
          } else {
            globalDefaultForHost = genericGloballyEnabled;
          }
          const override = siteOverrides[currentHost];
          thisSiteToggle.checked = override !== undefined ? override : globalDefaultForHost;
        }

        minImageSize.value = Number.isFinite(result.minImageSize) && result.minImageSize > 0
          ? result.minImageSize
          : 150;

        // 保存先フォルダ表示（省略形）
        const base = (result.baseDir || '').replace(/[/\\]+$/, '');
        const rel = result.lastRelDir || null;
        if (base && rel) {
          // 省略形で表示（例: Pictures\2607）
          folderInfo.textContent = `${base}\\${rel}`;
          folderInfo.classList.remove('empty');
        } else if (base) {
          folderInfo.textContent = base + '（直下）';
          folderInfo.classList.remove('empty');
        } else {
          folderInfo.textContent = 'フォルダ未選択';
          folderInfo.classList.add('empty');
        }

        // ホバーボタン表示位置
        const VALID_POS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
        const hoverButtonPosition = VALID_POS.includes(result.hoverButtonPosition)
          ? result.hoverButtonPosition
          : 'bottom-right';
        posPickerInputs.forEach(input => {
          input.checked = input.value === hoverButtonPosition;
        });

        // 文字ツイート保存形式
        const textFormat = result.textSaveFormat === 'text' ? 'text' : 'screenshot';
        textSaveFormat.value = textFormat;

        // Dimモード
        dimToggle.checked = !!result.dimMode;
      }
    );
  }

  // このサイトのトグル表示を再計算
  function refreshThisSiteToggle() {
    if (!currentHost) return;
    chrome.storage.local.get(['disabledTwitter', 'genericGloballyEnabled', 'siteOverrides'], (result) => {
      const disabledTwitter = !!result.disabledTwitter;
      const genericGloballyEnabled = result.genericGloballyEnabled === true;
      const siteOverrides = result.siteOverrides || {};

      let globalDefaultForHost;
      if (isTwitterHost(currentHost)) {
        globalDefaultForHost = !disabledTwitter;
      } else {
        globalDefaultForHost = genericGloballyEnabled;
      }

      const override = siteOverrides[currentHost];
      thisSiteToggle.checked = override !== undefined ? override : globalDefaultForHost;
    });
  }

  async function injectIntoActiveTabIfNeeded() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) return;
    const hostname = new URL(tab.url).hostname;
    const isTwitter = isTwitterHost(hostname);
    const flagName = isTwitter ? '__mediadl_injected' : '__mediadl_generic_injected';
    let alreadyActive = false;
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: key => !!window[key]?.active,
        args: [flagName],
      });
      alreadyActive = !!result;
    } catch (_) {
      // chrome:// 等、実行できないページでは例外になる。ここで抜けて終わり。
      return;
    }
    if (alreadyActive) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [isTwitter ? 'content.js' : 'content_generic.js'],
      });
    } catch (_) {}
  }

  // Twitter 表示トグル
  twitterToggle.addEventListener('change', () => {
    chrome.storage.local.set({ disabledTwitter: !twitterToggle.checked }, () => {
      refreshThisSiteToggle();
      if (twitterToggle.checked && isTwitterHost(currentHost || '')) injectIntoActiveTabIfNeeded();
    });
  });

  // 一般サイト表示トグル
  genericToggle.addEventListener('change', () => {
    chrome.storage.local.set({ genericGloballyEnabled: genericToggle.checked }, () => {
      refreshThisSiteToggle();
      if (genericToggle.checked && !isTwitterHost(currentHost || '')) injectIntoActiveTabIfNeeded();
    });
  });

  // このサイトで表示する（個別上書き）
  thisSiteToggle.addEventListener('change', () => {
    if (!currentHost) return;
    const desiredEnabled = thisSiteToggle.checked;
    chrome.storage.local.get(['disabledTwitter', 'genericGloballyEnabled', 'siteOverrides'], (result) => {
      const disabledTwitter = !!result.disabledTwitter;
      const genericGloballyEnabled = result.genericGloballyEnabled === true;

      let globalDefaultForHost;
      if (isTwitterHost(currentHost)) {
        globalDefaultForHost = !disabledTwitter;
      } else {
        globalDefaultForHost = genericGloballyEnabled;
      }

      const overrides = Object.assign({}, result.siteOverrides || {});

      if (desiredEnabled === globalDefaultForHost) {
        delete overrides[currentHost];
      } else {
        overrides[currentHost] = desiredEnabled;
      }
      chrome.storage.local.set({ siteOverrides: overrides }, () => {
        if (desiredEnabled) injectIntoActiveTabIfNeeded();
      });
    });
  });

  // 画像判定サイズ
  let sizeSaveTimer = null;
  minImageSize.addEventListener('input', () => {
    clearTimeout(sizeSaveTimer);
    sizeSaveTimer = setTimeout(() => {
      const val = parseInt(minImageSize.value, 10);
      if (Number.isFinite(val) && val > 0) {
        chrome.storage.local.set({ minImageSize: val });
      }
    }, 500);
  });

  // ホバーボタン表示位置
  posPickerInputs.forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) {
        chrome.storage.local.set({ hoverButtonPosition: input.value });
      }
    });
  });

  // 文字ツイート保存形式
  textSaveFormat.addEventListener('change', () => {
    chrome.storage.local.set({ textSaveFormat: textSaveFormat.value });
  });

  // フォルダリセット
  resetFolder.addEventListener('click', () => {
    chrome.storage.local.set({ resetFsHandleRequested: true }, () => {
      folderInfo.textContent = 'フォルダ未選択';
      folderInfo.classList.add('empty');
      setTimeout(() => {
        chrome.storage.local.remove('resetFsHandleRequested');
      }, 1000);
    });
  });

  // Dimモード
  dimToggle.addEventListener('change', () => {
    chrome.storage.local.set({ dimMode: dimToggle.checked });
  });
});
