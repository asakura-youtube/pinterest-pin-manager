// ==UserScript==
// @name         Pinterest 総合管理ツール
// @namespace    https://example.com/
// @version      2.0.0
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
// @connect      raw.githubusercontent.com
// @connect      githubusercontent.com
// @connect      github.com
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
  const FETCH_THUMBNAIL_IF_MISSING = true;

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
  //   ui: { activeFavId, activeSnapId, minEnabled, minCount, onlyKnown, sortDir, historySortDir },
  //   pinMeta: { [pinId]: { pinId, href, thumbUrl, countStr, countNum, updatedAt } }   // ★追加
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
        historySortDir: 'desc',
      },
      pinMeta: {}, // ★追加
    };

    const loaded = loadStateWithRestore();
    if (!loaded.data) return base;

    return {
      favorites: loaded.data.favorites || base.favorites,
      snapshots: loaded.data.snapshots || base.snapshots,
      ui: { ...base.ui, ...(loaded.data.ui || {}) },
      pinMeta: loaded.data.pinMeta || base.pinMeta, // ★追加（互換）
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

  // =========================================================
  // Persist pin meta (pinId -> {thumbUrl,count,href...})  ★追加
  // =========================================================
  const PINMETA_FLUSH_MS = 900;
  const PINMETA_MAX = 50000; // 保存しすぎ防止（必要なら増減）

  let _pinMetaFlushTimer = null;
  const _pinMetaDirty = new Set();

  function _rememberPinMeta(p) {
    if (!p || !p.pinId) return;

    // 必要なものだけ保存（肥大化防止）
    const meta = {
      pinId: p.pinId,
      href: p.href || pinUrl(p.pinId),
      thumbUrl: p.thumbUrl || null,
      countStr: (p.countStr != null) ? String(p.countStr) : null,
      countNum: (p.countNum != null) ? (parseInt(p.countNum, 10) || 0) : null,
      updatedAt: Date.now(),
    };

    if (!persisted.pinMeta) persisted.pinMeta = {};
    persisted.pinMeta[p.pinId] = meta;
    _pinMetaDirty.add(p.pinId);

    // debounce flush
    if (_pinMetaFlushTimer) return;
    _pinMetaFlushTimer = setTimeout(() => {
      _pinMetaFlushTimer = null;

      try {
        // prune（古い順に落とす）
        const keys = Object.keys(persisted.pinMeta || {});
        if (keys.length > PINMETA_MAX) {
          const arr = keys
            .map(k => persisted.pinMeta[k])
            .filter(Boolean)
            .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)); // 古い→新しい
          const cut = Math.max(0, arr.length - PINMETA_MAX);
          for (let i = 0; i < cut; i++) {
            const id = arr[i]?.pinId;
            if (id) delete persisted.pinMeta[id];
          }
        }

        saveStateAll(persisted);
      } catch (e) {
        log('pinMeta flush failed', e);
      } finally {
        _pinMetaDirty.clear();
      }
    }, PINMETA_FLUSH_MS);
  }

  function _hydrateFromPersisted(pinId) {
    const m = persisted?.pinMeta?.[pinId];
    if (!m) return false;

    // pinStore にまだ無い/薄い時に注入
    const cur = pinStore.get(pinId);
    if (!cur) {
      upsertPin(pinId, {
        href: m.href || pinUrl(pinId),
        thumbUrl: m.thumbUrl || null,
        countStr: m.countStr != null ? m.countStr : null,
        countNum: m.countNum != null ? m.countNum : null,
      });
    } else {
      // 既存に無いものだけ補完（上書きしすぎない）
      const patch = {};
      if (!cur.href && m.href) patch.href = m.href;
      if (!cur.thumbUrl && m.thumbUrl) patch.thumbUrl = m.thumbUrl;
      if (cur.countStr == null && m.countStr != null) patch.countStr = m.countStr;
      if (cur.countNum == null && m.countNum != null) patch.countNum = m.countNum;
      if (Object.keys(patch).length) upsertPin(pinId, patch);
    }

    // countCache にも入れる（再取得抑制）
    if (m.countStr != null) setCachedCount(pinId, m.countStr);
    return true;
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

    // ★追加：pinMeta に覚える（thumbUrl/❤/href を更新後も維持）
    _rememberPinMeta(next);
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

      // ★追加：ページ更新直後でも、保存済みの thumb/❤/href を即復元
      _hydrateFromPersisted(pinId);

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

  function getDefaultFavId() {
    return persisted?.favorites?.order?.[0] || null;
  }

  function ensureDefaultFavoriteList() {
    if (persisted.favorites.order.length > 0) return;
    const id = uuid();
    persisted.favorites.order.push(id);
    persisted.favorites.lists[id] = { id, name: 'お気に入り', pinIds: [] };
    saveStateAll(persisted);
  }

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

  function chooseFavListIdByPrompt() {
    const order = persisted?.favorites?.order || [];
    const lists = persisted?.favorites?.lists || {};
    const items = order.map((id) => lists[id]).filter(Boolean);

    if (!items.length) return null;

    const lines = items.map((it, i) => `${i + 1}. ${it.name}（${it.pinIds?.length || 0}件）`);
    lines.push(''); 
    lines.push('n. 新規リストを作って追加');

    const msg =
      '追加先のお気に入りリストを選んでください（番号 / n）\n\n' +
      lines.join('\n');

    const ans = prompt(msg, '1');
    if (!ans) return null;

    const t = String(ans).trim().toLowerCase();

    if (t === 'n') {
      const name = prompt('新しいお気に入りリスト名', `お気に入り ${items.length + 1}`);
      if (!name) return null;
      return createFavList(name);
    }

    const n = parseInt(t, 10);
    if (!Number.isFinite(n) || n < 1 || n > items.length) {
      alert('入力が不正です（番号 1〜' + items.length + ' / n）');
      return null;
    }

    return items[n - 1].id;
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
    const defaultId = getDefaultFavId();
    if (id === defaultId) return; // ★デフォルトは削除不可

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
    try {
        // 1) og:image が最優先（大抵 1200x 近い）
        const og = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
        if (og && /^https?:\/\//.test(og)) return og;

        // 2) twitter:image
        const tw = doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content') || '';
        if (tw && /^https?:\/\//.test(tw)) return tw;

        // 3) JSON-LD (schema.org) に image が入っている場合
        const ldNodes = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
        for (const n of ldNodes) {
        const txt = (n.textContent || '').trim();
        if (!txt) continue;
        let j;
        try { j = JSON.parse(txt); } catch { continue; }
        const arr = Array.isArray(j) ? j : [j];
        for (const o of arr) {
            const img = o?.image;
            if (typeof img === 'string' && /^https?:\/\//.test(img)) return img;
            if (Array.isArray(img)) {
            const s = img.find(v => typeof v === 'string' && /^https?:\/\//.test(v));
            if (s) return s;
            }
        }
        }

        // 4) 画面内の img から pinimg を拾う（最後の保険）
        const imgs = Array.from(doc.images || []);
        // pinimg.com を優先
        const pinimg = imgs.map(im => im.currentSrc || im.src || '').find(u => /pinimg\.com/.test(u));
        if (pinimg) return pinimg;

        // それでもダメなら何かURLっぽいもの
        const any = imgs.map(im => im.currentSrc || im.src || '').find(u => /^https?:\/\//.test(u));
        return any || null;
    } catch (e) {
        console.warn('[extractThumbUrlFromPinDoc] failed', e);
        return null;
    }
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
      viewerSidebarOpen: true, // ★追加：Viewerの左サイドバー開閉


      // ★追加：viewerの「どの一覧から開いたか」コンテキスト
      // source: 'favorites' | 'history' | 'sort' | null
      viewerSource: null,
      viewerIds: [],        // 現在の一覧pinId配列（ホイール移動用）
      viewerIndex: -1,      // viewerIds内の現在位置

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
      let el = document.getElementById('pt-toast');
      if (el) return;

      const mount = uiMountRoot();

      el = document.createElement('div');
      el.id = 'pt-toast';
      el.style.cssText = `
        position:fixed;
        left:12px;
        bottom:12px;
        z-index:2147483700; /* ★viewer(2147483650)より上にする */
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
      mount.appendChild(el);
    },

    toast(msg) {
      // ★Viewerが開いているときは Viewer専用Toastへ
      if (ui.state.viewerOpen) {
        ui.viewerToast(msg);
        return;
      }

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

    viewerToast(msg) {
      // pt-viewer が無ければ何もしない
      const viewer = document.getElementById('pt-viewer');
      if (!viewer) return;

      let el = document.getElementById('pt-vtoast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'pt-vtoast';
        el.style.cssText = `
          position: absolute;
          left: 16px;
          bottom: 16px;
          z-index: 10; /* ★Viewer内で最前面（Viewer自体のz-indexは触らない） */
          background: rgba(0,0,0,0.78);
          color: #fff;
          padding: 10px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 900;
          opacity: 0;
          transform: translateY(6px);
          transition: opacity 120ms ease, transform 120ms ease;
          pointer-events: none;
          user-select: none;
          max-width: 60vw;
          white-space: pre-line;
          backdrop-filter: blur(6px);
          border: 1px solid rgba(255,255,255,0.12);
        `;
        // ★Viewer直下に置く（panelの外＝画面左下に確実に出せる）
        viewer.appendChild(el);
      }

      el.textContent = msg;
      el.style.opacity = '1';
      el.style.transform = 'translateY(0px)';

      if (ui.state.vtoastTimer) clearTimeout(ui.state.vtoastTimer);
      ui.state.vtoastTimer = setTimeout(() => {
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

      // ★お気に入り保存先（ドロップダウン）
      const favTarget = document.createElement('select');
      favTarget.style.cssText = ui.selectCss();
      favTarget.style.minWidth = '220px';

      // options
      const rebuildFavTargetOptions = () => {
        favTarget.innerHTML = '';

        const defaultId = getDefaultFavId();
        const order = persisted?.favorites?.order || [];
        const lists = persisted?.favorites?.lists || {};

        for (const id of order) {
          const it = lists[id];
          if (!it) continue;
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = `${it.name}${id === defaultId ? '（デフォルト）' : ''}`;
          favTarget.appendChild(opt);
        }

        // （任意）新規作成
        const optNew = document.createElement('option');
        optNew.value = '__new__';
        optNew.textContent = '＋新規リスト作成…';
        favTarget.appendChild(optNew);

        // 初期値：前回選択がなければデフォルト
        const init = ui.state.favSaveTargetId || defaultId || (order[0] || '');
        favTarget.value = init || (defaultId || '');
      };

      rebuildFavTargetOptions();

      favTarget.addEventListener('change', () => {
        if (favTarget.value === '__new__') {
          const name = prompt('新しいお気に入りリスト名', `お気に入り ${persisted.favorites.order.length + 1}`);
          if (!name) {
            // キャンセル時はデフォルトへ戻す
            favTarget.value = getDefaultFavId() || '';
            return;
          }
          const newId = createFavList(name);
          ui.state.favSaveTargetId = newId;
          persistUIState();
          rebuildFavTargetOptions();
          favTarget.value = newId;
          ui.toast('リスト追加');
          return;
        }

        ui.state.favSaveTargetId = favTarget.value;
        persistUIState();
      });

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
        const ids = Array.from(selectedPins);
        if (ids.length === 0) {
          ui.toast('選択なし');
          return;
        }

        // ★保存先：ドロップダウンで選ばれていればそこ、なければデフォルト
        const defaultId = getDefaultFavId();
        const listId =
          (ui.state.favSaveTargetId && persisted.favorites.lists[ui.state.favSaveTargetId])
            ? ui.state.favSaveTargetId
            : defaultId;

        if (!listId) {
          ui.toast('お気に入りリストなし');
          return;
        }

        addPinsToFav(listId, ids);

        // 気持ちよさ：保存先をアクティブに
        ui.state.activeFavId = listId;
        persistUIState();

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
      right.appendChild(favTarget);
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
        _hydrateFromPersisted(id);
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

      // ★追加：モーダル側で表示する前に、永続pinMetaから復元（更新対策）
      if (p?.pinId) {
      _hydrateFromPersisted(p.pinId);
      const p2 = pinStore.get(p.pinId);
      if (p2) p = p2;
      }

      const isSelected = selectedPins.has(p.pinId);

      const card = document.createElement('a');
      card.href = p.href || pinUrl(p.pinId);
      card.target = '_blank';
      card.rel = 'noreferrer noopener';
      card.style.cssText = `
        display:block;
        background: rgba(0,0,0,0.55);
        border:1px solid rgba(255,255,255,${isSelected ? '0.30' : '0.12'});
        border-radius:14px;
        overflow:hidden;
        text-decoration:none;
        color:#fff;
        outline: ${isSelected ? '3px solid rgba(150,220,255,0.55)' : 'none'};
        box-shadow: ${isSelected ? '0 0 0 2px rgba(150,220,255,0.12), 0 0 18px rgba(120,200,255,0.10)' : 'none'};
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
    // Update checker (callable from anywhere)
    // =========================================================
    async ensureUpdateCheck(force = false) {
      try {
        if (!ui.state.updateCheck) ui.state.updateCheck = {};
        // ui.state.updateCheck = { ts, latestVersion, updateNeeded, error }

        const getLocalVersion = () => {
          try {
            if (typeof GM_info !== 'undefined' && GM_info?.script?.version) return String(GM_info.script.version);
          } catch {}
          return '0.0.0';
        };

        const normalizeVer = (v) => String(v || '0.0.0').trim().replace(/^v/i, '');
        const cmpSemver = (a, b) => {
          const pa = normalizeVer(a).split('.').map(x => parseInt(x, 10) || 0);
          const pb = normalizeVer(b).split('.').map(x => parseInt(x, 10) || 0);
          const n = Math.max(pa.length, pb.length, 3);
          for (let i = 0; i < n; i++) {
            const da = pa[i] || 0;
            const db = pb[i] || 0;
            if (da < db) return -1;
            if (da > db) return 1;
          }
          return 0;
        };

        const requestText = (url) => new Promise((resolve, reject) => {
          try {
            if (typeof GM_xmlhttpRequest === 'function') {
              GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload: (res) => resolve(res.responseText || ''),
                onerror: () => reject(new Error('request failed')),
                ontimeout: () => reject(new Error('request timeout')),
              });
              return;
            }
          } catch {}
          fetch(url, { cache: 'no-store' })
            .then(r => r.text())
            .then(resolve)
            .catch(reject);
        });

        const extractVersionFromUserscript = (text) => {
          const m = String(text || '').match(/^[ \t]*\/\/[ \t]*@version[ \t]+([0-9A-Za-z.\-_]+)[ \t]*$/m);
          return m ? String(m[1] || '').trim() : null;
        };

        const cacheMs = 24 * 60 * 60 * 1000;
        const now = Date.now();

        const prevLatest = ui.state.updateCheck.latestVersion || null;
        const prevNeeded = !!ui.state.updateCheck.updateNeeded;
        const prevErr = ui.state.updateCheck.error || null;

        const lastTs = ui.state.updateCheck.ts || 0;

        if (!force && lastTs && (now - lastTs) < cacheMs) {
          ui.state.updateNeeded = !!ui.state.updateCheck.updateNeeded;
          ui.state.latestVersion = ui.state.updateCheck.latestVersion || null;
          return;
        }

        const dlUrl =
          (typeof GM_info !== 'undefined' && GM_info?.script?.downloadURL)
            ? GM_info.script.downloadURL
            : 'https://raw.githubusercontent.com/asakura-youtube/pinterest-pin-manager/main/pinterest-pin-manager.user.js';

        const localV = getLocalVersion();

        ui.state.updateCheck.error = null;

        try {
          const txt = await requestText(dlUrl);
          const remoteV = extractVersionFromUserscript(txt);
          if (!remoteV) throw new Error('remote version not found');

          const needed = (cmpSemver(localV, remoteV) < 0);

          ui.state.updateCheck.ts = now;
          ui.state.updateCheck.latestVersion = remoteV;
          ui.state.updateCheck.updateNeeded = needed;
          ui.state.updateCheck.error = null;

          ui.state.updateNeeded = needed;
          ui.state.latestVersion = remoteV;

          // ★追加：上部ヘルプタブの⚠️表示を即時反映（ヘッダーは再生成されないためDOM直更新）
          try {
            const t = document.getElementById('pt-modal-tab-help');
            if (t) t.textContent = ui.state.updateNeeded ? '⚠️ヘルプ' : 'ヘルプ';
          } catch {}

          persistUIState();

          // ✅ チェック完了後、結果が変わったらモーダル即再描画（上部タブ/左メニュー反映）
          const changed =
            (prevLatest !== remoteV) ||
            (prevNeeded !== needed) ||
            (prevErr !== null);

          if (changed && ui.state.modalOpen && ui.state.modalMode) {
            ui.renderModal(true);
          }
        } catch (e) {
          const msg = e?.message || 'update check failed';

          ui.state.updateCheck.ts = now;
          ui.state.updateCheck.latestVersion = null;
          ui.state.updateCheck.updateNeeded = false;
          ui.state.updateCheck.error = msg;

          // ★追加：上部ヘルプタブの⚠️表示を即時反映（ヘッダーは再生成されないためDOM直更新）
          try {
            const t = document.getElementById('pt-modal-tab-help');
            if (t) t.textContent = ui.state.updateNeeded ? '⚠️ヘルプ' : 'ヘルプ';
          } catch {}

          ui.state.updateNeeded = false;
          ui.state.latestVersion = null;

          persistUIState();

          // ✅ 失敗→失敗表示へ切り替え（必要なら再描画）
          const changed =
            (prevLatest !== null) ||
            (prevNeeded !== false) ||
            (prevErr !== msg);

          if (changed && ui.state.modalOpen && ui.state.modalMode) {
            ui.renderModal(true);
          }
        }
      } catch {}
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

    // ★追加：管理メニューで開いた時点でも更新チェックを走らせる（非同期・UIブロックなし）
    try { ui.ensureUpdateCheck(false); } catch {}

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
      // ★追加：お気に入りクリックでも更新チェック
      try { ui.ensureUpdateCheck(false); } catch {}

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
      // ★追加：履歴クリックでも更新チェック
      try { ui.ensureUpdateCheck(false); } catch {}

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
      btnTabIO.textContent = ui.state.updateNeeded ? '⚠️ヘルプ' : 'ヘルプ';
      btnTabIO.id = 'pt-modal-tab-help';
      btnTabIO.style.cssText = ui.buttonCss(ui.state.modalMode !== 'help');
      btnTabIO.addEventListener('click', () => {
        // ★追加：ヘルプクリックでも更新チェック（押した瞬間に走る）
        try { ui.ensureUpdateCheck(false); } catch {}        
        ui.state.modalMode = 'help';
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

      if (mode === 'help') {
        title.textContent = 'ヘルプ';
        ui.renderHelpManager(body);
        return;
      }

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
    openViewer(pinId, ctx = {}) {
    const p = pinStore.get(pinId) || { pinId, thumbUrl: null, href: pinUrl(pinId), countStr: null, countNum: null };
    const hi = toHighResPinimgUrl(p.thumbUrl) || null;

    // ★コンテキスト
    const source = ctx.source || null; // 'favorites' | 'history' | 'sort' | null
    const ids = Array.isArray(ctx.ids) ? ctx.ids.filter(Boolean) : [];
    const index = (typeof ctx.index === 'number')
        ? ctx.index
        : (ids.length ? ids.indexOf(pinId) : -1);

    ui.state.viewerOpen = true;
    ui.state.viewerPinId = pinId;

    // ★まずはキャッシュで即表示（右側プレビューと同じ思想）
    ui.state.viewerImgUrl = hi;
    ui.state.viewerPinHref = p.href || pinUrl(pinId);
    ui.state.viewerCountStr = p.countStr;

    ui.state.viewerSource = source;
    ui.state.viewerIds = ids;
    ui.state.viewerIndex = index;

    ui.ensureViewer(true);
    ui.renderViewer(true);
    ui.ensureToast();

    // =========================================================
    // ★ここが本命：欠損なら Viewer 側で rehydrate → 再描画
    // （右側プレビューと同じ「表示しながら補完」）
    // =========================================================
    ui._viewerHydratePinIfNeeded?.(pinId);
    },

    closeViewer() {
      ui.state.viewerOpen = false;
      ui.state.viewerPinId = null;
      ui.state.viewerImgUrl = null;
      ui.state.viewerPinHref = null;
      ui.state.viewerCountStr = null;

      // ★追加：外側スクロール解除
      ui._unlockBodyScroll();

      // ★追加：wheelガード解除（残留防止）
      try {
        if (ui.state._viewerWheelGuard) {
          window.removeEventListener('wheel', ui.state._viewerWheelGuard, { capture: true });
          ui.state._viewerWheelGuard = null;
        }
      } catch {}

      const v = document.getElementById('pt-viewer');
      if (v) v.remove();
    },

    ensureViewer(force = false) {
      const existing = document.getElementById('pt-viewer');
      const existingToast = document.getElementById('pt-viewer-toast');

      if (!ui.state.viewerOpen) {
        if (existing) existing.remove();

        // ★外側スクロール解除（取りこぼし防止）
        try { ui._unlockBodyScroll?.(); } catch {}

        // ★Toastも確実に消す
        try { if (existingToast) existingToast.remove(); } catch {}

        // ★wheelガード解除（取りこぼし防止）
        try {
          if (ui.state._viewerWheelGuard) {
            // addEventListener 側が capture:true なので remove も capture:true を合わせる
            window.removeEventListener('wheel', ui.state._viewerWheelGuard, true);
          }
        } catch {}
        ui.state._viewerWheelGuard = null;

        return;
      }
      if (existing && !force) return;
      if (existing) existing.remove();

      // Toastの残骸があれば掃除（表示が残るのを防止）
      try { if (existingToast) existingToast.remove(); } catch {}

      const mount = uiMountRoot();

      // =========================
      // ★Left open/close（管理メニューと同じ開閉式）
      // =========================
      if (ui.state.viewerSidebarOpen == null) ui.state.viewerSidebarOpen = true;

      // 初期モード（未設定なら single）
      if (!ui.state.viewerMode) ui.state.viewerMode = 'single'; // 'single' | 'tile'

      // ★モードごとの「現在表示中pin」保持（混ざらないように）
      if (!ui.state.viewerPinIdSingle) ui.state.viewerPinIdSingle = null;
      if (!ui.state.viewerPinIdTile) ui.state.viewerPinIdTile = null;

      // =========================
      // Root overlay
      // =========================
      const viewer = document.createElement('div');
      viewer.id = 'pt-viewer';
      viewer.style.cssText = `
        position:fixed; inset:0;
        z-index:2147483640; /* toastより少し下にする */
        background: rgba(0,0,0,0.65);
        backdrop-filter: blur(8px);
        display:flex;
        align-items:center;
        justify-content:center;
        padding: 14px;
      `;
      viewer.dataset.mode = ui.state.viewerMode || 'single';

      viewer.addEventListener('click', (ev) => {
        if (ev.target === viewer) ui.closeViewer();
      });

      // ★追加：外側スクロール完全禁止（Pinterestの独自スクロール対策）
      // 重要：capture:true で先に潰す / passive:false で preventDefault を有効にする
      if (!ui.state._viewerWheelGuard) {
        ui.state._viewerWheelGuard = (ev) => {
          if (!ui.state.viewerOpen) return;

          const t = ev.target;
          // 内側スクロールOK領域だけ許可
          // 既に存在するID：pt-viewer-selected-rail / pt-viewer-selected-list
          const allow = t && t.closest && t.closest(
            '#pt-viewer-content, #pt-viewer-selected-rail, #pt-viewer-selected-list, #pt-viewer-sidebar-body, #pt-viewer-grid'
          );
          if (allow) return;

          ev.preventDefault();
          ev.stopPropagation();
        };
        window.addEventListener('wheel', ui.state._viewerWheelGuard, { capture: true, passive: false });
      }

      // =========================
      // Viewer-local toast（最前面・mount直下）
      // =========================
      const viewerToastEl = document.createElement('div');
      viewerToastEl.id = 'pt-viewer-toast';
      viewerToastEl.style.cssText = `
        position:fixed;
        left:12px;
        bottom:12px;
        z-index:2147483647; /* ★最前面固定 */
        background:rgba(0,0,0,0.78);
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
        max-width: 70vw;
        white-space: pre-line;
        backdrop-filter: blur(6px);
        border:1px solid rgba(255,255,255,0.12);
      `;
      // ★viewerの子ではなく mount直下へ（最前面を保証）
      mount.appendChild(viewerToastEl);

      let _viewerToastTimer = null;
      const viewerToast = (msg) => {
        try {
          viewerToastEl.textContent = String(msg ?? '');
          viewerToastEl.style.opacity = '1';
          viewerToastEl.style.transform = 'translateY(0px)';
          if (_viewerToastTimer) clearTimeout(_viewerToastTimer);
          _viewerToastTimer = setTimeout(() => {
            viewerToastEl.style.opacity = '0';
            viewerToastEl.style.transform = 'translateY(6px)';
          }, 900);
        } catch {}
      };

      // 外からも使えるように
      ui._viewerToast = viewerToast;

      // =========================
      // Click delay helper（single click 遅延）
      // =========================
      const CLICK_DELAY_MS = 220;

      // 要点：
      // - click(detail===1) は遅延して実行（ダブルクリックが来たらキャンセル）
      // - dblclick は即実行
      // - 2回目の click(detail===2) で余計な予約を作らない
      const makeDelayedClick = (onSingle, onDouble) => {
        let t = null;

        const cancel = () => {
          if (t) { clearTimeout(t); t = null; }
        };

        const click = (ev) => {
          // 2回目の click(detail=2) は無視（dblclick側で処理）
          if (ev && ev.detail && ev.detail >= 2) return;

          cancel();
          t = setTimeout(() => {
            t = null;
            try { onSingle?.(ev); } catch {}
          }, CLICK_DELAY_MS);
        };

        const dblclick = (ev) => {
          cancel();
          try { onDouble?.(ev); } catch {}
        };

        return { click, dblclick, cancel };
      };

      // =========================================================
      // ★ここが重要：Viewer側でも「persistedに保存済みのpin情報」を優先して使う
      // - renderHistoryManager と同じく _hydrateFromPersisted(pinId) を必ず噛ませる
      // - pinStore から取れない/欠損している場合でも、persisted側の情報で補完される想定
      // =========================================================
      const hydrateOne = (pinId) => {
        try { if (pinId) _hydrateFromPersisted?.(pinId); } catch {}
      };
      const hydrateMany = (ids) => {
        try {
          (ids || []).forEach((id) => {
            try { if (id) _hydrateFromPersisted?.(id); } catch {}
          });
        } catch {}
      };
      const getPinData = (pinId) => {
        hydrateOne(pinId);
        return pinStore.get(pinId) || { pinId, thumbUrl: null, href: pinUrl(pinId), countStr: null, countNum: null };
      };

      // =========================
      // Panel (left sidebar + main + rail)
      // =========================
      const panel = document.createElement('div');
      panel.id = 'pt-viewer-panel';
      panel.style.cssText = `
        width: min(1240px, 96vw);
        height: min(860px, 92vh);
        background: rgba(0,0,0,0.78);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px;
        display:flex;
        overflow:hidden;
        color:#fff;
      `;

      // =========================
      // Left sidebar
      // =========================
      const sidebar = document.createElement('div');
      sidebar.id = 'pt-viewer-sidebar';
      sidebar.style.cssText = `
        width: 260px;
        min-width: 240px;
        max-width: 300px;
        border-right: 1px solid rgba(255,255,255,0.10);
        background: rgba(0,0,0,0.42);
        display:flex;
        flex-direction:column;
        overflow:hidden;
        transition: width 120ms ease, min-width 120ms ease, max-width 120ms ease, opacity 120ms ease;
      `;

      // =========================
      // ★Splitter（サイドバー開閉：管理メニューと同じ）
      // =========================
      const splitter = document.createElement('div');
      splitter.id = 'pt-viewer-splitter';
      splitter.style.cssText = `
        width: 12px;
        flex: 0 0 12px;
        position: relative;
        user-select:none;
        background: rgba(255,255,255,0.02);
        transition: background 120ms ease;
        z-index: 6;
        pointer-events: auto;
      `;

      const splitBtn = document.createElement('button');
      splitBtn.type = 'button';
      splitBtn.textContent = ui.state.viewerSidebarOpen ? '◀' : '▶';
      splitBtn.title = ui.state.viewerSidebarOpen ? '左サイドバーを閉じる' : '左サイドバーを開く';
      splitBtn.style.cssText = `
        position:absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        padding: 6px 4px;
        border: none;
        background: transparent;
        color: rgba(255,255,255,0.85);
        font-size: 18px;
        font-weight: 900;
        cursor: pointer;
        z-index: 2;
        line-height: 1;
      `;

      splitter.addEventListener('mouseenter', () => {
        splitter.style.background = 'rgba(255,255,255,0.06)';
      });
      splitter.addEventListener('mouseleave', () => {
        splitter.style.background = 'rgba(255,255,255,0.02)';
      });

      splitter.appendChild(splitBtn);

      // Sticky header (1-row)
      const header = document.createElement('div');
      header.id = 'pt-viewer-sidebar-header';
      header.style.cssText = `
        position: sticky;
        top: 0;
        z-index: 5;
        padding: 10px 10px;
        background: rgba(0,0,0,0.55);
        border-bottom: 1px solid rgba(255,255,255,0.10);
        display:flex;
        align-items:center;
        gap:8px;
      `;

      const titleEl = document.createElement('div');
      titleEl.id = 'pt-viewer-title';
      titleEl.textContent = '—';
      titleEl.style.cssText = `
        flex: 1;
        min-width: 0;
        font-weight: 1000;
        color:#fff;
        opacity: 0.95;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      `;

      const posEl = document.createElement('div');
      posEl.id = 'pt-viewer-pos';
      posEl.textContent = '— / —';
      posEl.style.cssText = `
        flex: 0 0 auto;
        height: 20px;
        padding: 4px 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.10);
        color:#fff;
        font-weight: 1000;
        font-size: 12px;
        opacity: 0.92;
        white-space: nowrap;
      `;

      const iconBtnCss = `
        flex: 0 0 auto;
        width: 34px;
        height: 30px;
        padding: 0px 25px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(255,255,255,0.10);
        color: #fff;
        font-weight: 1000;
        cursor: pointer;
        display:flex;
        align-items:center;
        justify-content:center;
        user-select:none;
      `;

      const btnOpenPin = document.createElement('button');
      btnOpenPin.type = 'button';
      btnOpenPin.textContent = '↗PIN';
      btnOpenPin.title = 'Pinを開く';
      btnOpenPin.style.cssText = iconBtnCss;
      btnOpenPin.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const href = ui.state.viewerPinHref || pinUrl(ui.state.viewerPinId);
        if (!href) return;
        window.open(href, '_blank', 'noreferrer');
      });

      header.appendChild(titleEl);
      header.appendChild(posEl);
      header.appendChild(btnOpenPin);

      const sideBody = document.createElement('div');
      sideBody.id = 'pt-viewer-sidebar-body';
      sideBody.style.cssText = `
        flex: 1;
        padding: 12px;
        display:flex;
        flex-direction:column;
        gap: 10px;
        overflow:auto;
      `;

      // helpers
      const makeSection = (label) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = `
          display:flex;
          flex-direction:column;
          gap:8px;
          padding-top: 6px;
          border-top: 1px solid rgba(255,255,255,0.10);
        `;
        const t = document.createElement('div');
        t.textContent = label;
        t.style.cssText = `
          opacity:0.78;
          font-weight:1000;
          user-select:none;
          letter-spacing:0.2px;
          color:#fff;
        `;
        wrap.appendChild(t);
        return wrap;
      };

      const btnCss = (secondary = false) => `
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.18);
        background: ${secondary ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.14)'};
        color:#fff;
        cursor:pointer;
        font-size:12px;
        font-weight:900;
        white-space:nowrap;
        text-align:center;
        min-width: 0;
      `;

      const rowCss = `
        display:flex;
        gap:8px;
        align-items:center;
      `;

      // =========================
      // ★編集モード（ヘッダー直下に追加）
      // =========================
      const editSection = document.createElement('div');
      editSection.style.cssText = `
        display:flex;
        flex-direction:column;
        gap:8px;
        padding-top: 6px;
        border-top: none;
      `;

      const editLabel = document.createElement('div');
      editLabel.textContent = '編集モード';
      editLabel.style.cssText = `
        opacity:0.78;
        font-weight:1000;
        user-select:none;
        letter-spacing:0.2px;
        color:#fff;
      `;

      const btnCloseEdit = document.createElement('button');
      btnCloseEdit.type = 'button';
      btnCloseEdit.textContent = '編集モードを閉じる';
      btnCloseEdit.style.cssText = `${btnCss(false)} width:100%;`;
      btnCloseEdit.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        try {
          ui.closeViewer();
        } catch (e) {
          // ★例外が出ても必ず閉じる（No Img時に閉じない対策）
          try { console.error('[pt] closeViewer failed', e); } catch {}
          try { ui.state.viewerOpen = false; } catch {}
          try {
            const v = document.getElementById('pt-viewer');
            if (v) v.remove();
          } catch {}

          // ★Toastも消す
          try {
            const t = document.getElementById('pt-viewer-toast');
            if (t) t.remove();
          } catch {}

          // ★wheelガード解除
          try {
            if (ui.state._viewerWheelGuard) {
              window.removeEventListener('wheel', ui.state._viewerWheelGuard, true);
            }
          } catch {}
          ui.state._viewerWheelGuard = null;

          try { ui._unlockBodyScroll?.(); } catch {}
        }
      });

      editSection.appendChild(editLabel);
      editSection.appendChild(btnCloseEdit);

      // =========================
      // Main content (single/tile) + selected rail
      // =========================
      const main = document.createElement('div');
      main.id = 'pt-viewer-main';
      main.style.cssText = `
        flex:1;
        display:flex;
        overflow:hidden;
        min-width: 0;
      `;

      // content root
      const content = document.createElement('div');
      content.id = 'pt-viewer-content';
      content.style.cssText = `
        flex:1;
        min-width:0;
        display:flex;
        align-items:center;
        justify-content:center;
        padding: 12px;
        overflow: hidden; /* ★常にhidden運用（scrollはgridへ） */
      `;

      // ★ホイールで前後移動：single のときだけ
      content.addEventListener('wheel', (e) => {
        if (!ui.state.viewerOpen) return;
        if ((ui.state.viewerMode || 'single') !== 'single') return;
        e.preventDefault();
        e.stopPropagation();
        const dy = e.deltaY || 0;
        if (dy > 0) ui._viewerMove(+1);
        else if (dy < 0) ui._viewerMove(-1);
      }, { passive: false });

      // rail
      const rail = document.createElement('div');
      rail.id = 'pt-viewer-selected-rail';
      rail.style.cssText = `
        width: 150px;
        min-width: 130px;
        max-width: 170px;
        border-left: 1px solid rgba(255,255,255,0.10);
        background: rgba(0,0,0,0.32);
        display:flex;
        flex-direction:column;
        overflow:hidden;
      `;

      const railHead = document.createElement('div');
      railHead.textContent = '選択済み';
      railHead.style.cssText = `
        padding: 10px 10px;
        font-weight: 1000;
        color:#fff;           /* ★白固定 */
        opacity: 0.95;        /* ★薄くならない */
        background: rgba(0,0,0,0.40);
        border-bottom: 1px solid rgba(255,255,255,0.10);
        white-space: nowrap;
        user-select:none;
      `;

      const railList = document.createElement('div');
      railList.id = 'pt-viewer-selected-list';
      railList.style.cssText = `
        flex:1;
        overflow-y:auto;
        overflow-x:hidden;
        padding: 10px 8px;
        display:flex;
        flex-direction:column;
        gap: 10px;
        overscroll-behavior: contain;
      `;

      rail.appendChild(railHead);
      rail.appendChild(railList);

      main.appendChild(content);
      main.appendChild(rail);

      // =========================
      // 表示モード（タイル / シングル）
      // =========================
      const modeSection = makeSection('表示モード');

      const modeRow = document.createElement('div');
      modeRow.style.cssText = rowCss;

      const btnModeSingle = document.createElement('button');
      btnModeSingle.type = 'button';
      btnModeSingle.textContent = 'シングル';
      btnModeSingle.style.cssText = `${btnCss(false)} flex:1;`;

      const btnModeTile = document.createElement('button');
      btnModeTile.type = 'button';
      btnModeTile.textContent = 'タイル';
      btnModeTile.style.cssText = `${btnCss(true)} flex:1;`;

      // content/overflow制御 + ボタン表示
      const syncModeButtons = () => {
        const m = ui.state.viewerMode || 'single';
        btnModeSingle.style.background = (m === 'single') ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
        btnModeTile.style.background = (m === 'tile') ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
        viewer.dataset.mode = m;

        // ★重要：pt-viewer-content は常に hidden（スクロールは grid のみにする）
        try { content.style.overflow = 'hidden'; } catch {}
      };

      // ★モード切替時：現在pinをモード別に保存＆復元
      const rememberCurrentPinForMode = () => {
        const m = ui.state.viewerMode || 'single';
        if (m === 'single') ui.state.viewerPinIdSingle = ui.state.viewerPinId || ui.state.viewerPinIdSingle;
        else ui.state.viewerPinIdTile = ui.state.viewerPinId || ui.state.viewerPinIdTile;
      };

      const restoreCurrentPinForMode = () => {
        const idsAll = (ui.state.viewerIds || []).filter(Boolean);
        if (!idsAll.length) return;

        const m = ui.state.viewerMode || 'single';
        const want = (m === 'single') ? ui.state.viewerPinIdSingle : ui.state.viewerPinIdTile;
        const pinId =
          (want && idsAll.includes(want)) ? want :
          (ui.state.viewerPinId && idsAll.includes(ui.state.viewerPinId) ? ui.state.viewerPinId : idsAll[0]);

        ui.state.viewerPinId = pinId;
        ui.state.viewerIndex = Math.max(0, idsAll.indexOf(pinId));
      };

      btnModeSingle.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        rememberCurrentPinForMode();
        ui.state.viewerMode = 'single';
        restoreCurrentPinForMode();
        syncModeButtons();
        try { ui.renderViewer(true); } catch {}
      });

      btnModeTile.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        rememberCurrentPinForMode();
        ui.state.viewerMode = 'tile';
        restoreCurrentPinForMode();
        syncModeButtons();
        try { ui.renderViewer(true); } catch {}
      });

      modeRow.appendChild(btnModeSingle);
      modeRow.appendChild(btnModeTile);
      modeSection.appendChild(modeRow);

      // =========================
      // 選択操作（全選択 / 選択解除）
      // =========================
      const selSection = makeSection('選択操作');

      const selRow = document.createElement('div');
      selRow.style.cssText = rowCss;

      const btnSelectAll = document.createElement('button');
      btnSelectAll.type = 'button';
      btnSelectAll.textContent = '全選択';
      btnSelectAll.style.cssText = `${btnCss(true)} flex:1;`;

      const btnClearSel = document.createElement('button');
      btnClearSel.type = 'button';
      btnClearSel.textContent = '選択解除';
      btnClearSel.style.cssText = `${btnCss(true)} flex:1;`;

      const selCount = document.createElement('div');
      selCount.id = 'pt-viewer-selcount';
      selCount.textContent = '選択: 0';
      selCount.style.cssText = `
        opacity:0.85;
        font-weight:900;
        font-size:12px;
        white-space:nowrap;
        user-select:none;
        padding: 2px 2px;
        color:#fff;
      `;

      // =========================
      // Viewer selection set helpers（右レール更新の “元”）
      // =========================
      ui._getViewerSelectionSet = () => {
        try {
          const src = ui.state.viewerSource;
          if (src === 'sort') return (typeof selectedPins !== 'undefined' ? (selectedPins || new Set()) : new Set());
          return (ui.state.modalSelectedPinIds || new Set());
        } catch {
          return new Set();
        }
      };

      // ★右レールに表示されているID配列（= 一括操作の対象）
      const getRailIdsOrToast = (labelForToast = '選択') => {
        const set = ui._getViewerSelectionSet?.() || new Set();
        const ids = Array.from(set || []).filter(Boolean);
        if (!ids.length) {
          viewerToast(`${labelForToast}なし（右レールが空です）`);
          return null;
        }
        return ids;
      };

      ui._viewerUpdateSelCount = () => {
        try {
          const set = ui._getViewerSelectionSet?.() || new Set();
          selCount.textContent = `選択: ${(set?.size || 0)}`;
        } catch {}
      };

      // ★右レール：ハートは「画像左上バッジ」にする（画像下のID行は完全廃止）
      ui._viewerUpdateSelectedRail = () => {
        try {
          const set = ui._getViewerSelectionSet?.() || new Set();
          const ids = Array.from(set || []).filter(Boolean);

          // ★ここでも persisted→pinStore 補完（まとめて）
          hydrateMany(ids);

          railList.innerHTML = '';

          if (!ids.length) {
            const empty = document.createElement('div');
            empty.textContent = '(なし)';
            empty.style.cssText = `
              opacity:0.70;
              font-weight:900;
              padding:10px;
              border:1px dashed rgba(255,255,255,0.14);
              border-radius:12px;
              text-align:center;
              user-select:none;
              color:#fff;
            `;
            railList.appendChild(empty);
            return;
          }

          for (const id of ids) {
            const p = getPinData(id);

            const card = document.createElement('button');
            card.type = 'button';
            card.style.cssText = `
              border:none;
              padding:0;
              background:transparent;
              cursor:pointer;
              text-align:left;
            `;

            const box = document.createElement('div');
            const isCur = (id === ui.state.viewerPinId);
            box.style.cssText = `
              width:100%;
              border-radius:12px;
              overflow:hidden;
              border:1px solid rgba(255,255,255,${isCur ? '0.35' : '0.12'});
              outline:${isCur ? '3px solid rgba(150,220,255,0.50)' : 'none'};
              background: rgba(0,0,0,0.45);
            `;

            const img = document.createElement('div');
            img.style.cssText = `
              width:100%;
              height:92px;
              background: rgba(255,255,255,0.08);
              position:relative;
              overflow:hidden;
            `;

            if (p.thumbUrl) {
              const im = document.createElement('img');
              im.src = p.thumbUrl;
              im.draggable = false;
              im.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block;';
              img.appendChild(im);
            } else {
              const t = document.createElement('div');
              t.textContent = 'No img';
              t.style.cssText = 'opacity:0.7; font-weight:900; padding:8px; color:#fff;';
              img.appendChild(t);
            }

            // ★左上バッジ（白固定）
            const badge = document.createElement('div');
            badge.style.cssText = `
              position:absolute; left:8px; top:8px;
              padding:4px 8px; border-radius:999px;
              background:rgba(0,0,0,0.70);
              color:#fff;
              font-weight:900; font-size:11px;
              user-select:none;
              border: 1px solid rgba(255,255,255,0.14);
              backdrop-filter: blur(6px);
            `;
            badge.textContent = `❤ ${(p.countStr != null) ? p.countStr : '—'}`;
            img.appendChild(badge);

            box.appendChild(img);
            card.appendChild(box);

            // ★レールクリック：そのpinへ移動（選択は維持）＋ tile でも “見える位置へ” スクロール
            card.addEventListener('click', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const idsAll = (ui.state.viewerIds || []).filter(Boolean);
              if (!idsAll.length) return;
              if (!idsAll.includes(id)) return;

              ui.state.viewerPinId = id;
              ui.state.viewerIndex = Math.max(0, idsAll.indexOf(id));
              if ((ui.state.viewerMode || 'single') === 'single') ui.state.viewerPinIdSingle = id;
              else ui.state.viewerPinIdTile = id;

              ui.renderViewer(true);
            });

            railList.appendChild(card);
          }
        } catch {}
      };

      // =========================
      // ★重要：お気に入り/履歴の編集後に「右レールの選択表示」を確実に消す
      // =========================
      const clearViewerSelectionAndRail = (alsoToastMsg = null) => {
        try {
          const src = ui.state.viewerSource;
          if (src === 'sort') {
            selectedPins = new Set();
          } else {
            ui.state.modalSelectedPinIds = new Set();
            ui.state.modalSelectedPinId = null;
            ui.state.modalLastClickedPinId = null;
            try { ui._rerenderModalPreviewIfAny?.(); } catch {}
            try { ui._updateModalRightCount?.(); } catch {}
          }
          ui._viewerUpdateSelCount?.();
          ui._viewerUpdateSelectedRail?.();
          if (alsoToastMsg) viewerToast(alsoToastMsg);
        } catch {}
      };

      // =========================
      // ★削除を Viewer 表示にも即時反映（tile/single共通）
      // =========================
      const removeFromViewerIds = (pinIds) => {
        const del = new Set((pinIds || []).filter(Boolean));
        if (!del.size) return false;

        // viewerIds から削除
        const before = (ui.state.viewerIds || []).filter(Boolean);
        const after = before.filter(id => !del.has(id));
        ui.state.viewerIds = after;

        // 選択集合からも削除（右レールの残骸防止）
        try {
          const src = ui.state.viewerSource;
          if (src === 'sort') {
            if (typeof selectedPins !== 'undefined' && selectedPins) {
              for (const id of del) selectedPins.delete(id);
            }
          } else {
            if (!ui.state.modalSelectedPinIds) ui.state.modalSelectedPinIds = new Set();
            for (const id of del) ui.state.modalSelectedPinIds.delete(id);
            if (del.has(ui.state.modalSelectedPinId)) ui.state.modalSelectedPinId = null;
            if (del.has(ui.state.modalLastClickedPinId)) ui.state.modalLastClickedPinId = null;
            try { ui._rerenderModalPreviewIfAny?.(); } catch {}
            try { ui._updateModalRightCount?.(); } catch {}
          }
        } catch {}

        // 現在表示 pin を調整（消えたら次へ）
        const idsAll = after;
        if (!idsAll.length) {
          ui.state.viewerPinId = null;
          ui.state.viewerIndex = 0;
          ui.state.viewerPinIdSingle = null;
          ui.state.viewerPinIdTile = null;
          ui.state.viewerImgUrl = null;
          ui.state.viewerPinHref = null;
          return true;
        }

        // 現在pinが消えた/不整合なら index基準で次を選ぶ
        let idx = Number(ui.state.viewerIndex ?? 0);
        if (!Number.isFinite(idx)) idx = 0;
        if (idx >= idsAll.length) idx = idsAll.length - 1;

        let cur = ui.state.viewerPinId;
        if (!cur || !idsAll.includes(cur)) cur = idsAll[idx];

        ui.state.viewerPinId = cur;
        ui.state.viewerIndex = Math.max(0, idsAll.indexOf(cur));

        if ((ui.state.viewerMode || 'single') === 'single') ui.state.viewerPinIdSingle = cur;
        else ui.state.viewerPinIdTile = cur;

        return true;
      };

      // =========================
      // Select all / clear selection
      // =========================
      btnSelectAll.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();

        const ids = (ui.state.viewerIds || []).filter(Boolean);
        if (!ids.length) { viewerToast('対象なし'); return; }

        const src = ui.state.viewerSource;
        if (src === 'sort') {
          selectedPins = new Set(ids);
        } else {
          ui.state.modalSelectedPinIds = new Set(ids);
          ui.state.modalSelectedPinId = ids[0] || null;
          ui.state.modalLastClickedPinId = ids[0] || null;
          try { ui._rerenderModalPreviewIfAny?.(); } catch {}
          try { ui._updateModalRightCount?.(); } catch {}
        }

        viewerToast(`全選択: ${ids.length}`);
        ui._viewerUpdateSelCount?.();
        ui._viewerUpdateSelectedRail?.();
        try { ui.renderViewer(true); } catch {}
      });

      btnClearSel.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();

        clearViewerSelectionAndRail('選択解除');
        try { ui.renderViewer(true); } catch {}
      });

      selRow.appendChild(btnSelectAll);
      selRow.appendChild(btnClearSel);
      selSection.appendChild(selRow);
      selSection.appendChild(selCount);

      // =========================
      // Favorites（右レール対象に統一）
      // =========================
      const favSection = makeSection('お気に入り');

      const favSelect = document.createElement('select');
      favSelect.style.cssText = `
        ${ui.selectCss()}
        width:100%;
        min-width:0;
      `;

      const rebuildViewerFavOptions = () => {
        favSelect.innerHTML = '';

        const order = persisted?.favorites?.order || [];
        const lists = persisted?.favorites?.lists || {};
        const curFavId = ui.state.activeFavId;

        for (const id of order) {
          const it = lists[id];
          if (!it) continue;
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = it.name;
          if (ui.state.viewerSource === 'favorites' && id === curFavId) opt.disabled = true;
          favSelect.appendChild(opt);
        }

        if (ui.state.viewerSource === 'favorites') {
          const firstOther = order.find(x => x !== curFavId && !!lists[x]);
          favSelect.value = firstOther || (order[0] || '');
        } else {
          const def = getDefaultFavId?.() || (order[0] || '');
          favSelect.value = def || (order[0] || '');
        }
      };
      rebuildViewerFavOptions();

      const favRow = document.createElement('div');
      favRow.style.cssText = `${rowCss}`;

      const btnAdd = document.createElement('button');
      btnAdd.type = 'button';
      btnAdd.textContent = '追加';
      btnAdd.style.cssText = `${btnCss(false)} flex:1;`;

      const btnMove = document.createElement('button');
      btnMove.type = 'button';
      btnMove.textContent = '移動';
      btnMove.style.cssText = `${btnCss(true)} flex:1;`;

      const syncFavControls = () => {
        const src = ui.state.viewerSource;
        const enabled = !!favSelect.value;

        try { rebuildViewerFavOptions(); } catch {}

        const isFav = (src === 'favorites');
        const isHis = (src === 'history');
        const isFavOrHis = (isFav || isHis);

        favRow.style.display = isFavOrHis ? 'flex' : 'none';

        favSelect.disabled = !enabled;
        btnAdd.disabled = !enabled;
        btnMove.disabled = !enabled;

        if (isFav) {
          const order = persisted?.favorites?.order || [];
          const cur = ui.state.activeFavId;
          const hasOther = order.some(id => id !== cur && persisted?.favorites?.lists?.[id]);
          if (!hasOther) {
            btnAdd.disabled = true;
            btnMove.disabled = true;
            btnAdd.style.opacity = '0.55';
            btnMove.style.opacity = '0.55';
          } else {
            btnAdd.style.opacity = btnAdd.disabled ? '0.55' : '1';
            btnMove.style.opacity = btnMove.disabled ? '0.55' : '1';
          }
        } else {
          btnAdd.style.opacity = btnAdd.disabled ? '0.55' : '1';
          btnMove.style.opacity = btnMove.disabled ? '0.55' : '1';
        }
      };

      // ★お気に入り：追加（右レールのみ）
      btnAdd.addEventListener('click', () => {
        const ids = getRailIdsOrToast('選択');
        if (!ids) return;

        const to = favSelect.value;
        if (!to) return;

        const src = ui.state.viewerSource;

        if (src === 'history') {
          if (!confirm(`${ids.length} 件をお気に入りに追加しますか？`)) return;
          ui.copyPinsFromHistoryToFavorite(ids, to);

          // ★追加後：右レール（選択）を消す
          clearViewerSelectionAndRail(`追加: ${ids.length}`);

          try { ui.renderModal(true); } catch {}
          try { ui.renderViewer(true); } catch {}
          return;
        }

        const from = ui.state.activeFavId;
        if (!from) return;

        if (!confirm(`${ids.length} 件を別のお気に入りに追加しますか？`)) return;
        ui.copyPinsBetweenFavorites(ids, from, to);

        // ★追加後：右レール（選択）を消す
        clearViewerSelectionAndRail(`追加: ${ids.length}`);

        ui.renderModal?.(true);
        ui._viewerUpdateSelectedRail?.();
        try { ui.renderViewer(true); } catch {}
      });

      // ★お気に入り：移動（右レールのみ）
      btnMove.addEventListener('click', () => {
        const ids = getRailIdsOrToast('選択');
        if (!ids) return;

        const to = favSelect.value;
        if (!to) return;

        const src = ui.state.viewerSource;

        if (src === 'history') {
          if (!confirm(`${ids.length} 件をお気に入りへ移動しますか？（履歴から削除されます）`)) return;

          ui.copyPinsFromHistoryToFavorite(ids, to);

          const sid = ui.state.activeSnapId;
          const snap = sid ? persisted?.snapshots?.items?.[sid] : null;
          if (snap) {
            const del = new Set(ids);
            snap.pinIds = (snap.pinIds || []).filter(pid => !del.has(pid));
            saveStateAll(persisted);
          }

          // ★移動後：右レール（選択）を消す（＝選択済み表示が残る問題の対策）
          clearViewerSelectionAndRail(null);

          viewerToast(`移動: ${ids.length} 件`);
          try { ui.renderModal(true); } catch {}
          ui.closeViewer();
          return;
        }

        const from = ui.state.activeFavId;
        if (!from) return;

        if (!confirm(`${ids.length} 件を移動しますか？`)) return;
        ui.movePinsBetweenFavorites(ids, from, to);

        // ★移動後：右レール（選択）を消す
        clearViewerSelectionAndRail(`移動: ${ids.length}`);

        ui.renderModal?.(true);
        ui._viewerUpdateSelectedRail?.();
        try { ui.renderViewer(true); } catch {}
      });

      favRow.appendChild(btnAdd);
      favRow.appendChild(btnMove);

      favSection.appendChild(favSelect);
      favSection.appendChild(favRow);

      // =========================
      // Copy (1-row) PNG / URL
      // =========================
      const clipSection = makeSection('コピー（最後に選択した画像のみ）');
      const clipRow = document.createElement('div');
      clipRow.style.cssText = rowCss;

      const btnPng = document.createElement('button');
      btnPng.type = 'button';
      btnPng.textContent = 'PNG';
      btnPng.style.cssText = `${btnCss(false)} flex:1;`;

      const btnUrl = document.createElement('button');
      btnUrl.type = 'button';
      btnUrl.textContent = 'URL';
      btnUrl.style.cssText = `${btnCss(true)} flex:1;`;

      btnPng.addEventListener('click', async () => {
        const url = ui.state.viewerImgUrl;
        if (!url) { viewerToast('画像URLなし'); return; }
        try {
          await copyImageToClipboard_StrongPng(url);
          viewerToast('PNGコピー');
        } catch {
          try {
            await copyTextToClipboard(url);
            viewerToast('URLコピー');
          } catch {
            viewerToast('失敗');
          }
        }
      });

      btnUrl.addEventListener('click', async () => {
        const url = ui.state.viewerImgUrl || ui.state.viewerPinHref;
        if (!url) { viewerToast('URLなし'); return; }
        try {
          await copyTextToClipboard(url);
          viewerToast('URLコピー');
        } catch {
          viewerToast('失敗');
        }
      });

      clipRow.appendChild(btnPng);
      clipRow.appendChild(btnUrl);
      clipSection.appendChild(clipRow);

      // =========================
      // Download (1-row) 一括DL / この画像
      // =========================
      const dlSection = makeSection('ダウンロード（この画像=最後に選択した画像）');
      const dlRow = document.createElement('div');
      dlRow.style.cssText = rowCss;

      const btnBulkDl = document.createElement('button');
      btnBulkDl.type = 'button';
      btnBulkDl.textContent = '一括DL';
      btnBulkDl.style.cssText = `${btnCss(true)} flex:1;`;

      const btnDlThis = document.createElement('button');
      btnDlThis.type = 'button';
      btnDlThis.textContent = 'この画像';
      btnDlThis.style.cssText = `${btnCss(true)} flex:1;`;

      btnBulkDl.addEventListener('click', async () => {
        const ids = getRailIdsOrToast('選択');
        if (!ids) return;

        if (ids.length > BULK_DOWNLOAD_MAX) { viewerToast(`多すぎ（最大 ${BULK_DOWNLOAD_MAX}）`); return; }
        viewerToast(`DL開始: ${ids.length}`);
        await ui.bulkDownloadSelectedFast(ids);
      });

      btnDlThis.addEventListener('click', async () => {
        const pinId = ui.state.viewerPinId;
        const p = getPinData(pinId);
        const url = ui.state.viewerImgUrl || toHighResPinimgUrl(p.thumbUrl) || p.href;
        if (!url) { viewerToast('URLなし'); return; }
        const filename = makeDlFilename(p);
        try {
          await gmDownload(url, filename);
          viewerToast('DL完了');
        } catch {
          viewerToast('DL失敗');
        }
      });

      dlRow.appendChild(btnBulkDl);
      dlRow.appendChild(btnDlThis);
      dlSection.appendChild(dlRow);

      // =========================
      // Delete (1-row) 一括削除 / この画像
      // =========================
      const delSection = makeSection('削除（この画像=最後に選択した画像）');
      const delRow = document.createElement('div');
      delRow.style.cssText = rowCss;

      const btnBulkDel = document.createElement('button');
      btnBulkDel.type = 'button';
      btnBulkDel.textContent = '一括削除';
      btnBulkDel.style.cssText = `${btnCss(true)} flex:1;`;

      const btnDelThis = document.createElement('button');
      btnDelThis.type = 'button';
      btnDelThis.textContent = 'この画像';
      btnDelThis.style.cssText = `${btnCss(true)} flex:1;`;

      btnBulkDel.addEventListener('click', () => {
        const src = ui.state.viewerSource;
        const ids = getRailIdsOrToast('選択');
        if (!ids) return;

        if (src === 'favorites') {
          const listId = ui.state.activeFavId;
          const list = persisted?.favorites?.lists?.[listId];
          if (!list) { viewerToast('リスト不明'); return; }
          if (!confirm(`このお気に入りリストから ${ids.length} 件を削除しますか？`)) return;

          const del = new Set(ids);
          list.pinIds = (list.pinIds || []).filter(pid => !del.has(pid));
          saveStateAll(persisted);

          // ★Viewer表示にも即反映
          removeFromViewerIds(ids);

          viewerToast(`削除: ${ids.length} 件`);
          try { ui.renderModal(true); } catch {}
          try { ui._viewerUpdateSelCount?.(); } catch {}
          try { ui._viewerUpdateSelectedRail?.(); } catch {}
          try { ui.renderViewer(true); } catch {}
          return;
        }

        if (src === 'history') {
          const sid = ui.state.activeSnapId;
          const snap = sid ? persisted?.snapshots?.items?.[sid] : null;
          if (!snap) { viewerToast('履歴不明'); return; }
          if (!confirm(`この履歴から ${ids.length} 件を削除しますか？`)) return;

          const del = new Set(ids);
          snap.pinIds = (snap.pinIds || []).filter(pid => !del.has(pid));
          saveStateAll(persisted);

          // ★Viewer表示にも即反映
          removeFromViewerIds(ids);

          viewerToast(`削除: ${ids.length} 件`);
          try { ui.renderModal(true); } catch {}
          try { ui._viewerUpdateSelCount?.(); } catch {}
          try { ui._viewerUpdateSelectedRail?.(); } catch {}
          try { ui.renderViewer(true); } catch {}
          return;
        }

        viewerToast('この画面では削除未対応');
      });

      // ★「この画像」削除：必ず removeFromViewerIds で即時反映（タイル/シングル両対応）
      btnDelThis.addEventListener('click', () => {
        const src = ui.state.viewerSource;
        const pinId = ui.state.viewerPinId;
        if (!pinId) return;

        if (src === 'favorites') {
          const listId = ui.state.activeFavId;
          const list = persisted?.favorites?.lists?.[listId];
          if (!list) { viewerToast('リスト不明'); return; }
          if (!confirm('この画像をこのお気に入りリストから削除しますか？')) return;

          list.pinIds = (list.pinIds || []).filter(pid => pid !== pinId);
          saveStateAll(persisted);

          // ★Viewer表示にも即反映（右レール残骸も消す）
          removeFromViewerIds([pinId]);

          viewerToast('削除しました');
          try { ui.renderModal(true); } catch {}
          try { ui._viewerUpdateSelCount?.(); } catch {}
          try { ui._viewerUpdateSelectedRail?.(); } catch {}
          try { ui.renderViewer(true); } catch {}
          return;
        }

        if (src === 'history') {
          const sid = ui.state.activeSnapId;
          const snap = sid ? persisted?.snapshots?.items?.[sid] : null;
          if (!snap) { viewerToast('履歴不明'); return; }
          if (!confirm('この画像をこの履歴から削除しますか？')) return;

          snap.pinIds = (snap.pinIds || []).filter(pid => pid !== pinId);
          saveStateAll(persisted);

          // ★Viewer表示にも即反映（右レール残骸も消す）
          removeFromViewerIds([pinId]);

          viewerToast('削除しました');
          try { ui.renderModal(true); } catch {}
          try { ui._viewerUpdateSelCount?.(); } catch {}
          try { ui._viewerUpdateSelectedRail?.(); } catch {}
          try { ui.renderViewer(true); } catch {}
          return;
        }

        viewerToast('この画面では削除未対応');
      });

      delRow.appendChild(btnBulkDel);
      delRow.appendChild(btnDelThis);
      delSection.appendChild(delRow);

      // sidebar assemble
      sideBody.appendChild(editSection);
      sideBody.appendChild(modeSection);
      sideBody.appendChild(selSection);
      sideBody.appendChild(favSection);
      sideBody.appendChild(clipSection);
      sideBody.appendChild(dlSection);
      sideBody.appendChild(delSection);

      sidebar.appendChild(header);
      sidebar.appendChild(sideBody);

      // =========================
      // ★サイドバー開閉：状態反映 + クリック
      // =========================
      const applySidebarState = () => {
        if (ui.state.viewerSidebarOpen) {
          sidebar.style.width = '260px';
          sidebar.style.minWidth = '240px';
          sidebar.style.maxWidth = '300px';
          sidebar.style.opacity = '1';
          sidebar.style.pointerEvents = 'auto';
          sidebar.style.borderRight = '1px solid rgba(255,255,255,0.10)';

          splitBtn.textContent = '◀';
          splitBtn.title = '左サイドバーを閉じる';
        } else {
          sidebar.style.width = '0px';
          sidebar.style.minWidth = '0px';
          sidebar.style.maxWidth = '0px';
          sidebar.style.opacity = '0';
          sidebar.style.pointerEvents = 'none';
          sidebar.style.borderRight = 'none';

          splitBtn.textContent = '▶';
          splitBtn.title = '左サイドバーを開く';
        }
      };

      splitBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        ui.state.viewerSidebarOpen = !ui.state.viewerSidebarOpen;
        try { persistUIState?.(); } catch {}

        applySidebarState();
      });

      // 初期状態を反映
      applySidebarState();

      // =========================
      // Viewer pin navigation helpers
      // =========================
      const idsAllSafe = () => (ui.state.viewerIds || []).filter(Boolean);

      ui._viewerMove = (delta) => {
        const idsAll = idsAllSafe();
        if (!idsAll.length) return;

        let idx = Number(ui.state.viewerIndex ?? 0);
        if (!Number.isFinite(idx)) idx = 0;

        idx = Math.max(0, Math.min(idsAll.length - 1, idx + delta));
        const pinId = idsAll[idx];

        ui.state.viewerIndex = idx;
        ui.state.viewerPinId = pinId;

        if ((ui.state.viewerMode || 'single') === 'single') ui.state.viewerPinIdSingle = pinId;
        else ui.state.viewerPinIdTile = pinId;

        ui.renderViewer(true);
      };

      // =========================
      // Viewer content renderer（single / tile）
      // =========================
      const setCurrentPin = (pinId) => {
        const idsAll = idsAllSafe();
        if (!idsAll.length) return;

        const idx0 = idsAll.indexOf(pinId);
        const safeId = (idx0 >= 0 ? pinId : idsAll[0]);

        ui.state.viewerPinId = safeId;
        ui.state.viewerIndex = Math.max(0, idsAll.indexOf(safeId));

        if ((ui.state.viewerMode || 'single') === 'single') ui.state.viewerPinIdSingle = safeId;
        else ui.state.viewerPinIdTile = safeId;

        const p = getPinData(safeId);
        ui.state.viewerPinHref = p.href || pinUrl(safeId);
        ui.state.viewerImgUrl = toHighResPinimgUrl(p.thumbUrl) || p.thumbUrl || null;

        titleEl.textContent =
          (ui.state.viewerSource === 'favorites') ? 'お気に入り' :
          (ui.state.viewerSource === 'history') ? '履歴' :
          (ui.state.viewerSource === 'sort') ? '並び替え' : '編集';

        posEl.textContent = `${(ui.state.viewerIndex || 0) + 1} / ${idsAll.length}`;

        ui._viewerUpdateSelCount?.();
        ui._viewerUpdateSelectedRail?.();
      };

      const renderSingle = () => {
        content.innerHTML = '';
        content.style.alignItems = 'center';
        content.style.justifyContent = 'center';

        const idsAll = idsAllSafe();
        if (!idsAll.length) {
          const empty = document.createElement('div');
          empty.textContent = '対象なし';
          empty.style.cssText = 'opacity:0.8; font-weight:1000; color:#fff;';
          content.appendChild(empty);
          return;
        }

        // current pin
        const pinId = ui.state.viewerPinId || idsAll[0];
        setCurrentPin(pinId);

        const p = getPinData(pinId);
        const imgUrl = ui.state.viewerImgUrl || toHighResPinimgUrl(p.thumbUrl) || p.thumbUrl || null;

        const selSet = ui._getViewerSelectionSet?.() || new Set();
        const isSel = selSet && selSet.has && selSet.has(pinId);

        const wrap = document.createElement('div');
        wrap.style.cssText = `
          width:100%;
          height:100%;
          display:flex;
          align-items:center;
          justify-content:center;
          position:relative;
          overflow:hidden;
          border-radius: 14px;
          background: rgba(0,0,0,0.40);
          border: 1px solid rgba(255,255,255,${isSel ? '0.24' : '0.10'});
          outline:${isSel ? '3px solid rgba(150,220,255,0.50)' : 'none'};
        `;

        // ★左上バッジ
        const badge = document.createElement('div');
        badge.style.cssText = `
          position:absolute; left:10px; top:10px;
          padding:6px 10px; border-radius:999px;
          background:rgba(0,0,0,0.70);
          color:#fff;
          font-weight:900; font-size:12px;
          user-select:none;
          border: 1px solid rgba(255,255,255,0.14);
          backdrop-filter: blur(6px);
          z-index: 3;
          pointer-events: none; /* ★バッジはクリックを邪魔しない */
        `;
        badge.textContent = `❤ ${(p.countStr != null) ? p.countStr : '—'}`;

        // prev/next buttons
        const navBtnCss = `
          position:absolute;
          top:50%;
          transform: translateY(-50%);
          width: 44px;
          height: 44px;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.18);
          background: rgba(0,0,0,0.35);
          color:#fff;
          font-weight:1000;
          cursor:pointer;
          display:flex;
          align-items:center;
          justify-content:center;
          user-select:none;
          z-index: 3;
        `;

        const btnPrev = document.createElement('button');
        btnPrev.type = 'button';
        btnPrev.textContent = '⬅️';
        btnPrev.style.cssText = `${navBtnCss} left:10px;`;
        btnPrev.addEventListener('click', (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          ui._viewerMove(-1);
        });

        const btnNext = document.createElement('button');
        btnNext.type = 'button';
        btnNext.textContent = '➡️';
        btnNext.style.cssText = `${navBtnCss} right:10px;`;
        btnNext.addEventListener('click', (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          ui._viewerMove(+1);
        });

        // ★ single click delay（imgだけに付ける）
        const delayed = makeDelayedClick(
          () => {
            const src = ui.state.viewerSource;
            const cur = pinId;

            if (src === 'sort') {
              if (selectedPins && selectedPins.has(cur)) selectedPins.delete(cur);
              else (selectedPins = selectedPins || new Set(), selectedPins.add(cur));
            } else {
              const set = ui.state.modalSelectedPinIds || new Set();
              if (set.has(cur)) set.delete(cur);
              else set.add(cur);
              ui.state.modalSelectedPinIds = set;
              ui.state.modalSelectedPinId = cur;
              ui.state.modalLastClickedPinId = cur;
              try { ui._rerenderModalPreviewIfAny?.(); } catch {}
              try { ui._updateModalRightCount?.(); } catch {}
            }

            ui._viewerUpdateSelCount?.();
            ui._viewerUpdateSelectedRail?.();
            viewerToast('選択切替');

            // ★選択枠などの更新
            ui.renderViewer(true);
          },
          () => {
            // dblclick = タイルに戻る（今の仕様維持）
            try {
              const cur = ui.state.viewerPinId;
              rememberCurrentPinForMode();
              ui.state.viewerMode = 'tile';
              ui.state.viewerPinIdTile = cur || ui.state.viewerPinIdTile;
              restoreCurrentPinForMode();
              syncModeButtons();
              ui.renderViewer(true);
              viewerToast('タイルに戻りました');
            } catch {}
          }
        );

        if (imgUrl) {
          const img = document.createElement('img');
          img.draggable = false;
          img.src = imgUrl;
          img.alt = '';
          img.style.cssText = `
            max-width: 100%;
            max-height: 100%;
            width: auto;
            height: auto;
            object-fit: contain;
            display:block;
            user-select:none;
            -webkit-user-drag:none;
            cursor: pointer;
          `;

          // ★重要：img以外クリックでは選択させない
          img.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            delayed.click(ev);
          });

          img.addEventListener('dblclick', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            delayed.dblclick(ev);
          });

          wrap.appendChild(img);
          wrap.appendChild(badge);
        } else {
          const no = document.createElement('div');
          no.textContent = 'No img';
          no.style.cssText = 'opacity:0.75; font-weight:1000; color:#fff;';
          wrap.appendChild(no);
          wrap.appendChild(badge);
        }

        wrap.appendChild(btnPrev);
        wrap.appendChild(btnNext);

        content.appendChild(wrap);
      };

      const renderTile = () => {
        content.innerHTML = '';
        content.style.alignItems = 'stretch';
        content.style.justifyContent = 'stretch';

        const idsAll = idsAllSafe();
        if (!idsAll.length) {
          const empty = document.createElement('div');
          empty.textContent = '対象なし';
          empty.style.cssText = 'opacity:0.8; font-weight:1000; color:#fff;';
          content.appendChild(empty);
          return;
        }

        // ★tile表示前にまとめて補完（欠損率を下げる）
        hydrateMany(idsAll);

        // current pin（tile用を優先）
        restoreCurrentPinForMode();
        const pinId = ui.state.viewerPinId || idsAll[0];
        setCurrentPin(pinId);

        const grid = document.createElement('div');
        grid.id = 'pt-viewer-grid';  // ★このIDの中だけホイールOKにする
        grid.style.cssText = `
          width: 100%;
          height: 100%;
          overflow: auto;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
          gap: 10px;
          padding: 6px;
          overscroll-behavior: contain;
        `;

        const selSet = ui._getViewerSelectionSet?.() || new Set();

        for (const id of idsAll) {
          const p = getPinData(id);

          const item = document.createElement('div');
          const isSel = selSet && selSet.has && selSet.has(id); // ★選択だけを見る（isCurは廃止）

          item.style.cssText = `
            border-radius: 12px;
            overflow:hidden;
            border:1px solid rgba(255,255,255,${isSel ? '0.30' : '0.12'});
            outline:${isSel ? '3px solid rgba(150,220,255,0.50)' : 'none'};
            background: rgba(0,0,0,0.45);
            cursor:pointer;
            position:relative;
            height: 240px;
          `;

          const imgWrap = document.createElement('div');
          imgWrap.style.cssText = `width:100%; height:100%; position:relative; background: rgba(255,255,255,0.06);`;
          if (p.thumbUrl) {
            const im = document.createElement('img');
            im.src = p.thumbUrl;
            im.draggable = false;
            im.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block;';
            imgWrap.appendChild(im);
          } else {
            const t = document.createElement('div');
            t.textContent = 'No img';
            t.style.cssText = 'opacity:0.7; font-weight:900; padding:8px; color:#fff;';
            imgWrap.appendChild(t);
          }

          const badge = document.createElement('div');
          badge.style.cssText = `
            position:absolute; left:8px; top:8px;
            padding:4px 8px; border-radius:999px;
            background:rgba(0,0,0,0.70);
            color:#fff;
            font-weight:900; font-size:11px;
            user-select:none;
            border: 1px solid rgba(255,255,255,0.14);
            backdrop-filter: blur(6px);
          `;
          badge.textContent = `❤ ${(p.countStr != null) ? p.countStr : '—'}`;
          imgWrap.appendChild(badge);

          // ★タイルも single click 遅延（ダブルクリック時に最初の選択が入らない）
          const delayed = makeDelayedClick(
            () => {
              // single click = 現在表示を切り替える（選択のトグルも同時にやる）
              setCurrentPin(id);

              // 選択トグル
              const src = ui.state.viewerSource;
              if (src === 'sort') {
                if (selectedPins && selectedPins.has(id)) selectedPins.delete(id);
                else (selectedPins = selectedPins || new Set(), selectedPins.add(id));
              } else {
                const set = ui.state.modalSelectedPinIds || new Set();
                if (set.has(id)) set.delete(id);
                else set.add(id);
                ui.state.modalSelectedPinIds = set;
                ui.state.modalSelectedPinId = id;
                ui.state.modalLastClickedPinId = id;
                try { ui._rerenderModalPreviewIfAny?.(); } catch {}
                try { ui._updateModalRightCount?.(); } catch {}
              }

              ui._viewerUpdateSelCount?.();
              ui._viewerUpdateSelectedRail?.();

              // tileは grid 自体を再描画（枠/アウトラインを更新）
              // ★スクロール位置を保持して「先頭ジャンプ」を防ぐ
              const g0 = document.getElementById('pt-viewer-grid');
              const top0 = g0 ? g0.scrollTop : 0;

              ui.renderViewer(true);

              requestAnimationFrame(() => {
                const g1 = document.getElementById('pt-viewer-grid');
                if (g1) g1.scrollTop = top0;
              });
            },
            () => {
              // double click = シングルへ切替して開く
              rememberCurrentPinForMode();
              ui.state.viewerMode = 'single';
              ui.state.viewerPinIdSingle = id;
              ui.state.viewerPinId = id;
              ui.state.viewerIndex = Math.max(0, idsAll.indexOf(id));
              syncModeButtons();
              ui.renderViewer(true);
            }
          );

          item.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            delayed.click(ev);
          });

          item.addEventListener('dblclick', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            delayed.dblclick(ev);
          });

          item.appendChild(imgWrap);
          grid.appendChild(item);
        }

        content.appendChild(grid);

        // ★右レールクリック等で “今のpin” が更新された場合、タイルでもそこまでスクロールしてジャンプを体感できるようにする
        try {
          const cur = ui.state.viewerPinId;
          if (cur) {
            const idx = idsAll.indexOf(cur);
            if (idx >= 0) {
              const el = grid.children && grid.children[idx] ? grid.children[idx] : null;
              if (el && el.scrollIntoView) {
                el.scrollIntoView({ block: 'center', inline: 'nearest' });
              }
            }
          }
        } catch {}
      };

      // ★viewer renderer 本体
      ui.renderViewer = (forceRender = false) => {
        try {
          if (!ui.state.viewerOpen) return;

          const idsAll = idsAllSafe();
          if (!idsAll.length) {
            content.innerHTML = '<div style="opacity:0.8;font-weight:1000;color:#fff;">対象なし</div>';
            ui._viewerUpdateSelCount?.();
            ui._viewerUpdateSelectedRail?.();
            return;
          }

          // 現在pinの整合
          restoreCurrentPinForMode();
          const cur = ui.state.viewerPinId || idsAll[0];
          setCurrentPin(cur);

          // 描画
          const m = ui.state.viewerMode || 'single';
          if (m === 'tile') renderTile();
          else renderSingle();

          // 右レール＆件数を確実更新
          ui._viewerUpdateSelCount?.();
          ui._viewerUpdateSelectedRail?.();

          // 左のfav系ボタン状態
          try { syncFavControls?.(); } catch {}
        } catch (e) {
          console.error('[viewer render] error', e);
          viewerToast('viewer render error（console参照）');
        }
      };

      // =========================
      // mount
      // =========================
      panel.appendChild(sidebar);
      panel.appendChild(splitter); // ★追加：開閉用
      panel.appendChild(main);
      viewer.appendChild(panel);
      mount.appendChild(viewer);

      // 初期同期
      try { syncFavControls?.(); } catch {}
      try { syncFavControls(); } catch {}
      try { syncModeButtons(); } catch {}
      try { ui._viewerUpdateSelectedRail?.(); } catch {}
      try { ui._viewerUpdateSelCount?.(); } catch {}
      try { viewerToastEl.style.opacity = '0'; } catch {}

      // 初回描画
      try { ui.renderViewer(true); } catch {}
    },

    // ★viewerが操作する「選択Set」を取得（置換版：常に “安全な Set” を返す）
    _getViewerSelectionSet() {
      try {
        const src = ui.state.viewerSource;
        if (src === 'sort') {
          return (typeof selectedPins !== 'undefined' ? (selectedPins || new Set()) : new Set());
        }
        // favorites/history はモーダル選択を使う
        return ui.state.modalSelectedPinIds || new Set();
      } catch {
        return new Set();
      }
    },

    // ★viewerの前後移動（ホイール用）
    _viewerMove(delta) {
      const ids = ui.state.viewerIds || [];
      if (!ids.length) return;

      let idx = ui.state.viewerIndex;
      if (!Number.isFinite(idx) || idx < 0) idx = ids.indexOf(ui.state.viewerPinId);
      if (idx < 0) idx = 0;

      const next = idx + delta;
      if (next < 0 || next >= ids.length) return; // 端で止める（ループしたければここ変更）

      const pinId = ids[next];
      ui.state.viewerIndex = next;

      const p = pinStore.get(pinId) || { pinId, thumbUrl: null, href: pinUrl(pinId), countStr: null, countNum: null };
      ui.state.viewerPinId = pinId;
      ui.state.viewerImgUrl = toHighResPinimgUrl(p.thumbUrl) || null;
      ui.state.viewerPinHref = p.href || pinUrl(pinId);
      ui.state.viewerCountStr = p.countStr;

      ui.renderViewer(true);
    },

    // =========================================================
    // Favorites -> Favorites: 追加（コピー）
    // =========================================================
    copyPinsBetweenFavorites(pinIds, fromFavId, toFavId) {
      const ids = (pinIds || []).filter(Boolean);
      if (!ids.length) { ui.toast('追加する画像がありません'); return; }
      if (!fromFavId || !toFavId) { ui.toast('リストIDが不明です'); return; }
      if (fromFavId === toFavId) { ui.toast('同じリストには追加できません'); return; }

      const from = persisted?.favorites?.lists?.[fromFavId];
      const to   = persisted?.favorites?.lists?.[toFavId];
      if (!from || !to) { ui.toast('お気に入りリストが不明です'); return; }

      const existing = new Set(to.pinIds || []);
      let added = 0;
      for (const id of ids) {
        if (!existing.has(id)) {
          to.pinIds.push(id);
          existing.add(id);
          added++;
        }
      }

      saveStateAll(persisted);

      // 選択解除（安全）
      ui.state.modalSelectedPinIds = new Set();
      ui.state.modalSelectedPinId = null;
      ui.state.modalLastClickedPinId = null;

      ui.toast(`お気に入りに追加: ${added} 件`);
    },

    // =========================================================
    // Favorites -> Favorites: 移動（追加＋元から削除）
    // =========================================================
    movePinsBetweenFavorites(pinIds, fromFavId, toFavId) {
      const ids = (pinIds || []).filter(Boolean);
      if (!ids.length) { ui.toast('移動する画像がありません'); return; }
      if (!fromFavId || !toFavId) { ui.toast('リストIDが不明です'); return; }
      if (fromFavId === toFavId) { ui.toast('同じリストには移動できません'); return; }

      const from = persisted?.favorites?.lists?.[fromFavId];
      const to   = persisted?.favorites?.lists?.[toFavId];
      if (!from || !to) { ui.toast('お気に入りリストが不明です'); return; }

      const set = new Set(ids);

      // ① 先に追加（重複除外）
      const existing = new Set(to.pinIds || []);
      let added = 0;
      for (const id of ids) {
        if (!existing.has(id)) {
          to.pinIds.push(id);
          existing.add(id);
          added++;
        }
      }

      // ② 元から削除
      from.pinIds = (from.pinIds || []).filter(pid => !set.has(pid));

      saveStateAll(persisted);

      ui.syncViewerAfterFavoritesChanged(fromFavId, ids);

      // 選択解除（安全）
      ui.state.modalSelectedPinIds = new Set();
      ui.state.modalSelectedPinId = null;
      ui.state.modalLastClickedPinId = null;

      ui.toast(`お気に入りを移動: ${set.size} 件（追加 ${added} 件）`);
    },

    // =========================================================
    // History -> Favorites コピー（履歴は残す）
    // =========================================================
    copyPinsFromHistoryToFavorite(pinIds, targetFavId) {
      if (!pinIds || !pinIds.length) {
        ui.toast('コピーする画像がありません');
        return;
      }

      const favList = persisted?.favorites?.lists?.[targetFavId];
      if (!favList) {
        ui.toast('お気に入りリストが不明です');
        return;
      }

      const set = new Set(pinIds);

      // ★ お気に入りに追加（重複除外）
      const existing = new Set(favList.pinIds || []);
      let added = 0;
      for (const id of set) {
        if (!existing.has(id)) {
          favList.pinIds.push(id);
          added++;
        }
      }

      saveStateAll(persisted);

      // ★ 選択解除（履歴は残す）
      ui.state.modalSelectedPinIds = new Set();
      ui.state.modalSelectedPinId = null;
      ui.state.modalLastClickedPinId = null;

      ui.toast(`お気に入りに追加: ${added} 件`);
      ui.renderModal(true);
    },

    // =========================================================
    // Shared: same logic as modal right preview (renderVS)
    // - always hydrate from persisted
    // - read pinStore
    // - draw p.thumbUrl as-is (no toHighRes, no state.viewerImgUrl)
    // =========================================================
    _buildPreviewLikeNode(pinId, opt = {}) {
    const id = pinId;
    if (!id) return document.createElement('div');

    try { _hydrateFromPersisted(id); } catch {}

    const p = pinStore.get(id) || { pinId: id, thumbUrl: null, href: pinUrl(id), countStr: null, countNum: null };

    const root = document.createElement('div');
    root.style.cssText = opt.rootCss || 'width:100%; height:100%; position:relative;';

    // (renderVS と同じ) 画像枠
    const img = document.createElement('div');
    img.style.cssText = opt.imgBoxCss || 'width:100%; height:100%; background: rgba(255,255,255,0.08); position:relative;';

    if (p.thumbUrl) {
        const im = document.createElement('img');
        im.src = p.thumbUrl; // ★右側プレビューと同じ（thumbUrl直）
        im.loading = opt.loading || 'lazy';
        im.alt = `pin ${id}`;
        im.style.cssText = opt.imgCss || 'width:100%; height:100%; object-fit:cover; display:block;';
        img.appendChild(im);
    } else {
        const t = document.createElement('div');
        t.textContent = 'No img'; // ★右側プレビューと同じ
        t.style.cssText = opt.noImgCss || 'opacity:0.7; font-weight:900; padding:8px; color:#fff;';
        img.appendChild(t);
    }

    // (renderVS と同じ) ❤バッジ
    const badge = document.createElement('div');
    badge.style.cssText = opt.badgeCss || `
        position:absolute; left:8px; top:8px;
        padding:4px 8px; border-radius:999px;
        background:rgba(0,0,0,0.70); font-weight:900; font-size:11px; color:#fff;
        border: 1px solid rgba(255,255,255,0.12);
        backdrop-filter: blur(6px);
        pointer-events:none;
    `;
    badge.textContent = `❤ ${(p.countStr != null) ? p.countStr : '—'}`;

    img.appendChild(badge);
    root.appendChild(img);

    return root;
    },

    renderViewer(force = false) {

    // =========================================================
    // ★Viewer描画前の強制hydrateフェーズ（毎回）
    // =========================================================
    const preHydrateViewer = () => {
        const ids = (ui.state.viewerIds || []).filter(Boolean);
        for (const id of ids) {
        try { _hydrateFromPersisted(id); } catch {}
        }
    };

    // ★開いてないなら何もしない
    if (!ui.state.viewerOpen) return;

    // ★DOMに触る前に必ず hydrate（これが「表示直前に毎回」）
    try { preHydrateViewer(); } catch {}

    // ★Viewer DOM を保証
    ui.ensureViewer();

    const title = document.getElementById('pt-viewer-title');
    const posEl = document.getElementById('pt-viewer-pos');
    const content = document.getElementById('pt-viewer-content');
    if (!title || !posEl || !content) return;

    const mode = ui.state.viewerMode || 'single'; // 'single' | 'tile'
    const pinId = ui.state.viewerPinId;

    const ids = (ui.state.viewerIds || []).filter(Boolean);
    let idx = ui.state.viewerIndex;
    if (!Number.isFinite(idx) || idx < 0) idx = ids.indexOf(pinId);

    // =========================================================
    // ★タイトル（renderVSと同じ：pinStore優先）
    // =========================================================
    let curP = null;
    if (pinId) {
        try { _hydrateFromPersisted(pinId); } catch {}
        curP = pinStore.get(pinId) || null;
    }
    const count = (curP && curP.countStr != null) ? curP.countStr : '—';
    title.textContent = `❤ ${count}`;

    // position 表示（タイル時は件数）
    if (mode === 'tile') {
        posEl.textContent = `${ids.length} 件`;
    } else {
        const posText = (ids.length && idx >= 0) ? `${idx + 1} / ${ids.length}` : '— / —';
        posEl.textContent = posText;
    }

    // 選択数表示を更新
    try { ui._viewerUpdateSelCount?.(); } catch {}

    // ---- main ----
    content.innerHTML = '';

    // =========================================================
    // TILE MODE（★右側プレビュー(renderVS)をそのまま移植）
    // =========================================================
    if (mode === 'tile') {

        // content 自体は “枠” にして、実スクロールは vsWrap に任せる（右側プレビュー式）
        content.style.alignItems = 'stretch';
        content.style.justifyContent = 'flex-start';
        content.style.overflowY = 'hidden'; // ★ここが重要：二重スクロールを防ぐ
        content.style.overflowX = 'hidden';

        // --- Viewerタイル（仮想スクロール） ---
        const gridWrap = document.createElement('div');
        gridWrap.style.cssText = `
        flex: 1;
        overflow: hidden;
        padding-top: 6px;
        position: relative;
        min-height: 0;
        width: 100%;
        `;

        const vsWrap = document.createElement('div');
        vsWrap.style.cssText = `
        position:relative;
        width:100%;
        height:100%;
        overflow-y:auto;
        overflow-x:hidden;
        padding:0;
        scrollbar-gutter: stable;
        `;

        const vsInner = document.createElement('div');
        vsInner.style.cssText = `
        position:relative;
        width:100%;
        overflow-x:hidden;
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
        content.appendChild(gridWrap);

        // 右側プレビューと同等の定数（必要なら調整してOK）
        const CARD_MIN_W = 160;     // Viewerは少し大きめで（右側は120）
        const GAP = 12;

        // ★縦長化：renderFavoritesManager寄せ（2:3想定）
        const CARD_ASPECT_H_PER_W = 1.5;  // height = width * 1.5  → 2:3
        const CARD_MIN_H = 220;           // 小さすぎる時の下限
        const CARD_MAX_H = 520;           // 大きすぎる時の上限

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

        const CLICK_DELAY_MS = 180;

        const renderVS = (forceVS = false) => {
        const idsNow = (ui.state.viewerIds || []).filter(Boolean);

        const { cols, cardW } = computeCols();
        const cardH = Math.max(
        CARD_MIN_H,
        Math.min(CARD_MAX_H, Math.round(cardW * CARD_ASPECT_H_PER_W))
        );

        const totalRows = Math.ceil(idsNow.length / cols);
        const rowH = cardH + GAP;
        const fullH = Math.max(0, totalRows * rowH);
        spacer.style.height = `${fullH}px`;

        const top = vsWrap.scrollTop;
        const vh = vsWrap.clientHeight;

        const firstRow = Math.max(0, Math.floor(top / rowH) - OVERSCAN_ROWS);
        const lastRow = Math.min(totalRows - 1, Math.floor((top + vh) / rowH) + OVERSCAN_ROWS);

        const startIdx = firstRow * cols;
        const endIdx = Math.min(idsNow.length - 1, (lastRow + 1) * cols - 1);

        // ★Viewerは「選択Set」をキーに含める（重いのでサイズだけ）
        const selSet = ui._getViewerSelectionSet?.();
        const selSize = selSet ? selSet.size : 0;

        // 現在pinIdもキーへ（枠表示などが変わる）
        const curId = ui.state.viewerPinId || '';

        const key = `${idsNow.length}|${cols}|${cardW}|${cardH}|${firstRow}|${lastRow}|${selSize}|${curId}`;

        if (!forceVS && key === _lastKey && Math.abs(top - _lastTop) < 2) return;
        _lastKey = key;
        _lastTop = top;

        clearVS();

        const frag = document.createDocumentFragment();

        for (let i = startIdx; i <= endIdx; i++) {
            const id = idsNow[i];
            try { _hydrateFromPersisted(id); } catch {}
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
            item.setAttribute('data-pt-viewer-item', '1');
            item.setAttribute('data-pin-id', id);

            // ★Viewerの選択状態（Set）で枠を出す
            const sel = ui._getViewerSelectionSet?.();
            const selected = !!(sel && sel.has(id));

            item.style.cssText = `
            width:100%;
            height:100%;
            border-radius:12px;
            overflow:hidden;
            border:1px solid rgba(255,255,255,${selected ? '0.30' : '0.12'});
            outline:${selected ? '3px solid rgba(150,220,255,0.55)' : 'none'};
            box-shadow:${selected ? '0 0 0 2px rgba(150,220,255,0.10), 0 0 14px rgba(120,200,255,0.10)' : 'none'};
            background: rgba(0,0,0,0.45);
            cursor:pointer;
            position:relative;
            user-select:none;
            `;

            // ★click / dblclick の誤爆防止（右側プレビュー式）
            let _clickTimer = null;

            item.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            if (_clickTimer) clearTimeout(_clickTimer);
            _clickTimer = setTimeout(() => {
                _clickTimer = null;

                const set = ui._getViewerSelectionSet?.();
                if (!set) return;

                if (set.has(id)) set.delete(id);
                else set.add(id);

                try { ui._updateModalRightCount?.(); } catch {}
                try { ui._rerenderModalPreviewIfAny?.(); } catch {}
                try { ui._viewerUpdateSelCount?.(); } catch {}
                try { ui._viewerUpdateSelectedRail?.(); } catch {}

                // ★Viewer側タイルを再描画
                renderVS(true);

                // ★タイトル/posなども更新したいので Viewer全体も更新
                //   ※ただし無限ループ回避のため、次フレームで
                requestAnimationFrame(() => {
                try { ui.renderViewer(true); } catch {}
                });
            }, CLICK_DELAY_MS);
            });

            item.addEventListener('dblclick', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            if (_clickTimer) {
                clearTimeout(_clickTimer);
                _clickTimer = null;
            }

            // ★Viewer内で single に遷移（openViewerは呼ばない）
            ui.state.viewerPinId = id;
            ui.state.viewerIndex = i;
            ui.state.viewerMode = 'single';

            ui.renderViewer(true);
            });

            // --- 画像枠（右側プレビューと同一構造） ---
            const img = document.createElement('div');
            img.style.cssText = 'width:100%; height:100%; background: rgba(255,255,255,0.08); position:relative;';

            if (p.thumbUrl) {
            const im = document.createElement('img');
            im.src = p.thumbUrl;
            im.draggable = false;
            im.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block; user-select:none; -webkit-user-drag:none;';
            img.appendChild(im);
            } else {
            const t = document.createElement('div');
            t.textContent = 'No img';
            t.style.cssText = 'opacity:0.7; font-weight:900; padding:8px; color:#fff;';
            img.appendChild(t);
            }

            const badge = document.createElement('div');
            badge.style.cssText = `
            position:absolute; left:8px; top:8px;
            padding:4px 8px; border-radius:999px;
            background:rgba(0,0,0,0.70); font-weight:900; font-size:11px; color:#fff;
            border: 1px solid rgba(255,255,255,0.12);
            backdrop-filter: blur(6px);
            pointer-events:none;
            `;
            badge.textContent = `❤ ${(p.countStr != null) ? p.countStr : '—'}`;
            img.appendChild(badge);

            item.appendChild(img);
            holder.appendChild(item);
            frag.appendChild(holder);
        }

        vsInner.appendChild(frag);

        // ★Viewer側も外部から「再描画して」と呼べるようにする（互換）
        ui._rerenderViewerTileIfAny = () => {
            try { renderVS(true); } catch {}
        };
        };

        // scroll / resize
        vsWrap.addEventListener('scroll', () => renderVS(false));
        try {
        _ro = new ResizeObserver(() => renderVS(true));
        _ro.observe(vsWrap);
        } catch {}

        // ---- first paint ----
        requestAnimationFrame(() => {
        try { renderVS(true); } catch {}
        });

        // rail 更新
        try { ui._viewerUpdateSelectedRail?.(); } catch {}
        return;
    }

    // =========================================================
    // SINGLE MODE（あなたの現行のまま：buildPreviewLikeNode + 枠 + click toggle）
    // =========================================================
    content.style.alignItems = 'center';
    content.style.justifyContent = 'center';
    content.style.overflow = 'hidden';
    content.style.overflowX = 'hidden';
    content.style.overflowY = 'hidden';

    const wrap = document.createElement('div');
    wrap.style.cssText = `
        position: relative;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
    `;

    // ★singleも右側プレビューと同じ “thumbUrl直描画”
    // ただし表示は contain（見せ方だけ変更）
    if (pinId) {
        try { _hydrateFromPersisted(pinId); } catch {}
    }

    const node = ui._buildPreviewLikeNode(pinId, {
        rootCss: 'width:100%; height:100%; position:relative;',
        imgBoxCss: 'width:100%; height:100%; background: rgba(255,255,255,0.08); position:relative;',
        imgCss: `
        width:100%;
        height:100%;
        object-fit:contain;
        display:block;
        user-select:none;
        -webkit-user-drag:none;
        `,
    });

    // 選択時の枠（あなたの現行UI踏襲）
    const set = ui._getViewerSelectionSet?.();
    const isSelected = set && pinId && set.has(pinId);

    node.style.borderRadius = '12px';
    node.style.border = `1px solid rgba(255,255,255,${isSelected ? '0.30' : '0.12'})`;
    node.style.outline = isSelected ? '3px solid rgba(150,220,255,0.55)' : 'none';
    node.style.boxShadow = isSelected ? '0 0 0 2px rgba(150,220,255,0.10), 0 0 18px rgba(120,200,255,0.10)' : 'none';
    node.style.background = 'rgba(0,0,0,0.25)';
    node.style.cursor = 'pointer';

    node.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const pid = ui.state.viewerPinId;
        if (!pid) return;

        const sel = ui._getViewerSelectionSet();
        if (sel.has(pid)) sel.delete(pid);
        else sel.add(pid);

        try { ui._updateModalRightCount?.(); } catch {}
        try { ui._rerenderModalPreviewIfAny?.(); } catch {}
        try { ui._viewerUpdateSelCount?.(); } catch {}

        ui.renderViewer(true);
    });

    node.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();

        ui.state.viewerMode = 'tile';
        ui.renderViewer(true);
    });

    wrap.appendChild(node);
    content.appendChild(wrap);

    // rail 更新
    try { ui._viewerUpdateSelectedRail?.(); } catch {}
    },

    renderHelpManager(bodyEl) {
      // =========================
      // Left open/close (Favorites/Historyと同じ)
      // =========================
      if (ui.state.modalLeftOpen == null) ui.state.modalLeftOpen = true;

      // =========================
      // Help left menu selection
      // =========================
      if (!ui.state.helpLeft) ui.state.helpLeft = 'backup'; // 'backup' | 'update' | 'tips'

      // =========================
      // Update check state (cache)
      // =========================
      if (!ui.state.updateCheck) ui.state.updateCheck = {};
      // ui.state.updateCheck = { ts, latestVersion, updateNeeded, error }

      const getLocalVersion = () => {
        try {
          if (typeof GM_info !== 'undefined' && GM_info?.script?.version) return String(GM_info.script.version);
        } catch {}
        return '0.0.0';
      };

      // ★初回描画で非同期チェック（UIをブロックしない）
      // （ローカル関数は廃止し、ui.ensureUpdateCheck に統一）
      try { ui.ensureUpdateCheck(false); } catch {}

      const updateNeeded = !!ui.state.updateNeeded;

      // ---- layout root ----
      bodyEl.innerHTML = '';
      bodyEl.style.cssText = `
        display:flex;
        width:100%;
        height:100%;
        min-height:0;
        gap:0;
      `;

      // =========================================================
      // Left
      // =========================================================
      const left = document.createElement('div');
      left.style.cssText = `
        width: 320px;
        border-right: 1px solid rgba(255,255,255,0.10);
        padding: 12px;
        display:flex;
        flex-direction:column;
        gap: 10px;
        overflow:hidden;
        min-height:0;
        background: rgba(0,0,0,0.18);

        transition:
          width 300ms cubic-bezier(.2,.8,.2,1),
          flex-basis 300ms cubic-bezier(.2,.8,.2,1),
          padding 220ms ease,
          opacity 180ms ease;
      `;

      // =========================================================
      // Right
      // =========================================================
      const right = document.createElement('div');
      right.style.cssText = `
        flex:1;
        padding: 12px;
        display:flex;
        flex-direction:column;
        gap: 12px;
        overflow:hidden;
        min-height:0;
      `;

      // =========================================================
      // Splitter + Toggle (Favorites/Historyと同じ)
      // =========================================================
      const splitter = document.createElement('div');
      splitter.style.cssText = `
        width: 12px;
        position: relative;
        flex: 0 0 12px;
        user-select:none;
        background: rgba(255,255,255,0.02);

        transition: background 120ms ease;
        z-index: 5;
        pointer-events: auto;
      `;

      const splitBtn = document.createElement('button');
      splitBtn.type = 'button';
      splitBtn.textContent = ui.state.modalLeftOpen ? '◀' : '▶';
      splitBtn.title = ui.state.modalLeftOpen ? '左メニューを閉じる' : '左メニューを開く';
      splitBtn.style.cssText = `
        position:absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        padding: 6px 4px;
        border: none;
        background: transparent;
        color: rgba(255,255,255,0.85);
        font-size: 18px;
        font-weight: 900;
        cursor: pointer;
        z-index: 2;
        line-height: 1;
      `;

      splitter.addEventListener('mouseenter', () => {
        splitter.style.background = 'rgba(255,255,255,0.06)';
      });
      splitter.addEventListener('mouseleave', () => {
        splitter.style.background = 'rgba(255,255,255,0.02)';
      });

      const applyLeftState = () => {
        if (ui.state.modalLeftOpen) {
          left.style.width = '320px';
          left.style.flexBasis = '320px';
          left.style.padding = '12px';
          left.style.opacity = '1';
          left.style.pointerEvents = 'auto';

          splitBtn.textContent = '◀';
          splitBtn.title = '左メニューを閉じる';
        } else {
          left.style.width = '0px';
          left.style.flexBasis = '0px';
          left.style.padding = '12px 0';
          left.style.opacity = '0';
          left.style.pointerEvents = 'none';

          splitBtn.textContent = '▶';
          splitBtn.title = '左メニューを開く';
        }
      };

      splitBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        ui.state.modalLeftOpen = !ui.state.modalLeftOpen;
        persistUIState();

        applyLeftState();
      });

      splitter.appendChild(splitBtn);

      // =========================================================
      // Left: Title + Nav buttons
      // =========================================================
      const leftTitleRow = document.createElement('div');
      leftTitleRow.style.cssText = 'display:flex; gap:8px; align-items:center;';

      const leftTitle = document.createElement('div');
      leftTitle.textContent = 'ヘルプ';
      leftTitle.style.cssText = 'flex:1; font-weight:1000; opacity:0.95;';

      leftTitleRow.appendChild(leftTitle);
      left.appendChild(leftTitleRow);

      const mkNavBtn = (key, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = ui.buttonCss(ui.state.helpLeft !== key);
        b.style.width = '100%';
        b.style.textAlign = 'left';
        b.addEventListener('click', () => {
          ui.state.helpLeft = key;
          persistUIState();
          ui.renderModal(true);
        });
        return b;
      };

      left.appendChild(mkNavBtn('backup', 'バックアップ'));
      left.appendChild(mkNavBtn('update', updateNeeded ? '⚠️アップデート' : 'アップデート'));
      left.appendChild(mkNavBtn('tips', '便利な使い方'));

      // =========================================================
      // Right: Helpers
      // =========================================================
      const mkCard = (titleText) => {
        const card = document.createElement('div');
        card.style.cssText = `
          background: rgba(0,0,0,0.40);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 14px;
          padding: 12px;
          display:flex;
          flex-direction:column;
          gap:10px;
        `;
        const h = document.createElement('div');
        h.textContent = titleText;
        h.style.cssText = 'font-weight:1000; opacity:0.95;';
        card.appendChild(h);
        return card;
      };

      // =========================================================
      // Right: Content
      // =========================================================

      // -------------------------
      // Backup (既存バックアップUI)
      // -------------------------
      if (ui.state.helpLeft === 'backup') {
        const wrap = document.createElement('div');
        wrap.style.cssText = `
          display:flex;
          flex-direction:column;
          gap:12px;
          overflow:auto;
          min-height:0;
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
        desc.style.cssText = 'opacity:0.85; font-weight:800; line-height:1.5; white-space:pre-wrap;';
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

        rowBtns.appendChild(btnExport);
        rowBtns.appendChild(btnImport);

        section.appendChild(h);
        section.appendChild(desc);
        section.appendChild(rowBtns);

        const note = document.createElement('div');
        note.style.cssText =
          'opacity:0.75; font-weight:800; line-height:1.5; padding: 2px 2px; white-space:pre-wrap;';
        note.textContent =
          '※ インポート後、表示が古い場合は「お気に入り / 履歴」タブに戻って確認してください。\n' +
          '※ Pinterestページの再読み込みは不要です。';

        wrap.appendChild(section);
        wrap.appendChild(note);

        right.appendChild(wrap);
      }

      // -------------------------
      // Update（文言最終調整 + 再チェック）
      // -------------------------
      if (ui.state.helpLeft === 'update') {
        const card = mkCard(updateNeeded ? '⚠️アップデート' : 'アップデート');

        const localV = getLocalVersion();
        const dlUrl =
          (typeof GM_info !== 'undefined' && GM_info?.script?.downloadURL)
            ? GM_info.script.downloadURL
            : 'https://raw.githubusercontent.com/asakura-youtube/pinterest-pin-manager/main/pinterest-pin-manager.user.js';

        const latestV = ui.state.latestVersion || ui.state.updateCheck.latestVersion || null;
        const err = ui.state.updateCheck.error || null;
        const lastTs = ui.state.updateCheck.ts || 0;
        const lastStr = lastTs ? new Date(lastTs).toLocaleString() : null;

        const desc = document.createElement('div');
        desc.style.cssText = 'opacity:0.85; font-weight:800; line-height:1.65; white-space:pre-wrap;';

        if (err) {
          desc.textContent =
            `現在のバージョン: ${localV}\n` +
            `最新版チェック: 失敗（${err}）\n` +
            (lastStr ? `最終チェック: ${lastStr}\n\n` : '\n') +
            `更新する場合は、下の「更新用URLを開く」→（Tampermonkeyの画面で）インストール/更新してください。`;
        } else if (!latestV) {
          desc.textContent =
            `現在のバージョン: ${localV}\n` +
            `最新版チェック: 実行中...\n\n` +
            `更新する場合は、下の「更新用URLを開く」→（Tampermonkeyの画面で）インストール/更新してください。`;
        } else if (updateNeeded) {
          desc.textContent =
            `現在のバージョン: ${localV}\n` +
            `最新版: ${latestV}\n\n` +
            `⚠️ 更新があります。\n` +
            `下の「更新用URLを開く」→（Tampermonkeyの画面で）「上書き」を押してください。`;
        } else {
          desc.textContent =
            `現在のバージョン: ${localV}\n` +
            `最新版: ${latestV}\n` +
            (lastStr ? `最終チェック: ${lastStr}\n\n` : '\n') +
            `✅ 最新です。`;
        }

        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

        const btnOpenRaw = document.createElement('button');
        btnOpenRaw.type = 'button';
        btnOpenRaw.textContent = '更新用URLを開く';
        btnOpenRaw.style.cssText = ui.buttonCss(false);
        btnOpenRaw.addEventListener('click', () => {
          try { window.open(dlUrl, '_blank', 'noopener'); } catch {}
        });

        const btnRecheck = document.createElement('button');
        btnRecheck.type = 'button';
        btnRecheck.textContent = '最新版を再チェック';
        btnRecheck.style.cssText = ui.buttonCss(true);
        btnRecheck.addEventListener('click', async () => {
          ui.toast('最新版を確認中...');
          try { await ui.ensureUpdateCheck(true); } catch {}
          // ensureUpdateCheck内で必要ならrenderModal(true)されるが、念のため：
          if (ui.state.modalOpen && ui.state.modalMode === 'help') ui.renderModal(true);
        });

        row.appendChild(btnOpenRaw);
        row.appendChild(btnRecheck);

        card.appendChild(desc);
        card.appendChild(row);

        // 右側が overflow:hidden なので、カード側でスクロールを持つ
        card.style.overflow = 'auto';
        card.style.minHeight = '0';

        right.appendChild(card);
      }

      // -------------------------
      // Tips
      // -------------------------
      if (ui.state.helpLeft === 'tips') {
        const card = mkCard('便利な使い方');

        const desc = document.createElement('div');
        desc.style.cssText = 'opacity:0.85; font-weight:800; line-height:1.7; white-space:pre-wrap;';
        desc.textContent =
          '■ Windows\n' +
          '  F11でブラウザを全画面にできます。全画面にすると、操作画面が広く使えて快適です。\n\n' +
          '■ Mac\n' +
          '  ブラウザをフルスクリーン表示にすると同様に使いやすくなります。\n\n' +
          '■ 使い方記事（リベシティ）\n' +
          '  下のボタンから記事へ飛べます。';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

        const btnLibecity = document.createElement('button');
        btnLibecity.type = 'button';
        btnLibecity.textContent = 'リベシティ記事を開く';
        btnLibecity.style.cssText = ui.buttonCss(true);
        btnLibecity.addEventListener('click', () => {
          try { window.open('https://library.libecity.com/articles/01KGCJA6Z2TZZ6BF9RF4KE5FR0', '_blank', 'noopener'); } catch {}
        });

        row.appendChild(btnLibecity);

        card.appendChild(desc);
        card.appendChild(row);

        // 右側が overflow:hidden なので、カード側でスクロールを持つ
        card.style.overflow = 'auto';
        card.style.minHeight = '0';

        right.appendChild(card);
      }

      // ---- mount ----
      bodyEl.appendChild(left);
      bodyEl.appendChild(splitter);
      bodyEl.appendChild(right);

      applyLeftState();
    },

    // =========================================================
    // Viewer同期ヘルパー（お気に入り移動後に即更新するため）
    // =========================================================
    syncViewerAfterFavoritesChanged(fromFavId, removedPinIds) {
      if (!ui.state.viewerOpen) return;
      if (ui.state.viewerSource !== 'favorites') return;

      // Viewerが見ているお気に入りが「移動元」でなければ何もしない
      const viewingFavId = ui.state.activeFavId;
      if (!viewingFavId || viewingFavId !== fromFavId) return;

      const removed = new Set(removedPinIds || []);

      // 現在のviewerIdsから削除
      const oldIds = ui.state.viewerIds || [];
      const newIds = oldIds.filter(id => !removed.has(id));
      ui.state.viewerIds = newIds;

      // 0件ならViewerを閉じる
      if (!newIds.length) {
        ui.closeViewer();
        return;
      }

      const curId = ui.state.viewerPinId;

      // 表示中のpinが消えた場合 → 次へ
      if (curId && removed.has(curId)) {
        let idx = ui.state.viewerIndex ?? 0;

        if (idx >= newIds.length) idx = newIds.length - 1;
        if (idx < 0) idx = 0;

        ui.state.viewerIndex = idx;
        ui.state.viewerPinId = newIds[idx];
      } else {
        // 残っているなら index を再同期
        const pos = newIds.indexOf(curId);
        if (pos >= 0) ui.state.viewerIndex = pos;
      }

      // ★中央画像・タイル両方を強制再描画
      ui.renderViewer(true);
    },

    // =========================================================
    // Viewer: 右側プレビュー式（欠損ならその場で補完して再描画）
    // =========================================================
    _viewerHydratePinIfNeeded(pinId) {
    if (!pinId) return;

    // 二重実行防止
    if (!ui.state._viewerHydrating) ui.state._viewerHydrating = {};
    if (ui.state._viewerHydrating[pinId]) return;

    const cur = pinStore.get(pinId);
    const needThumb = (!cur || !cur.thumbUrl);
    const needCount = (!cur || cur.countStr == null);
    if (!needThumb && !needCount) return;

    ui.state._viewerHydrating[pinId] = true;

    (async () => {
        try {
        // Viewer が閉じた/別pinに切り替わったら中断しやすいようにチェック
        if (!ui.state.viewerOpen || ui.state.viewerPinId !== pinId) return;

        // ★右側プレビュー同様：rehydrate で pinStore を埋める
        // - force:true で「onlyMissing判定や古い状態」に引っかからないようにする
        await rehydratePins([pinId], {
            force: true,
            onlyMissing: false,
            toast: false,
        });

        // まだ同じpinを見ているなら Viewer state を更新して再描画
        if (!ui.state.viewerOpen || ui.state.viewerPinId !== pinId) return;

        const p2 = pinStore.get(pinId) || {};
        const hi2 = toHighResPinimgUrl(p2.thumbUrl) || null;

        if (hi2) ui.state.viewerImgUrl = hi2;
        if (p2.countStr != null) ui.state.viewerCountStr = p2.countStr;

        ui.renderViewer(true);
        } catch (e) {
        console.error('[Viewer hydrate] failed', pinId, e);
        } finally {
        ui.state._viewerHydrating[pinId] = false;
        }
    })();
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
      // =========================
      // Left menu open/close state (default: open)
      // =========================
      if (ui.state.modalLeftOpen == null) ui.state.modalLeftOpen = true;

      // =========================
      // Favorites Manager local selection (NOT shared with viewer / history)
      // =========================
      if (ui.state.favSelectedPinId == null) ui.state.favSelectedPinId = null;
      // ※Setは永続化しない想定（必要なら配列化してpersistしてもOK）
      if (!ui.state.favSelectedPinIds || !(ui.state.favSelectedPinIds instanceof Set)) {
        ui.state.favSelectedPinIds = new Set();
      }

      const resetFavSelection = () => {
        ui.state.favSelectedPinId = null;
        ui.state.favSelectedPinIds = new Set();
      };

      const setFavSingleSelection = (pinId) => {
        ui.state.favSelectedPinId = pinId;
        ui.state.favSelectedPinIds = new Set(pinId ? [pinId] : []);
      };

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

        // ★Favoritesの選択状態だけリセット（Historyと共有しない）
        resetFavSelection();

        ui.renderModal(true);
      };

      ensureActive();

      // ---- layout root ----
      bodyEl.innerHTML = '';
      bodyEl.style.cssText = `
        display:flex;
        width:100%;
        height:100%;
        min-height:0;
        gap:0;
      `;

      const left = document.createElement('div');
      left.style.cssText = `
        width: 320px;
        border-right: 1px solid rgba(255,255,255,0.10);
        padding: 12px;
        display:flex;
        flex-direction:column;
        gap: 10px;
        overflow:hidden;
        min-height:0;
        background: rgba(0,0,0,0.18);

        transition:
          width 300ms cubic-bezier(.2,.8,.2,1),
          flex-basis 300ms cubic-bezier(.2,.8,.2,1),
          padding 220ms ease,
          opacity 180ms ease;
      `;

      const right = document.createElement('div');
      right.style.cssText = `
        flex:1;
        padding: 12px;
        display:flex;
        flex-direction:column;
        gap: 10px;
        overflow:hidden;
        min-height:0;
      `;

      // =========================================================
      // Splitter (left/right boundary) + toggle button
      // =========================================================
      const splitter = document.createElement('div');
      splitter.style.cssText = `
        width: 12px;
        position: relative;
        flex: 0 0 12px;
        user-select:none;
        background: rgba(255,255,255,0.02);

        transition: background 120ms ease;
        z-index: 5;
        pointer-events: auto;
      `;

      const splitBtn = document.createElement('button');
      splitBtn.type = 'button';
      splitBtn.textContent = ui.state.modalLeftOpen ? '◀' : '▶';
      splitBtn.title = ui.state.modalLeftOpen ? '左メニューを閉じる' : '左メニューを開く';
      splitBtn.style.cssText = `
        position:absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        padding: 6px 4px;
        border: none;
        background: transparent;
        color: rgba(255,255,255,0.85);
        font-size: 18px;
        font-weight: 900;
        cursor: pointer;
        z-index: 2;
        line-height: 1;
      `;

      splitter.addEventListener('mouseenter', () => {
        splitter.style.background = 'rgba(255,255,255,0.06)';
      });
      splitter.addEventListener('mouseleave', () => {
        splitter.style.background = 'rgba(255,255,255,0.02)';
      });

      const applyLeftState = () => {
        if (ui.state.modalLeftOpen) {
          left.style.width = '320px';
          left.style.flexBasis = '320px';
          left.style.padding = '12px';
          left.style.opacity = '1';
          left.style.pointerEvents = 'auto';

          splitBtn.textContent = '◀';
          splitBtn.title = '左メニューを閉じる';
        } else {
          left.style.width = '0px';
          left.style.flexBasis = '0px';
          left.style.padding = '12px 0';
          left.style.opacity = '0';
          left.style.pointerEvents = 'none';

          splitBtn.textContent = '▶';
          splitBtn.title = '左メニューを開く';
        }
      };

      splitBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        ui.state.modalLeftOpen = !ui.state.modalLeftOpen;
        persistUIState();

        applyLeftState();
      });

      splitter.appendChild(splitBtn);

      // =========================================================
      // Left: favorites list (collapsible)
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

        const defaultId = getDefaultFavId();
        if (id === defaultId) {
          ui.toast('デフォルトの「お気に入り」は削除できません');
          return;
        }

        if (!confirm('このお気に入りリストを削除しますか？（最低1つは残ります）')) return;
        deleteFavList(id);
        ensureActive();
        ui.renderModal(true);
      };

      ops.append(btnRename, btnUp, btnDown, btnDel);

      const countText = document.createElement('div');
      countText.style.cssText = 'opacity:0.85; font-weight:900;';
      const updateCountText = () => {
        const list = persisted.favorites.lists[ui.state.activeFavId];
        countText.textContent = `件数: ${list?.pinIds?.length || 0}`;
      };

      const listWrap = document.createElement('div');
      listWrap.style.cssText = `
        flex:1;
        overflow:auto;
        display:flex;
        flex-direction:column;
        gap:8px;
        min-height:0;
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

      left.append(leftTopRow, ops, countText, listWrap);

      // =========================================================
      // Right: top bar (表示モード / 画像取得 / コピー) + preview
      // =========================================================
      const rightTop = document.createElement('div');
      rightTop.style.cssText = `
        display:flex;
        gap:12px;
        align-items:center;
        flex-wrap:wrap;
      `;

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

      // ---- 表示モード：編集モードを開く（= Viewer） ----
      const viewBlock = document.createElement('div');
      viewBlock.style.cssText = `
        display:flex;
        align-items:center;
        gap:10px;
        flex-wrap:nowrap;
        white-space:nowrap;
        padding:2px 0;
      `;

      const getActiveList = () => persisted.favorites.lists[ui.state.activeFavId] || null;
      const getIds = () => (getActiveList()?.pinIds || []);

      const btnOpenViewer = document.createElement('button');
      btnOpenViewer.type = 'button';
      btnOpenViewer.textContent = '編集モードを開く';
      btnOpenViewer.style.cssText = ui.buttonCss(false);
      btnOpenViewer.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const list = getActiveList();
      const idsAll = (list?.pinIds || []).filter(Boolean);
      if (!idsAll.length) { ui.toast('対象なし'); return; }

      // ★Favorites専用の単一選択を参照
      const pinId = ui.state.favSelectedPinId || idsAll[0];
      const idx = Math.max(0, idsAll.indexOf(pinId));

      // =========================
      // ★ここが追加：開く直前に 1件だけ画像/❤数を補完
      // =========================
      try {
          const p = pinStore.get(pinId);
          const need = (!p || !p.thumbUrl || p.countStr == null);
          if (need && typeof rehydratePins === 'function') {
          ui.toast('画像取得: 1件');
          await rehydratePins([pinId], { force: false });
          }
      } catch (e) {
          console.error('[openViewer prefetch:favorites] error', e);
          ui.toast('画像取得: エラー（console参照）');
      }

      ui.openViewer(pinId, { source: 'favorites', ids: idsAll, index: idx });
      });

      viewBlock.appendChild(makeLabel('表示モード'));
      viewBlock.appendChild(btnOpenViewer);

      // ---- 画像取得（仕様どおり：欠損のみ / この一覧=右側 / 全リスト=左側全リスト） ----
      const imageBlock = document.createElement('div');
      imageBlock.style.cssText = `
        display:flex;
        align-items:center;
        gap:10px;
        flex-wrap:nowrap;
        white-space:nowrap;
        padding:2px 0;
      `;

      const btnImageThis = document.createElement('button');
      btnImageThis.type = 'button';
      btnImageThis.textContent = 'この一覧';
      btnImageThis.style.cssText = ui.buttonCss(true);

      const btnImageAll = document.createElement('button');
      btnImageAll.type = 'button';
      btnImageAll.textContent = '全リスト';
      btnImageAll.style.cssText = ui.buttonCss(true);

      const confirmIfLarge = async (ids, title = '画像取得') => {
        const n = (ids || []).length;
        if (n <= 0) return false;
        if (n > 500) return !!confirm(`${title} 対象が ${n} 件あります。\n実行しますか？`);
        return true;
      };

      const onlyMissing = (ids) => (ids || [])
        .filter(Boolean)
        .filter(id => {
          const p = pinStore.get(id);
          return !p || !p.thumbUrl;
        });

      // この一覧（右側=active list）
      const getCurrentIds_Fav = () => (getActiveList()?.pinIds || []).filter(Boolean);

      // 全リスト（左側=全お気に入りリスト）
      const getAllIds_FavoritesAllLists = () => {
        return (persisted.favorites.order || [])
          .flatMap(fid => persisted.favorites.lists[fid]?.pinIds || [])
          .filter(Boolean);
      };

      const runRehydrate = async (ids, title = '画像取得') => {
        ids = (ids || []).filter(Boolean);
        if (!ids.length) { ui.toast('対象なし'); return; }

        if (typeof rehydratePins !== 'function') {
          ui.toast('画像取得関数(rehydratePins)が見つかりません');
          return;
        }

        const ok = await confirmIfLarge(ids, title);
        if (!ok) return;

        try {
          ui.toast(`${title}: ${ids.length}`);
          await rehydratePins(ids, { force: false });
          ui.toast(`${title}: 完了`);
          try { ui._rerenderModalPreviewIfAny?.(); } catch {}
        } catch (e) {
          console.error('[rehydrate] error', e);
          ui.toast(`${title}: エラー（console参照）`);
        }
      };

      btnImageThis.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        await runRehydrate(onlyMissing(getCurrentIds_Fav()), '画像取得');
      });

      btnImageAll.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        await runRehydrate(onlyMissing(getAllIds_FavoritesAllLists()), '画像取得（全リスト）');
      });

      imageBlock.appendChild(makeLabel('画像取得'));
      imageBlock.appendChild(btnImageThis);
      imageBlock.appendChild(btnImageAll);

      // ---- コピー：PNG / URL ----
      const copyBlock = document.createElement('div');
      copyBlock.style.cssText = `
        display:flex;
        align-items:center;
        gap:10px;
        flex-wrap:nowrap;
        white-space:nowrap;
        padding:2px 0;
      `;

      const btnCopyPng = document.createElement('button');
      btnCopyPng.type = 'button';
      btnCopyPng.textContent = 'PNG';
      btnCopyPng.style.cssText = ui.buttonCss(false);

      const btnCopyUrl = document.createElement('button');
      btnCopyUrl.type = 'button';
      btnCopyUrl.textContent = 'URL';
      btnCopyUrl.style.cssText = ui.buttonCss(true);

      const getCurrentPinId = () => {
        const idsAll = (getIds() || []).filter(Boolean);
        return ui.state.favSelectedPinId || idsAll[0] || null;
      };

      btnCopyPng.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const pid = getCurrentPinId();
        if (!pid) { ui.toast('対象なし'); return; }
        _hydrateFromPersisted(pid);
        const p = pinStore.get(pid) || { pinId: pid, thumbUrl: null, href: pinUrl(pid), countStr: null, countNum: null };
        const imgUrl = toHighResPinimgUrl(p.thumbUrl);
        if (!imgUrl) { ui.toast('画像URLなし'); return; }

        try {
          await copyImageToClipboard_StrongPng(imgUrl);
          ui.toast('PNGコピー');
        } catch {
          try {
            await copyTextToClipboard(imgUrl);
            ui.toast('URLコピー');
          } catch {
            ui.toast('失敗');
          }
        }
      });

      btnCopyUrl.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const pid = getCurrentPinId();
        if (!pid) { ui.toast('対象なし'); return; }
        _hydrateFromPersisted(pid);
        const p = pinStore.get(pid) || { pinId: pid, thumbUrl: null, href: pinUrl(pid), countStr: null, countNum: null };
        const url = p.href || pinUrl(pid) || null;
        if (!url) { ui.toast('URLなし'); return; }

        try {
          await copyTextToClipboard(url);
          ui.toast('URLコピー');
        } catch {
          ui.toast('失敗');
        }
      });

      copyBlock.appendChild(makeLabel('コピー'));
      copyBlock.appendChild(btnCopyPng);
      copyBlock.appendChild(btnCopyUrl);

      // 右上バー組み立て
      rightTop.appendChild(viewBlock);
      rightTop.appendChild(imageBlock);
      rightTop.appendChild(copyBlock);

      // --- 右側プレビュー（仮想スクロール） ---
      const gridWrap = document.createElement('div');
      gridWrap.style.cssText = 'flex:1; overflow:hidden; padding-top:6px; position:relative; min-height:0;';

      const vsWrap = document.createElement('div');
      vsWrap.style.cssText = `
        position:relative;
        width:100%;
        height:100%;
        overflow-y:auto;
        overflow-x:hidden;
        padding:0;
        scrollbar-gutter: stable;
      `;

      const vsInner = document.createElement('div');
      vsInner.style.cssText = `
        position:relative;
        width:100%;
        overflow-x:hidden;
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

      const CLICK_DELAY_MS = 180;

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

        // ★Favorites専用選択キー
        const selKey = ui.state.favSelectedPinId || '';
        const key = `${ids.length}|${cols}|${cardW}|${cardH}|${firstRow}|${lastRow}|${selKey}|${ui.state.activeFavId || ''}`;

        if (!force && key === _lastKey && Math.abs(top - _lastTop) < 2) return;
        _lastKey = key;
        _lastTop = top;

        clearVS();

        const frag = document.createDocumentFragment();

        for (let i = startIdx; i <= endIdx; i++) {
          const id = ids[i];
          _hydrateFromPersisted(id);
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
            const ii = arr.indexOf(fromId);
            const jj = arr.indexOf(toId);
            if (ii < 0 || jj < 0) return;

            arr.splice(ii, 1);
            arr.splice(jj, 0, fromId);

            saveStateAll(persisted);
            ui.renderModal(true);
          });

          const selected = (ui.state.favSelectedPinId === id);
          item.style.cssText = `
            width:100%;
            height:100%;
            border-radius:12px;
            overflow:hidden;
            border:1px solid rgba(255,255,255,${selected ? '0.30' : '0.12'});
            outline:${selected ? '3px solid rgba(150,220,255,0.55)' : 'none'};
            box-shadow:${selected ? '0 0 0 2px rgba(150,220,255,0.10), 0 0 14px rgba(120,200,255,0.10)' : 'none'};
            background: rgba(0,0,0,0.45);
            cursor:pointer;
            position:relative;
          `;

          // ★click / dblclick の誤爆防止（dblclickで選択が変わらない）
          let _clickTimer = null;

          item.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            if (_clickTimer) clearTimeout(_clickTimer);
            _clickTimer = setTimeout(() => {
              _clickTimer = null;
              // ★単一選択
              setFavSingleSelection(id);
              renderVS(true);
            }, CLICK_DELAY_MS);
          });

          item.addEventListener('dblclick', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            if (_clickTimer) {
              clearTimeout(_clickTimer);
              _clickTimer = null;
            }

            const idsAll = (getIds() || []).filter(Boolean);
            const idx = idsAll.indexOf(id);

            ui.openViewer(id, {
              source: 'favorites',
              ids: idsAll,
              index: idx,
            });
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

        // 外部から「再描画して」と呼べるようにする
        ui._rerenderModalPreviewIfAny = () => {
          try { renderVS(true); } catch {}
          try { updateCountText(); } catch {}
        };
      };

      // scroll / resize
      vsWrap.addEventListener('scroll', () => renderVS(false));
      try {
        _ro = new ResizeObserver(() => renderVS(true));
        _ro.observe(vsWrap);
      } catch {}

      // ---- mount ----
      bodyEl.appendChild(left);
      bodyEl.appendChild(splitter);
      bodyEl.appendChild(right);

      applyLeftState();

      // ---- first paint ----
      renderLeftList();
      updateCountText();

      requestAnimationFrame(() => {
        try { renderVS(true); } catch {}
        try { updateCountText(); } catch {}
      });
    },

    renderHistoryManager(bodyEl) {
      // =========================
      // Left menu open/close state (default: open)
      // =========================
      if (ui.state.modalLeftOpen == null) ui.state.modalLeftOpen = true;

      // =========================
      // History Manager local selection (NOT shared with viewer / favorites)
      // =========================
      if (ui.state.histSelectedPinId == null) ui.state.histSelectedPinId = null;
      if (!ui.state.histSelectedPinIds || !(ui.state.histSelectedPinIds instanceof Set)) {
        ui.state.histSelectedPinIds = new Set();
      }

      const resetHistSelection = () => {
        ui.state.histSelectedPinId = null;
        ui.state.histSelectedPinIds = new Set();
      };

      const setHistSingleSelection = (pinId) => {
        ui.state.histSelectedPinId = pinId;
        ui.state.histSelectedPinIds = new Set(pinId ? [pinId] : []);
      };

      // ---- layout root ----
      bodyEl.innerHTML = '';
      bodyEl.style.cssText = `
        display:flex;
        width:100%;
        height:100%;
        min-height:0;
        gap:0;
      `;

      const left = document.createElement('div');
      left.style.cssText = `
        width: 320px;
        border-right: 1px solid rgba(255,255,255,0.10);
        padding: 12px;
        display:flex;
        flex-direction:column;
        gap: 10px;
        overflow:hidden;
        min-height:0;
        background: rgba(0,0,0,0.18);

        transition:
          width 300ms cubic-bezier(.2,.8,.2,1),
          flex-basis 300ms cubic-bezier(.2,.8,.2,1),
          padding 220ms ease,
          opacity 180ms ease;
      `;

      const right = document.createElement('div');
      right.style.cssText = `
        flex:1;
        padding: 12px;
        display:flex;
        flex-direction:column;
        gap: 10px;
        overflow:hidden;
        min-height:0;
      `;

      // =========================================================
      // Splitter (left/right boundary) + toggle button
      // =========================================================
      const splitter = document.createElement('div');
      splitter.style.cssText = `
        width: 12px;
        position: relative;
        flex: 0 0 12px;
        user-select:none;
        background: rgba(255,255,255,0.02);

        transition: background 120ms ease;
        z-index: 5;
        pointer-events: auto;
      `;

      const splitBtn = document.createElement('button');
      splitBtn.type = 'button';
      splitBtn.textContent = ui.state.modalLeftOpen ? '◀' : '▶';
      splitBtn.title = ui.state.modalLeftOpen ? '左メニューを閉じる' : '左メニューを開く';
      splitBtn.style.cssText = `
        position:absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        padding: 6px 4px;
        border: none;
        background: transparent;
        color: rgba(255,255,255,0.85);
        font-size: 18px;
        font-weight: 900;
        cursor: pointer;
        z-index: 2;
        line-height: 1;
      `;

      splitter.addEventListener('mouseenter', () => {
        splitter.style.background = 'rgba(255,255,255,0.06)';
      });
      splitter.addEventListener('mouseleave', () => {
        splitter.style.background = 'rgba(255,255,255,0.02)';
      });

      const applyLeftState = () => {
        if (ui.state.modalLeftOpen) {
          left.style.width = '320px';
          left.style.flexBasis = '320px';
          left.style.padding = '12px';
          left.style.opacity = '1';
          left.style.pointerEvents = 'auto';

          splitBtn.textContent = '◀';
          splitBtn.title = '左メニューを閉じる';
        } else {
          left.style.width = '0px';
          left.style.flexBasis = '0px';
          left.style.padding = '12px 0';
          left.style.opacity = '0';
          left.style.pointerEvents = 'none';

          splitBtn.textContent = '▶';
          splitBtn.title = '左メニューを開く';
        }
      };

      splitBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        ui.state.modalLeftOpen = !ui.state.modalLeftOpen;
        persistUIState();

        applyLeftState();
      });

      splitter.appendChild(splitBtn);

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
        min-height:0;
      `;

      // ---- local state defaults ----
      if (!ui.state.historySortDir) ui.state.historySortDir = 'desc'; // 'desc' | 'asc'

      const toMs = (iso) => {
        const t = Date.parse(iso || '');
        return Number.isFinite(t) ? t : 0;
      };

      const getSortedSnapshotIds = () => {
        const ids = (persisted.snapshots.order || []).filter(id => !!persisted.snapshots.items?.[id]);
        ids.sort((a, b) => {
          const am = toMs(persisted.snapshots.items[a]?.createdAt);
          const bm = toMs(persisted.snapshots.items[b]?.createdAt);
          return ui.state.historySortDir === 'asc' ? (am - bm) : (bm - am);
        });
        return ids;
      };

      const normalizeActiveId = () => {
        const cur = ui.state.activeSnapId;
        if (cur && persisted.snapshots.items[cur]) return cur;

        const sorted = getSortedSnapshotIds();
        const first = sorted[0] || null;

        ui.state.activeSnapId = first;
        persistUIState();
        return first;
      };

      normalizeActiveId();

      // 左上：見出し & 件数 + ソート切替
      const headRow = document.createElement('div');
      headRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px;';

      const headTitle = document.createElement('div');
      headTitle.textContent = '履歴一覧';
      headTitle.style.cssText = 'font-weight:1000; opacity:0.95;';

      const headRight = document.createElement('div');
      headRight.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;';

      const getActiveSnapshot = () => (ui.state.activeSnapId ? persisted.snapshots.items[ui.state.activeSnapId] : null);
      const getIds = () => (getActiveSnapshot()?.pinIds || []);

      const headCount = document.createElement('div');
      headCount.style.cssText = 'opacity:0.75; font-weight:900;';
      headCount.textContent = `件数: ${(getIds() || []).length || 0}`;

      const btnSortDir = document.createElement('button');
      btnSortDir.type = 'button';
      const updateSortBtn = () => {
        btnSortDir.textContent = (ui.state.historySortDir === 'asc') ? '古い順' : '新しい順';
        btnSortDir.title = '履歴取得日時（createdAt）の並び替え';
      };
      btnSortDir.style.cssText = ui.buttonCss(true);
      btnSortDir.addEventListener('click', () => {
        ui.state.historySortDir = (ui.state.historySortDir === 'asc') ? 'desc' : 'asc';
        persistUIState();
        ui.renderModal(true);
      });
      updateSortBtn();

      headRight.appendChild(headCount);
      headRight.appendChild(btnSortDir);

      headRow.appendChild(headTitle);
      headRow.appendChild(headRight);

      // 左：操作ボタン（rename / delete）
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

        // ★Historyの選択だけリセット
        resetHistSelection();

        ui.renderModal(true);
      });

      ops.appendChild(btnRename);
      ops.appendChild(btnDel);

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

            // ★Historyの選択だけリセット
            resetHistSelection();

            ui.renderModal(true);
          });

          listWrap.appendChild(row);
        }
      };

      renderLeftList();

      left.appendChild(headRow);
      left.appendChild(ops);
      left.appendChild(listWrap);

      // =========================
      // 右：top bar（表示モード / 画像取得 / コピー）+ プレビュー
      // =========================
      const rightTop = document.createElement('div');
      rightTop.style.cssText = `
        display:flex;
        gap:12px;
        align-items:center;
        flex-wrap:wrap;
      `;

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

      // ---- 表示モード：編集モードを開く（= Viewer） ----
      const viewBlock = document.createElement('div');
      viewBlock.style.cssText = `
        display:flex;
        align-items:center;
        gap:10px;
        flex-wrap:nowrap;
        white-space:nowrap;
        padding:2px 0;
      `;

      const btnOpenViewer = document.createElement('button');
      btnOpenViewer.type = 'button';
      btnOpenViewer.textContent = '編集モードを開く';
      btnOpenViewer.style.cssText = ui.buttonCss(false);
      btnOpenViewer.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const idsAll = (getIds() || []).filter(Boolean);
      if (!idsAll.length) { ui.toast('対象なし'); return; }

      // ★History専用の単一選択を参照
      const pinId = ui.state.histSelectedPinId || idsAll[0];
      const idx = Math.max(0, idsAll.indexOf(pinId));

      // =========================
      // ★ここが追加：開く直前に 1件だけ画像/❤数を補完
      // =========================
      try {
          const p = pinStore.get(pinId);
          const need = (!p || !p.thumbUrl || p.countStr == null);
          if (need && typeof rehydratePins === 'function') {
          ui.toast('画像取得: 1件');
          await rehydratePins([pinId], { force: false });
          }
      } catch (e) {
          console.error('[openViewer prefetch:history] error', e);
          ui.toast('画像取得: エラー（console参照）');
      }

      ui.openViewer(pinId, { source: 'history', ids: idsAll, index: idx });
      });

      viewBlock.appendChild(makeLabel('表示モード'));
      viewBlock.appendChild(btnOpenViewer);

      // ---- 画像取得（欠損のみ / この履歴=右側 / 全リスト=左側全履歴） ----
      const imageBlock = document.createElement('div');
      imageBlock.style.cssText = `
        display:flex;
        align-items:center;
        gap:10px;
        flex-wrap:nowrap;
        white-space:nowrap;
        padding:2px 0;
      `;

      const btnImageThis = document.createElement('button');
      btnImageThis.type = 'button';
      btnImageThis.textContent = 'この履歴';
      btnImageThis.style.cssText = ui.buttonCss(true);

      const btnImageAll = document.createElement('button');
      btnImageAll.type = 'button';
      btnImageAll.textContent = '全リスト';
      btnImageAll.style.cssText = ui.buttonCss(true);

      const confirmIfLarge = async (ids, title = '画像取得') => {
        const n = (ids || []).length;
        if (n <= 0) return false;
        if (n > 500) return !!confirm(`${title} 対象が ${n} 件あります。\n実行しますか？`);
        return true;
      };

      const onlyMissing = (ids) => (ids || [])
        .filter(Boolean)
        .filter(id => {
          const p = pinStore.get(id);
          return !p || !p.thumbUrl;
        });

      const getCurrentIds_History = () => (getIds() || []).filter(Boolean);

      const getAllIds_HistoryAll = () => {
        return (persisted.snapshots.order || [])
          .flatMap(sid => persisted.snapshots.items[sid]?.pinIds || [])
          .filter(Boolean);
      };

      const runRehydrate = async (ids, title = '画像取得') => {
        ids = (ids || []).filter(Boolean);
        if (!ids.length) { ui.toast('対象なし'); return; }

        if (typeof rehydratePins !== 'function') {
          ui.toast('画像取得関数(rehydratePins)が見つかりません');
          return;
        }

        const ok = await confirmIfLarge(ids, title);
        if (!ok) return;

        try {
          ui.toast(`${title}: ${ids.length}`);
          await rehydratePins(ids, { force: false });
          ui.toast(`${title}: 完了`);
          try { ui._rerenderModalPreviewIfAny?.(); } catch {}
        } catch (e) {
          console.error('[rehydrate] error', e);
          ui.toast(`${title}: エラー（console参照）`);
        }
      };

      btnImageThis.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        await runRehydrate(onlyMissing(getCurrentIds_History()), '画像取得');
      });

      btnImageAll.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        await runRehydrate(onlyMissing(getAllIds_HistoryAll()), '画像取得（全リスト）');
      });

      imageBlock.appendChild(makeLabel('画像取得'));
      imageBlock.appendChild(btnImageThis);
      imageBlock.appendChild(btnImageAll);

      // ---- コピー：PNG / URL ----
      const copyBlock = document.createElement('div');
      copyBlock.style.cssText = `
        display:flex;
        align-items:center;
        gap:10px;
        flex-wrap:nowrap;
        white-space:nowrap;
        padding:2px 0;
      `;

      const btnCopyPng = document.createElement('button');
      btnCopyPng.type = 'button';
      btnCopyPng.textContent = 'PNG';
      btnCopyPng.style.cssText = ui.buttonCss(false);

      const btnCopyUrl = document.createElement('button');
      btnCopyUrl.type = 'button';
      btnCopyUrl.textContent = 'URL';
      btnCopyUrl.style.cssText = ui.buttonCss(true);

      const getCurrentPinId = () => {
        const idsAll = (getIds() || []).filter(Boolean);
        return ui.state.histSelectedPinId || idsAll[0] || null;
      };

      btnCopyPng.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const pid = getCurrentPinId();
        if (!pid) { ui.toast('対象なし'); return; }
        _hydrateFromPersisted(pid);
        const p = pinStore.get(pid) || { pinId: pid, thumbUrl: null, href: pinUrl(pid), countStr: null, countNum: null };
        const imgUrl = toHighResPinimgUrl(p.thumbUrl);
        if (!imgUrl) { ui.toast('画像URLなし'); return; }

        try {
          await copyImageToClipboard_StrongPng(imgUrl);
          ui.toast('PNGコピー');
        } catch {
          try {
            await copyTextToClipboard(imgUrl);
            ui.toast('URLコピー');
          } catch {
            ui.toast('失敗');
          }
        }
      });

      btnCopyUrl.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const pid = getCurrentPinId();
        if (!pid) { ui.toast('対象なし'); return; }
        _hydrateFromPersisted(pid);
        const p = pinStore.get(pid) || { pinId: pid, thumbUrl: null, href: pinUrl(pid), countStr: null, countNum: null };
        const url = p.href || pinUrl(pid) || null;
        if (!url) { ui.toast('URLなし'); return; }

        try {
          await copyTextToClipboard(url);
          ui.toast('URLコピー');
        } catch {
          ui.toast('失敗');
        }
      });

      copyBlock.appendChild(makeLabel('コピー'));
      copyBlock.appendChild(btnCopyPng);
      copyBlock.appendChild(btnCopyUrl);

      rightTop.appendChild(viewBlock);
      rightTop.appendChild(imageBlock);
      rightTop.appendChild(copyBlock);

      right.appendChild(rightTop);

      // --- 右側プレビュー（仮想スクロール） ---
      const gridWrap = document.createElement('div');
      gridWrap.style.cssText = 'flex:1; overflow:hidden; padding-top:6px; position:relative; min-height:0;';

      const vsWrap = document.createElement('div');
      vsWrap.style.cssText = `
        position:relative;
        width:100%;
        height:100%;
        overflow-y:auto;
        overflow-x:hidden;
        padding:0;
        scrollbar-gutter: stable;
      `;

      const vsInner = document.createElement('div');
      vsInner.style.cssText = `
        position:relative;
        width:100%;
        overflow-x:hidden;
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
      right.appendChild(gridWrap);

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

      const CLICK_DELAY_MS = 180;

      const renderVS = (force = false) => {
        const ids = getIds();

        // 左上の件数追随
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

        // ★History専用選択キー
        const selKey = ui.state.histSelectedPinId || '';
        const key = `${ids.length}|${cols}|${cardW}|${cardH}|${firstRow}|${lastRow}|${selKey}|${ui.state.activeSnapId || ''}`;

        if (!force && key === _lastKey && Math.abs(top - _lastTop) < 2) return;
        _lastKey = key;
        _lastTop = top;

        clearVS();

        const frag = document.createDocumentFragment();

        for (let i = startIdx; i <= endIdx; i++) {
          const id = ids[i];
          _hydrateFromPersisted(id);
          if (!id) continue;

          const p = pinStore.get(id) || { pinId: id, thumbUrl: null, href: pinUrl(id), countStr: null, countNum: null };

          const row = Math.floor(i / cols);
          const col = i % cols;

          const x = col * (cardW + GAP);
          const y = row * (cardH + GAP);

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

          const selected = (ui.state.histSelectedPinId === id);
          item.style.cssText = `
            width:100%;
            height:100%;
            border-radius:12px;
            overflow:hidden;
            border:1px solid rgba(255,255,255,${selected ? '0.30' : '0.12'});
            outline:${selected ? '3px solid rgba(150,220,255,0.55)' : 'none'};
            box-shadow:${selected ? '0 0 0 2px rgba(150,220,255,0.10), 0 0 14px rgba(120,200,255,0.10)' : 'none'};
            background: rgba(0,0,0,0.45);
            cursor:pointer;
            position:relative;
          `;

          let _clickTimer = null;

          item.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            if (_clickTimer) clearTimeout(_clickTimer);
            _clickTimer = setTimeout(() => {
              _clickTimer = null;
              // ★単一選択
              setHistSingleSelection(id);
              renderVS(true);
            }, CLICK_DELAY_MS);
          });

          item.addEventListener('dblclick', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            if (_clickTimer) {
              clearTimeout(_clickTimer);
              _clickTimer = null;
            }

            const idsAll = (getIds() || []).filter(Boolean);
            const idx = idsAll.indexOf(id);

            ui.openViewer(id, {
              source: 'history',
              ids: idsAll,
              index: idx,
            });
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

        ui._rerenderModalPreviewIfAny = () => {
          try { renderVS(true); } catch {}
        };
      };

      vsWrap.addEventListener('scroll', () => renderVS(false));
      try {
        _ro = new ResizeObserver(() => renderVS(true));
        _ro.observe(vsWrap);
      } catch {}

      // ---- mount ----
      bodyEl.appendChild(left);
      bodyEl.appendChild(splitter);
      bodyEl.appendChild(right);

      applyLeftState();

      // ---- first paint ----
      renderLeftList();
      requestAnimationFrame(() => renderVS(true));
    },

  // =========================================================
  // History -> Favorites コピー（履歴は残す）
  // =========================================================
  copyPinsFromHistoryToFavorite(pinIds, targetFavId) {
    if (!pinIds || !pinIds.length) {
      ui.toast('コピーする画像がありません');
      return;
    }

    const favList = persisted?.favorites?.lists?.[targetFavId];
    if (!favList) {
      ui.toast('お気に入りリストが不明です');
      return;
    }

    const set = new Set(pinIds);

    // ★ お気に入りに追加（重複除外）
    const existing = new Set(favList.pinIds || []);
    let added = 0;
    for (const id of set) {
      if (!existing.has(id)) {
        favList.pinIds.push(id);
        added++;
      }
    }

    saveStateAll(persisted);

    // ★ 選択解除（履歴は残す）
    ui.state.modalSelectedPinIds = new Set();
    ui.state.modalSelectedPinId = null;
    ui.state.modalLastClickedPinId = null;

    ui.toast(`お気に入りに追加: ${added} 件`);
    ui.renderModal(true);
  },

  // =========================================================
  // History -> Favorites 移動（共通）
  // ※今は「コピー仕様」にしたいなら、この関数は使わない（残してOK）
  // =========================================================
  movePinsFromHistoryToFavorite(pinIds, targetFavId) {
    if (!pinIds || !pinIds.length) {
      ui.toast('移動する画像がありません');
      return;
    }

    const favList = persisted?.favorites?.lists?.[targetFavId];
    if (!favList) {
      ui.toast('お気に入りリストが不明です');
      return;
    }

    const snapId = ui.state.activeSnapId;
    const snap = snapId ? persisted?.snapshots?.items?.[snapId] : null;
    if (!snap) {
      ui.toast('履歴が不明です');
      return;
    }

    const set = new Set(pinIds);

    // ① お気に入りに追加（重複除外）
    const existing = new Set(favList.pinIds || []);
    for (const id of set) {
      if (!existing.has(id)) favList.pinIds.push(id);
    }

    // ② 履歴から削除（移動なので削除する）
    snap.pinIds = (snap.pinIds || []).filter(pid => !set.has(pid));

    saveStateAll(persisted);

    // =========================
    // ★Viewer即更新（移動したら表示から消す）
    // =========================
    try {
      if (ui?.state?.viewerOpen && ui.state.viewerSource !== 'history') {
        // Viewerが「今見てるお気に入り」が移動元なら、Viewerの表示リストから削除する
        const viewingFrom = ui.state.activeFavId;
        if (viewingFrom && viewingFrom === fromFavId) {
          const del = new Set(ids);

          // viewerIds から削除
          const oldIds = (ui.state.viewerIds || []).filter(Boolean);
          const newIds = oldIds.filter(pid => !del.has(pid));
          ui.state.viewerIds = newIds;

          // 現在表示中のピンが消えた場合、次のピンにスライド
          const cur = ui.state.viewerPinId;
          const curRemoved = cur && del.has(cur);

          if (!newIds.length) {
            // 0件になったらViewerを閉じる
            ui.closeViewer();
          } else {
            if (curRemoved) {
              // 現在の index を基準に「次」を選ぶ（末尾ならひとつ前）
              let idx = ui.state.viewerIndex;
              if (!Number.isFinite(idx) || idx < 0) idx = 0;

              // oldIds上の位置を使う（より自然）
              const oldPos = oldIds.indexOf(cur);
              let nextPos = oldPos;
              if (nextPos < 0) nextPos = idx;

              // newIdsは短くなっているので clamp
              if (nextPos >= newIds.length) nextPos = newIds.length - 1;
              if (nextPos < 0) nextPos = 0;

              ui.state.viewerIndex = nextPos;
              ui.state.viewerPinId = newIds[nextPos];
            } else {
              // 現在ピンが残っているなら index/pos を整える
              const newPos = newIds.indexOf(cur);
              if (newPos >= 0) ui.state.viewerIndex = newPos;
              else ui.state.viewerIndex = Math.min(ui.state.viewerIndex || 0, newIds.length - 1);
            }

            // ★Viewer再描画（即反映）
            ui.renderViewer(true);
          }

          // 右レール（選択済み）も同期
          ui._viewerUpdateSelectedRail?.();
        }
      }
    } catch (e) {
      console.warn('[PT] viewer immediate update failed', e);
    }

    // ③ 選択状態リセット
    ui.state.modalSelectedPinIds = new Set();
    ui.state.modalSelectedPinId = null;
    ui.state.modalLastClickedPinId = null;

    ui.toast(`お気に入りへ移動: ${set.size} 件`);
    ui.renderModal(true);
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
