(() => {
  "use strict";

  const STORAGE_KEY = "exd-state-v1";
  const SCAN_MS = 1200;      // 활동 중 스캔 간격
  const SCAN_MAX_MS = 6000;  // 조용할 때 최대 간격
  const QUIET_STEPS = 3;     // 이만큼 연속으로 변화가 없으면 간격을 한 단계(2배) 늘린다
  const ALARM_MS = 3000;     // 알람 배지 세기 최소 간격(서랍이 열려 있으면 매번)
  const OWNER_MS = 10000;    // 직접 담은 아이콘의 소유 확장 스타일시트 재확인 간격
  const PENDING_MS = 1500;
  const PANEL_ID = "exd-panel-root";
  const ICON_CACHE_MAX = 8000;

  // 앱 자체 팝업/포털 등 절대 수집하면 안 되는 것들
  const SKIP_SELECTOR = [
    "#root", "script", "style", "link", "template",
    "[data-radix-popper-content-wrapper]", "[data-radix-portal]",
    "[role='dialog']", "[role='alertdialog']", "[role='tooltip']",
    "[role='menu']", "[role='listbox']", "[role='status']", "[role='alert']",
    "[aria-hidden='true']",
  ].join(",");

  const SVG_DRAWER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8.5 12 3 3 8.5"/><path d="M3 8.5h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11Z"/><path d="M3 13.5h6.5a2.5 2.5 0 0 0 5 0H21"/></svg>`;
  const SVG_GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1.02-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.02H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z"/></svg>`;
  const SVG_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`;
  const SVG_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
  const SVG_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>`;
  const SVG_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  const SVG_MINUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>`;

  const state = {
    mode: "topbar", // "topbar" | "floating"
    autoCollect: true,
    floatPos: { x: 0.985, y: 0.62 },
    rules: [],       // 직접 담은 아이콘: [{ selector, label, icon }]
    exclusions: [],  // 자동 수집 제외: [{ sig, label }]
    order: [],       // 표시 순서: ["auto:<sig>" | "rule:<selector>", ...]
  };

  /** @type {Map<Element, object>} 자동 수집(제자리 숨김) 항목 */
  const entries = new Map();
  /** @type {Map<string, object>} 직접 담은 항목: selector 기준, 항상 서랍에 표시 */
  const proxies = new Map();
  const pendingSince = new Map();
  const cleanupFns = [];
  let panelOpen = false;
  let settingsView = false;
  let pickMode = false;
  let bodyObserver = null, bodyAttrObserver = null;
  let hideStyleTag = null;
  let fab = null, topbarBtn = null, panel = null, itemsBox = null, settingsBox = null, emptyMsg = null;
  let pickHint = null, pickHighlight = null;
  let dragMoved = false;

  // ---------- 저장/복원 ----------
  function parseRecord(raw) {
    if (!raw) return null;
    try { const v = typeof raw === "string" ? JSON.parse(raw) : raw; return v && typeof v === "object" ? v : null; }
    catch { return null; }
  }

  async function loadState() {
    let saved = null;
    try { saved = parseRecord(localStorage.getItem(STORAGE_KEY)); } catch {}
    try {
      if (typeof marinara !== "undefined" && marinara?.storage?.get) {
        const ext = parseRecord(await marinara.storage.get());
        const inner = ext && parseRecord(ext[STORAGE_KEY]);
        if (inner) saved = inner;
      }
    } catch {}
    if (!saved) return;
    if (saved.mode === "topbar" || saved.mode === "floating") state.mode = saved.mode;
    if (typeof saved.autoCollect === "boolean") state.autoCollect = saved.autoCollect;
    if (saved.floatPos && Number.isFinite(saved.floatPos.x) && Number.isFinite(saved.floatPos.y)) {
      state.floatPos = { x: Math.min(1, Math.max(0, saved.floatPos.x)), y: Math.min(1, Math.max(0, saved.floatPos.y)) };
    }
    if (Array.isArray(saved.rules)) {
      state.rules = saved.rules
        .filter((r) => r && typeof r.selector === "string")
        .map((r) => ({
          selector: r.selector,
          label: String(r.label || ""),
          icon: typeof r.icon === "string" ? r.icon.slice(0, ICON_CACHE_MAX) : "",
          ownerId: typeof r.ownerId === "string" ? r.ownerId : "",
          ownerName: typeof r.ownerName === "string" ? r.ownerName : "",
        }))
        .slice(0, 100);
    }
    if (Array.isArray(saved.exclusions)) {
      // 예전 버전은 시그니처 문자열만 저장했으므로 {sig, label} 형태로 이행
      state.exclusions = saved.exclusions
        .map((x) => (typeof x === "string" ? { sig: x, label: "" } : x))
        .filter((x) => x && typeof x.sig === "string")
        .map((x) => ({ sig: x.sig, label: String(x.label || "") }))
        .slice(0, 200);
    }
    if (Array.isArray(saved.order)) state.order = saved.order.filter((s) => typeof s === "string").slice(0, 300);
  }

  async function saveState() {
    const snapshot = {
      mode: state.mode, autoCollect: state.autoCollect, floatPos: state.floatPos,
      rules: state.rules, exclusions: state.exclusions, order: state.order,
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch {}
    try {
      if (typeof marinara !== "undefined" && marinara?.storage?.patch) {
        await marinara.storage.patch({ [STORAGE_KEY]: snapshot });
      }
    } catch {}
  }

  // ---------- 유틸 ----------
  function toast(message, isError = false) {
    let el = document.querySelector(".exd-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "exd-toast";
      el.dataset.exd = "";
      document.body.append(el);
    }
    el.textContent = message;
    el.classList.toggle("is-error", !!isError);
    el.classList.add("is-show");
    clearTimeout(el._exdTimer);
    el._exdTimer = setTimeout(() => el.classList.remove("is-show"), 2600);
  }

  function signatureOf(el) {
    if (el.id) return "#" + el.id;
    const btn = el.matches("button,a,[role='button']") ? el : el.querySelector("button,a,[role='button']");
    const cls = Array.from(el.classList).slice(0, 2).join(".");
    const label = (el.getAttribute("aria-label") || el.title || btn?.getAttribute("aria-label") || btn?.title || "").trim();
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (label ? "@" + label : "");
  }

  // Shadow DOM(격리 공간) 안에 버튼을 두는 확장(예: 익명 커뮤니티)도 다루기 위한 헬퍼들
  function shadowQuery(el, selector) {
    if (!el.shadowRoot) return null;
    try { return el.shadowRoot.querySelector(selector); } catch { return null; }
  }

  // 보이는 상태의 섀도 호스트 안에서 떠 있는 작은 런처 버튼을 찾는다
  function shadowLauncherOf(el) {
    if (!el.shadowRoot) return null;
    try {
      for (const child of el.shadowRoot.querySelectorAll("button, a, [role='button']")) {
        if (child.dataset.exdHidden !== undefined) return child; // 우리가 숨겨 둔 런처는 그대로 런처로 본다
        const cs = getComputedStyle(child);
        if (cs.position !== "fixed" && cs.position !== "absolute") continue;
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = child.getBoundingClientRect();
        if (r.width >= 14 && r.height >= 14 && r.width <= 170 && r.height <= 170) return child;
      }
    } catch {}
    return null;
  }

  function innerButtonOf(el) {
    if (el.matches("button,a,[role='button']")) return el;
    return el.querySelector("button,a,[role='button']") || shadowLauncherOf(el) || shadowQuery(el, "button, a, [role='button']");
  }

  // 숨길 대상: 섀도 호스트는 실행 화면(패널)도 같은 호스트 안에 있으므로
  // 호스트 전체가 아니라 안쪽 런처 버튼만 숨긴다
  function hideTargetOf(el) {
    if (!el.shadowRoot) return el;
    return shadowLauncherOf(el) || shadowQuery(el, "button, a, [role='button']") || el;
  }

  // 원본 런처는 display:none이 아니라 visibility로 숨긴다.
  // display:none이면 요소의 크기·위치가 0이 되어, 런처 위치를 기준으로 패널을 띄우는 확장
  // (예: API 잔액 위젯)이 화면 구석에 열리거나 동작이 어긋난다. visibility:hidden은 자리와 크기를
  // 그대로 두면서 클릭·포커스·접근성 트리에서만 빠지므로 원본 확장 입장에선 "보이는" 버튼과 같다.
  // 흐름 안(in-flow)에 있는 버튼(툴바 안 아이콘 등)은 빈칸이 남지 않도록 absolute로 띄워 둔다.
  const HIDE_PROPS = ["visibility", "pointer-events", "position"];
  function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) {
      if (el.dataset.exdHidden !== undefined) return;
      let pos = "";
      try { pos = getComputedStyle(el).position; } catch {}
      markDirty();
      el.dataset.exdHidden = "";
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
      if (pos !== "fixed" && pos !== "absolute") el.style.setProperty("position", "absolute", "important");
    } else {
      unanchor(el); // 클릭 중 옮겨 둔 상태라면 먼저 원위치(아래에서 지우는 속성을 나중에 다시 덮지 않도록)
      if (el.dataset.exdHidden !== undefined) {
        delete el.dataset.exdHidden;
        for (const p of HIDE_PROPS) el.style.removeProperty(p);
      }
      el.style.removeProperty("display"); // 예전 판(display:none 방식)의 잔여 정리
    }
  }

  // 섀도 호스트가 런처를 새로 그리면 다음 주기 스캔(최대 1.2초)까지 원본이 잠깐 보인다.
  // 숨긴 런처가 든 섀도 트리의 자식 변화를 감시해 바로 다시 숨긴다. (body 감시자는 섀도 안을 못 본다)
  const shadowObservers = new Map(); // host -> MutationObserver
  function watchShadow(host) {
    if (!host?.shadowRoot || shadowObservers.has(host)) return;
    const mo = new MutationObserver(() => wake(300));
    try {
      mo.observe(host.shadowRoot, { childList: true, subtree: true });
      shadowObservers.set(host, mo);
    } catch {}
  }
  function unwatchShadow(host) {
    const mo = host && shadowObservers.get(host);
    if (!mo) return;
    mo.disconnect();
    shadowObservers.delete(host);
  }

  function labelOf(el) {
    const btn = innerButtonOf(el);
    const t = (el.getAttribute("aria-label") || el.title || btn?.getAttribute("aria-label") || btn?.title || "").trim();
    if (t) return t.replace(/\s*(열기|열림|닫기|토글)$/g, "").slice(0, 20) || t.slice(0, 20);
    const text = ((el.textContent || "") + " " + (btn && btn.getRootNode() !== document ? btn.textContent || "" : ""))
      .replace(/\d+/g, "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 12);
    return signatureOf(el).replace(/^#/, "").slice(0, 20);
  }

  function isOurs(el) {
    return !!(el.dataset && el.dataset.exd !== undefined) || !!el.closest?.("[data-exd]");
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ---------- 아이콘 추출 (요소가 보이는 동안 호출해야 색상이 정확) ----------
  function sanitizeNode(node) {
    node.removeAttribute?.("id");
    for (const child of node.querySelectorAll?.("[id]") || []) child.removeAttribute("id");
    for (const n of [node, ...(node.querySelectorAll?.("*") || [])]) {
      for (const attr of Array.from(n.attributes || [])) {
        if (/^on/i.test(attr.name)) n.removeAttribute(attr.name);
      }
      if (n.tagName === "A") n.removeAttribute("href");
    }
    return node;
  }

  function extractIconHtml(el) {
    const src = el.matches("svg,img")
      ? el
      : el.querySelector("svg, img") || shadowLauncherOf(el)?.querySelector("svg, img") || shadowQuery(el, "svg, img");
    if (!src) return "";
    const clone = sanitizeNode(src.cloneNode(true));
    clone.removeAttribute("style");
    if (clone.tagName?.toLowerCase() === "svg") {
      try {
        const cs = getComputedStyle(src);
        if (cs.fill && cs.fill !== "rgb(0, 0, 0)") clone.style.fill = cs.fill;
        else clone.style.fill = "none";
        if (cs.stroke && cs.stroke !== "none") {
          clone.style.stroke = "currentColor";
          clone.style.strokeWidth = cs.strokeWidth || "1.8";
          clone.style.strokeLinecap = "round";
          clone.style.strokeLinejoin = "round";
        }
      } catch {}
      clone.removeAttribute("class");
      for (const child of clone.querySelectorAll("*")) child.removeAttribute("class");
    }
    const html = clone.outerHTML || "";
    return html.length > ICON_CACHE_MAX ? "" : html;
  }

  function iconMarkup(iconHtml, label) {
    if (iconHtml) return iconHtml;
    const ch = (label || "?").trim().charAt(0).toUpperCase() || "?";
    return `<span class="exd-tile-letter">${esc(ch)}</span>`;
  }

  // ---------- 소유 확장 판별 (애드온 삭제 감지용) ----------
  // 활성화된 클라이언트 확장 목록: Map<id, name>
  let enabledExts = null;
  let extsFetchedAt = 0;
  const bootAt = Date.now(); // 부팅 직후 스타일시트 로딩 전 오판 방지용

  async function refreshEnabledExts(force) {
    const now = Date.now();
    if (!force && now - extsFetchedAt < 60_000) return;
    extsFetchedAt = now;
    try {
      const res = await fetch("/api/personal-extensions/runtime/client", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      const list = await res.json();
      if (Array.isArray(list)) {
        enabledExts = new Map(list.map((x) => [String(x.id), String(x.name || "")]));
      }
    } catch {}
  }

  // 확장이 주입한 스타일시트(/api/personal-extensions/{id}/page-style.css)에서
  // 주어진 id/클래스 토큰을 꾸미는 규칙을 찾아 소유 확장 id를 알아낸다.
  // 확장이 삭제/비활성화되면 그 스타일시트 링크가 페이지에서 제거되므로,
  // 어떤 시트에서도 흔적이 없으면 소유 확장이 사라졌다고 판단할 수 있다.
  function ownerExtIdForTokens(tokens) {
    if (!tokens || !tokens.length) return "";
    for (const sheet of document.styleSheets) {
      const m = (sheet.href || "").match(/\/api\/personal-extensions\/([^/]+)\/page-style\.css/);
      if (!m) continue;
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        const sel = rule.selectorText || "";
        if (!sel) continue;
        for (const t of tokens) {
          if (sel.includes(t)) return decodeURIComponent(m[1]);
        }
      }
    }
    return "";
  }

  function ownerExtIdFor(el) {
    const tokens = new Set();
    if (el.id) tokens.add("#" + el.id);
    for (const c of el.classList) tokens.add("." + c);
    for (const child of el.querySelectorAll("*")) {
      if (child.id) tokens.add("#" + child.id);
      for (const c of child.classList) tokens.add("." + c);
      if (tokens.size > 40) break;
    }
    return ownerExtIdForTokens([...tokens]);
  }

  // 셀렉터 문자열에서 id/클래스 토큰 추출 (예: "#ooc-root", ".tb-launcher")
  function selectorTokens(selector) {
    return selector.match(/[#.][A-Za-z0-9_-]+/g) || [];
  }

  // ---------- 알람 배지 감지 ----------
  function alarmCountOf(rootEl) {
    if (!rootEl || !rootEl.isConnected) return 0;
    let total = 0;
    const candidates = [...rootEl.querySelectorAll("*")];
    if (rootEl.shadowRoot) {
      try { candidates.push(...rootEl.shadowRoot.querySelectorAll("*")); } catch {}
    }
    for (const el of candidates) {
      if (el.children.length) continue;
      const text = (el.textContent || "").trim();
      if (!/^\d{1,3}$/.test(text)) continue;
      if (el.hidden) continue;
      let cs;
      try { cs = getComputedStyle(el); } catch { continue; }
      if (cs.display === "none") continue;
      // 우리가 visibility로 숨긴 런처 안의 배지는 소유 확장 기준으론 보이는 상태다
      if (cs.visibility === "hidden" && !el.closest("[data-exd-hidden]")) continue;
      const hint = /badge|count|alert|alarm|noti|dot|bubble/i.test(el.className || "");
      const round = parseFloat(cs.borderRadius) >= 7;
      if (!hint && !round) continue;
      const n = Number(text);
      if (n > 0) total += n;
    }
    return Math.min(total, 999);
  }

  // ---------- 표시 순서 ----------
  function ensureOrderKey(key) {
    if (!state.order.includes(key)) {
      state.order.push(key);
      if (state.order.length > 300) state.order = state.order.slice(-300);
      void saveState();
    }
  }

  function displayItems() {
    const all = [];
    for (const entry of entries.values()) all.push(entry);
    for (const proxy of proxies.values()) all.push(proxy);
    all.sort((a, b) => {
      const ia = state.order.indexOf(a.key), ib = state.order.indexOf(b.key);
      return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    });
    return all;
  }

  function layoutItems() {
    const items = displayItems();
    items.forEach((item, i) => {
      item.cell.style.setProperty("--i", String(i));
      itemsBox.append(item.cell);
    });
  }

  function moveItem(key, dir) {
    const keys = displayItems().map((it) => it.key);
    const i = keys.indexOf(key);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    const rest = state.order.filter((k) => !keys.includes(k));
    state.order = [...keys, ...rest];
    void saveState();
    layoutItems();
  }

  // ---------- 타일 (통일된 아이콘 카드) ----------
  function makeCell(key, label, iconHtml, onActivate, getTarget) {
    const cell = document.createElement("div");
    cell.className = "exd-cell";
    cell.dataset.exd = "";
    cell.dataset.key = key;
    cell.innerHTML = `
      <button type="button" class="exd-tile" title="${esc(label)}">
        <span class="exd-tile-icon">${iconMarkup(iconHtml, label)}</span>
        <span class="exd-tile-alarm" hidden>0</span>
      </button>
      <span class="exd-cell-label">${esc(label)}</span>
    `;
    const tile = cell.querySelector(".exd-tile");
    tile.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const target = getTarget?.();
      // 누르는 동안 원본을 타일 자리에 겹쳐 둔다(패널을 런처 위치 기준으로 띄우는 확장 대응)
      const inner = target ? innerButtonOf(target) || target : null;
      if (inner) anchorTo(inner, tile.getBoundingClientRect());
      const forwarded = target ? forwardPointerDown(target, e) : null;
      const onCancel = () => { document.removeEventListener("pointerup", onUp, true); if (inner) unanchor(inner, ANCHOR_HOLD_MS); };
      const onUp = (ev) => {
        document.removeEventListener("pointercancel", onCancel, true);
        if (inner) unanchor(inner, ANCHOR_HOLD_MS);
        // 원본이 포인터를 캡처해 갔으면 실제 pointerup이 원본을 거쳐 간다. 캡처가 안 된 환경(브라우저·터치에 따라 다름)에선
        // 원본이 pointerup을 못 받아 pointerup으로 여는 확장이 반응하지 않으므로, 그때만 pointerup을 복제해 보낸다.
        if (forwarded && ev.pointerId === e.pointerId && !ev.composedPath().includes(forwarded)) forwardPointerUp(forwarded, ev);
        // 원본이 포인터를 캡처해 가면 click이 타일로 오지 않으므로, 서랍 닫기는 pointerup 기준
        setTimeout(() => { if (panelOpen && !settingsView) closePanel(); }, 150);
      };
      document.addEventListener("pointerup", onUp, { once: true, capture: true });
      document.addEventListener("pointercancel", onCancel, { once: true, capture: true });
    });
    tile.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onActivate();
    });
    return cell;
  }

  function setCellAlarm(item, count) {
    if (item.lastAlarm === count) return;
    item.lastAlarm = count;
    markDirty();
    const badge = item.cell.querySelector(".exd-tile-alarm");
    badge.textContent = String(count);
    badge.hidden = count <= 0;
  }

  // 타일을 실제로 누르는 순간, 그 포인터 이벤트를 복제해 원본 런처로 전달한다.
  // 진짜 pointerId를 쓰므로 원본 확장이 setPointerCapture를 호출하면 성공하고,
  // 이후의 실제 pointerup·click까지 자연스럽게 원본 런처로 이어진다.
  // (폴더 관리기처럼 click을 막고 pointerdown/up으로만 여는 확장 대응)
  // ---------- 클릭 중 원본을 타일 자리로 잠깐 옮기기 ----------
  // 숨긴 원본은 visibility로만 가려져 있어 크기·위치가 살아 있다. 런처 위치를 기준으로 패널을 띄우는 확장
  // (API 잔액 위젯 등)이 서랍 타일 옆에서 열리도록, 타일을 누르는 동안만 원본을 타일 자리에 겹쳐 두고
  // 클릭이 끝나면 원래 인라인 스타일로 되돌린다. 보이지 않는 요소라 화면엔 변화가 없고, 드래그형 런처들은
  // 실제로 움직였을 때만 위치를 저장하므로(폴더 관리기·다마고찌·턴 북마크·OOC·커뮤니티·잔액 위젯 확인) 저장되지 않는다.
  const ANCHOR_PROPS = ["position", "left", "top", "right", "bottom", "width", "height", "margin", "transform", "transition"];
  const ANCHOR_HOLD_MS = 600;  // pointerup 뒤 click·애니메이션 배치까지 기다리는 시간
  const ANCHOR_MAX_MS = 3000;  // pointerup이 끝내 안 오는 경우의 안전장치
  const anchored = new Map();  // el -> { saved: [[prop, value, priority]...], timer }

  function anchorTo(el, rect) {
    if (!(el instanceof HTMLElement) || !el.isConnected) return;
    let rec = anchored.get(el);
    if (!rec) {
      rec = { saved: ANCHOR_PROPS.map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]), timer: null };
      anchored.set(el, rec);
    }
    clearTimeout(rec.timer);
    const set = (p, v) => el.style.setProperty(p, v, "important");
    set("position", "fixed"); set("left", `${rect.left}px`); set("top", `${rect.top}px`);
    set("right", "auto"); set("bottom", "auto");
    set("width", `${rect.width}px`); set("height", `${rect.height}px`);
    set("margin", "0"); set("transform", "none"); set("transition", "none");
    // 조상에 transform 등이 있으면 fixed의 기준점이 뷰포트가 아니다. 실제로 놓인 자리를 재어 한 번 보정한다.
    try {
      const r = el.getBoundingClientRect();
      const dx = rect.left - r.left, dy = rect.top - r.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) { set("left", `${rect.left + dx}px`); set("top", `${rect.top + dy}px`); }
    } catch {}
    rec.timer = setTimeout(() => unanchor(el), ANCHOR_MAX_MS);
  }

  function unanchor(el, delay = 0) {
    const rec = anchored.get(el);
    if (!rec) return;
    clearTimeout(rec.timer);
    if (delay > 0) { rec.timer = setTimeout(() => unanchor(el), delay); return; }
    anchored.delete(el);
    for (const [p, v, pr] of rec.saved) {
      if (v) el.style.setProperty(p, v, pr);
      else el.style.removeProperty(p);
    }
  }

  function unanchorAll() {
    for (const el of Array.from(anchored.keys())) unanchor(el);
  }

  function pointerOpts(e, buttons) {
    return {
      bubbles: true, cancelable: true, composed: true, view: window,
      button: 0, buttons, clientX: e.clientX, clientY: e.clientY,
      screenX: e.screenX, screenY: e.screenY,
    };
  }

  function forwardPointerDown(el, e) {
    if (!el) return null;
    const target = innerButtonOf(el) || el;
    try {
      const opts = pointerOpts(e, 1);
      target.dispatchEvent(new PointerEvent("pointerdown", {
        ...opts, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
      }));
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      return target;
    } catch { return null; }
  }

  // 원본이 실제 pointerup을 못 받았을 때만 호출된다(캡처 실패 보완). mouseup·click은 타일 click 쪽(forwardClick)이 보낸다.
  function forwardPointerUp(target, e) {
    try {
      target.dispatchEvent(new PointerEvent("pointerup", {
        ...pointerOpts(e, 0), pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
      }));
    } catch {}
  }

  // 분리된(detached) 요소여도 클릭 리스너는 살아 있으므로 신호를 보낼 수 있다
  function forwardClick(el) {
    if (!el) return false;
    const target = innerButtonOf(el) || el;
    try {
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, view: window, button: 0 }));
      target.click();
      return true;
    } catch { return false; }
  }

  // ---------- 자동 수집 (원본은 제자리에서 숨김) ----------
  function isAutoCandidate(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (isOurs(el) || el.hidden) return false;
    if (el.matches(SKIP_SELECTOR)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    // Shadow DOM 호스트: 호스트 자체는 크기가 없어도 안쪽에 떠 있는 런처가 있으면 후보
    if (el.shadowRoot) return !!shadowLauncherOf(el);
    if (cs.position !== "fixed" && cs.position !== "absolute") return false;
    if (cs.pointerEvents === "none") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 14 || r.height < 14 || r.width > 170 || r.height > 170) return false;
    const clickable =
      el.matches("button,a,[role='button']") ||
      el.querySelector(":scope button, :scope a, :scope [role='button']") ||
      cs.cursor === "pointer";
    return !!clickable;
  }

  function collectAuto(el) {
    if (entries.has(el) || isOurs(el)) return;
    const sig = signatureOf(el);
    if (state.exclusions.some((x) => x.sig === sig)) return;
    markDirty();
    const label = labelOf(el);
    const iconHtml = extractIconHtml(el); // 숨기기 전에 추출
    const key = "auto:" + sig;
    const entry = { kind: "auto", key, el, sig, label, lastAlarm: -1 };
    entry.cell = makeCell(key, label, iconHtml, () => {
      setTimeout(() => closePanel(), 80);
      forwardClick(entry.el);
    }, () => entry.el);
    entry.hideEl = hideTargetOf(el);
    setHidden(entry.hideEl, true);
    itemsBox.append(entry.cell);
    entries.set(el, entry);
    pendingSince.delete(el);
    ensureOrderKey(key);
    layoutItems();
    updateBadges();
    if (settingsView) renderSettings();
  }

  function releaseAuto(entry, exclude) {
    markDirty();
    setHidden(entry.el, false);
    setHidden(entry.hideEl, false);
    unwatchShadow(entry.el);
    entry.cell.remove();
    entries.delete(entry.el);
    if (exclude) {
      if (!state.exclusions.some((x) => x.sig === entry.sig)) {
        state.exclusions.push({ sig: entry.sig, label: entry.label });
      }
      void saveState();
    }
    updateBadges();
  }

  // ---------- 직접 담은 아이콘 (항상 서랍에 표시, 원본은 CSS+인라인으로 숨김) ----------
  function findLiveRuleEl(selector) {
    let found = null;
    try { found = document.querySelector(selector); } catch {}
    if (!found || isOurs(found)) return null;
    return found;
  }

  // 소유 확장이 아이콘을 새로 만들어도 즉시 숨겨지도록 CSS로도 가린다
  function updateHideStyles() {
    if (!hideStyleTag || !hideStyleTag.isConnected) {
      hideStyleTag = document.createElement("style");
      hideStyleTag.dataset.exd = "";
      document.head.append(hideStyleTag);
    }
    const css = state.rules
      // 섀도 호스트 규칙은 CSS로 호스트를 가리면 실행 화면까지 숨겨지므로 제외(인라인으로 런처만 숨김)
      .filter((r) => !findLiveRuleEl(r.selector)?.shadowRoot)
      // 인라인 숨김(setHidden)과 같은 이유로 display:none 대신 visibility를 쓴다(크기·위치 유지)
      .map((r) => `${r.selector}:not([data-exd]):not([data-exd] *){visibility:hidden !important;pointer-events:none !important;}`)
      .join("\n");
    if (hideStyleTag.textContent !== css) hideStyleTag.textContent = css; // 바뀔 때만 써서 불필요한 스타일 재계산을 피한다
  }

  function ensureProxy(rule) {
    let proxy = proxies.get(rule.selector);
    if (proxy) return proxy;
    const key = "rule:" + rule.selector;
    proxy = { kind: "rule", key, rule, lastAlarm: -1, live: null, lastLiveEl: null };
    proxy.cell = makeCell(key, rule.label || "아이콘", rule.icon || "", () => {
      // 화면에서 사라진 버튼이어도 마지막으로 봤던 요소로 클릭 신호를 보낸다
      const target = findLiveRuleEl(rule.selector) || proxy.lastLiveEl;
      if (!target) { toast("이 아이콘을 아직 한 번도 본 적이 없어요. 원래 화면에 한 번 들어갔다 와주세요.", true); return; }
      setTimeout(() => closePanel(), 80);
      if (!forwardClick(target)) toast("아이콘 실행에 실패했어요.", true);
    }, () => findLiveRuleEl(rule.selector) || proxy.lastLiveEl);
    itemsBox.append(proxy.cell);
    proxies.set(rule.selector, proxy);
    ensureOrderKey(key);
    return proxy;
  }

  function syncProxies() {
    updateHideStyles();
    let layoutDirty = false;
    for (const rule of state.rules) {
      const had = proxies.has(rule.selector);
      const proxy = ensureProxy(rule);
      if (!had) layoutDirty = true;
      const live = findLiveRuleEl(rule.selector);
      if (proxy.live !== live) markDirty();
      proxy.live = live;
      if (live) proxy.lastLiveEl = live;
      // 소유 확장 파악: 요소가 있으면 요소 기준, 없으면 셀렉터 토큰으로 스타일시트 탐색
      // (스타일시트 훑기는 요소가 바뀌었거나 일정 시간이 지났을 때만)
      const tokens = selectorTokens(rule.selector);
      const now = Date.now();
      let sheetOwner = proxy.sheetOwner || "";
      if (live !== proxy.ownerCheckedEl || now - (proxy.ownerCheckedAt || 0) >= OWNER_MS) {
        sheetOwner = live ? ownerExtIdFor(live) : ownerExtIdForTokens(tokens);
        proxy.sheetOwner = sheetOwner;
        proxy.ownerCheckedEl = live;
        proxy.ownerCheckedAt = now;
      }
      if (sheetOwner && rule.ownerId !== sheetOwner) {
        rule.ownerId = sheetOwner;
        rule.ownerName = enabledExts?.get(sheetOwner) || rule.ownerName || "";
        void saveState();
      }
      if (rule.ownerId && !rule.ownerName && enabledExts?.has(rule.ownerId)) {
        rule.ownerName = enabledExts.get(rule.ownerId);
        void saveState();
      }
      // 요소도 없고 어떤 활성 확장의 스타일시트에도 흔적이 없으면
      // 소유 확장이 애드온에서 삭제/비활성화된 것으로 판단해 그리드에서 숨긴다
      const removedFromAddons = !live && tokens.length > 0 && !sheetOwner && now - bootAt > 8000;
      if (proxy.removedFromAddons !== removedFromAddons) markDirty();
      proxy.removedFromAddons = removedFromAddons;
      proxy.cell.classList.toggle("is-away", removedFromAddons);
      if (live) {
        if (!proxy.hideEl || !proxy.hideEl.isConnected) proxy.hideEl = hideTargetOf(live);
        setHidden(proxy.hideEl, true);
        watchShadow(live);
        if (!rule.icon) {
          const iconHtml = extractIconHtml(live);
          if (iconHtml) {
            rule.icon = iconHtml;
            proxy.cell.querySelector(".exd-tile-icon").innerHTML = iconMarkup(iconHtml, rule.label);
            void saveState();
          }
        }
        if (alarmPass) setCellAlarm(proxy, alarmCountOf(live));
      } else {
        setCellAlarm(proxy, 0);
      }
    }
    // 규칙이 삭제된 프록시 정리
    for (const [selector, proxy] of Array.from(proxies.entries())) {
      if (!state.rules.some((r) => r.selector === selector)) {
        markDirty();
        const live = findLiveRuleEl(selector);
        if (live) setHidden(live, false);
        setHidden(proxy.hideEl, false);
        unwatchShadow(live);
        unwatchShadow(proxy.lastLiveEl);
        proxy.cell.remove();
        proxies.delete(selector);
        layoutDirty = true;
      }
    }
    if (layoutDirty) layoutItems();
  }

  function removeProxy(selector, deleteRule) {
    markDirty();
    const proxy = proxies.get(selector);
    const live = findLiveRuleEl(selector);
    if (live) setHidden(live, false);
    setHidden(proxy?.hideEl, false);
    unwatchShadow(live);
    unwatchShadow(proxy?.lastLiveEl);
    proxy?.cell.remove();
    proxies.delete(selector);
    if (deleteRule) {
      state.rules = state.rules.filter((r) => r.selector !== selector);
      void saveState();
    }
    updateHideStyles();
    updateBadges();
  }

  function releaseAll() {
    for (const entry of Array.from(entries.values())) releaseAuto(entry, false);
    for (const selector of Array.from(proxies.keys())) removeProxy(selector, false);
  }

  // ---------- 스캔 주기 조절 ----------
  // 채팅 앱 특성상 새로 담길 런처는 확장 설치·화면 이동 때나 생긴다. 변화가 없는 스캔이 이어지면 간격을
  // 1.2초 → 2.4 → 4.8 → 6초로 늘려 쉬고, 화면이 바뀌는 신호(DOM 감시자·탭 복귀·창 크기 변화·서랍 열기)가
  // 오면 즉시 활동 간격으로 돌아온다. 탭이 보이지 않는 동안은 아예 쉰다.
  let scanTimer = null, scanDelay = SCAN_MS, quietScans = 0, scanDirty = false;
  let lastScanAt = 0, scanDueAt = 0, lastAlarmAt = 0, alarmPass = true;
  const debugStats = (() => { try { return localStorage.getItem("exd-debug") === "1"; } catch { return false; } })();
  function markDirty() { scanDirty = true; }
  // 인앱 브라우저처럼 document.hidden이 항상 true인 환경에서 테스트할 때는 localStorage exd-always-scan=1
  function alwaysScan() { try { return localStorage.getItem("exd-always-scan") === "1"; } catch { return false; } }
  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = null;
    if (document.hidden && !alwaysScan()) return; // visibilitychange에서 다시 깨운다
    scanDueAt = Date.now() + delay;
    scanTimer = setTimeout(scan, delay);
  }
  // 화면 변화 신호용. 스트리밍처럼 변화가 쉴 새 없이 올 때도 스캔은 SCAN_MS(1.2초)에 한 번을 넘지 않는다.
  function wake(delay = 300, minGap = SCAN_MS) {
    quietScans = 0;
    scanDelay = SCAN_MS;
    const now = Date.now();
    const due = Math.max(now + delay, lastScanAt + minGap);
    if (scanTimer && scanDueAt <= due) return; // 이미 그보다 빨리 돌 예정
    scheduleScan(Math.max(0, due - now));
  }
  // 사용자 동작용(서랍 열기·설정 변경·탭 복귀): 간격 제한 없이 바로
  function wakeNow() { wake(0, 0); }

  // ---------- 주기 스캔 ----------
  function scan() {
    const t0 = debugStats ? performance.now() : 0;
    try {
      const now = Date.now();
      lastScanAt = now;
      alarmPass = panelOpen || now - lastAlarmAt >= ALARM_MS;
      if (alarmPass) lastAlarmAt = now;

      ensureAnchors();
      void refreshEnabledExts(false);

      // 소유 확장이 비활성화되어 사라진 자동 항목 정리
      for (const [el, entry] of Array.from(entries.entries())) {
        if (!el.isConnected) {
          markDirty();
          entry.cell.remove();
          entries.delete(el);
          unwatchShadow(el);
        }
      }

      syncProxies();

      if (state.autoCollect) {
        for (const el of Array.from(document.body.children)) {
          if (entries.has(el)) continue;
          if (!isAutoCandidate(el)) { pendingSince.delete(el); continue; }
          const first = pendingSince.get(el);
          if (!first) { pendingSince.set(el, now); markDirty(); continue; } // 후보가 생겼으니 활동 간격 유지
          if (now - first >= PENDING_MS) collectAuto(el);
        }
        for (const el of Array.from(pendingSince.keys())) {
          if (!el.isConnected) pendingSince.delete(el);
        }
      }

      for (const entry of entries.values()) {
        if (entry.el.isConnected) {
          // 소유 확장이 런처를 새로 그렸으면 숨길 대상을 다시 찾아 숨긴다
          if (!entry.hideEl || !entry.hideEl.isConnected) entry.hideEl = hideTargetOf(entry.el);
          setHidden(entry.hideEl, true);
          watchShadow(entry.el);
        }
        if (alarmPass) setCellAlarm(entry, alarmCountOf(entry.el));
      }
      updateBadges();
    } catch (err) {
      console.warn("[확장 서랍] scan error:", err);
    } finally {
      if (scanDirty) { quietScans = 0; scanDelay = SCAN_MS; }
      else if (++quietScans >= QUIET_STEPS) { quietScans = 0; scanDelay = Math.min(SCAN_MAX_MS, scanDelay * 2); }
      scanDirty = false;
      if (debugStats) {
        const s = (window.__exdScanStats ||= { count: 0, totalMs: 0, maxMs: 0 });
        const dt = performance.now() - t0;
        s.count++; s.totalMs += dt; s.maxMs = Math.max(s.maxMs, dt); s.lastMs = dt; s.lastDelay = scanDelay; s.alarmPass = alarmPass;
      }
      scheduleScan(scanDelay);
    }
  }

  // ---------- 앵커 (상단 바 버튼 / 플로팅 버튼) ----------
  // 채팅방 툴바의 ⋯(더 보기) 버튼: 모바일 확장이 채팅방에서 상단 바를 숨길 때의 대체 자리
  function findChatMoreButton() {
    let candidates = [];
    try { candidates = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')); } catch { return null; }
    for (const btn of candidates) {
      if (isOurs(btn) || btn.offsetParent === null) continue;
      if (btn.querySelector("svg.lucide-ellipsis, svg.lucide-more-horizontal") || btn.getAttribute("aria-label") === "More options") return btn;
    }
    return null;
  }

  // ⋯ 버튼의 클래스 중 "열림/활성" 상태 표시용만 빼고 기본 모양 클래스를 가져온다
  function nativeToolbarClasses(model) {
    return String(model?.className || "")
      .split(/\s+/)
      .filter((c) => c && !/--open|--active|-active\)\]/.test(c) && !(/-hover\)\]$/.test(c) && !c.startsWith("hover:")))
      .join(" ");
  }

  function ensureAnchors() {
    if (state.mode === "topbar") {
      if (fab) fab.style.display = "none";
      if (!topbarBtn) {
        topbarBtn = document.createElement("button");
        topbarBtn.type = "button";
        topbarBtn.className = "exd-topbar-btn";
        topbarBtn.dataset.exd = "";
        topbarBtn.title = "확장 서랍";
        topbarBtn.setAttribute("aria-label", "확장 서랍 열기");
        topbarBtn.innerHTML = `${SVG_DRAWER}<i class="exd-badge" hidden>0</i>`;
        topbarBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(); });
      }
      // 모바일 확장의 ∨(상단 도구 펼치기)가 있으면 그 바로 뒤에 둔다: [∨][서랍]
      const mobileChevron = document.getElementById("marinara-mobile-actions-button");
      // 기본: 메인 컨트롤(채팅·홈 버튼 그룹) 끝에 넣는다; 없으면 오른쪽 패널 메뉴로 폴백
      const nav = document.querySelector(".mari-topbar-left-controls") || document.querySelector('nav[data-tour="panel-buttons"]');
      const mobileDock = !!(mobileChevron?.isConnected && mobileChevron.offsetParent !== null);
      // 상단 바 자체가 숨겨진 경우(모바일 확장의 채팅방 전체화면): 채팅 툴바의 ⋯ 왼쪽에 둔다
      const header = document.querySelector('header[data-component="TopBar"]');
      const topbarVisible = !!header && header.offsetParent !== null;
      const chatMore = topbarVisible ? null : findChatMoreButton();
      // 버튼 클래스는 한 곳에서 조립한다. ⋯ 옆에 설 때는 ⋯의 네이티브 클래스(배경·테두리·크기)를
      // 그대로 빌려 어떤 테마에서도 같은 모양이 되게 하고, 그 외엔 서랍 기본 스타일만 쓴다.
      const nextClass = [
        "exd-topbar-btn",
        chatMore ? "is-chat-dock" : "",
        !chatMore && mobileDock ? "is-mobile-dock" : "", // 모바일 확장 옆에 설 때만 버튼을 조금 키운다
        chatMore ? nativeToolbarClasses(chatMore) : "",
      ].filter(Boolean).join(" ");
      if (topbarBtn.className !== nextClass) { topbarBtn.className = nextClass; markDirty(); }
      if (chatMore) {
        // 익명 커뮤니티 등 다른 확장도 "⋯ 바로 왼쪽"을 고집하므로, 서랍은 바로 옆자리를 고집하지 않고
        // "같은 줄에서 ⋯보다 앞"이기만 하면 그대로 둔다(자리 싸움·깜빡임 방지)
        const wrapper = chatMore.parentElement || chatMore;
        const parent = wrapper.parentElement;
        const placedBefore = !!parent && topbarBtn.parentElement === parent &&
          !!(topbarBtn.compareDocumentPosition(wrapper) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (!placedBefore) { wrapper.before(topbarBtn); markDirty(); }
      } else if (mobileDock) {
        if (topbarBtn.previousElementSibling !== mobileChevron) { mobileChevron.after(topbarBtn); markDirty(); }
      } else if (nav) {
        if (!topbarBtn.isConnected || nav.lastElementChild !== topbarBtn) { nav.append(topbarBtn); markDirty(); }
      } else if (fab) {
        fab.style.display = "";
        positionFab();
      }
    } else {
      if (topbarBtn?.isConnected) topbarBtn.remove();
      if (fab) { fab.style.display = ""; positionFab(); }
    }
  }

  function dockSide() {
    const EDGE = 36;
    const px = state.floatPos.x * window.innerWidth;
    const py = state.floatPos.y * window.innerHeight;
    const d = { left: px, right: window.innerWidth - px, top: py, bottom: window.innerHeight - py };
    const min = Math.min(d.left, d.right, d.top, d.bottom);
    if (min > EDGE) return null;
    if (min === d.left) return "left";
    if (min === d.right) return "right";
    if (min === d.top) return "top";
    return "bottom";
  }

  function positionFab() {
    if (!fab) return;
    const dock = dockSide();
    for (const side of ["left", "right", "top", "bottom"]) {
      fab.classList.toggle("exd-dock-" + side, dock === side);
    }
    const w = fab.offsetWidth || 46;
    const h = fab.offsetHeight || 46;
    const px = state.floatPos.x * window.innerWidth;
    const py = state.floatPos.y * window.innerHeight;
    let left, top;
    if (dock === "left") { left = 0; top = py - h / 2; }
    else if (dock === "right") { left = window.innerWidth - w; top = py - h / 2; }
    else if (dock === "top") { top = 0; left = px - w / 2; }
    else if (dock === "bottom") { top = window.innerHeight - h; left = px - w / 2; }
    else { left = px - w / 2; top = py - h / 2; }
    left = Math.min(window.innerWidth - w, Math.max(0, left));
    top = Math.min(window.innerHeight - h, Math.max(0, top));
    fab.style.left = `${Math.round(left)}px`;
    fab.style.top = `${Math.round(top)}px`;
  }

  function installFab() {
    fab = document.createElement("button");
    fab.type = "button";
    fab.className = "exd-fab";
    fab.dataset.exd = "";
    fab.title = "확장 서랍 (드래그로 이동)";
    fab.setAttribute("aria-label", "확장 서랍 열기");
    fab.innerHTML = `<span class="exd-fab-icon">${SVG_DRAWER}</span><i class="exd-badge" hidden>0</i>`;
    fab.style.display = "none";
    document.body.append(fab);
    positionFab();

    let startX = 0, startY = 0, startPos = null;
    fab.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragMoved = false;
      startX = e.clientX; startY = e.clientY;
      startPos = { ...state.floatPos };
      fab.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!dragMoved && Math.hypot(dx, dy) < 5) return;
        dragMoved = true;
        state.floatPos = {
          x: Math.min(1, Math.max(0, startPos.x + dx / window.innerWidth)),
          y: Math.min(1, Math.max(0, startPos.y + dy / window.innerHeight)),
        };
        positionFab();
        if (panelOpen) positionPanel();
      };
      const up = () => {
        fab.removeEventListener("pointermove", move);
        fab.removeEventListener("pointerup", up);
        fab.removeEventListener("pointercancel", up);
        if (dragMoved) void saveState();
      };
      fab.addEventListener("pointermove", move);
      fab.addEventListener("pointerup", up);
      fab.addEventListener("pointercancel", up);
    });
    fab.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dragMoved) { dragMoved = false; return; }
      togglePanel();
    });
    window.addEventListener("resize", positionFab);
    cleanupFns.push(() => window.removeEventListener("resize", positionFab));
  }

  // ---------- 배지: 담긴 확장들의 알람 합계 ----------
  function updateBadges() {
    let alarms = 0;
    for (const entry of entries.values()) alarms += Math.max(0, entry.lastAlarm || 0);
    for (const proxy of proxies.values()) alarms += Math.max(0, proxy.lastAlarm || 0);
    alarms = Math.min(alarms, 999);
    for (const btn of [fab, topbarBtn]) {
      const badge = btn?.querySelector(".exd-badge");
      if (!badge) continue;
      badge.textContent = String(alarms);
      badge.hidden = alarms === 0;
    }
    if (emptyMsg) emptyMsg.hidden = settingsView || entries.size + proxies.size !== 0;
  }

  // ---------- 패널 ----------
  function installPanel() {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.dataset.exd = "";
    panel.hidden = true;
    panel.innerHTML = `
      <header class="exd-head">
        <button type="button" class="exd-icon-btn exd-head-back" title="아이콘 목록으로" hidden>${SVG_BACK}</button>
        <strong class="exd-head-title">확장 서랍</strong>
        <span class="exd-head-spacer"></span>
        <button type="button" class="exd-icon-btn exd-head-pick" title="직접 담기">${SVG_PLUS}</button>
        <button type="button" class="exd-icon-btn exd-head-gear" title="설정">${SVG_GEAR}</button>
      </header>
      <div class="exd-items"></div>
      <p class="exd-empty">아직 담긴 아이콘이 없어요.<br>화면 고정 아이콘은 자동으로 담기고,<br>+ 버튼으로 직접 담을 수도 있어요.</p>
      <div class="exd-settings" hidden></div>
    `;
    document.body.append(panel);
    itemsBox = panel.querySelector(".exd-items");
    settingsBox = panel.querySelector(".exd-settings");
    emptyMsg = panel.querySelector(".exd-empty");

    panel.querySelector(".exd-head-gear").addEventListener("click", () => setSettingsView(!settingsView));
    panel.querySelector(".exd-head-back").addEventListener("click", () => setSettingsView(false));
    panel.querySelector(".exd-head-pick").addEventListener("click", () => startPickMode());

    document.addEventListener("pointerdown", onOutsidePointer, true);
    cleanupFns.push(() => document.removeEventListener("pointerdown", onOutsidePointer, true));
    document.addEventListener("keydown", onKeydown);
    cleanupFns.push(() => document.removeEventListener("keydown", onKeydown));
  }

  function onOutsidePointer(e) {
    if (!e.isTrusted) return; // 우리가 복제해 보낸 포인터 신호를 바깥 클릭으로 오인하지 않기
    if (pickMode || !panelOpen) return;
    const t = e.target;
    if (panel.contains(t)) return;
    if (fab?.contains(t) || topbarBtn?.contains(t)) return;
    closePanel();
  }

  function onKeydown(e) {
    if (e.key !== "Escape") return;
    if (pickMode) { stopPickMode(); return; }
    if (panelOpen) closePanel();
  }

  function setSettingsView(on) {
    settingsView = !!on;
    itemsBox.hidden = settingsView;
    emptyMsg.hidden = settingsView || entries.size + proxies.size !== 0;
    settingsBox.hidden = !settingsView;
    panel.querySelector(".exd-head-back").hidden = !settingsView;
    panel.querySelector(".exd-head-title").textContent = settingsView ? "서랍 설정" : "확장 서랍";
    if (settingsView) renderSettings();
    if (panelOpen) requestAnimationFrame(positionPanel);
  }

  function positionPanel() {
    const margin = 10;
    const pw = Math.min(300, window.innerWidth - 16);
    panel.style.width = `${pw}px`;
    let anchor = state.mode === "topbar" && topbarBtn?.isConnected ? topbarBtn : fab;
    if (!anchor || !anchor.isConnected) anchor = topbarBtn?.isConnected ? topbarBtn : fab;
    const r = anchor.getBoundingClientRect();
    const ph = panel.offsetHeight || 220;
    let top = r.bottom + margin;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - margin - ph);
    let left = r.right - pw;
    if (left < 8) left = Math.min(window.innerWidth - pw - 8, Math.max(8, r.left));
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
  }

  function togglePanel() { panelOpen ? closePanel() : openPanel(); }

  function openPanel() {
    panelOpen = true;
    panel.hidden = false;
    wakeNow(); // 열 때는 배지·상태를 바로 갱신
    setSettingsView(false);
    layoutItems();
    panel.classList.remove("is-anim");
    void panel.offsetWidth;
    panel.classList.add("is-anim");
    positionPanel();
    requestAnimationFrame(positionPanel);
  }

  function closePanel() {
    panelOpen = false;
    panel.hidden = true;
  }

  // ---------- 설정 화면 ----------
  function renderSettings() {
    const items = displayItems();
    const itemRows = items.map((item, i) => {
      const label = item.kind === "auto" ? item.label : (item.rule.label || item.rule.selector);
      const tag = item.kind === "auto" ? "자동" : "직접";
      const removed = item.kind === "rule" && item.removedFromAddons;
      return `<div class="exd-row">
        <span class="exd-row-tag is-${item.kind}">${tag}</span>
        <span class="exd-row-name">${esc(label)}${removed ? ` <em class="exd-row-away">애드온에 없음</em>` : ""}</span>
        <span class="exd-row-actions">
          <button type="button" class="exd-mini" data-exd-up="${i}" title="위로" ${i === 0 ? "disabled" : ""}>${SVG_UP}</button>
          <button type="button" class="exd-mini" data-exd-down="${i}" title="아래로" ${i === items.length - 1 ? "disabled" : ""}>${SVG_DOWN}</button>
          <button type="button" class="exd-mini" data-exd-remove="${i}" title="서랍에서 빼기">${SVG_MINUS}</button>
        </span>
      </div>`;
    }).join("");
    // 예전 데이터에 이름이 없으면 시그니처에서 사람이 읽을 만한 부분을 추출
    const prettySig = (sig) => {
      const at = sig.indexOf("@");
      if (at !== -1 && at < sig.length - 1) return sig.slice(at + 1);
      return sig.replace(/^#/, "").replace(/^[a-z]+\./, "");
    };
    const exclusionRows = state.exclusions.map((x, i) =>
      `<div class="exd-row"><span class="exd-row-name">${esc(x.label || prettySig(x.sig))}</span><button type="button" class="exd-mini exd-mini-text" data-exd-restore="${i}">다시 담기</button></div>`).join("");
    settingsBox.innerHTML = `
      <section>
        <h4>서랍 위치</h4>
        <div class="exd-choice-row">
          <label class="exd-choice"><input type="radio" name="exd-mode" value="topbar" ${state.mode === "topbar" ? "checked" : ""}> 상단 메뉴</label>
          <label class="exd-choice"><input type="radio" name="exd-mode" value="floating" ${state.mode === "floating" ? "checked" : ""}> 아이콘 띄우기 <span class="exd-note-inline">이동 가능</span></label>
        </div>
      </section>
      <section>
        <h4>수집</h4>
        <label class="exd-choice"><input type="checkbox" data-exd-auto ${state.autoCollect ? "checked" : ""}> 화면 고정 아이콘 자동으로 담기</label>
        <p class="exd-note-sub">홈 화면 아이콘 등 나머지는 직접 담기로 추가가능</p>
        <button type="button" class="exd-btn" data-exd-pick>직접 담기</button>
      </section>
      <section>
        <h4>담긴 아이콘 <span class="exd-count">${items.length}</span></h4>
        ${itemRows || `<p class="exd-note">비어 있어요.</p>`}
      </section>
      ${state.exclusions.length ? `<section><h4>제외한 아이콘</h4>${exclusionRows}</section>` : ""}
    `;
    settingsBox.querySelectorAll("input[name='exd-mode']").forEach((input) => {
      input.addEventListener("change", () => {
        state.mode = input.value === "floating" ? "floating" : "topbar";
        void saveState();
        ensureAnchors();
        if (panelOpen) positionPanel();
      });
    });
    settingsBox.querySelector("[data-exd-auto]").addEventListener("change", (e) => {
      state.autoCollect = !!e.target.checked;
      void saveState();
      wakeNow();
    });
    settingsBox.querySelector("[data-exd-pick]").addEventListener("click", () => startPickMode());
    settingsBox.querySelectorAll("[data-exd-up]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = displayItems()[Number(btn.dataset.exdUp)];
        if (item) { moveItem(item.key, -1); renderSettings(); }
      });
    });
    settingsBox.querySelectorAll("[data-exd-down]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = displayItems()[Number(btn.dataset.exdDown)];
        if (item) { moveItem(item.key, 1); renderSettings(); }
      });
    });
    settingsBox.querySelectorAll("[data-exd-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = displayItems()[Number(btn.dataset.exdRemove)];
        if (!item) return;
        if (item.kind === "auto") { releaseAuto(item, true); toast(`"${item.label}"을(를) 원래 자리로 되돌렸어요.`); }
        else { removeProxy(item.rule.selector, true); toast(`"${item.rule.label || "아이콘"}"을(를) 원래 자리로 되돌렸어요.`); }
        renderSettings();
      });
    });
    settingsBox.querySelectorAll("[data-exd-restore]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.exclusions.splice(Number(btn.dataset.exdRestore), 1);
        void saveState();
        wakeNow();
        renderSettings();
        toast("다음 스캔부터 다시 자동으로 담아요.");
      });
    });
  }

  // ---------- 직접 담기 (픽 모드) ----------
  function pickRootFrom(target) {
    let el = target instanceof Element ? target : null;
    if (!el || isOurs(el)) return null;
    let cur = el.closest("button,a,[role='button']") || el;
    if (isOurs(cur)) return null;
    while (cur.parentElement && cur.parentElement !== document.body) {
      const p = cur.parentElement;
      if (p.id === "root" || p === document.documentElement) break;
      const r = p.getBoundingClientRect();
      if (r.width > 200 || r.height > 200) break;
      // 버튼이 여럿 들어 있는 상자(툴바 등)까지 올라가면 그 상자 전체를 숨기게 되므로 여기서 멈춘다
      if (p.querySelectorAll("button, a, [role='button']").length > 1) break;
      cur = p;
    }
    const r = cur.getBoundingClientRect();
    if (r.width > 220 || r.height > 220) return null;
    return cur;
  }

  function selectorFor(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [el.tagName.toLowerCase()];
    const cls = Array.from(el.classList).slice(0, 2);
    for (const c of cls) parts.push("." + CSS.escape(c));
    const label = el.getAttribute("aria-label");
    if (label) return `${parts.join("")}[aria-label="${CSS.escape(label)}"]`;
    return parts.join("");
  }

  function startPickMode() {
    if (pickMode) return;
    pickMode = true;
    closePanel();
    pickHint = document.createElement("div");
    pickHint.className = "exd-pick-hint";
    pickHint.dataset.exd = "";
    pickHint.textContent = "담고 싶은 아이콘을 클릭하세요 · Esc 취소";
    document.body.append(pickHint);
    pickHighlight = document.createElement("div");
    pickHighlight.className = "exd-pick-highlight";
    pickHighlight.dataset.exd = "";
    document.body.append(pickHighlight);
    document.addEventListener("mousemove", onPickMove, true);
    document.addEventListener("click", onPickClick, true);
  }

  function stopPickMode() {
    pickMode = false;
    pickHint?.remove(); pickHint = null;
    pickHighlight?.remove(); pickHighlight = null;
    document.removeEventListener("mousemove", onPickMove, true);
    document.removeEventListener("click", onPickClick, true);
  }

  function onPickMove(e) {
    const root = pickRootFrom(e.target);
    if (!root) { pickHighlight.style.display = "none"; return; }
    const r = root.getBoundingClientRect();
    pickHighlight.style.display = "";
    pickHighlight.style.top = `${r.top - 3}px`;
    pickHighlight.style.left = `${r.left - 3}px`;
    pickHighlight.style.width = `${r.width + 6}px`;
    pickHighlight.style.height = `${r.height + 6}px`;
  }

  function onPickClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const root = pickRootFrom(e.target);
    stopPickMode();
    if (!root) { toast("담을 수 있는 아이콘이 아니에요.", true); return; }
    if (entries.has(root) || root.closest("[data-exd]")) { toast("이미 서랍에 담겨 있는 아이콘이에요.", true); return; }
    const selector = selectorFor(root);
    let resolved = null;
    try { resolved = document.querySelector(selector); } catch {}
    if (resolved !== root) { toast("이 아이콘은 고유하게 식별할 수 없어 담지 못했어요.", true); return; }
    const label = labelOf(root);
    const sig = signatureOf(root);
    state.exclusions = state.exclusions.filter((x) => x.sig !== sig);
    if (!state.rules.some((rl) => rl.selector === selector)) {
      const ownerId = ownerExtIdFor(root);
      state.rules.push({
        selector, label, icon: extractIconHtml(root),
        ownerId, ownerName: (ownerId && enabledExts?.get(ownerId)) || "",
      });
    }
    void saveState();
    syncProxies();
    updateBadges();
    toast(`"${label}"을(를) 서랍에 담았어요.`);
    openPanel();
  }

  // ---------- 시작/정리 ----------
  function start() {
    installFab();
    installPanel();
    ensureAnchors();
    // 화면 어디든 요소가 생기거나 사라지면(새 런처·화면 이동·앱 재렌더) 깨운다. 우리 자신이 만든 변화는 무시.
    const isOurRecord = (rec) => {
      if (rec.target instanceof Element && rec.target.closest("[data-exd]")) return true;
      const nodes = [...rec.addedNodes, ...rec.removedNodes];
      return nodes.length > 0 && nodes.every((n) => n instanceof Element && n.matches("[data-exd]"));
    };
    bodyObserver = new MutationObserver((records) => {
      if (records.every(isOurRecord)) return;
      wake(300);
    });
    bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
    // 모바일 확장이 채팅방 전체화면을 켜고 끌 때처럼 body 클래스만 바뀌는 경우(상단 바 숨김 → 서랍 자리 이동)
    bodyAttrObserver = new MutationObserver(() => wake(300));
    bodyAttrObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const onVisibility = () => { if (document.hidden && !alwaysScan()) scheduleScan(0); else wakeNow(); }; // 숨김이면 scheduleScan이 타이머만 지운다
    const onResize = () => wake(300);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    window.addEventListener("resize", onResize);
    cleanupFns.push(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener("resize", onResize);
    });
    scan();
  }

  function cleanup() {
    stopPickMode();
    clearTimeout(scanTimer);
    scanTimer = null;
    bodyObserver?.disconnect();
    bodyAttrObserver?.disconnect();
    unanchorAll();
    releaseAll();
    for (const host of Array.from(shadowObservers.keys())) unwatchShadow(host);
    for (const fn of cleanupFns.splice(0)) { try { fn(); } catch {} }
    fab?.remove(); topbarBtn?.remove(); panel?.remove();
    hideStyleTag?.remove();
    document.querySelector(".exd-toast")?.remove();
  }

  try {
    if (typeof marinara !== "undefined" && typeof marinara?.onCleanup === "function") marinara.onCleanup(cleanup);
  } catch {}

  const boot = () => { void loadState().then(start); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
