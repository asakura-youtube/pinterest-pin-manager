// ==UserScript==
// @name         Pinterest 総合管理ツール
// @namespace    https://example.com/
// @version      1.0.0
// @description  Pinterestのピンを収集して、いいね数の表示・お気に入り管理・履歴保存ができる便利ツール（非公式）
// @author       あさくら
// @downloadURL  https://raw.githubusercontent.com/asakura-youtube/pinterest-pin-manager/main/pinterest-pin-manager.user.js
// @updateURL    https://raw.githubusercontent.com/asakura-youtube/pinterest-pin-manager/main/pinterest-pin-manager.user.js
// @match        https://jp.pinterest.com/*
// @match        https://*.pinterest.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      i.pinimg.com
// ==/UserScript==

(() => {
  'use strict';

  // =========================================================
  // Config
  // =========================================================
  const DEBUG = false;

  // pinページ取得（❤数取得）
  const MAX_CONCURRENCY = 3;
  const REQUEST_DELAY_MS = 180;

  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
  const FETCH_THUMBNAIL_IF_MISSING = false;

  const HIGHRES_SIZE_SEGMENT = '1200x';

  // Bulk DL
  const BULK_DL_CONCURRENCY = 6;
  const BULK_DOWNLOAD_DELAY_MS = 0;
  const BULK_DL_RETRY = 2;
  const BULK_DL_RETRY_BASE_DELAY_MS = 650;
  const BULK_DOWNLOAD_MAX = 2000;

  // UI watchdog
  const UI_WATCHDOG_INTERVAL_MS = 800;

  // Auto collect (scroll)
  const AUTO_COLLECT_SCROLL_STEP_PX = 1600;
  const AUTO_COLLECT_TICK_MS = 700;
  const AUTO_COLLECT_MAX_LOOPS = 600; // 安全装置（約7分）
  const AUTO_COLLECT_STUCK_LIMIT = 12; // 収集数が増えない状態が続いたら停止

  // Storage
  const LS_KEY = 'pt_heart_tool_v652';
  const GM_KEY = 'pt_heart_tool_v652_gm_backup';

  // Modal preview limit
  const MODAL_PREVIEW_LIMIT = 80;

  // Virtual Scroll (Sort Grid)
  const VS_CARD_MIN_W = 180;
  const VS_GAP = 12;
  const VS_CARD_EST_H = 360; // 目安（renderCardの高さに合わせる）
  const VS_OVERSCAN_ROWS = 3;

  // =========================================================
  // Utilities
  // =========================================================
  const log = (...args) => DEBUG && console.log('[PT-Heart]', ...args);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function normalizeCount(text) {
    const t = (text || '').replace(/,/g, '').trim();
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : 0;
  }

  function pinUrl(pinId) {
    return `${location.origin}/pin/${pinId}/`;
  }

  function makePageKey() {
    return `${location.pathname}${location.search}`;
  }

  function toHighResPinimgUrl(url) {
    if (!url) return null;
    // Pinterestのimg URL以外（pinページなど）はそのまま
    if (!/\/\/i\.pinimg\.com\//.test(url)) return url;

    // /236x/ -> /1200x/ のようなサイズ置換
    return url.replace(/\/\d+x\//, `/${HIGHRES_SIZE_SEGMENT}/`);
  }

  function safeFileName(str) {
    return String(str || '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }

  function padNum(n, width) {
    const s = String(Math.max(0, parseInt(n, 10) || 0));
    return s.length >= width ? s : ('0'.repeat(width - s.length) + s);
  }

  function makeDlFilename(p) {
    const heart = (p && p.countNum != null) ? p.countNum : 0;
    const heartPad = padNum(heart, 7);
    const base = `❤${heartPad}__pin_${p?.pinId || 'unknown'}__${HIGHRES_SIZE_SEGMENT}`;
    return safeFileName(`${base}.jpg`);
  }

  function uiMountRoot() {
    return document.body || document.documentElement;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function uuid() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  // =========================================================
  // Storage (LS + GM Restore)
  // =========================================================
  function loadStateFromLS() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveStateToLS(data) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) {
      log('saveState LS failed', e);
    }
  }

  function loadStateFromGM() {
    try {
      if (typeof GM_getValue === 'undefined') return null;
      return GM_getValue(GM_KEY, null);
    } catch (e) {
      log('loadState GM failed', e);
      return null;
    }
  }

  function saveStateToGM(data) {
    try {
      if (typeof GM_setValue === 'undefined') return;
      GM_setValue(GM_KEY, data);
    } catch (e) {
      log('saveState GM failed', e);
    }
  }

  function loadStateWithRestore() {
    const ls = loadStateFromLS();
    if (ls) return { data: ls, restored: false };
    const gm = loadStateFromGM();
    if (gm) {
      // LSへ復元
      saveStateToLS(gm);
      return { data: gm, restored: true };
    }
    return { data: null, restored: false };
  }

  function saveStateAll(data) {
    saveStateToLS(data);
    saveStateToGM(data);
  }

  // =========================================================
  // Export / Import (JSON)
  // =========================================================
  function exportPersistedToJson() {
    const data = {
      schema: 1,
      exportedAt: new Date().toISOString(),
      persisted,
    };
    return JSON.stringify(data, null, 2);
  }

  function importPersistedFromJson(jsonText) {
    let obj;
    try {
      obj = JSON.parse(jsonText);
    } catch (e) {
      throw new Error('JSONの形式が不正です');
    }

    if (!obj || !obj.persisted) {
      throw new Error('persistedデータが見つかりません');
    }

    const p = obj.persisted;

    // 最低限の形チェック
    if (!p.favorites || !p.snapshots || !p.ui) {
      throw new Error('データ構造が不正です');
    }

    // 既存persistedを置き換え
    persisted.favorites = p.favorites;
    persisted.snapshots = p.snapshots;
    persisted.ui = { ...persisted.ui, ...p.ui };

    saveStateAll(persisted);
  }

  // 永続データの形
  // {
  //   favorites: { order: [listId], lists: { [listId]: {id,name,pinIds[]} } },
  //   snapshots: { order: [snapId], items: { [snapId]: {id,name,createdAt,pageKey,pinIds[]} } },
  //   ui: { activeFavId, activeSnapId, minEnabled, minCount, onlyKnown, sortDir }
  // }
  const persisted = (() => {
    const base = {
      favorites: { order: [], lists: {} },
      snapshots: { order: [], items: {} },
      ui: {
        activeFavId: null,
        activeSnapId: null,
        minEnabled: false,
        minCount: 0,
        onlyKnown: false,
        sortDir: 'desc',
        historySortDir: 'desc', // ★追加：履歴一覧の createdAt ソート（desc=新しい順）
      },
    };

    const loaded = loadStateWithRestore();
    if (!loaded.data) return base;

    return {
      favorites: loaded.data.favorites || base.favorites,
      snapshots: loaded.data.snapshots || base.snapshots,
      ui: { ...base.ui, ...(loaded.data.ui || {}) },
      _restoredFromGM: !!loaded.restored,
    };
  })();

  // =========================================================
  // Per-page stores (SPA aware)
  // =========================================================
  const pageStores = new Map();
  let currentPageKey = makePageKey();

  function getOrCreatePageStore(pageKey) {
    if (!pageStores.has(pageKey)) {
      pageStores.set(pageKey, {
        pinStore: new Map(),
        selectedPins: new Set(), // 汎用チェック（お気に入り保存にも使う）
      });
    }
    return pageStores.get(pageKey);
  }

  let pinStore = getOrCreatePageStore(currentPageKey).pinStore;
  let selectedPins = getOrCreatePageStore(currentPageKey).selectedPins;

  // queue
  const q = [];
  let running = 0;
  const inFlight = new Set();

  function switchToPage(pageKey) {
    if (pageKey === currentPageKey) return;

    currentPageKey = pageKey;
    const store = getOrCreatePageStore(currentPageKey);
    pinStore = store.pinStore;
    selectedPins = store.selectedPins;

    q.length = 0;
    inFlight.clear();

    setTimeout(() => {
      ui.ensureAllUI();
      ui.updateInfo();
      if (ui.state.sortViewOpen) ui.renderSortGrid(true);
      if (ui.state.modalOpen) ui.renderModal(); // ページ切替でもモーダル維持
      if (ui.state.viewerOpen) ui.renderViewer(true); // ビューワ維持
    }, 0);
  }

  function hookHistory() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;

    history.pushState = function (...args) {
      origPush.apply(this, args);
      window.dispatchEvent(new Event('pt-locationchange'));
    };
    history.replaceState = function (...args) {
      origReplace.apply(this, args);
      window.dispatchEvent(new Event('pt-locationchange'));
    };
    window.addEventListener('popstate', () => {
      window.dispatchEvent(new Event('pt-locationchange'));
    });
    window.addEventListener('pt-locationchange', () => {
      switchToPage(makePageKey());
    });
  }
  hookHistory();

  // =========================================================
  // Cache (global, across pages)
  // =========================================================
  const countCache = new Map(); // pinId -> {countStr, ts}

  function getCachedCount(pinId) {
    const v = countCache.get(pinId);
    if (!v) return null;
    if (Date.now() - v.ts > CACHE_TTL_MS) {
      countCache.delete(pinId);
      return null;
    }
    return v.countStr;
  }

  function setCachedCount(pinId, countStr) {
    countCache.set(pinId, { countStr, ts: Date.now() });
  }

  function upsertPin(pinId, patch) {
    const prev = pinStore.get(pinId) || {
      pinId,
      href: pinUrl(pinId),
      thumbUrl: null,
      countStr: null,
      countNum: null,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    const next = { ...prev, ...patch, lastSeenAt: Date.now() };
    pinStore.set(pinId, next);
  }

  // =========================================================
  // Queue (concurrency limit)
  // =========================================================
  function enqueue(fn) {
    q.push(fn);
    pump();
  }

  async function pump() {
    if (running >= MAX_CONCURRENCY) return;
    const fn = q.shift();
    if (!fn) return;
    running++;
    try {
      await fn();
    } catch (e) {
      log('queue error', e);
    } finally {
      running--;
      pump();
    }
  }

  // =========================================================
  // DOM: find cards & overlay badge (Pinterest native view)
  // =========================================================
  function extractPinIdFromAnchor(a) {
    const href = a?.getAttribute('href') || '';
    const m = href.match(/\/pin\/(\d+)\//);
    return m ? m[1] : null;
  }

  function getAnchorCandidates() {
    return document.querySelectorAll('a[href^="/pin/"][href*="/"]');
  }

  function findCardFromAnchor(a) {
    return (
      a.closest('[data-grid-item="true"][role="listitem"]') ||
      a.closest('[role="listitem"]') ||
      a.closest('div')
    );
  }

  function getOverlayRoot(card) {
    return (
      card.querySelector('.PinCard__imageWrapper') ||
      card.querySelector('[data-test-id="pinWrapper"]') ||
      card
    );
  }

  function ensureBadge(card) {
    let badge = card.querySelector(':scope [data-pt-heart-badge="1"]');
    if (badge) return badge;

    const root = getOverlayRoot(card);
    const cs = getComputedStyle(root);
    if (cs.position === 'static') root.style.position = 'relative';

    badge = document.createElement('div');
    badge.setAttribute('data-pt-heart-badge', '1');
    badge.style.cssText = `
      position:absolute;
      left:10px;
      top:10px;
      z-index:9999;
      display:inline-flex;
      align-items:center;
      gap:6px;
      padding:6px 10px;
      border-radius:999px;
      background:rgba(0,0,0,0.68);
      color:#fff;
      font-size:12px;
      line-height:1;
      font-weight:800;
      backdrop-filter: blur(6px);
      pointer-events:none;
      user-select:none;
      white-space:nowrap;
    `;

    const heart = document.createElement('span');
    heart.textContent = '❤';

    const count = document.createElement('span');
    count.setAttribute('data-pt-heart-count', '1');
    count.textContent = '...';

    badge.appendChild(heart);
    badge.appendChild(count);
    root.appendChild(badge);
    return badge;
  }

  function setBadgeCount(card, val) {
    const badge = ensureBadge(card);
    const c = badge.querySelector('[data-pt-heart-count="1"]');
    if (c) c.textContent = val;
  }

  function findCountInCardDom(card) {
    const el = card.querySelector('[data-test-id="reactions-count"]');
    const txt = el?.textContent?.trim();
    if (txt && /^[0-9.,]+$/.test(txt)) return txt;
    return null;
  }

  function extractThumbnailFromCard(card) {
    const img = card.querySelector('img[src], img[srcset]');
    if (!img) return null;
    const src = img.getAttribute('src');
    if (src) return src;
    const ss = img.getAttribute('srcset') || '';
    const first = ss.split(',')[0]?.trim()?.split(' ')[0];
    return first || null;
  }

  // =========================================================
  // Fetch pin page -> count + thumbnail (robust)
  // =========================================================
  function _pickLargestFromSrcset(srcset) {
    if (!srcset) return null;

    // "url 236w, url2 474w, ..." or "url 1x, url2 2x"
    const parts = String(srcset)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    let bestUrl = null;
    let bestScore = -1;

    for (const part of parts) {
      const seg = part.split(/\s+/).filter(Boolean);
      const u = seg[0];
      const desc = seg[1] || '';

      let score = 0;
      const mW = desc.match(/^(\d+)w$/);
      const mX = desc.match(/^(\d+(?:\.\d+)?)x$/);

      if (mW) score = parseInt(mW[1], 10);
      else if (mX) score = Math.round(parseFloat(mX[1]) * 1000);
      else score = 1;

      if (score > bestScore) {
        bestScore = score;
        bestUrl = u;
      }
    }
    return bestUrl;
  }

  function _extractBestImageUrlFromPinDoc(doc) {
    if (!doc) return null;

    // 1) Most reliable: pinned image meta (og:image)
    const og = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
    const ogUrl = og?.getAttribute('content')?.trim();
    if (ogUrl) return ogUrl;

    // 2) Twitter card fallback
    const tw = doc.querySelector('meta[name="twitter:image"], meta[property="twitter:image"]');
    const twUrl = tw?.getAttribute('content')?.trim();
    if (twUrl) return twUrl;

    // 3) Any img with src/srcset: choose largest from srcset if exists
    // Pinterest pages can have many images; prefer ones from i.pinimg.com.
    const imgs = Array.from(doc.querySelectorAll('img[src], img[srcset]'));
    if (imgs.length === 0) return null;

    // Prefer i.pinimg.com candidates first
    const preferred = imgs.filter(im => {
      const src = im.getAttribute('src') || '';
      const ss = im.getAttribute('srcset') || '';
      return /\/\/i\.pinimg\.com\//.test(src) || /\/\/i\.pinimg\.com\//.test(ss);
    });

    const pool = preferred.length ? preferred : imgs;

    // Try srcset largest first
    for (const im of pool) {
      const ss = im.getAttribute('srcset');
      const pick = _pickLargestFromSrcset(ss);
      if (pick) return pick;
    }

    // Fallback to src
    for (const im of pool) {
      const src = im.getAttribute('src')?.trim();
      if (src) return src;
    }

    return null;
  }

  async function fetchPinPageData(pinId) {
    const url = pinUrl(pinId);
    const res = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // ❤ count
    const el = doc.querySelector('[data-test-id="reactions-count"]');
    const countStr = el?.textContent?.trim() || null;

    // thumbnail (always try; callers can decide whether to use)
    // - prefer meta og/twitter image
    // - otherwise pick largest srcset/src from i.pinimg.com
    let thumbUrl = _extractBestImageUrlFromPinDoc(doc);

    // If extracted URL is i.pinimg.com, upgrade to 1200x when possible
    if (thumbUrl && /\/\/i\.pinimg\.com\//.test(thumbUrl)) {
      thumbUrl = toHighResPinimgUrl(thumbUrl);
    }

    // Keep backward behavior: if you truly want to disable storing thumbnail
    // set FETCH_THUMBNAIL_IF_MISSING=false and return null (count-only).
    // (Rehydrate用途では true 推奨)
    if (!FETCH_THUMBNAIL_IF_MISSING) {
      // ただし、re-hydrate用途で thumbUrl が必須なら、
      // このフラグを true にするか、呼び出し側で別関数に切り替えてください。
      return { countStr, thumbUrl: null };
    }

    return { countStr, thumbUrl: thumbUrl || null };
  }

  function ensureCount(pinId, cardForBadgeUpdate) {
    const cached = getCachedCount(pinId);
    if (cached != null) {
      upsertPin(pinId, { countStr: cached, countNum: normalizeCount(cached) });
      if (cardForBadgeUpdate) setBadgeCount(cardForBadgeUpdate, cached);
      return;
    }

    if (inFlight.has(pinId)) return;
    inFlight.add(pinId);

    enqueue(async () => {
      try {
        await sleep(REQUEST_DELAY_MS);

        const { countStr, thumbUrl } = await fetchPinPageData(pinId);

        const finalCount = (countStr && /^[0-9.,]+$/.test(countStr)) ? countStr : '0';
        setCachedCount(pinId, finalCount);

        const patch = { countStr: finalCount, countNum: normalizeCount(finalCount) };
        if (thumbUrl) patch.thumbUrl = thumbUrl;
        upsertPin(pinId, patch);

        if (cardForBadgeUpdate) setBadgeCount(cardForBadgeUpdate, finalCount);
        if (ui.state.sortViewOpen) ui.renderSortGridDebounced();

      } catch (e) {
        log('fetch failed', pinId, e);
        if (cardForBadgeUpdate) setBadgeCount(cardForBadgeUpdate, '!');
      } finally {
        inFlight.delete(pinId);
        ui.updateInfo();
      }
    });
  }

  // =========================================================
  // Scan: collect pins as they appear
  // =========================================================
  function scanAndCollect() {
    const anchors = getAnchorCandidates();
    let found = 0;

    for (const a of anchors) {
      const pinId = extractPinIdFromAnchor(a);
      if (!pinId) continue;

      found++;

      const card = findCardFromAnchor(a);
      if (!card) continue;

      const href = a.getAttribute('href');
      const absHref = href?.startsWith('http') ? href : `${location.origin}${href}`;
      const thumb = extractThumbnailFromCard(card);

      upsertPin(pinId, {
        href: absHref || pinUrl(pinId),
        thumbUrl: thumb || (pinStore.get(pinId)?.thumbUrl ?? null),
      });

      ensureBadge(card);

      const domCount = findCountInCardDom(card);
      if (domCount != null) {
        setCachedCount(pinId, domCount);
        upsertPin(pinId, { countStr: domCount, countNum: normalizeCount(domCount) });
        setBadgeCount(card, domCount);
      } else {
        const cached = getCachedCount(pinId);
        if (cached != null) {
          setBadgeCount(card, cached);
          upsertPin(pinId, { countStr: cached, countNum: normalizeCount(cached) });
        } else {
          ensureCount(pinId, card);
        }
      }
    }

    ui.updateInfo(found);
  }

  // =========================================================
  // Clipboard / Download helpers
  // =========================================================
  async function copyTextToClipboard(text) {
    await navigator.clipboard.writeText(text);
  }

  function gmFetchBlob(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'undefined') {
        reject(new Error('GM_xmlhttpRequest not available'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        onload: (res) => {
          if (!res || res.status < 200 || res.status >= 300) {
            reject(new Error(`GM HTTP ${res?.status}`));
            return;
          }
          const mime = res.responseHeaders?.match(/content-type:\s*([^\n\r;]+)/i)?.[1]?.trim() || 'image/jpeg';
          const blob = new Blob([res.response], { type: mime });
          resolve(blob);
        },
        onerror: () => reject(new Error('GM request error')),
        ontimeout: () => reject(new Error('GM request timeout')),
      });
    });
  }

  async function convertBlobToPng(blob) {
    if (blob.type === 'image/png') return blob;

    try {
      const bmp = await createImageBitmap(blob);
      const w = bmp.width;
      const h = bmp.height;

      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!png) throw new Error('toBlob returned null');
        return png;
      }
    } catch {
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = reject;
          im.src = url;
        });

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!png) throw new Error('toBlob returned null');
        return png;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  async function copyImageToClipboard_StrongPng(imageUrl) {
    try { window.focus(); } catch {}
    try { document.body?.focus?.(); } catch {}

    let blob;
    try {
      blob = await gmFetchBlob(imageUrl);
    } catch {
      const res = await fetch(imageUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`fetch HTTP ${res.status}`);
      blob = await res.blob();
    }

    if (typeof ClipboardItem === 'undefined') throw new Error('ClipboardItem not supported');
    const pngBlob = await convertBlobToPng(blob);

    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': pngBlob }),
    ]);
  }

  function gmDownload(url, filename) {
    return new Promise((resolve, reject) => {
      if (typeof GM_download === 'undefined') {
        reject(new Error('GM_download not available'));
        return;
      }
      GM_download({
        url,
        name: filename,
        saveAs: false,
        onload: () => resolve(),
        onerror: (e) => reject(e || new Error('GM_download error')),
        ontimeout: () => reject(new Error('GM_download timeout')),
      });
    });
  }

  async function downloadWithRetry(url, filename, maxRetry) {
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      try {
        await gmDownload(url, filename);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt >= maxRetry) break;
        const backoff = BULK_DL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  // =========================================================
  // Auto Collect
  // =========================================================
  async function autoCollectTo(targetCount) {
    if (!Number.isFinite(targetCount) || targetCount <= 0) return;

    ui.state.autoCollecting = true;
    ui.state.autoCollectCancel = false;
    ui.toast(`自動収集中: ${targetCount} 件`);

    let lastSize = pinStore.size;
    let stuck = 0;

    for (let i = 0; i < AUTO_COLLECT_MAX_LOOPS; i++) {
      if (ui.state.autoCollectCancel) break;

      scanAndCollect();

      if (pinStore.size >= targetCount) break;

      if (pinStore.size === lastSize) stuck++;
      else stuck = 0;
      lastSize = pinStore.size;

      if (stuck >= AUTO_COLLECT_STUCK_LIMIT) {
        ui.toast('自動収集: これ以上増えないため停止');
        break;
      }

      window.scrollBy(0, AUTO_COLLECT_SCROLL_STEP_PX);
      await sleep(AUTO_COLLECT_TICK_MS);
    }

    ui.state.autoCollecting = false;

    if (ui.state.autoCollectCancel) ui.toast('自動収集: 停止');
    else ui.toast(`自動収集: 完了 (${pinStore.size} 件)`);

    ui.updateInfo();
    if (ui.state.sortViewOpen) ui.renderSortGridDebounced(true);
  }

  // =========================================================
  // Favorites / Snapshots helpers
  // =========================================================
  function persistUIState() {
    // ★ガード（ui/stateが未初期化でも落とさない）
    if (!ui || !ui.state) return;

    // 既存項目（そのまま維持）
    persisted.ui.activeFavId = ui.state.activeFavId;
    persisted.ui.activeSnapId = ui.state.activeSnapId;
    persisted.ui.minEnabled = ui.state.minEnabled;
    persisted.ui.minCount = ui.state.minCount;
    persisted.ui.onlyKnown = ui.state.onlyKnown;
    persisted.ui.sortDir = ui.state.sortDir;

    // ★追加：履歴一覧の createdAt ソート（新しい順/古い順）
    // - ui.state.historySortDir が未定義なら既存persistedを尊重
    // - それも無ければデフォルト 'desc'（新しい順）
    const dir =
      (ui.state.historySortDir === 'asc' || ui.state.historySortDir === 'desc')
        ? ui.state.historySortDir
        : (persisted.ui.historySortDir === 'asc' || persisted.ui.historySortDir === 'desc')
          ? persisted.ui.historySortDir
          : 'desc';

    persisted.ui.historySortDir = dir;
    ui.state.historySortDir = dir; // state側も正規化して揃える

    // 保存（LS + GM）
    saveStateAll(persisted);
  }

  function ensureDefaultFavoriteList() {
    if (persisted.favorites.order.length > 0) return;
    const id = uuid();
    persisted.favorites.order.push(id);
    persisted.favorites.lists[id] = { id, name: 'お気に入り', pinIds: [] };
    saveStateAll(persisted);
  }
  ensureDefaultFavoriteList();

  function getActiveFavId() {
    const id = ui.state.activeFavId || persisted.ui.activeFavId;
    if (id && persisted.favorites.lists[id]) return id;
    const first = persisted.favorites.order[0];
    return first || null;
  }

  function addPinsToFav(listId, pinIds) {
    const list = persisted.favorites.lists[listId];
    if (!list) return;
    const set = new Set(list.pinIds);
    for (const id of pinIds) set.add(id);
    list.pinIds = Array.from(set);
    saveStateAll(persisted);
  }

  function createFavList(name) {
    const id = uuid();
    persisted.favorites.order.push(id);
    persisted.favorites.lists[id] = { id, name: name || 'お気に入り', pinIds: [] };
    saveStateAll(persisted);
    return id;
  }

  function moveFavList(id, dir) {
    const order = persisted.favorites.order;
    const idx = order.indexOf(id);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j], order[idx]];
    saveStateAll(persisted);
  }

  function renameFavList(id, name) {
    const list = persisted.favorites.lists[id];
    if (!list) return;
    list.name = name || list.name;
    saveStateAll(persisted);
  }

  function deleteFavList(id) {
    if (!persisted.favorites.lists[id]) return;
    if (persisted.favorites.order.length <= 1) return; // 最低1つ残す
    delete persisted.favorites.lists[id];
    persisted.favorites.order = persisted.favorites.order.filter(x => x !== id);
    if (ui.state.activeFavId === id) ui.state.activeFavId = persisted.favorites.order[0] || null;
    saveStateAll(persisted);
  }

  function removePinFromFav(listId, pinId) {
    const list = persisted.favorites.lists[listId];
    if (!list) return;
    list.pinIds = list.pinIds.filter(x => x !== pinId);
    saveStateAll(persisted);
  }

  function movePinInFav(listId, pinId, dir) {
    const list = persisted.favorites.lists[listId];
    if (!list) return;
    const a = list.pinIds;
    const i = a.indexOf(pinId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    saveStateAll(persisted);
  }

  function createSnapshot(name, pinIdsOrdered) {
    const id = uuid();
    persisted.snapshots.order.push(id);
    persisted.snapshots.items[id] = {
      id,
      name: name || `履歴 ${persisted.snapshots.order.length}`,
      createdAt: nowIso(),
      pageKey: currentPageKey,
      pinIds: pinIdsOrdered || [],
    };
    saveStateAll(persisted);
    return id;
  }

  function moveSnapshot(id, dir) {
    const order = persisted.snapshots.order;
    const idx = order.indexOf(id);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j], order[idx]];
    saveStateAll(persisted);
  }

  function renameSnapshot(id, name) {
    const it = persisted.snapshots.items[id];
    if (!it) return;
    it.name = name || it.name;
    saveStateAll(persisted);
  }

  function deleteSnapshot(id) {
    if (!persisted.snapshots.items[id]) return;
    delete persisted.snapshots.items[id];
    persisted.snapshots.order = persisted.snapshots.order.filter(x => x !== id);
    if (ui.state.activeSnapId === id) ui.state.activeSnapId = null;
    saveStateAll(persisted);
  }

  // =========================================================
  // Rehydrate (Favorites / History restore)
  // - pinStore が空の状態でも、お気に入り/履歴の pinId 群から
  //   thumbUrl / countStr を再取得して表示を復元する
  // =========================================================

  // 再取得の並列数（強すぎると失敗/負荷が増える）
  const REHYDRATE_CONCURRENCY = 3;
  // 1件ごとに軽い間隔（0でも動くが、安定性目的で少し入れる）
  const REHYDRATE_DELAY_MS = 80;

  function needsRehydratePin(pinId, { force = false } = {}) {
    if (!pinId) return false;
    if (force) return true;
    const p = pinStore.get(pinId);
    // thumbUrl がない（or 空）なら表示復元が必要
    if (!p || !p.thumbUrl) return true;
    return false;
  }

  // pinページHTMLから「使えそうな画像URL」を拾う（安全寄りの最低限）
  function extractThumbUrlFromPinDoc(doc) {
    if (!doc) return null;

    // まずは og:image が最も安定
    const og = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
    const ogUrl = og?.getAttribute('content')?.trim();
    if (ogUrl) return ogUrl;

    // 次に、doc内の img から拾う（最初の1枚）
    const img = doc.querySelector('img[src], img[srcset]');
    const src = img?.getAttribute('src')?.trim();
    if (src) return src;

    const ss = img?.getAttribute('srcset') || '';
    const first = ss.split(',')[0]?.trim()?.split(' ')[0];
    return first || null;
  }

  // 再取得用：pinページをfetchして countStr + thumbUrl を拾う
  // ※既存 fetchPinPageData() が thumbUrl を返さない/不安定でも動くように、ここで補完する
  async function fetchPinPageDataForRehydrate(pinId) {
    const url = pinUrl(pinId);
    const res = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const el = doc.querySelector('[data-test-id="reactions-count"]');
    const countStrRaw = el?.textContent?.trim() || null;
    const countStr = (countStrRaw && /^[0-9.,]+$/.test(countStrRaw)) ? countStrRaw : '0';

    const thumbUrl = extractThumbUrlFromPinDoc(doc);

    return { countStr, thumbUrl };
  }

  // pinIds を一括で再取得して pinStore を復元する
  // opts:
  //   - force: true で既存 thumbUrl があっても再取得
  //   - onlyMissing: true で「欠損だけ」対象（デフォルト）
  //   - concurrency: 並列数
  //   - delayMs: 1件ごとの軽い待機
  //   - onProgress({done,total,ok,fail,skipped})
  async function rehydratePins(pinIds, opts = {}) {
    const {
      force = false,
      onlyMissing = true,
      concurrency = REHYDRATE_CONCURRENCY,
      delayMs = REHYDRATE_DELAY_MS,
      onProgress = null,
      toast = true,
    } = opts;

    // キャンセル用（UI側で ui.state.rehydrateCancel=true にする想定）
    // UIが未改造でも動くように、無ければローカル扱い
    if (ui?.state) {
      ui.state.rehydrateRunning = true;
      ui.state.rehydrateCancel = false;
    }

    const uniq = Array.from(new Set((pinIds || []).filter(Boolean)));

    // 対象絞り込み
    let targets = uniq;
    if (onlyMissing && !force) {
      targets = targets.filter((id) => needsRehydratePin(id, { force: false }));
    } else if (!onlyMissing && !force) {
      // そのまま
    }

    const total = targets.length;

    let done = 0;
    let ok = 0;
    let fail = 0;
    let skipped = (uniq.length - targets.length);

    const progress = () => {
      if (typeof onProgress === 'function') {
        try { onProgress({ done, total, ok, fail, skipped }); } catch {}
      }
      if (toast && ui?.toast) {
        ui.toast(`再取得: ${done}/${total} (成功${ok} 失敗${fail})`);
      }
    };

    if (toast && ui?.toast) {
      ui.toast(`再取得開始: ${total}件`);
    }

    // 1つずつ取り出すワーカー方式
    let idx = 0;
    const worker = async () => {
      while (true) {
        // キャンセル（UI側）
        if (ui?.state?.rehydrateCancel) break;

        const my = idx++;
        if (my >= total) break;

        const pinId = targets[my];

        try {
          if (delayMs > 0) await sleep(delayMs);

          const { countStr, thumbUrl } = await fetchPinPageDataForRehydrate(pinId);

          // count cache & pinStore 更新
          const finalCount = (countStr && /^[0-9.,]+$/.test(countStr)) ? countStr : '0';
          setCachedCount(pinId, finalCount);

          const patch = {
            countStr: finalCount,
            countNum: normalizeCount(finalCount),
          };

          if (thumbUrl) patch.thumbUrl = thumbUrl;

          upsertPin(pinId, patch);

          ok++;
        } catch (e) {
          fail++;
          log('rehydrate failed', pinId, e);
        } finally {
          done++;
          // 進捗通知
          progress();
        }
      }
    };

    const n = Math.max(1, Math.min(concurrency, total || 1));
    const ps = [];
    for (let i = 0; i < n; i++) ps.push(worker());
    await Promise.all(ps);

    if (ui?.state) {
      ui.state.rehydrateRunning = false;
    }

    if (toast && ui?.toast) {
      if (ui?.state?.rehydrateCancel) ui.toast(`再取得: 中断 (成功${ok} 失敗${fail})`);
      else ui.toast(`再取得完了: 成功${ok} 失敗${fail} (スキップ${skipped})`);
    }

    // 画面反映（呼び出し側でモーダル/VS再描画してもOKだが、最低限ここでも反映）
    try {
      if (ui?.state?.modalOpen) ui.renderModal(true);
    } catch {}
    try {
      if (ui?.state?.sortViewOpen) ui.renderSortGridDebounced(true);
    } catch {}

    return { total, ok, fail, skipped, canceled: !!ui?.state?.rehydrateCancel };
  }

  function downloadTextAsFile(filename, text) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function pickJsonFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';
      input.onchange = () => resolve(input.files?.[0] || null);
      input.click();
    });
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  // =========================================================
  // UI (Panel + SortOverlay + Modal + Viewer)
  // =========================================================
  const ui = {
    state: {
      sortViewOpen: false,
      sortDir: persisted.ui.sortDir || 'desc',

      // min filter
      minEnabled: !!persisted.ui.minEnabled,
      minCount: persisted.ui.minCount || 0,

      // count known filter
      onlyKnown: !!persisted.ui.onlyKnown,

      // favorites / snapshots
      activeFavId: persisted.ui.activeFavId || persisted.favorites.order[0] || null,
      activeSnapId: persisted.ui.activeSnapId || null,

      // mode: 'all' | 'favorites' | 'snapshot'
      viewMode: 'all',

      // panel
      panelOpen: true,

      // render
      lastRenderAt: 0,
      renderTimer: null,
      toastTimer: null,

      // bulk
      bulkDownloading: false,
      bulkCancel: false,

      // auto collect
      autoCollecting: false,
      autoCollectCancel: false,
      autoCollectTarget: 200,

      // modal
      modalOpen: false,
      modalMode: null, // 'favorites' | 'history'
      modalSelectedPinId: null,           // 単一（互換のため残す）
      modalSelectedPinIds: new Set(),     // ★追加：モーダル右側の複数選択
      modalLastClickedPinId: null,        // ★追加：UX用（最後に触ったpin）
      historySortDir: 'desc', // 'desc' = 新しい順, 'asc' = 古い順

      // viewer
      viewerOpen: false,
      viewerPinId: null,
      viewerImgUrl: null,   // 1200x置換済みURL
      viewerPinHref: null,  // pinページ
      viewerCountStr: null,

      // virtual scroll
      vs: {
        wrapEl: null,
        innerEl: null,
        spacerEl: null,
        resizeObs: null,
        lastTop: 0,
        lastWidth: 0,
        cols: 1,
        cardW: VS_CARD_MIN_W,
        cardH: VS_CARD_EST_H,
        gap: VS_GAP,
        overscan: VS_OVERSCAN_ROWS,
        arr: [],
        key: '',
        raf: 0,
      },
    },

    ensureAllUI() {
      ui.ensureMenuOpenButton();
      ui.ensurePanel();
      ui.ensureToast();
      if (ui.state.sortViewOpen) ui.ensureSortOverlay();
      if (ui.state.modalOpen) ui.ensureModal();
      if (ui.state.viewerOpen) ui.ensureViewer();
      persistUIState();
      if (persisted._restoredFromGM) {
        persisted._restoredFromGM = false;
        ui.toast('データを復元しました（GMバックアップ）');
      }
    },

    ensureMenuOpenButton() {
      const existing = document.getElementById('pt-menu-open');
      if (ui.state.panelOpen) {
        if (existing) existing.remove();
        return;
      }
      if (existing) return;

      const mount = uiMountRoot();

      const btn = document.createElement('button');
      btn.id = 'pt-menu-open';
      btn.type = 'button';
      btn.textContent = 'メニュー';
      btn.title = 'ツールメニューを開く';
      btn.style.cssText = `
        position:fixed;
        right:12px;
        bottom:12px;
        z-index:2147483647;
        padding:10px 12px;
        border-radius:999px;
        border:1px solid rgba(255,255,255,0.22);
        background: rgba(0,0,0,0.62);
        color:#fff;
        font-weight:900;
        cursor:pointer;
        backdrop-filter: blur(6px);
      `;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ui.state.panelOpen = true;
        ui.ensureAllUI();
        ui.ensurePanel(true);
      });

      mount.appendChild(btn);
    },

    ensurePanel(forceRerender = false) {
      const existing = document.getElementById('pt-panel');

      if (!ui.state.panelOpen) {
        if (existing) existing.remove();
        return;
      }

      if (existing && !forceRerender) {
        ui.updateInfo();
        return;
      }
      if (existing) existing.remove();

      const mount = uiMountRoot();

      const panel = document.createElement('div');
      panel.id = 'pt-panel';
      panel.style.cssText = `
        position:fixed;
        right:12px;
        bottom:12px;
        z-index:2147483647;
        background:rgba(0,0,0,0.62);
        color:#fff;
        padding:10px;
        border-radius:12px;
        font-size:12px;
        font-weight:800;
        display:flex;
        flex-direction:column;
        gap:10px;
        user-select:none;
        min-width: 250px;
        backdrop-filter: blur(6px);
        border: 1px solid rgba(255,255,255,0.12);
      `;

      // header
      const head = document.createElement('div');
      head.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px;';

      const info = document.createElement('div');
      info.id = 'pt-info';
      info.textContent = '収集: 0/0';
      info.style.cssText = 'opacity:0.95;';

      const btnClose = document.createElement('button');
      btnClose.type = 'button';
      btnClose.textContent = '×';
      btnClose.title = 'メニューを閉じる';
      btnClose.style.cssText = `
        width:28px; height:28px;
        border-radius:10px;
        border:1px solid rgba(255,255,255,0.18);
        background: rgba(255,255,255,0.10);
        color:#fff;
        font-weight:1000;
        cursor:pointer;
      `;
      btnClose.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ui.state.panelOpen = false;
        ui.ensureAllUI();
        ui.ensurePanel(true);
      });

      head.appendChild(info);
      head.appendChild(btnClose);

      // row: sort (only)
      const rowTop = document.createElement('div');
      rowTop.style.cssText = 'display:flex; gap:8px;';

      const btnSort = document.createElement('button');
      btnSort.type = 'button';
      btnSort.textContent = ui.state.sortViewOpen ? '戻る' : '並び替え';
      btnSort.style.cssText = ui.buttonCss(false);
      btnSort.style.flex = '1';
      btnSort.addEventListener('click', () => {
        if (ui.state.sortViewOpen) ui.closeSortView();
        else ui.openSortView();
        ui.ensurePanel(true);
      });

      rowTop.appendChild(btnSort);

      // row: asc/desc
      const rowSort = document.createElement('div');
      rowSort.style.cssText = 'display:flex; gap:8px;';

      const btnDesc = document.createElement('button');
      btnDesc.type = 'button';
      btnDesc.textContent = '❤↓ 降順';
      btnDesc.style.cssText = ui.buttonCss(false);
      btnDesc.style.flex = '1';
      btnDesc.addEventListener('click', () => {
        ui.state.sortDir = 'desc';
        ui.renderSortGridDebounced(true);
        persistUIState();
      });

      const btnAsc = document.createElement('button');
      btnAsc.type = 'button';
      btnAsc.textContent = '❤↑ 昇順';
      btnAsc.style.cssText = ui.buttonCss(false);
      btnAsc.style.flex = '1';
      btnAsc.addEventListener('click', () => {
        ui.state.sortDir = 'asc';
        ui.renderSortGridDebounced(true);
        persistUIState();
      });

      rowSort.appendChild(btnDesc);
      rowSort.appendChild(btnAsc);

      // filters (min only)  ※onlyKnown UIは撤去
      const filters = document.createElement('div');
      filters.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

      const minLabel = document.createElement('div');
      minLabel.textContent = '❤下限';
      minLabel.style.cssText = 'opacity:0.85;';

      const minInput = document.createElement('input');
      minInput.type = 'number';
      minInput.value = String(ui.state.minCount || 0);
      minInput.min = '0';
      minInput.style.cssText = ui.inputCss(78);
      minInput.addEventListener('input', () => {
        ui.state.minCount = Math.max(0, parseInt(minInput.value || '0', 10) || 0);
        persistUIState();
        ui.renderSortGridDebounced(true);
      });

      const minEnableLabel = document.createElement('label');
      minEnableLabel.style.cssText = 'display:flex; gap:6px; align-items:center; opacity:0.9;';
      const minEnable = document.createElement('input');
      minEnable.type = 'checkbox';
      minEnable.checked = !!ui.state.minEnabled;
      const minEnableText = document.createElement('span');
      minEnableText.textContent = '有効';
      minEnableLabel.appendChild(minEnable);
      minEnableLabel.appendChild(minEnableText);
      minEnable.addEventListener('change', () => {
        ui.state.minEnabled = !!minEnable.checked;
        persistUIState();
        ui.renderSortGridDebounced(true);
      });

      filters.appendChild(minLabel);
      filters.appendChild(minInput);
      filters.appendChild(minEnableLabel);

      // Auto collect
      const autoRow = document.createElement('div');
      autoRow.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

      const acLabel = document.createElement('div');
      acLabel.textContent = '自動収集';
      acLabel.style.cssText = 'opacity:0.85;';

      const acInput = document.createElement('input');
      acInput.type = 'number';
      acInput.min = '1';
      acInput.value = String(ui.state.autoCollectTarget || 200);
      acInput.style.cssText = ui.inputCss(88);
      acInput.addEventListener('input', () => {
        ui.state.autoCollectTarget = Math.max(1, parseInt(acInput.value || '1', 10) || 1);
      });

      const btnAC = document.createElement('button');
      btnAC.type = 'button';
      btnAC.textContent = ui.state.autoCollecting ? '収集中…' : '開始';
      btnAC.style.cssText = ui.buttonCss(false);
      btnAC.addEventListener('click', async () => {
        if (ui.state.autoCollecting) return;
        const n = Math.max(1, parseInt(acInput.value || '1', 10) || 1);
        ui.state.autoCollectTarget = n;
        ui.ensurePanel(true);
        await autoCollectTo(n);
        ui.ensurePanel(true);
      });

      const btnACStop = document.createElement('button');
      btnACStop.type = 'button';
      btnACStop.textContent = '停止';
      btnACStop.style.cssText = ui.buttonCss(true);
      btnACStop.addEventListener('click', () => {
        ui.state.autoCollectCancel = true;
      });

      autoRow.appendChild(acLabel);
      autoRow.appendChild(acInput);
      autoRow.appendChild(btnAC);
      autoRow.appendChild(btnACStop);

      // manage (統合：管理メニューのみ) ※Export/Importは撤去、履歴ボタンも撤去
      const manageRow = document.createElement('div');
      manageRow.style.cssText = 'display:flex; gap:8px;';

      const btnManage = document.createElement('button');
      btnManage.type = 'button';
      btnManage.textContent = '管理メニュー';
      btnManage.style.cssText = ui.buttonCss(true);
      btnManage.style.flex = '1';
      btnManage.addEventListener('click', () => {
        // 管理モーダルはお気に入りをデフォルト表示（履歴/入出力へはモーダル内から）
        ui.openModal('favorites');
      });

      manageRow.appendChild(btnManage);

      panel.appendChild(head);
      panel.appendChild(rowTop);
      panel.appendChild(rowSort);
      panel.appendChild(filters);
      panel.appendChild(autoRow);
      panel.appendChild(manageRow);

      mount.appendChild(panel);

      ui.updateInfo();
    },

    buttonCss(isSecondary = false) {
      return `
        padding:8px 10px;
        border-radius:10px;
        border:1px solid rgba(255,255,255,0.18);
        background:${isSecondary ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.14)'};
        color:#fff;
        cursor:pointer;
        font-size:12px;
        font-weight:900;
        white-space:nowrap;
      `;
    },

    inputCss(widthPx) {
      return `
        width:${widthPx}px;
        padding:6px 8px;
        border-radius:10px;
        border:1px solid rgba(255,255,255,0.18);
        background:rgba(255,255,255,0.10);
        color:#fff;
        outline:none;
        font-weight:900;
      `;
    },

    selectCss() {
      return `
        flex:1;
        min-width: 160px;
        padding:7px 8px;
        border-radius:10px;
        border:1px solid rgba(255,255,255,0.18);
        background:rgba(0,0,0,0.35);
        color:#fff;
        outline:none;
        font-weight:900;
      `;
    },

    ensureToast() {
      if (document.getElementById('pt-toast')) return;
      const mount = uiMountRoot();
      const t = document.createElement('div');
      t.id = 'pt-toast';
      t.style.cssText = `
        position:fixed;
        left:12px;
        bottom:12px;
        z-index:2147483647;
        background:rgba(0,0,0,0.72);
        color:#fff;
        padding:10px 12px;
        border-radius:12px;
        font-size:12px;
        font-weight:900;
        opacity:0;
        transform: translateY(6px);
        transition: opacity 120ms ease, transform 120ms ease;
        pointer-events:none;
        user-select:none;
        max-width: 60vw;
        white-space: pre-line;
        backdrop-filter: blur(6px);
      `;
      mount.appendChild(t);
    },

    toast(msg) {
      const el = document.getElementById('pt-toast');
      if (!el) return;
      el.textContent = msg;
      el.style.opacity = '1';
      el.style.transform = 'translateY(0px)';
      if (ui.state.toastTimer) clearTimeout(ui.state.toastTimer);
      ui.state.toastTimer = setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(6px)';
      }, 1200);
    },

    updateInfo() {
      const info = document.getElementById('pt-info');
      if (!info) return;
      const totalPins = pinStore.size;
      const known = Array.from(pinStore.values()).filter(p => p.countStr != null && p.countNum != null).length;
      info.textContent = `収集: ${known}/${totalPins}`;
    },

    openSortView() {
      ui.state.sortViewOpen = true;
      ui.ensureSortOverlay();
      ui.renderSortGrid(true);
      ui.updateInfo();
      ui.ensurePanel(true);
    },

    closeSortView() {
      ui.state.sortViewOpen = false;

      // virtual scroll cleanup
      try {
        const vs = ui.state.vs;
        if (vs.resizeObs) vs.resizeObs.disconnect();
        vs.resizeObs = null;
        vs.wrapEl = null;
        vs.innerEl = null;
        vs.spacerEl = null;
        vs.arr = [];
        vs.key = '';
        if (vs.raf) cancelAnimationFrame(vs.raf);
        vs.raf = 0;
      } catch {}

      const overlay = document.getElementById('pt-sort-overlay');
      if (overlay) overlay.remove();
      ui.updateInfo();
      ui.ensurePanel(true);
    },

    ensureSortOverlay() {
      if (document.getElementById('pt-sort-overlay')) return;

      const mount = uiMountRoot();

      const overlay = document.createElement('div');
      overlay.id = 'pt-sort-overlay';
      overlay.style.cssText = `
        position:fixed; inset:0; z-index:2147483000;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(6px);
        display:flex; flex-direction:column;
      `;

      const topbar = document.createElement('div');
      topbar.style.cssText = `
        display:flex; align-items:center; gap:10px;
        padding:10px 12px;
        background: rgba(0,0,0,0.60);
        color:#fff;
        font-weight:900;
        flex-wrap: wrap;
        border-bottom: 1px solid rgba(255,255,255,0.10);
      `;

      const left = document.createElement('div');
      left.textContent = '並び替え';
      left.style.cssText = 'flex:1; min-width: 80px; opacity:0.95;';

      const right = document.createElement('div');
      right.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

      const btnBulkDl = document.createElement('button');
      btnBulkDl.textContent = '一括DL';
      btnBulkDl.style.cssText = ui.buttonCss(false);

      const btnFavSave = document.createElement('button');
      btnFavSave.textContent = 'お気に入り保存';
      btnFavSave.style.cssText = ui.buttonCss(true);

      const btnSnapSave = document.createElement('button');
      btnSnapSave.textContent = '履歴保存';
      btnSnapSave.style.cssText = ui.buttonCss(true);

      const btnClearSel = document.createElement('button');
      btnClearSel.textContent = '選択クリア';
      btnClearSel.style.cssText = ui.buttonCss(true);

      const close = document.createElement('button');
      close.textContent = '閉じる';
      close.style.cssText = ui.buttonCss(true);

      btnBulkDl.addEventListener('click', async () => {
        const ids = Array.from(selectedPins);
        if (ids.length === 0) {
          ui.toast('選択なし');
          return;
        }
        if (ids.length > BULK_DOWNLOAD_MAX) {
          ui.toast(`多すぎ（最大 ${BULK_DOWNLOAD_MAX}）`);
          return;
        }
        ui.toast(`DL開始: ${ids.length}`);
        await ui.bulkDownloadSelectedFast(ids);
      });

      btnFavSave.addEventListener('click', () => {
        const listId = getActiveFavId();
        if (!listId) {
          ui.toast('お気に入りリストなし');
          return;
        }
        const ids = Array.from(selectedPins);
        if (ids.length === 0) {
          ui.toast('選択なし');
          return;
        }
        addPinsToFav(listId, ids);
        ui.toast(`お気に入り保存: ${ids.length}`);
      });

      btnSnapSave.addEventListener('click', () => {
        const pinIdsOrdered = ui.computeOrderedPinIds();
        const name = prompt('履歴名', `履歴 ${new Date().toLocaleString()}`);
        const id = createSnapshot(name || `履歴 ${persisted.snapshots.order.length}`, pinIdsOrdered);
        ui.state.activeSnapId = id;
        ui.state.viewMode = 'snapshot';
        persistUIState();
        ui.toast('履歴保存');
      });

      btnClearSel.addEventListener('click', () => {
        selectedPins.clear();
        ui.toast('選択クリア');
        ui.renderSortGridDebounced(true);
      });

      close.addEventListener('click', () => ui.closeSortView());

      right.appendChild(btnBulkDl);
      right.appendChild(btnFavSave);
      right.appendChild(btnSnapSave);
      right.appendChild(btnClearSel);
      right.appendChild(close);

      topbar.appendChild(left);
      topbar.appendChild(right);

      const gridWrap = document.createElement('div');
      gridWrap.id = 'pt-sort-grid-wrap';
      gridWrap.style.cssText = `
        flex:1; overflow:auto;
        padding:12px;
        position:relative;
      `;

      // virtual scroll container
      const vsWrap = document.createElement('div');
      vsWrap.id = 'pt-vs-wrap';
      vsWrap.style.cssText = `
        position:relative;
        width:100%;
        height:100%;
        overflow:auto;
        padding: 0;
      `;

      const vsInner = document.createElement('div');
      vsInner.id = 'pt-vs-inner';
      vsInner.style.cssText = `
        position:relative;
        width:100%;
      `;

      const spacer = document.createElement('div');
      spacer.id = 'pt-vs-spacer';
      spacer.style.cssText = `
        position:relative;
        width:100%;
        height:0px;
      `;

      vsInner.appendChild(spacer);
      vsWrap.appendChild(vsInner);
      gridWrap.appendChild(vsWrap);

      overlay.appendChild(topbar);
      overlay.appendChild(gridWrap);
      mount.appendChild(overlay);

      // bind vs elements
      ui.state.vs.wrapEl = vsWrap;
      ui.state.vs.innerEl = vsInner;
      ui.state.vs.spacerEl = spacer;

      // listeners
      vsWrap.addEventListener('scroll', () => ui.renderSortGridDebounced(false));

      // resize observer
      try {
        const ro = new ResizeObserver(() => ui.renderSortGridDebounced(true));
        ro.observe(vsWrap);
        ui.state.vs.resizeObs = ro;
      } catch {}

      // first paint
      ui.renderSortGridDebounced(true);
    },

    // いまの条件で並び順pinId配列を作る（履歴保存用）
    computeOrderedPinIds() {
      let arr = Array.from(pinStore.values());

      const allowed = ui.getAllowedPinIdSet();
      if (allowed) arr = arr.filter(p => allowed.has(p.pinId));

      if (ui.state.onlyKnown) arr = arr.filter(p => p.countNum != null);

      if (ui.state.minEnabled) {
        const minC = ui.state.minCount || 0;
        arr = arr.filter(p => (p.countNum != null ? p.countNum : 0) >= minC);
      }

      arr.sort((a, b) => {
        const ah = a.countNum != null;
        const bh = b.countNum != null;
        if (ah !== bh) return ah ? -1 : 1;

        const av = ah ? a.countNum : 0;
        const bv = bh ? b.countNum : 0;
        return ui.state.sortDir === 'asc' ? (av - bv) : (bv - av);
      });

      return arr.map(p => p.pinId);
    },

    getAllowedPinIdSet() {
      if (ui.state.viewMode === 'favorites') {
        const list = persisted.favorites.lists[ui.state.activeFavId];
        if (!list) return null;
        return new Set(list.pinIds);
      }
      if (ui.state.viewMode === 'snapshot') {
        const it = persisted.snapshots.items[ui.state.activeSnapId];
        if (!it) return null;
        return new Set(it.pinIds);
      }
      return null;
    },

    _buildSortArray() {
      let arr = Array.from(pinStore.values());

      const allowed = ui.getAllowedPinIdSet();
      if (allowed) arr = arr.filter(p => allowed.has(p.pinId));

      if (ui.state.onlyKnown) arr = arr.filter(p => p.countNum != null);

      if (ui.state.minEnabled) {
        const minC = ui.state.minCount || 0;
        arr = arr.filter(p => (p.countNum != null ? p.countNum : 0) >= minC);
      }

      arr.sort((a, b) => {
        const ah = a.countNum != null;
        const bh = b.countNum != null;
        if (ah !== bh) return ah ? -1 : 1;

        const av = ah ? a.countNum : 0;
        const bv = bh ? b.countNum : 0;
        return ui.state.sortDir === 'asc' ? (av - bv) : (bv - av);
      });

      return arr;
    },

    _vsComputeLayout() {
      const vs = ui.state.vs;
      const wrap = vs.wrapEl;
      if (!wrap) return;

      const width = wrap.clientWidth || 1;
      const cols = Math.max(1, Math.floor((width + VS_GAP) / (VS_CARD_MIN_W + VS_GAP)));
      vs.cols = cols;
      const usable = width - VS_GAP * (cols - 1);
      vs.cardW = Math.max(VS_CARD_MIN_W, Math.floor(usable / cols));
      vs.cardH = VS_CARD_EST_H;
      vs.lastWidth = width;
    },

    _vsRender(force = false) {
      const vs = ui.state.vs;
      const wrap = vs.wrapEl;
      const inner = vs.innerEl;
      const spacer = vs.spacerEl;
      if (!wrap || !inner || !spacer) return;

      ui._vsComputeLayout();

      const arr = vs.arr || [];
      const cols = vs.cols || 1;
      const gap = vs.gap;
      const cardW = vs.cardW;
      const cardH = vs.cardH;

      const totalRows = Math.ceil(arr.length / cols);
      const fullH = Math.max(0, totalRows * cardH + Math.max(0, totalRows - 1) * gap);
      spacer.style.height = `${fullH}px`;

      const top = wrap.scrollTop;
      const vh = wrap.clientHeight;
      const rowH = cardH + gap;

      const firstRow = Math.max(0, Math.floor(top / rowH) - vs.overscan);
      const lastRow = Math.min(totalRows - 1, Math.floor((top + vh) / rowH) + vs.overscan);

      // viewport rows -> items
      const startIdx = firstRow * cols;
      const endIdx = Math.min(arr.length - 1, (lastRow + 1) * cols - 1);

      // key for light caching
      const key = `${arr.length}|${ui.state.sortDir}|${ui.state.minEnabled}|${ui.state.minCount}|${ui.state.onlyKnown}|${ui.state.viewMode}|${ui.state.activeFavId || ''}|${ui.state.activeSnapId || ''}|${cols}|${cardW}|${cardH}|${firstRow}|${lastRow}`;

      if (!force && key === vs.key && Math.abs(top - vs.lastTop) < 2) return;
      vs.key = key;
      vs.lastTop = top;

      // clear old nodes except spacer
      while (inner.children.length > 1) inner.removeChild(inner.lastChild);

      const frag = document.createDocumentFragment();

      for (let i = startIdx; i <= endIdx; i++) {
        const p = arr[i];
        if (!p) continue;

        const row = Math.floor(i / cols);
        const col = i % cols;

        const x = col * (cardW + gap);
        const y = row * (cardH + gap);

        const holder = document.createElement('div');
        holder.style.cssText = `
          position:absolute;
          left:${x}px;
          top:${y}px;
          width:${cardW}px;
          height:${cardH}px;
        `;

        const card = ui.renderCard(p);
        // card is an <a>, force fill height
        card.style.height = '100%';
        card.style.display = 'block';

        holder.appendChild(card);
        frag.appendChild(holder);
      }

      inner.appendChild(frag);
    },

    renderSortGrid(force = false) {
      if (!ui.state.sortViewOpen) return;

      const now = Date.now();
      if (!force && (now - ui.state.lastRenderAt) < 50) return;
      ui.state.lastRenderAt = now;

      const vs = ui.state.vs;
      if (!vs.wrapEl) return;

      vs.arr = ui._buildSortArray();
      ui._vsRender(force);
    },

    renderSortGridDebounced(force = false) {
      if (!ui.state.sortViewOpen) return;
      if (ui.state.renderTimer) clearTimeout(ui.state.renderTimer);
      ui.state.renderTimer = setTimeout(() => ui.renderSortGrid(force), 60);
    },

    async bulkDownloadSelectedFast(pinIds) {
      const jobs = pinIds.map((id) => {
        const p = pinStore.get(id);
        if (!p) return null;
        const hiUrl = toHighResPinimgUrl(p.thumbUrl);
        const url = hiUrl || (p.href || pinUrl(id));
        const filename = makeDlFilename(p);
        return { id, url, filename };
      }).filter(Boolean);

      let done = 0;
      let fail = 0;
      let idx = 0;

      const worker = async () => {
        while (true) {
          if (ui.state.bulkCancel) break;
          const my = idx++;
          if (my >= jobs.length) break;

          const job = jobs[my];
          try {
            await downloadWithRetry(job.url, job.filename, BULK_DL_RETRY);
            done++;
          } catch (e) {
            fail++;
            log('DL failed', job, e);
          }
          if (BULK_DOWNLOAD_DELAY_MS > 0) await sleep(BULK_DOWNLOAD_DELAY_MS);
        }
      };

      const n = Math.max(1, Math.min(BULK_DL_CONCURRENCY, jobs.length));
      const ps = [];
      for (let i = 0; i < n; i++) ps.push(worker());
      await Promise.all(ps);

      ui.toast(`DL: 成功 ${done} / 失敗 ${fail}`);
    },

    renderCard(p) {
      const isSelected = selectedPins.has(p.pinId);

      const card = document.createElement('a');
      card.href = p.href || pinUrl(p.pinId);
      card.target = '_blank';
      card.rel = 'noreferrer noopener';
      card.style.cssText = `
        display:block;
        background: rgba(0,0,0,0.55);
        border:1px solid rgba(255,255,255,0.12);
        border-radius:14px;
        overflow:hidden;
        text-decoration:none;
        color:#fff;
        outline: ${isSelected ? '2px solid rgba(255,255,255,0.65)' : 'none'};
      `;

      const imgWrap = document.createElement('div');
      imgWrap.style.cssText = `
        width:100%;
        height: 260px;
        background: rgba(255,255,255,0.08);
        display:flex;
        align-items:center;
        justify-content:center;
        position:relative;
      `;

      if (p.thumbUrl) {
        const im = document.createElement('img');
        im.src = p.thumbUrl;
        im.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block;';
        imgWrap.appendChild(im);
      } else {
        const ph = document.createElement('div');
        ph.textContent = 'No thumbnail';
        ph.style.cssText = 'opacity:0.75; font-weight:900; padding:10px;';
        imgWrap.appendChild(ph);
      }

      const badge = document.createElement('div');
      badge.style.cssText = `
        position:absolute;
        left:10px;
        top:10px;
        padding:6px 10px;
        border-radius:999px;
        background:rgba(0,0,0,0.70);
        font-weight:900;
        font-size:12px;
        display:inline-flex;
        gap:6px;
        align-items:center;
      `;
      const heart = document.createElement('span');
      heart.textContent = '❤';
      const cnt = document.createElement('span');
      cnt.textContent = (p.countStr != null) ? p.countStr : '...';
      badge.appendChild(heart);
      badge.appendChild(cnt);
      imgWrap.appendChild(badge);

      const meta = document.createElement('div');
      meta.style.cssText = 'padding:10px; display:flex; flex-direction:column; gap:8px;';

      const controlRow = document.createElement('div');
      controlRow.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

      const btnCopy = document.createElement('button');
      btnCopy.type = 'button';
      btnCopy.textContent = 'Copy PNG';
      btnCopy.style.cssText = ui.buttonCss(true);

      const btnCopyUrl = document.createElement('button');
      btnCopyUrl.type = 'button';
      btnCopyUrl.textContent = 'Copy URL';
      btnCopyUrl.style.cssText = ui.buttonCss(true);

      const btnCheck = document.createElement('button');
      btnCheck.type = 'button';
      btnCheck.textContent = isSelected ? '✓ 選択' : '□ 選択';
      btnCheck.style.cssText = ui.buttonCss(false);

      btnCopy.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const hiUrl = toHighResPinimgUrl(p.thumbUrl);
        if (!hiUrl) {
          try {
            await copyTextToClipboard(p.href || pinUrl(p.pinId));
            ui.toast('pin URL');
          } catch {
            ui.toast('失敗');
          }
          return;
        }

        try {
          await copyImageToClipboard_StrongPng(hiUrl);
          ui.toast('PNGコピー');
        } catch {
          try {
            await copyTextToClipboard(hiUrl);
            ui.toast('URLコピー');
          } catch {
            ui.toast('失敗');
          }
        }
      });

      btnCopyUrl.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const hiUrl = toHighResPinimgUrl(p.thumbUrl) || (p.href || pinUrl(p.pinId));
        try {
          await copyTextToClipboard(hiUrl);
          ui.toast('URLコピー');
        } catch {
          ui.toast('失敗');
        }
      });

      btnCheck.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (selectedPins.has(p.pinId)) selectedPins.delete(p.pinId);
        else selectedPins.add(p.pinId);
        ui.renderSortGridDebounced(true);
      });

      controlRow.appendChild(btnCopy);
      controlRow.appendChild(btnCopyUrl);
      controlRow.appendChild(btnCheck);

      meta.appendChild(controlRow);

      card.appendChild(imgWrap);
      card.appendChild(meta);
      return card;
    },

    // =========================================================
    // Modal
    // =========================================================
    openModal(mode) {
      ui.state.modalOpen = true;
      ui.state.modalMode = mode;

      ui.state.modalSelectedPinId = null;
      ui.state.modalSelectedPinIds = new Set();   // ★追加
      ui.state.modalLastClickedPinId = null;      // ★追加

      ui._rerenderModalPreviewIfAny = null;
      ui._updateModalRightCount = null;

      ui.ensureModal(true);
      ui.renderModal(true);
    },

    closeModal() {
      ui.state.modalOpen = false;
      ui.state.modalMode = null;

      ui.state.modalSelectedPinId = null;
      ui.state.modalSelectedPinIds = new Set();   // ★追加
      ui.state.modalLastClickedPinId = null;      // ★追加

      ui._rerenderModalPreviewIfAny = null;
      ui._updateModalRightCount = null;

      const m = document.getElementById('pt-modal');
      if (m) m.remove();
    },

    ensureModal(force = false) {
      const existing = document.getElementById('pt-modal');
      if (!ui.state.modalOpen) {
        if (existing) existing.remove();
        return;
      }
      if (existing && !force) return;
      if (existing) existing.remove();

      const mount = uiMountRoot();

      const modal = document.createElement('div');
      modal.id = 'pt-modal';
      modal.style.cssText = `
        position:fixed; inset:0;
        z-index:2147483600;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(6px);
        display:flex;
        align-items:center;
        justify-content:center;
        padding: 18px;
      `;

      modal.addEventListener('click', (ev) => {
        if (ev.target === modal) ui.closeModal();
      });

      const panel = document.createElement('div');
      panel.id = 'pt-modal-panel';
      panel.style.cssText = `
        width: 94vw;
        height: 90vh;
        background: rgba(0,0,0,0.72);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px;
        display:flex;
        flex-direction:column;
        overflow:hidden;
        color:#fff;
      `;

      const header = document.createElement('div');
      header.id = 'pt-modal-header';
      header.style.cssText = `
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.10);
        background: rgba(0,0,0,0.40);
        gap:10px;
      `;

      const title = document.createElement('div');
      title.id = 'pt-modal-title';
      title.textContent = '—';
      title.style.cssText =
        'font-weight:1000; opacity:0.95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

      const headerRight = document.createElement('div');
      headerRight.style.cssText =
        'display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;';

      const btnTabFav = document.createElement('button');
      btnTabFav.type = 'button';
      btnTabFav.textContent = 'お気に入り';
      btnTabFav.style.cssText = ui.buttonCss(ui.state.modalMode !== 'favorites');
      btnTabFav.addEventListener('click', () => {
        ui.state.modalMode = 'favorites';
        ui.state.modalSelectedPinId = null;
        ui.state.modalSelectedPinIds = new Set();
        ui.state.modalLastClickedPinId = null;
        ui._rerenderModalPreviewIfAny = null;
        ui._updateModalRightCount = null;
        ui.renderModal(true);
      });

      const btnTabHis = document.createElement('button');
      btnTabHis.type = 'button';
      btnTabHis.textContent = '履歴';
      btnTabHis.style.cssText = ui.buttonCss(ui.state.modalMode !== 'history');
      btnTabHis.addEventListener('click', () => {
        ui.state.modalMode = 'history';
        ui.state.modalSelectedPinId = null;
        ui.state.modalSelectedPinIds = new Set();
        ui.state.modalLastClickedPinId = null;
        ui._rerenderModalPreviewIfAny = null;
        ui._updateModalRightCount = null;
        ui.renderModal(true);
      });

      const btnTabIO = document.createElement('button');
      btnTabIO.type = 'button';
      btnTabIO.textContent = 'バックアップ';
      btnTabIO.style.cssText = ui.buttonCss(ui.state.modalMode !== 'io');
      btnTabIO.addEventListener('click', () => {
        ui.state.modalMode = 'io';
        ui.state.modalSelectedPinId = null;
        ui.state.modalSelectedPinIds = new Set();
        ui.state.modalLastClickedPinId = null;
        ui._rerenderModalPreviewIfAny = null;
        ui._updateModalRightCount = null;
        ui.renderModal(true);
      });

      const btnClose = document.createElement('button');
      btnClose.type = 'button';
      btnClose.textContent = '閉じる';
      btnClose.style.cssText = ui.buttonCss(true);
      btnClose.addEventListener('click', () => ui.closeModal());

      headerRight.appendChild(btnTabFav);
      headerRight.appendChild(btnTabHis);
      headerRight.appendChild(btnTabIO);
      headerRight.appendChild(btnClose);

      header.appendChild(title);
      header.appendChild(headerRight);

      const body = document.createElement('div');
      body.id = 'pt-modal-body';
      body.style.cssText = `
        flex:1;
        display:flex;
        gap: 0;
        overflow:hidden;
      `;

      panel.appendChild(header);
      panel.appendChild(body);
      modal.appendChild(panel);
      mount.appendChild(modal);

      if (!ui._modalKeyHandlerInstalled) {
        ui._modalKeyHandlerInstalled = true;
        window.addEventListener('keydown', (e) => {
          if (ui.state.viewerOpen && e.key === 'Escape') {
            ui.closeViewer();
            return;
          }
          if (!ui.state.modalOpen) return;
          if (e.key === 'Escape') ui.closeModal();
        });
      }
    },

    renderModal(force = false) {
      if (!ui.state.modalOpen) return;
      ui.ensureModal();

      const title = document.getElementById('pt-modal-title');
      const body = document.getElementById('pt-modal-body');
      if (!title || !body) return;

      body.innerHTML = '';

      const mode = ui.state.modalMode || 'favorites';

      if (mode === 'favorites') {
        title.textContent = 'お気に入り管理';
        ui.renderFavoritesManager(body);
        return;
      }

      if (mode === 'history') {
        title.textContent = '履歴管理';
        ui.renderHistoryManager(body);
        return;
      }

      // ---- Data I/O ----
      title.textContent = 'バックアップ';

      const wrap = document.createElement('div');
      wrap.style.cssText = `
        flex:1;
        display:flex;
        flex-direction:column;
        gap:12px;
        padding: 12px;
        overflow:auto;
      `;

      const section = document.createElement('div');
      section.style.cssText = `
        background: rgba(0,0,0,0.40);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px;
        padding: 12px;
        display:flex;
        flex-direction:column;
        gap:10px;
      `;

      const h = document.createElement('div');
      h.textContent = 'JSON エクスポート / インポート';
      h.style.cssText = 'font-weight:1000; opacity:0.95;';

      const desc = document.createElement('div');
      desc.style.cssText = 'opacity:0.85; font-weight:800; line-height:1.5;';
      desc.textContent =
        '・エクスポート：現在のデータ（お気に入り/履歴/設定）をJSONファイルとしてダウンロードします。\n' +
        '・インポート：JSONファイルを選択して復元します（既存データは置き換え）。';

      const rowBtns = document.createElement('div');
      rowBtns.style.cssText =
        'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

      const btnExport = document.createElement('button');
      btnExport.type = 'button';
      btnExport.textContent = 'エクスポート（JSON）';
      btnExport.style.cssText = ui.buttonCss(false);
      btnExport.addEventListener('click', () => {
        try {
          const json = exportPersistedToJson();
          const name = `pinterest-tool-backup-${new Date()
            .toISOString()
            .replace(/[:.]/g, '-')}.json`;
          downloadTextAsFile(name, json);
          ui.toast('JSONファイルをダウンロードしました');
        } catch (e) {
          ui.toast('エクスポート失敗');
        }
      });

      const btnImport = document.createElement('button');
      btnImport.type = 'button';
      btnImport.textContent = 'インポート（JSON）';
      btnImport.style.cssText = ui.buttonCss(true);
      btnImport.addEventListener('click', async () => {
        try {
          const file = await pickJsonFile();
          if (!file) return;
          const text = await readFileAsText(file);
          importPersistedFromJson(text);
          ui.toast('インポート完了（再描画します）');
          ui.ensureAllUI();
          ui.renderSortGridDebounced(true);
          if (ui.state.modalOpen) ui.renderModal(true);
        } catch (e) {
          ui.toast(e?.message || 'インポート失敗');
        }
      });

      const btnResetSel = document.createElement('button');
      btnResetSel.type = 'button';
      btnResetSel.textContent = '選択状態リセット';
      btnResetSel.style.cssText = ui.buttonCss(true);
      btnResetSel.addEventListener('click', () => {
        ui.state.modalSelectedPinIds = new Set();
        ui.state.modalSelectedPinId = null;
        ui.state.modalLastClickedPinId = null;
        ui._rerenderModalPreviewIfAny = null;
        ui._updateModalRightCount = null;
        ui.toast('選択状態をリセットしました');
      });

      rowBtns.appendChild(btnExport);
      rowBtns.appendChild(btnImport);

      section.appendChild(h);
      section.appendChild(desc);
      section.appendChild(rowBtns);

      const note = document.createElement('div');
      note.style.cssText =
        'opacity:0.75; font-weight:800; line-height:1.5; padding: 2px 2px;';
      note.textContent =
        '※ インポート後、表示が古い場合は「お気に入り / 履歴」タブに戻って確認してください。\n' +
        '※ Pinterestページの再読み込みは不要です。';

      wrap.appendChild(section);
      wrap.appendChild(note);
      body.appendChild(wrap);
    },

    highlightModalSelection() {
      const items = document.querySelectorAll('[data-pt-modal-item="1"]');
      const set = ui.state.modalSelectedPinIds || new Set();
      for (const el of items) {
        const pid = el.getAttribute('data-pin-id');
        const selected = set.has(pid) || (pid === ui.state.modalSelectedPinId); // 保険
        el.style.border = `1px solid rgba(255,255,255,${selected ? '0.55' : '0.12'})`;
        el.style.outline = selected ? '2px solid rgba(255,255,255,0.55)' : 'none';
      }
    },

    // =========================================================
    // Viewer
    // =========================================================
    openViewer(pinId) {
      const p = pinStore.get(pinId) || { pinId, thumbUrl: null, href: pinUrl(pinId), countStr: null, countNum: null };
      const hi = toHighResPinimgUrl(p.thumbUrl) || null;

      ui.state.viewerOpen = true;
      ui.state.viewerPinId = pinId;
      ui.state.viewerImgUrl = hi;
      ui.state.viewerPinHref = p.href || pinUrl(pinId);
      ui.state.viewerCountStr = p.countStr;

      ui.ensureViewer(true);
      ui.renderViewer(true);
    },

    closeViewer() {
      ui.state.viewerOpen = false;
      ui.state.viewerPinId = null;
      ui.state.viewerImgUrl = null;
      ui.state.viewerPinHref = null;
      ui.state.viewerCountStr = null;
      const v = document.getElementById('pt-viewer');
      if (v) v.remove();
    },

    ensureViewer(force = false) {
      const existing = document.getElementById('pt-viewer');
      if (!ui.state.viewerOpen) {
        if (existing) existing.remove();
        return;
      }
      if (existing && !force) return;
      if (existing) existing.remove();

      const mount = uiMountRoot();

      const viewer = document.createElement('div');
      viewer.id = 'pt-viewer';
      viewer.style.cssText = `
        position:fixed; inset:0;
        z-index:2147483650;
        background: rgba(0,0,0,0.65);
        backdrop-filter: blur(8px);
        display:flex;
        align-items:center;
        justify-content:center;
        padding: 18px;
      `;

      viewer.addEventListener('click', (ev) => {
        if (ev.target === viewer) ui.closeViewer();
      });

      const panel = document.createElement('div');
      panel.id = 'pt-viewer-panel';
      panel.style.cssText = `
        width: min(1100px, 96vw);
        height: min(860px, 92vh);
        background: rgba(0,0,0,0.78);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px;
        display:flex;
        flex-direction:column;
        overflow:hidden;
        color:#fff;
      `;

      const top = document.createElement('div');
      top.style.cssText = `
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.10);
        background: rgba(0,0,0,0.40);
        gap:10px;
      `;

      const left = document.createElement('div');
      left.id = 'pt-viewer-title';
      left.textContent = '—';
      left.style.cssText = 'font-weight:1000; opacity:0.95;';

      const right = document.createElement('div');
      right.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

      const btnCopyPng = document.createElement('button');
      btnCopyPng.type = 'button';
      btnCopyPng.textContent = 'Copy PNG';
      btnCopyPng.style.cssText = ui.buttonCss(false);

      const btnCopyUrl = document.createElement('button');
      btnCopyUrl.type = 'button';
      btnCopyUrl.textContent = 'Copy URL';
      btnCopyUrl.style.cssText = ui.buttonCss(true);

      const btnDl = document.createElement('button');
      btnDl.type = 'button';
      btnDl.textContent = 'DL';
      btnDl.style.cssText = ui.buttonCss(true);

      const btnOpen = document.createElement('button');
      btnOpen.type = 'button';
      btnOpen.textContent = 'Pin';
      btnOpen.style.cssText = ui.buttonCss(true);

      const btnClose = document.createElement('button');
      btnClose.type = 'button';
      btnClose.textContent = '閉じる';
      btnClose.style.cssText = ui.buttonCss(true);
      btnClose.addEventListener('click', () => ui.closeViewer());

      btnCopyPng.addEventListener('click', async () => {
        const url = ui.state.viewerImgUrl;
        if (!url) { ui.toast('画像URLなし'); return; }
        try {
          await copyImageToClipboard_StrongPng(url);
          ui.toast('PNGコピー');
        } catch (e) {
          try {
            await copyTextToClipboard(url);
            ui.toast('URLコピー');
          } catch {
            ui.toast('失敗');
          }
        }
      });

      btnCopyUrl.addEventListener('click', async () => {
        const url = ui.state.viewerImgUrl || ui.state.viewerPinHref;
        if (!url) { ui.toast('URLなし'); return; }
        try {
          await copyTextToClipboard(url);
          ui.toast('URLコピー');
        } catch {
          ui.toast('失敗');
        }
      });

      btnDl.addEventListener('click', async () => {
        const pinId = ui.state.viewerPinId;
        const p = pinStore.get(pinId) || { pinId, countNum: null, countStr: null, thumbUrl: null, href: pinUrl(pinId) };
        const url = ui.state.viewerImgUrl || toHighResPinimgUrl(p.thumbUrl) || p.href;
        if (!url) { ui.toast('URLなし'); return; }
        const filename = makeDlFilename(p);
        try {
          await gmDownload(url, filename);
          ui.toast('DL完了');
        } catch (e) {
          ui.toast('DL失敗');
        }
      });

      btnOpen.addEventListener('click', () => {
        const href = ui.state.viewerPinHref || pinUrl(ui.state.viewerPinId);
        if (!href) return;
        window.open(href, '_blank', 'noreferrer');
      });

      right.appendChild(btnCopyPng);
      right.appendChild(btnCopyUrl);
      right.appendChild(btnDl);
      right.appendChild(btnOpen);
      right.appendChild(btnClose);

      top.appendChild(left);
      top.appendChild(right);

      const content = document.createElement('div');
      content.id = 'pt-viewer-content';
      content.style.cssText = `
        flex:1;
        display:flex;
        align-items:center;
        justify-content:center;
        padding: 12px;
        overflow:auto;
      `;

      panel.appendChild(top);
      panel.appendChild(content);
      viewer.appendChild(panel);
      mount.appendChild(viewer);
    },

    renderViewer(force = false) {
      if (!ui.state.viewerOpen) return;
      ui.ensureViewer();

      const title = document.getElementById('pt-viewer-title');
      const content = document.getElementById('pt-viewer-content');
      if (!title || !content) return;

      const pinId = ui.state.viewerPinId;
      const count = ui.state.viewerCountStr != null ? ui.state.viewerCountStr : '—';
      title.textContent = `❤ ${count} / pin: ${pinId} / img: ${HIGHRES_SIZE_SEGMENT}`;

      content.innerHTML = '';

      const url = ui.state.viewerImgUrl;
      if (!url) {
        const m = document.createElement('div');
        m.textContent = 'このpinは画像URLが未収集です（通常モードで収集してから試してください）';
        m.style.cssText = 'opacity:0.85; font-weight:900; padding:12px;';
        content.appendChild(m);
        return;
      }

      const img = document.createElement('img');
      img.src = url;
      img.alt = `pin ${pinId}`;
      img.style.cssText = `
        max-width: 100%;
        max-height: 100%;
        height: auto;
        width: auto;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(0,0,0,0.25);
        cursor: pointer;
      `;

      // ★ 画像クリックで Viewer を閉じる
      img.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation(); // 背景クリック等との干渉防止
        ui.closeViewer();
      });

      content.appendChild(img);
    },

    _buildModalRightActionsBar({ mode, getIds }) {
      // mode: 'favorites' | 'history'
      // getIds(): 現在右側に表示している pinIds 配列（仮想スクロールの ids と一致させる）

      // ★親は「ブロック単位で折り返し」させる
      const bar = document.createElement('div');
      bar.style.cssText = `
        display:flex;
        gap:12px;
        align-items:flex-start;
        flex-wrap:wrap;  /* ★ブロック単位で改行させる */
      `;

      // ---------------------------------
      // Helpers
      // ---------------------------------
      const makeLabel = (text) => {
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = `
          opacity:0.78;
          font-weight:1000;
          padding: 0 2px;
          user-select:none;
          white-space:nowrap;
        `;
        return el;
      };

      // ★ラベル＋関連ボタン群を「1ブロック」として扱う
      // - ブロック内は折り返さない（ラベルだけ置き去りを防ぐ）
      // - ブロック単位で次行に落ちる
      const makeBlock = (labelText, nodes) => {
        const block = document.createElement('div');
        block.style.cssText = `
          display:flex;
          align-items:center;
          gap:10px;
          flex-wrap:nowrap;   /* ★ブロック内では折り返さない */
          white-space:nowrap; /* ★ラベル単体の置き去り防止 */
          padding:2px 0;
        `;

        const label = makeLabel(labelText);
        label.style.whiteSpace = 'nowrap';

        block.appendChild(label);
        for (const n of (nodes || [])) block.appendChild(n);

        return block;
      };

      const confirmIfLarge = async (ids, title = '画像取得') => {
        const n = (ids || []).length;
        if (n <= 0) return false;
        if (n > 500) {
          const ok = confirm(`${title} 対象が ${n} 件あります。\n実行しますか？`);
          return !!ok;
        }
        return true;
      };

      const getAllIds_FavoritesAllLists = () => {
        const all = [];
        for (const lid of (persisted?.favorites?.order || [])) {
          const list = persisted?.favorites?.lists?.[lid];
          if (list?.pinIds?.length) all.push(...list.pinIds);
        }
        return Array.from(new Set(all.filter(Boolean)));
      };

      const getAllIds_HistoryAll = () => {
        const all = [];
        for (const sid of (persisted?.snapshots?.order || [])) {
          const s = persisted?.snapshots?.items?.[sid];
          if (s?.pinIds?.length) all.push(...s.pinIds);
        }
        return Array.from(new Set(all.filter(Boolean)));
      };

      const getCurrentIds = () => ((getIds && getIds()) || []).filter(Boolean);

      // ---------------------------------
      // 選択操作
      // ---------------------------------

      // 一括DL(選択)
      const btnDl = document.createElement('button');
      btnDl.type = 'button';
      btnDl.textContent = '一括DL(選択)';
      btnDl.style.cssText = ui.buttonCss(false);
      btnDl.addEventListener('click', async () => {
        const ids = Array.from(ui.state.modalSelectedPinIds || []);
        if (ids.length === 0) { ui.toast('選択なし'); return; }
        if (ids.length > BULK_DOWNLOAD_MAX) { ui.toast(`多すぎ（最大 ${BULK_DOWNLOAD_MAX}）`); return; }
        ui.toast(`DL開始: ${ids.length}`);
        await ui.bulkDownloadSelectedFast(ids);
      });

      // 全選択（現在表示中の一覧）
      const btnSelectAll = document.createElement('button');
      btnSelectAll.type = 'button';
      btnSelectAll.textContent = '全選択';
      btnSelectAll.style.cssText = ui.buttonCss(true);
      btnSelectAll.addEventListener('click', () => {
        const ids = getCurrentIds();
        if (ids.length === 0) { ui.toast('対象なし'); return; }
        ui.state.modalSelectedPinIds = new Set(ids);
        ui.state.modalSelectedPinId = ids[0] || null;
        ui.state.modalLastClickedPinId = ids[0] || null;
        ui.toast(`全選択: ${ids.length}`);
        ui._rerenderModalPreviewIfAny?.();
      });

      // 選択解除
      const btnClear = document.createElement('button');
      btnClear.type = 'button';
      btnClear.textContent = '選択解除';
      btnClear.style.cssText = ui.buttonCss(true);
      btnClear.addEventListener('click', () => {
        ui.state.modalSelectedPinIds = new Set();
        ui.state.modalSelectedPinId = null;
        ui.state.modalLastClickedPinId = null;
        ui.toast('選択解除');
        ui._rerenderModalPreviewIfAny?.();
      });

      // 選択数表示
      const count = document.createElement('div');
      count.style.cssText = 'opacity:0.85; font-weight:900; white-space:nowrap;';
      const updateCount = () => {
        count.textContent = `選択: ${(ui.state.modalSelectedPinIds?.size || 0)}`;
      };
      ui._updateModalRightCount = updateCount;
      updateCount();

      // --- 削除：favorites のみ（今のリストから外す） ---
      let btnRemoveSelected = null;

      if (mode === 'favorites') {
        btnRemoveSelected = document.createElement('button');
        btnRemoveSelected.type = 'button';
        btnRemoveSelected.textContent = '削除';
        btnRemoveSelected.style.cssText = ui.buttonCss(true);

        btnRemoveSelected.addEventListener('click', () => {
          const listId = ui.state.activeFavId;
          const list = persisted?.favorites?.lists?.[listId];
          if (!list) { ui.toast('リスト不明'); return; }

          const sel = Array.from(ui.state.modalSelectedPinIds || []);
          if (!sel.length) { ui.toast('選択なし'); return; }

          const ok = confirm(`このお気に入りリストから ${sel.length} 件を削除しますか？`);
          if (!ok) return;

          const delSet = new Set(sel);
          const before = list.pinIds?.length || 0;

          list.pinIds = (list.pinIds || []).filter(pid => !delSet.has(pid));

          saveStateAll(persisted);

          // 選択解除＆再描画
          ui.state.modalSelectedPinId = null;
          ui.state.modalSelectedPinIds = new Set();
          ui.state.modalLastClickedPinId = null;

          const removed = before - (list.pinIds?.length || 0);
          ui.toast(`削除: ${removed} 件`);

          ui.renderModal(true);
        });
      }

      // ---------------------------------
      // 画像取得（=表示復元/欠損補完）
      // ---------------------------------
      const btnThis = document.createElement('button');
      btnThis.type = 'button';
      btnThis.textContent = (mode === 'history') ? 'この履歴' : 'この一覧';
      btnThis.style.cssText = ui.buttonCss(true);
      btnThis.addEventListener('click', async () => {
        const ids = getCurrentIds();
        if (!ids.length) { ui.toast('対象なし'); return; }

        const ok = await confirmIfLarge(ids, '画像取得');
        if (!ok) return;

        try {
          ui.toast(`画像取得: ${ids.length}`);
          await rehydratePins(ids, { force: false });
          ui.toast('画像取得: 完了');
          ui._rerenderModalPreviewIfAny?.();
        } catch (e) {
          console.error('[rehydrate] error', e);
          ui.toast('画像取得: エラー（console参照）');
        }
      });

      const btnAll = document.createElement('button');
      btnAll.type = 'button';
      btnAll.textContent = '全リスト';
      btnAll.style.cssText = ui.buttonCss(true);
      btnAll.addEventListener('click', async () => {
        const ids = (mode === 'history') ? getAllIds_HistoryAll() : getAllIds_FavoritesAllLists();
        if (!ids.length) { ui.toast('対象なし'); return; }

        const ok = await confirmIfLarge(ids, '画像取得（全リスト）');
        if (!ok) return;

        try {
          ui.toast(`画像取得(全): ${ids.length}`);
          await rehydratePins(ids, { force: false });
          ui.toast('画像取得(全): 完了');
          ui._rerenderModalPreviewIfAny?.();
        } catch (e) {
          console.error('[rehydrate] error', e);
          ui.toast('画像取得(全): エラー（console参照）');
        }
      });

      // ---------------------------------
      // Layout（★ブロック単位で折り返し）
      // ---------------------------------
      const selectNodes = [btnDl, btnSelectAll, btnClear];
      if (btnRemoveSelected) selectNodes.push(btnRemoveSelected);
      selectNodes.push(count);

      const selectBlock = makeBlock('選択操作', selectNodes);
      const rehydrateBlock = makeBlock('画像取得', [btnThis, btnAll]);

      bar.appendChild(selectBlock);
      bar.appendChild(rehydrateBlock);

      return bar;
    },

  renderFavoritesManager(bodyEl) {
    // ---- ensure active favorite id ----
    const ensureActive = () => {
      const id = ui.state.activeFavId || getActiveFavId();
      if (id && persisted.favorites.lists[id]) {
        ui.state.activeFavId = id;
        persistUIState();
        return id;
      }
      const first = persisted.favorites.order[0] || null;
      ui.state.activeFavId = first;
      persistUIState();
      return first;
    };

    const setActive = (id) => {
      if (!id || !persisted.favorites.lists[id]) return;
      ui.state.activeFavId = id;
      persistUIState();

      // 選択状態リセット
      ui.state.modalSelectedPinId = null;
      ui.state.modalSelectedPinIds = new Set();
      ui.state.modalLastClickedPinId = null;

      ui.renderModal(true);
    };

    ensureActive();

    // ---- layout ----
    const left = document.createElement('div');
    left.style.cssText = `
      width: 320px;
      border-right: 1px solid rgba(255,255,255,0.10);
      padding: 12px;
      display:flex;
      flex-direction:column;
      gap: 10px;
      overflow:hidden;
    `;

    const right = document.createElement('div');
    right.style.cssText = `
      flex:1;
      padding: 12px;
      display:flex;
      flex-direction:column;
      gap: 10px;
      overflow:hidden;
    `;

    // =========================================================
    // Left: favorites list
    // =========================================================
    const leftTopRow = document.createElement('div');
    leftTopRow.style.cssText = 'display:flex; gap:8px; align-items:center;';

    const leftTitle = document.createElement('div');
    leftTitle.textContent = 'リスト';
    leftTitle.style.cssText = 'flex:1; font-weight:1000; opacity:0.95;';

    const btnAddList = document.createElement('button');
    btnAddList.type = 'button';
    btnAddList.textContent = '＋追加';
    btnAddList.style.cssText = ui.buttonCss(true);
    btnAddList.addEventListener('click', () => {
      const name = prompt('お気に入りリスト名', `お気に入り ${persisted.favorites.order.length + 1}`);
      if (!name) return;
      const newId = createFavList(name);
      ui.state.activeFavId = newId;
      persistUIState();
      ui.toast('リスト追加');
      ui.renderModal(true);
    });

    leftTopRow.appendChild(leftTitle);
    leftTopRow.appendChild(btnAddList);

    // ---- list ops ----
    const ops = document.createElement('div');
    ops.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';

    const btnRename = document.createElement('button');
    btnRename.textContent = '名前';
    btnRename.style.cssText = ui.buttonCss(true);
    btnRename.onclick = () => {
      const id = ui.state.activeFavId;
      if (!id) return;
      const cur = persisted.favorites.lists[id]?.name || '';
      const name = prompt('リスト名を変更', cur);
      if (!name) return;
      renameFavList(id, name);
      ui.renderModal(true);
    };

    const btnUp = document.createElement('button');
    btnUp.textContent = '↑';
    btnUp.style.cssText = ui.buttonCss(true);
    btnUp.onclick = () => {
      const id = ui.state.activeFavId;
      if (!id) return;
      moveFavList(id, -1);
      ui.renderModal(true);
    };

    const btnDown = document.createElement('button');
    btnDown.textContent = '↓';
    btnDown.style.cssText = ui.buttonCss(true);
    btnDown.onclick = () => {
      const id = ui.state.activeFavId;
      if (!id) return;
      moveFavList(id, +1);
      ui.renderModal(true);
    };

    const btnDel = document.createElement('button');
    btnDel.textContent = '削除';
    btnDel.style.cssText = ui.buttonCss(true);
    btnDel.onclick = () => {
      const id = ui.state.activeFavId;
      if (!id) return;
      if (!confirm('このお気に入りリストを削除しますか？（最低1つは残ります）')) return;
      deleteFavList(id);
      ensureActive();
      ui.renderModal(true);
    };

    ops.append(btnRename, btnUp, btnDown, btnDel);

    const listWrap = document.createElement('div');
    listWrap.style.cssText = `
      flex:1;
      overflow:auto;
      display:flex;
      flex-direction:column;
      gap:8px;
    `;

    const renderLeftList = () => {
      listWrap.innerHTML = '';
      for (const id of persisted.favorites.order) {
        const it = persisted.favorites.lists[id];
        if (!it) continue;

        const row = document.createElement('div');
        const isActive = id === ui.state.activeFavId;
        row.style.cssText = `
          display:flex;
          align-items:center;
          gap:8px;
          padding:10px;
          border-radius:12px;
          cursor:pointer;
          border:1px solid rgba(255,255,255,${isActive ? '0.40' : '0.12'});
          background:${isActive ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.06)'};
        `;

        const name = document.createElement('div');
        name.textContent = it.name;
        name.style.cssText = 'flex:1; font-weight:1000;';

        const cnt = document.createElement('div');
        cnt.textContent = `${it.pinIds?.length || 0}件`;
        cnt.style.cssText = 'opacity:0.8; font-weight:900;';

        row.append(name, cnt);
        row.onclick = () => setActive(id);

        listWrap.appendChild(row);
      }
    };

    const countText = document.createElement('div');
    countText.style.cssText = 'opacity:0.85; font-weight:900;';
    const updateCountText = () => {
      const list = persisted.favorites.lists[ui.state.activeFavId];
      countText.textContent = `件数: ${list?.pinIds?.length || 0}`;
    };

    left.append(leftTopRow, ops, countText, listWrap);

    // =========================================================
    // Right: actions + preview
    // =========================================================
    const rightTop = document.createElement('div');
    rightTop.style.cssText = 'display:flex; gap:10px; align-items:center; flex-wrap:wrap;';

    // ---- common actions (選択操作 / 画像取得) ----
    const actionsContainer = ui._buildModalRightActionsBar({
      mode: 'favorites',
      getIds: () => (persisted.favorites.lists[ui.state.activeFavId]?.pinIds || []),
    });

    // bar要素 → 右上へ子を移す
    if (actionsContainer && actionsContainer.nodeType === 1) {
      if (actionsContainer !== rightTop) {
        while (actionsContainer.firstChild) rightTop.appendChild(actionsContainer.firstChild);
      }
    }

    // =========================================================
    // ★復活：選択した画像を「別リストへ移動」
    // - UI: [移動先▼] [選択を移動] （選択数0やリスト1個なら無効）
    // - 挙動: 現在リストから削除 → 移動先リスト末尾へ追加（重複は追加しない）
    // - 移動後: 移動先リストへ切替＆選択解除（分かりやすさ優先）
    // =========================================================
    const makeLabel = (text) => {
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = `
        opacity:0.78;
        font-weight:1000;
        padding: 0 2px;
        user-select:none;
        white-space:nowrap;
      `;
      return el;
    };

    const moveLabel = makeLabel('リスト移動');

    const moveSelect = document.createElement('select');
    moveSelect.style.cssText = ui.selectCss();
    moveSelect.style.minWidth = '220px';

    const btnMoveSelected = document.createElement('button');
    btnMoveSelected.type = 'button';
    btnMoveSelected.textContent = '選択を移動';
    btnMoveSelected.style.cssText = ui.buttonCss(true);

    // 移動UIを作る/更新する
    const rebuildMoveOptions = () => {
      const curId = ui.state.activeFavId;
      const curList = persisted.favorites.lists[curId];
      const others = (persisted.favorites.order || [])
        .filter((id) => id !== curId && !!persisted.favorites.lists[id])
        .map((id) => persisted.favorites.lists[id]);

      moveSelect.innerHTML = '';
      if (!others.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '移動先なし（リストが1つ）';
        moveSelect.appendChild(opt);
        moveSelect.disabled = true;
      } else {
        for (const it of others) {
          const opt = document.createElement('option');
          opt.value = it.id;
          opt.textContent = `→ ${it.name}`;
          moveSelect.appendChild(opt);
        }
        moveSelect.disabled = false;
      }

      const selCount = ui.state.modalSelectedPinIds?.size || 0;
      const canMove = !!curList && !!others.length && selCount > 0;
      btnMoveSelected.disabled = !canMove;
      btnMoveSelected.style.opacity = canMove ? '1' : '0.55';
    };

    // 選択数が変わったら「移動」ボタンの有効/無効も追随させたい
    // 既存の ui._updateModalRightCount をラップして、同時に rebuildMoveOptions も呼ぶ
    const prevUpdateCount = ui._updateModalRightCount;
    ui._updateModalRightCount = () => {
      try { prevUpdateCount?.(); } catch {}
      try { rebuildMoveOptions(); } catch {}
    };

    btnMoveSelected.addEventListener('click', () => {
      const fromId = ui.state.activeFavId;
      const toId = moveSelect.value;

      if (!fromId || !persisted.favorites.lists[fromId]) { ui.toast('移動元が不明'); return; }
      if (!toId || !persisted.favorites.lists[toId]) { ui.toast('移動先を選択してください'); return; }

      const sel = Array.from(ui.state.modalSelectedPinIds || []);
      if (!sel.length) { ui.toast('選択なし'); return; }

      const from = persisted.favorites.lists[fromId];
      const to = persisted.favorites.lists[toId];

      // 移動（順序維持）
      const moveSet = new Set(sel);
      const movingIdsInOrder = (from.pinIds || []).filter((pid) => moveSet.has(pid));

      // from から削除
      from.pinIds = (from.pinIds || []).filter((pid) => !moveSet.has(pid));

      // to へ追加（重複は避ける）
      const toSet = new Set(to.pinIds || []);
      for (const pid of movingIdsInOrder) {
        if (!toSet.has(pid)) {
          to.pinIds.push(pid);
          toSet.add(pid);
        }
      }

      saveStateAll(persisted);

      // 分かりやすさ優先：移動先へ切替＆選択解除
      ui.state.activeFavId = toId;
      persistUIState();
      ui.state.modalSelectedPinId = null;
      ui.state.modalSelectedPinIds = new Set();
      ui.state.modalLastClickedPinId = null;

      ui.toast(`移動: ${movingIdsInOrder.length} 件`);
      ui.renderModal(true);
    });

    const moveBlock = document.createElement('div');
    moveBlock.style.cssText = `
      display:flex;
      align-items:center;
      gap:10px;
      flex-wrap:nowrap;      /* ★ブロック内では折り返さない */
      white-space:nowrap;    /* ★ラベルだけ改行しない */
      padding:2px 0;
    `;

    moveBlock.appendChild(moveLabel);
    moveBlock.appendChild(moveSelect);
    moveBlock.appendChild(btnMoveSelected);

    rightTop.appendChild(moveBlock);

    // --- 右側プレビュー（仮想スクロール） ---
    const gridWrap = document.createElement('div');
    gridWrap.style.cssText = 'flex:1; overflow:hidden; padding-top:6px; position:relative;';

    const vsWrap = document.createElement('div');
    vsWrap.style.cssText = `
      position:relative;
      width:100%;
      height:100%;
      overflow:auto;
      padding:0;
    `;

    const vsInner = document.createElement('div');
    vsInner.style.cssText = `
      position:relative;
      width:100%;
    `;

    const spacer = document.createElement('div');
    spacer.style.cssText = `
      position:relative;
      width:100%;
      height:0px;
    `;

    vsInner.appendChild(spacer);
    vsWrap.appendChild(vsInner);
    gridWrap.appendChild(vsWrap);

    right.append(rightTop, gridWrap);

    // 既存仕様：list.pinIds をそのまま順序維持で表示（※sliceしない）
    const getActiveList = () => persisted.favorites.lists[ui.state.activeFavId] || null;
    const getIds = () => (getActiveList()?.pinIds || []);

    // 仮想スクロール設定
    const CARD_MIN_W = 120;
    const GAP = 10;
    const CARD_EST_H = 160;
    const OVERSCAN_ROWS = 4;

    let _lastKey = '';
    let _lastTop = -1;
    let _ro = null;

    const computeCols = () => {
      const width = vsWrap.clientWidth || 1;
      const cols = Math.max(1, Math.floor((width + GAP) / (CARD_MIN_W + GAP)));
      const usable = width - GAP * (cols - 1);
      const cardW = Math.max(CARD_MIN_W, Math.floor(usable / cols));
      return { cols, cardW, width };
    };

    const clearVS = () => {
      while (vsInner.children.length > 1) vsInner.removeChild(vsInner.lastChild);
    };

    const renderVS = (force = false) => {
      const ids = getIds();
      const { cols, cardW } = computeCols();
      const cardH = CARD_EST_H;

      const totalRows = Math.ceil(ids.length / cols);
      const rowH = cardH + GAP;
      const fullH = Math.max(0, totalRows * rowH);
      spacer.style.height = `${fullH}px`;

      const top = vsWrap.scrollTop;
      const vh = vsWrap.clientHeight;

      const firstRow = Math.max(0, Math.floor(top / rowH) - OVERSCAN_ROWS);
      const lastRow = Math.min(totalRows - 1, Math.floor((top + vh) / rowH) + OVERSCAN_ROWS);

      const startIdx = firstRow * cols;
      const endIdx = Math.min(ids.length - 1, (lastRow + 1) * cols - 1);

      const selKey = Array.from(ui.state.modalSelectedPinIds || []).sort().join(',');
      const key = `${ids.length}|${cols}|${cardW}|${cardH}|${firstRow}|${lastRow}|${selKey}|${ui.state.activeFavId || ''}`;

      if (!force && key === _lastKey && Math.abs(top - _lastTop) < 2) return;
      _lastKey = key;
      _lastTop = top;

      clearVS();

      const frag = document.createDocumentFragment();

      for (let i = startIdx; i <= endIdx; i++) {
        const id = ids[i];
        if (!id) continue;

        const p = pinStore.get(id) || { pinId: id, thumbUrl: null, href: pinUrl(id), countStr: null, countNum: null };

        const row = Math.floor(i / cols);
        const col = i % cols;

        const x = col * (cardW + GAP);
        const y = row * rowH;

        const holder = document.createElement('div');
        holder.style.cssText = `
          position:absolute;
          left:${x}px;
          top:${y}px;
          width:${cardW}px;
          height:${cardH}px;
        `;

        const item = document.createElement('div');
        item.setAttribute('data-pt-modal-item', '1');
        item.setAttribute('data-pin-id', id);

        // Drag & Drop（並び替え）
        item.draggable = true;

        item.addEventListener('dragstart', () => {
          item.style.opacity = '0.4';
          ui._dragPinId = id;
        });

        item.addEventListener('dragend', () => {
          item.style.opacity = '1';
          ui._dragPinId = null;
        });

        item.addEventListener('dragover', (e) => {
          e.preventDefault();
        });

        item.addEventListener('drop', (e) => {
          e.preventDefault();
          const fromId = ui._dragPinId;
          const toId = id;
          if (!fromId || fromId === toId) return;

          const list = getActiveList();
          if (!list) return;

          const arr = list.pinIds || [];
          const i = arr.indexOf(fromId);
          const j = arr.indexOf(toId);
          if (i < 0 || j < 0) return;

          arr.splice(i, 1);
          arr.splice(j, 0, fromId);

          saveStateAll(persisted);
          ui.renderModal(true);
        });

        const selected = (ui.state.modalSelectedPinIds && ui.state.modalSelectedPinIds.has(id));
        item.style.cssText = `
          width:100%;
          height:100%;
          border-radius:12px;
          overflow:hidden;
          border:1px solid rgba(255,255,255,${selected ? '0.55' : '0.12'});
          outline:${selected ? '2px solid rgba(255,255,255,0.55)' : 'none'};
          background: rgba(0,0,0,0.45);
          cursor:pointer;
          position:relative;
        `;

        item.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          const set = ui.state.modalSelectedPinIds || new Set();
          if (set.has(id)) set.delete(id);
          else set.add(id);

          ui.state.modalSelectedPinIds = set;
          ui.state.modalSelectedPinId = id;
          ui.state.modalLastClickedPinId = id;

          ui.highlightModalSelection();
          renderVS(true);

          if (ui._updateModalRightCount) ui._updateModalRightCount();
        });

        item.addEventListener('dblclick', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          ui.openViewer(id);
        });

        const img = document.createElement('div');
        img.style.cssText = 'width:100%; height:100%; background: rgba(255,255,255,0.08); position:relative;';

        if (p.thumbUrl) {
          const im = document.createElement('img');
          im.src = p.thumbUrl;
          im.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block;';
          img.appendChild(im);
        } else {
          const t = document.createElement('div');
          t.textContent = 'No img';
          t.style.cssText = 'opacity:0.7; font-weight:900; padding:8px;';
          img.appendChild(t);
        }

        const badge = document.createElement('div');
        badge.style.cssText = `
          position:absolute; left:8px; top:8px;
          padding:4px 8px; border-radius:999px;
          background:rgba(0,0,0,0.70); font-weight:900; font-size:11px;
        `;
        badge.textContent = `❤ ${(p.countStr != null) ? p.countStr : '—'}`;
        img.appendChild(badge);

        item.appendChild(img);
        holder.appendChild(item);
        frag.appendChild(holder);
      }

      vsInner.appendChild(frag);

      // 右上バーの「選択数」更新
      if (ui._updateModalRightCount) ui._updateModalRightCount();

      // 外部から「再描画して」と呼べるようにする
      ui._rerenderModalPreviewIfAny = () => {
        try { renderVS(true); } catch {}
        try { ui.highlightModalSelection(); } catch {}
        try { if (ui._updateModalRightCount) ui._updateModalRightCount(); } catch {}
      };
    };

    // scroll / resize
    vsWrap.addEventListener('scroll', () => renderVS(false));
    try {
      _ro = new ResizeObserver(() => renderVS(true));
      _ro.observe(vsWrap);
    } catch {}

    // 右側初期描画
    requestAnimationFrame(() => renderVS(true));

    // ---- mount ----
    bodyEl.append(left, right);

    // ---- first paint ----
    renderLeftList();
    updateCountText();

    // 初期状態で「移動」UIを更新
    rebuildMoveOptions();

    // 表示の更新（active切り替え後に再描画されるように）
    requestAnimationFrame(() => {
      try { renderVS(true); } catch {}
      try { updateCountText(); } catch {}
      try { rebuildMoveOptions(); } catch {}
    });
  },

  renderHistoryManager(bodyEl) {
    const left = document.createElement('div');
    left.style.cssText = `
      width: 320px;
      border-right: 1px solid rgba(255,255,255,0.10);
      padding: 12px;
      display:flex;
      flex-direction:column;
      gap: 10px;
      overflow:hidden;
    `;

    const right = document.createElement('div');
    right.style.cssText = `
      flex:1;
      padding: 12px;
      display:flex;
      flex-direction:column;
      gap: 10px;
      overflow:hidden;
    `;

    // =========================
    // 左：履歴一覧（縦リスト）
    // =========================
    const listWrap = document.createElement('div');
    listWrap.style.cssText = `
      flex:1;
      overflow:auto;
      display:flex;
      flex-direction:column;
      gap: 8px;
      padding-right: 4px;
    `;

    // ---- local state defaults (STEP1未反映でも動くように) ----
    if (!ui.state.historySortDir) ui.state.historySortDir = 'desc'; // 'desc' | 'asc'

    // createdAt をDate(ms)に（壊れてても落とさない）
    const toMs = (iso) => {
      const t = Date.parse(iso || '');
      return Number.isFinite(t) ? t : 0;
    };

    // 表示用の履歴ID配列（createdAtソート）
    const getSortedSnapshotIds = () => {
      const ids = (persisted.snapshots.order || []).filter(id => !!persisted.snapshots.items?.[id]);
      ids.sort((a, b) => {
        const am = toMs(persisted.snapshots.items[a]?.createdAt);
        const bm = toMs(persisted.snapshots.items[b]?.createdAt);
        return ui.state.historySortDir === 'asc' ? (am - bm) : (bm - am);
      });
      return ids;
    };

    // activeSnapId の正規化（削除後などで存在しない場合）
    const normalizeActiveId = () => {
      const cur = ui.state.activeSnapId;
      if (cur && persisted.snapshots.items[cur]) return cur;

      const sorted = getSortedSnapshotIds();
      const first = sorted[0] || null;

      ui.state.activeSnapId = first;
      persistUIState();
      return first;
    };

    const activeId = normalizeActiveId();
    const activeItem = activeId ? persisted.snapshots.items[activeId] : null;

    // 左上：見出し & 件数 + ソート切替（新しい順/古い順）
    const headRow = document.createElement('div');
    headRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px;';

    const headTitle = document.createElement('div');
    headTitle.textContent = '履歴一覧';
    headTitle.style.cssText = 'font-weight:1000; opacity:0.95;';

    const headRight = document.createElement('div');
    headRight.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;';

    const headCount = document.createElement('div');
    headCount.style.cssText = 'opacity:0.75; font-weight:900;';
    headCount.textContent = `件数: ${activeItem?.pinIds?.length || 0}`;

    const btnSortDir = document.createElement('button');
    btnSortDir.type = 'button';
    const updateSortBtn = () => {
      btnSortDir.textContent = (ui.state.historySortDir === 'asc') ? '古い順' : '新しい順';
      btnSortDir.title = '履歴取得日時（createdAt）の並び替え';
    };
    btnSortDir.style.cssText = ui.buttonCss(true);
    btnSortDir.addEventListener('click', () => {
      ui.state.historySortDir = (ui.state.historySortDir === 'asc') ? 'desc' : 'asc';
      persistUIState(); // STEP1で永続化に入れたら保存される。未対応でも問題なし。
      ui.renderModal(true);
    });
    updateSortBtn();

    headRight.appendChild(headCount);
    headRight.appendChild(btnSortDir);

    headRow.appendChild(headTitle);
    headRow.appendChild(headRight);

    // 左上：操作ボタン（rename / delete） ※手動並び替え（↑↓）は撤去
    const ops = document.createElement('div');
    ops.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';

    const btnRename = document.createElement('button');
    btnRename.textContent = '名前';
    btnRename.style.cssText = ui.buttonCss(true);
    btnRename.addEventListener('click', () => {
      const id = ui.state.activeSnapId;
      if (!id) return;
      const cur = persisted.snapshots.items[id]?.name || '';
      const name = prompt('履歴名を変更', cur);
      if (!name) return;
      renameSnapshot(id, name);
      ui.renderModal(true);
    });

    const btnDel = document.createElement('button');
    btnDel.textContent = '削除';
    btnDel.style.cssText = ui.buttonCss(true);
    btnDel.addEventListener('click', () => {
      const id = ui.state.activeSnapId;
      if (!id) return;
      if (!confirm('この履歴を削除しますか？')) return;
      deleteSnapshot(id);
      ui.state.activeSnapId = null;
      ui.state.viewMode = 'all';
      persistUIState();
      ui.renderModal(true);
    });

    ops.appendChild(btnRename);
    ops.appendChild(btnDel);

    // 一覧レンダリング（createdAtソート）
    const renderLeftList = () => {
      listWrap.innerHTML = '';

      const sortedIds = getSortedSnapshotIds();

      if (!sortedIds.length) {
        const empty = document.createElement('div');
        empty.textContent = '(履歴なし)';
        empty.style.cssText = `
          opacity:0.75;
          font-weight:900;
          padding: 10px;
          border:1px dashed rgba(255,255,255,0.14);
          border-radius: 12px;
        `;
        listWrap.appendChild(empty);
        return;
      }

      for (const id of sortedIds) {
        const it = persisted.snapshots.items[id];
        if (!it) continue;

        const row = document.createElement('button');
        row.type = 'button';
        row.style.cssText = `
          width:100%;
          text-align:left;
          padding:10px 10px;
          border-radius:12px;
          border:1px solid rgba(255,255,255,${id === ui.state.activeSnapId ? '0.40' : '0.12'});
          background: ${id === ui.state.activeSnapId ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)'};
          color:#fff;
          cursor:pointer;
          font-weight:900;
          display:flex;
          flex-direction:column;
          gap:6px;
        `;

        const name = document.createElement('div');
        name.textContent = it.name || '(no name)';
        name.style.cssText = 'opacity:0.95;';

        const meta = document.createElement('div');
        meta.style.cssText = 'display:flex; gap:8px; align-items:center; opacity:0.75; font-weight:900; font-size:11px; flex-wrap:wrap;';

        const created = document.createElement('span');
        created.textContent = it.createdAt ? new Date(it.createdAt).toLocaleString() : '';

        const cnt = document.createElement('span');
        cnt.textContent = `件数 ${it.pinIds?.length || 0}`;

        meta.appendChild(cnt);
        meta.appendChild(created);

        row.appendChild(name);
        row.appendChild(meta);

        row.addEventListener('click', () => {
          if (ui.state.activeSnapId === id) return;
          ui.state.activeSnapId = id;
          persistUIState();

          // 選択状態リセット
          ui.state.modalSelectedPinId = null;
          ui.state.modalSelectedPinIds = new Set();
          ui.state.modalLastClickedPinId = null;

          ui.renderModal(true);
        });

        listWrap.appendChild(row);
      }
    };

    renderLeftList();

    // 左の組み立て
    left.appendChild(headRow);
    left.appendChild(ops);
    left.appendChild(listWrap);

    // =========================
    // 右：選択操作 + 画像取得 + プレビュー
    // =========================
    const getActiveSnapshot = () => (ui.state.activeSnapId ? persisted.snapshots.items[ui.state.activeSnapId] : null);
    const getIds = () => (getActiveSnapshot()?.pinIds || []);

    const rightTop = document.createElement('div');
    rightTop.style.cssText = 'display:flex; gap:10px; align-items:center; flex-wrap:wrap;';

    // ---- helper: section label ----
    const makeLabel = (text) => {
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = 'opacity:0.70; font-weight:1000; padding:0 2px;';
      return el;
    };

    // ---- selection ops block ----
    const selLabel = makeLabel('選択操作');

    const btnDl = document.createElement('button');
    btnDl.type = 'button';
    btnDl.textContent = '一括DL(選択)';
    btnDl.style.cssText = ui.buttonCss(false);
    btnDl.addEventListener('click', async () => {
      const ids = Array.from(ui.state.modalSelectedPinIds || []);
      if (ids.length === 0) { ui.toast('選択なし'); return; }
      if (ids.length > BULK_DOWNLOAD_MAX) { ui.toast(`多すぎ（最大 ${BULK_DOWNLOAD_MAX}）`); return; }
      ui.toast(`DL開始: ${ids.length}`);
      await ui.bulkDownloadSelectedFast(ids);
    });

    const btnSelectAll = document.createElement('button');
    btnSelectAll.type = 'button';
    btnSelectAll.textContent = '全選択';
    btnSelectAll.style.cssText = ui.buttonCss(true);
    btnSelectAll.addEventListener('click', () => {
      const ids = getIds();
      if (!ids.length) { ui.toast('対象なし'); return; }
      ui.state.modalSelectedPinIds = new Set(ids);
      ui.state.modalSelectedPinId = ids[0] || null;
      ui.state.modalLastClickedPinId = ids[0] || null;
      ui.toast(`全選択: ${ids.length}`);
      ui._rerenderModalPreviewIfAny?.();
    });

    const btnClear = document.createElement('button');
    btnClear.type = 'button';
    btnClear.textContent = '選択解除';
    btnClear.style.cssText = ui.buttonCss(true);
    btnClear.addEventListener('click', () => {
      ui.state.modalSelectedPinIds = new Set();
      ui.state.modalSelectedPinId = null;
      ui.state.modalLastClickedPinId = null;
      ui.toast('選択解除');
      ui._rerenderModalPreviewIfAny?.();
    });

    const count = document.createElement('div');
    count.style.cssText = 'opacity:0.85; font-weight:900;';
    const updateCount = () => {
      count.textContent = `選択: ${(ui.state.modalSelectedPinIds?.size || 0)}`;
    };
    ui._updateModalRightCount = updateCount;
    updateCount();

    // ---- rehydrate block ----
    const rhLabel = makeLabel('画像取得');

    const btnRehydrateThis = document.createElement('button');
    btnRehydrateThis.type = 'button';
    btnRehydrateThis.textContent = 'この履歴';
    btnRehydrateThis.style.cssText = ui.buttonCss(true);
    btnRehydrateThis.addEventListener('click', async () => {
      const it = getActiveSnapshot();
      const ids = (it?.pinIds || []);
      if (!ids.length) { ui.toast('対象なし'); return; }
      if (typeof rehydratePins !== 'function') { ui.toast('画像取得機能が未実装です'); return; }

      if (ids.length > 500) {
        const ok = confirm(`対象が ${ids.length} 件あります。\n実行しますか？`);
        if (!ok) return;
      } else {
        if (!confirm(`この履歴の画像を取得しますか？（${ids.length} 件）`)) return;
      }

      try {
        ui.toast(`取得開始: ${ids.length}`);
        await rehydratePins(ids, { force: false });
        ui.toast('取得完了');
        ui._rerenderModalPreviewIfAny?.();
      } catch {
        ui.toast('取得失敗');
      }
    });

    const btnRehydrateAll = document.createElement('button');
    btnRehydrateAll.type = 'button';
    btnRehydrateAll.textContent = '全リスト';
    btnRehydrateAll.style.cssText = ui.buttonCss(true);
    btnRehydrateAll.addEventListener('click', async () => {
      if (typeof rehydratePins !== 'function') { ui.toast('画像取得機能が未実装です'); return; }

      const all = [];
      for (const sid of (persisted.snapshots.order || [])) {
        const s = persisted.snapshots.items[sid];
        if (!s?.pinIds?.length) continue;
        all.push(...s.pinIds);
      }
      const uniq = Array.from(new Set(all));
      if (!uniq.length) { ui.toast('対象なし'); return; }

      if (uniq.length > 500) {
        const ok = confirm(`対象が ${uniq.length} 件あります。\n実行しますか？`);
        if (!ok) return;
      } else {
        if (!confirm(`履歴全体の画像を取得しますか？（${uniq.length} 件）`)) return;
      }

      try {
        ui.toast(`取得開始: ${uniq.length}`);
        await rehydratePins(uniq, { force: false });
        ui.toast('取得完了');
        ui._rerenderModalPreviewIfAny?.();
      } catch {
        ui.toast('取得失敗');
      }
    });

    // mount rightTop
    rightTop.appendChild(selLabel);
    rightTop.appendChild(btnDl);
    rightTop.appendChild(btnSelectAll);
    rightTop.appendChild(btnClear);
    rightTop.appendChild(count);

    rightTop.appendChild(rhLabel);
    rightTop.appendChild(btnRehydrateThis);
    rightTop.appendChild(btnRehydrateAll);

    right.appendChild(rightTop);

    // --- 右側プレビュー（仮想スクロール） ---
    const gridWrap = document.createElement('div');
    gridWrap.style.cssText = 'flex:1; overflow:auto; padding-top:6px; position:relative;';

    const vsWrap = document.createElement('div');
    vsWrap.style.cssText = `
      position:relative;
      width:100%;
      height:100%;
      overflow:auto;
      padding:0;
    `;

    const vsInner = document.createElement('div');
    vsInner.style.cssText = `
      position:relative;
      width:100%;
    `;

    const spacer = document.createElement('div');
    spacer.style.cssText = `
      position:relative;
      width:100%;
      height:0px;
    `;

    vsInner.appendChild(spacer);
    vsWrap.appendChild(vsInner);
    gridWrap.appendChild(vsWrap);

    const CARD_MIN_W = 120;
    const GAP = 10;
    const CARD_EST_H = 160;
    const OVERSCAN_ROWS = 4;

    let _lastKey = '';
    let _lastTop = -1;
    let _ro = null;

    const computeCols = () => {
      const width = vsWrap.clientWidth || 1;
      const cols = Math.max(1, Math.floor((width + GAP) / (CARD_MIN_W + GAP)));
      const usable = width - GAP * (cols - 1);
      const cardW = Math.max(CARD_MIN_W, Math.floor(usable / cols));
      return { cols, cardW, width };
    };

    const clearVS = () => {
      while (vsInner.children.length > 1) vsInner.removeChild(vsInner.lastChild);
    };

    const renderVS = (force = false) => {
      const ids = getIds();

      // 左上の件数も追随（active切替でUIが作り直されるが保険）
      headCount.textContent = `件数: ${ids.length || 0}`;

      const { cols, cardW } = computeCols();
      const cardH = CARD_EST_H;

      const totalRows = Math.ceil(ids.length / cols);
      const rowH = cardH + GAP;
      const fullH = Math.max(0, totalRows * rowH);
      spacer.style.height = `${fullH}px`;

      const top = vsWrap.scrollTop;
      const vh = vsWrap.clientHeight;

      const firstRow = Math.max(0, Math.floor(top / rowH) - OVERSCAN_ROWS);
      const lastRow = Math.min(totalRows - 1, Math.floor((top + vh) / rowH) + OVERSCAN_ROWS);

      const startIdx = firstRow * cols;
      const endIdx = Math.min(ids.length - 1, (lastRow + 1) * cols - 1);

      const selKey = Array.from(ui.state.modalSelectedPinIds || []).sort().join(',');
      const key = `${ids.length}|${cols}|${cardW}|${cardH}|${firstRow}|${lastRow}|${selKey}|${ui.state.activeSnapId || ''}`;

      if (!force && key === _lastKey && Math.abs(top - _lastTop) < 2) return;
      _lastKey = key;
      _lastTop = top;

      clearVS();

      const frag = document.createDocumentFragment();

      for (let i = startIdx; i <= endIdx; i++) {
        const id = ids[i];
        if (!id) continue;

        const p = pinStore.get(id) || { pinId: id, thumbUrl: null, href: pinUrl(id), countStr: null, countNum: null };

        const row = Math.floor(i / cols);
        const col = i % cols;

        const x = col * (cardW + GAP);
        const y = row * rowH;

        const holder = document.createElement('div');
        holder.style.cssText = `
          position:absolute;
          left:${x}px;
          top:${y}px;
          width:${cardW}px;
          height:${cardH}px;
        `;

        const item = document.createElement('div');
        item.setAttribute('data-pt-modal-item', '1');
        item.setAttribute('data-pin-id', id);

        const selected = (ui.state.modalSelectedPinIds && ui.state.modalSelectedPinIds.has(id));
        item.style.cssText = `
          width:100%;
          height:100%;
          border-radius:12px;
          overflow:hidden;
          border:1px solid rgba(255,255,255,${selected ? '0.55' : '0.12'});
          outline:${selected ? '2px solid rgba(255,255,255,0.55)' : 'none'};
          background: rgba(0,0,0,0.45);
          cursor:pointer;
          position:relative;
        `;

        item.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          const set = ui.state.modalSelectedPinIds || new Set();
          if (set.has(id)) set.delete(id);
          else set.add(id);

          ui.state.modalSelectedPinIds = set;
          ui.state.modalSelectedPinId = id;
          ui.state.modalLastClickedPinId = id;

          ui.highlightModalSelection();
          renderVS(true);

          if (ui._updateModalRightCount) ui._updateModalRightCount();
        });

        item.addEventListener('dblclick', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          ui.openViewer(id);
        });

        const img = document.createElement('div');
        img.style.cssText = 'width:100%; height:100%; background: rgba(255,255,255,0.08); position:relative;';
        if (p.thumbUrl) {
          const im = document.createElement('img');
          im.src = p.thumbUrl;
          im.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block;';
          img.appendChild(im);
        } else {
          const t = document.createElement('div');
          t.textContent = 'No img';
          t.style.cssText = 'opacity:0.7; font-weight:900; padding:8px;';
          img.appendChild(t);
        }

        const badge = document.createElement('div');
        badge.style.cssText = `
          position:absolute; left:8px; top:8px;
          padding:4px 8px; border-radius:999px;
          background:rgba(0,0,0,0.70); font-weight:900; font-size:11px;
        `;
        badge.textContent = `❤ ${(p.countStr != null) ? p.countStr : '—'}`;
        img.appendChild(badge);

        item.appendChild(img);
        holder.appendChild(item);
        frag.appendChild(holder);
      }

      vsInner.appendChild(frag);

      // 右上バーの「選択数」を更新
      if (ui._updateModalRightCount) ui._updateModalRightCount();

      // 外部から「再描画して」と呼べるようにする（選択解除等）
      ui._rerenderModalPreviewIfAny = () => {
        try { renderVS(true); } catch {}
        try { ui.highlightModalSelection(); } catch {}
        try { if (ui._updateModalRightCount) ui._updateModalRightCount(); } catch {}
      };
    };

    vsWrap.addEventListener('scroll', () => renderVS(false));
    try {
      _ro = new ResizeObserver(() => renderVS(true));
      _ro.observe(vsWrap);
    } catch {}

    right.appendChild(gridWrap);

    const hint = document.createElement('div');
    hint.style.cssText = 'opacity:0.7; font-weight:900; padding-top:6px;';
    hint.textContent = ' ';
    right.appendChild(hint);

    bodyEl.appendChild(left);
    bodyEl.appendChild(right);

    requestAnimationFrame(() => renderVS(true));
  },
  };

  // =========================================================
  // Init
  // =========================================================
  ui.ensureAllUI();

  // 初回
  scanAndCollect();

  // Pinterestの仮想スクロール対策：DOM変化で収集
  const mo = new MutationObserver(() => {
    if (scanAndCollect._pending) return;
    scanAndCollect._pending = true;
    requestAnimationFrame(() => {
      scanAndCollect._pending = false;
      scanAndCollect();
    });
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // 定期スキャン
  setInterval(() => scanAndCollect(), 2000);

  // UI watchdog
  setInterval(() => {
    ui.ensureAllUI();
  }, UI_WATCHDOG_INTERVAL_MS);

})();
