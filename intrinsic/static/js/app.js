import {
  buildAnalysis,
  defaultAssumptions,
  currencySymbol,
  isFinancialCompany,
} from "./valuation.js";

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

const state = {
  company: null,
  assumptions: null,
  analysis: null,
  symbol: null,
  loading: false,
  watchlist: loadWatchlist(),
  searchResults: [],
  activeSuggestion: -1,
  loadStartedAt: 0,
  loadedSymbol: null,
  qRendered: false,
  searchAbort: null,
  loadAbort: null,
  peerAbort: null,
  peerSeq: 0,
  contextLoaded: false,
  peers: null,
  peerLoading: false,
  peerError: null,
  lastQuoteAt: null,
  updateTimer: null,
  updateChecking: false,
  updating: false,
  toastTimer: null,
  methodOpen: false,
};

const POPULAR = [
  { symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", sector: "Technology" },
  { symbol: "MSFT", name: "Microsoft Corporation", exchange: "NASDAQ", sector: "Technology" },
  { symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", sector: "Technology" },
  { symbol: "AMZN", name: "Amazon.com, Inc.", exchange: "NASDAQ", sector: "Consumer Cyclical" },
  { symbol: "GOOGL", name: "Alphabet Inc.", exchange: "NASDAQ", sector: "Communication Services" },
  { symbol: "META", name: "Meta Platforms, Inc.", exchange: "NASDAQ", sector: "Communication Services" },
  { symbol: "TSLA", name: "Tesla, Inc.", exchange: "NASDAQ", sector: "Consumer Cyclical" },
  { symbol: "JPM", name: "JPMorgan Chase & Co.", exchange: "NYSE", sector: "Financial Services" },
  { symbol: "KO", name: "The Coca-Cola Company", exchange: "NYSE", sector: "Consumer Defensive" },
  { symbol: "JNJ", name: "Johnson & Johnson", exchange: "NYSE", sector: "Healthcare" },
  { symbol: "XOM", name: "Exxon Mobil Corporation", exchange: "NYSE", sector: "Energy" },
  { symbol: "BRK-B", name: "Berkshire Hathaway Inc.", exchange: "NYSE", sector: "Financial Services" },
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));

function money(value, currency = "USD", digits = 2) {
  if (!Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency === "GBp" ? "GBP" : currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(currency === "GBp" ? value / 100 : value);
  } catch {
    return `${currencySymbol(currency)}${value.toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`;
  }
}

function moneyCompact(value, currency = "USD") {
  if (!Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency === "GBp" ? "GBP" : currency,
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(currency === "GBp" ? value / 100 : value);
  } catch {
    const abs = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    if (abs >= 1e12) return `${sign}${currencySymbol(currency)}${(abs / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${sign}${currencySymbol(currency)}${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}${currencySymbol(currency)}${(abs / 1e6).toFixed(2)}M`;
    return money(value, currency, 0);
  }
}

function pct(value, digits = 1, signed = false) {
  if (!Number.isFinite(value)) return "—";
  const formatted = `${(Math.abs(value) * 100).toFixed(digits)}%`;
  if (!signed) return value < 0 ? `−${formatted}` : formatted;
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

function num(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function ratio(value, suffix = "×") {
  return Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : "—";
}

function signedClass(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.0005) return "";
  return value > 0 ? "positive" : "negative";
}

function fmtDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtQuoteTime(epoch) {
  if (!epoch) return "—";
  const date = new Date(epoch * 1000);
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function recommendationLabel(key) {
  const labels = {
    strong_buy: "Strong buy",
    buy: "Buy",
    hold: "Hold",
    underperform: "Underperform",
    sell: "Sell",
    none: "No consensus",
  };
  return labels[String(key || "").toLowerCase()] || (key ? String(key).replace(/_/g, " ") : "No consensus");
}

function splitValue(value, currency) {
  if (!Number.isFinite(value)) return { symbol: currencySymbol(currency), main: "—", cents: "" };
  const symbol = currencySymbol(currency);
  const fixed = value.toFixed(2);
  const [main, cents] = fixed.split(".");
  return { symbol, main: Number(main).toLocaleString("en-US"), cents: cents ? `.${cents}` : "" };
}

function nice(value, digits = 0) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/* -------------------------------------------------------------------------- */
/* Theme                                                                       */
/* -------------------------------------------------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const icon = $("#themeToggle use");
  if (icon) icon.setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  $("#themeToggle")?.setAttribute("title", theme === "dark" ? "Switch to paper theme" : "Switch to ink theme");
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#121211" : "#f4f3ef");
  try {
    localStorage.setItem("intrinsic.theme", theme);
  } catch {
    /* ignore */
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem("intrinsic.theme");
  } catch {
    /* ignore */
  }
  // Paper is the canonical mode for this design; ink is the alternative.
  applyTheme(saved === "dark" ? "dark" : "light");
}

/* -------------------------------------------------------------------------- */
/* Watchlist                                                                   */
/* -------------------------------------------------------------------------- */

function loadWatchlist() {
  try {
    const raw = JSON.parse(localStorage.getItem("intrinsic.watchlist.v1") || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((item) => item && typeof item.symbol === "string").slice(0, 40);
  } catch {
    return [];
  }
}

function persistWatchlist() {
  try {
    localStorage.setItem("intrinsic.watchlist.v1", JSON.stringify(state.watchlist));
  } catch {
    /* ignore */
  }
}

function isWatched(symbol) {
  return state.watchlist.some((item) => item.symbol === symbol);
}

function saveCurrentToWatchlist() {
  const c = state.company;
  if (!c) return;
  if (isWatched(c.symbol)) {
    state.watchlist = state.watchlist.filter((item) => item.symbol !== c.symbol);
    toast(`${c.symbol} removed from watchlist`);
  } else {
    state.watchlist.unshift({
      symbol: c.symbol,
      name: c.name,
      exchange: c.exchange,
      currency: c.currency,
      price: c.price.last,
      upside: state.analysis?.upside ?? null,
      addedAt: new Date().toISOString(),
    });
    state.watchlist = state.watchlist.slice(0, 40);
    toast(`${c.symbol} saved to watchlist`);
  }
  persistWatchlist();
  renderWatchlist();
  syncWatchButtons();
}

function syncWatchButtons() {
  const c = state.company;
  const toggle = $("#watchToggle");
  const count = $("#watchCount");
  if (count) count.textContent = String(state.watchlist.length);
  if (!toggle || !c) return;
  const watched = isWatched(c.symbol);
  toggle.classList.toggle("active", watched);
  const label = $("span", toggle);
  if (label) label.textContent = watched ? "Saved" : "Save";
  const use = $("use", toggle);
  if (use) use.style.fill = watched ? "currentColor" : "none";
}

function renderWatchlist() {
  const list = $("#watchList");
  const empty = $("#watchEmpty");
  const clear = $("#clearWatchlist");
  if (!list || !empty) return;
  if (!state.watchlist.length) {
    list.innerHTML = "";
    list.hidden = true;
    empty.hidden = false;
    if (clear) clear.hidden = true;
    $("#watchCount").textContent = "0";
    return;
  }
  list.hidden = false;
  empty.hidden = true;
  if (clear) clear.hidden = false;
  list.innerHTML = state.watchlist
    .map((item) => {
      const upside = Number.isFinite(item.upside) ? item.upside : null;
      return `
        <div class="watch-item">
          <div class="watch-mark">${esc((item.symbol || "?").replace(/[^A-Z0-9]/gi, "").slice(0, 2))}</div>
          <div class="watch-info">
            <button type="button" data-load-watch="${esc(item.symbol)}">${esc(item.name || item.symbol)}</button>
            <span>${esc(item.symbol)}${item.exchange ? ` · ${esc(item.exchange)}` : ""}</span>
          </div>
          <div class="watch-side">
            <strong>${money(item.price, item.currency || "USD")}</strong>
            <span class="${signedClass(upside)}" style="font-family:var(--mono);font-size:8px">${upside === null ? "" : pct(upside, 1, true)}</span>
            <button type="button" data-remove-watch="${esc(item.symbol)}">Remove</button>
          </div>
        </div>`;
    })
    .join("");
  $("#watchCount").textContent = String(state.watchlist.length);
}

function openWatchlist() {
  const drawer = $("#watchlistDrawer");
  const backdrop = $("#drawerBackdrop");
  if (!drawer || !backdrop) return;
  renderWatchlist();
  backdrop.hidden = false;
  requestAnimationFrame(() => backdrop.classList.add("visible"));
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  $("#watchlistButton")?.setAttribute("aria-expanded", "true");
  document.body.classList.add("drawer-open");
  setTimeout(() => $("#closeWatchlist")?.focus(), 120);
}

function closeWatchlist() {
  const drawer = $("#watchlistDrawer");
  const backdrop = $("#drawerBackdrop");
  if (!drawer || !backdrop) return;
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  backdrop.classList.remove("visible");
  $("#watchlistButton")?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("drawer-open");
  setTimeout(() => {
    backdrop.hidden = true;
  }, 250);
}

/* -------------------------------------------------------------------------- */
/* Toast                                                                       */
/* -------------------------------------------------------------------------- */

function toast(message) {
  const node = $("#toast");
  if (!node) return;
  clearTimeout(state.toastTimer);
  node.textContent = message;
  node.classList.add("show");
  state.toastTimer = setTimeout(() => node.classList.remove("show"), 2400);
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

function localSearch(query) {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  return POPULAR.filter(
    (item) =>
      item.symbol.toLowerCase().includes(needle) ||
      item.name.toLowerCase().replace(/[\s.,]/g, "").includes(needle)
  ).slice(0, 8);
}

function setSearchExpanded(open) {
  const input = $("#searchInput");
  const dropdown = $("#suggestions");
  if (!input || !dropdown) return;
  input.setAttribute("aria-expanded", String(open));
  dropdown.hidden = !open;
}

function hideSuggestions() {
  state.searchResults = [];
  state.activeSuggestion = -1;
  setSearchExpanded(false);
}

function renderSuggestions(results, query) {
  const dropdown = $("#suggestions");
  if (!dropdown) return;
  state.searchResults = results;
  state.activeSuggestion = results.length ? 0 : -1;
  if (!results.length) {
    dropdown.innerHTML = `<div class="suggestion-empty">No matches for “${esc(query)}”. Try a ticker such as AAPL, or a fuller company name.</div>`;
    setSearchExpanded(true);
    return;
  }
  dropdown.innerHTML = results
    .map((item, index) => {
      const mark = (item.symbol || "?").replace(/[^A-Z0-9]/gi, "").slice(0, 2).toUpperCase();
      return `
        <button type="button" class="suggestion-item${index === 0 ? " active" : ""}" role="option" aria-selected="${index === 0}" data-suggestion="${index}" data-symbol="${esc(item.symbol)}">
          <span class="suggestion-mark">${esc(mark)}</span>
          <span class="suggestion-main">
            <strong>${esc(item.name || item.symbol)}</strong>
            <span>${esc(item.symbol)}${item.industry ? ` · ${esc(item.industry)}` : ""}</span>
          </span>
          <span class="suggestion-side">${esc(item.exchange || item.type || "")}</span>
        </button>`;
    })
    .join("");
  setSearchExpanded(true);
}

function setActiveSuggestion(index) {
  const items = $$(".suggestion-item");
  if (!items.length) return;
  const next = index < 0 ? 0 : index % items.length;
  state.activeSuggestion = next;
  items.forEach((item, i) => {
    item.classList.toggle("active", i === next);
    item.setAttribute("aria-selected", String(i === next));
  });
  items[next].scrollIntoView({ block: "nearest" });
}

async function searchStocks(query) {
  const q = query.trim();
  if (q.length < 1) {
    hideSuggestions();
    return;
  }
  state.searchAbort?.abort();
  const controller = new AbortController();
  state.searchAbort = controller;
  const immediate = localSearch(q);
  if (immediate.length) renderSuggestions(immediate, q);
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("search failed");
    const data = await response.json();
    if (controller.signal.aborted) return;
    if (Array.isArray(data.results) && data.results.length) {
      // Local matches for well-known companies first; Yahoo's ranking can put
      // a fuzzy match such as Micron ahead of Microsoft for "micro".
      const merged = [...immediate];
      for (const item of data.results) {
        if (!merged.some((entry) => entry.symbol === item.symbol)) merged.push(item);
      }
      renderSuggestions(merged.slice(0, 9), q);
    } else if (!immediate.length) {
      renderSuggestions([], q);
    }
  } catch (error) {
    if (error.name !== "AbortError" && !immediate.length) {
      renderSuggestions([], q);
    }
  }
}

function chooseSearchResult(result) {
  if (!result?.symbol) return;
  const input = $("#searchInput");
  if (input) input.value = `${result.symbol} — ${result.name}`;
  hideSuggestions();
  loadCompany(result.symbol, { scroll: true, push: true });
}

/* -------------------------------------------------------------------------- */
/* Data loading                                                                */
/* -------------------------------------------------------------------------- */

function setStatus(mode, text) {
  const pill = $("#dataStatus");
  const label = $("#dataStatusText");
  if (!pill || !label) return;
  pill.classList.remove("busy", "error", "demo");
  if (mode === "busy") pill.classList.add("busy");
  if (mode === "error") pill.classList.add("error");
  if (mode === "demo") pill.classList.add("demo");
  label.textContent = text;
}

function showLoading() {
  $("#loadingState").hidden = false;
  $("#errorState").hidden = true;
  $("#results").hidden = true;
}

function showError(title, message) {
  $("#loadingState").hidden = true;
  $("#results").hidden = true;
  $("#errorState").hidden = false;
  $("#errorTitle").textContent = title;
  $("#errorMessage").textContent = message;
  setStatus("error", "Data error");
}

function showResults() {
  $("#loadingState").hidden = true;
  $("#errorState").hidden = true;
  $("#results").hidden = false;
}

function updateUrl(symbol) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("ticker", symbol);
    history.replaceState({}, "", url);
  } catch {
    /* ignore */
  }
}

async function loadCompany(rawSymbol, options = {}) {
  const symbol = String(rawSymbol || "").trim().toUpperCase();
  if (!symbol) return;
  if (state.loading && state.symbol === symbol) return;

  state.loadAbort?.abort();
  state.peerAbort?.abort();
  const controller = new AbortController();
  state.loadAbort = controller;
  state.loading = true;
  state.loadStartedAt = Date.now();
  state.symbol = symbol;
  state.company = null;
  state.analysis = null;
  state.assumptions = null;
  state.peers = null;
  state.peerError = null;
  state.peerLoading = false;
  state.contextLoaded = false;
  state.qRendered = false;
  state.lastQuoteAt = null;
  clearTimeout(state.updateTimer);
  state.updateTimer = null;
  hideUpdatesBanner();
  updateQuoteUpdatedLine();
  const peerSection = $("#peerSection");
  if (peerSection) peerSection.hidden = true;
  hideSuggestions();
  showLoading();
  setStatus("busy", "Pulling data…");
  if (options.scroll) {
    requestAnimationFrame(() =>
      $("#loadingState")?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  }

  try {
    const response = await fetch(`/api/stock/${encodeURIComponent(symbol)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error || `No valuation data found for ${symbol}.`);
    }
    if (!payload || !payload.price || !payload.financials) {
      throw new Error("The data service returned an incomplete response.");
    }
    if (controller.signal.aborted) return;

    state.company = payload;
    state.assumptions = defaultAssumptions(payload);
    state.analysis = buildAnalysis(payload, state.assumptions);
    state.peers = null;
    state.peerError = null;
    state.loading = false;
    state.loadedSymbol = payload.symbol || symbol;
    const startedAt = Date.now();

    renderCompanyHeader();
    renderSource();
    syncLabControls();
    renderAll();
    state.qRendered = true;
    showResults();
    syncWatchButtons();
    updateUrl(payload.symbol || symbol);
    document.title = `${payload.name || payload.symbol} intrinsic value — Intrinsic`;
    const mode = payload.meta?.dataMode || "live";
    const modeLabel =
      mode === "live"
        ? "Live · delayed"
        : mode === "cache"
          ? "Cached snapshot"
          : mode === "partial"
            ? "Partial snapshot"
            : "Demo data";
    setStatus(mode === "live" || mode === "partial" ? "live" : "demo", modeLabel);
    $("#dataNoticeClose")?.blur();
    loadPeers(payload.symbol || symbol, startedAt);
    if (state.live?.on && state.live.timer) startLiveLoop();
    // A new filing may have landed since this company was last viewed.
    setTimeout(() => checkForUpdates({ keepBanner: true }), 1200);
    if (options.scroll) {
      setTimeout(() => {
        $("#summarySection")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    state.loading = false;
    const message =
      error instanceof TypeError
        ? "Could not reach the local data service. Make sure server.py is still running."
        : error.message || "Something went wrong while loading this company.";
    showError(`Could not value ${symbol}.`, message);
    if (options.scroll) {
      setTimeout(() => {
        $("#errorState")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 60);
    }
  }
}

async function loadPeers(symbol, startedAt = 0) {
  const loadSeq = ++state.peerSeq;
  state.peerAbort?.abort();
  const controller = new AbortController();
  state.peerAbort = controller;
  state.peerLoading = true;
  state.peerError = null;
  // Show the peer panel immediately with a loading row; peers can take a few
  // seconds while the rest of the page is already useful.
  if (!state.contextLoaded) {
    renderPeerLoading();
    state.contextLoaded = true;
  }
  try {    const response = await fetch(`/api/peers/${encodeURIComponent(symbol)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Peer data unavailable");
    const data = await response.json();
    if (controller.signal.aborted || state.company?.symbol !== symbol) return;
    if (startedAt && startedAt < state.loadStartedAt) return;
    if (loadSeq !== state.peerSeq) return;
    state.peers = data;
    state.peerLoading = false;
    if (data && Number.isFinite(data.count)) {
      state.company.peerStats = {
        ...(data.median || {}),
        count: data.count,
        industryCount: data.industryCount || 0,
        asOf: data.asOf,
      };
      state.company.peers = Array.isArray(data.peers) ? data.peers : [];
    }
    state.analysis = buildAnalysis(state.company, state.assumptions);
    if (!state.qRendered) {
      renderAll();
      state.qRendered = true;
    } else {
      renderSummary();
      renderConfidence();
      renderReverse();
      renderModels();
      renderFootball();
      renderAnalyst();
      renderThesis();
    }
    renderPeerSection();
  } catch (error) {
    if (error.name === "AbortError" || state.company?.symbol !== symbol) return;
    if (loadSeq !== state.peerSeq) return;
    state.peerLoading = false;
    state.peerError = error.message || "Peer data unavailable";
    renderPeerUnavailable();
  }
}

function renderPeerLoading() {
  const section = $("#peerSection");
  if (!section || !state.company) return;
  section.hidden = false;
  $("#peerStatus").textContent = "Fetching peers…";
  $("#peerHeading").textContent = `${state.company.sector || "Sector"} peers, side by side.`;
  $("#peerIntro").textContent = "Fetching live sector peers, median multiples and the subject company…";
  $("#peerSummary").innerHTML = ["P/E", "EV / EBITDA", "P / B"]
    .map(
      (label) => `
      <div class="peer-stat">
        <span class="peer-stat-label">${label}</span>
        <div class="peer-stat-values">— <small>vs —</small></div>
        <span class="peer-stat-gap">loading</span>
      </div>`
    )
    .join("");
  $("#peerRows").innerHTML = `<tr><td colspan="5" class="peer-loading-cell"><span class="spinner"></span> Building the live peer set…</td></tr>`;
  $("#peerMedianRow").innerHTML = "";
  $("#peerNote").textContent = "Live peer data usually arrives within a second.";
}

function renderPeerUnavailable() {
  const section = $("#peerSection");
  if (!section || !state.company) return;
  section.hidden = false;
  $("#peerStatus").textContent = "Peer data unavailable";
  $("#peerHeading").textContent = `${state.company.sector || "Sector"} peers, side by side.`;
  $("#peerIntro").textContent =
    "The live peer set could not be loaded. Relative multiples fall back to static sector benchmarks.";
  $("#peerSummary").innerHTML = "";
  $("#peerRows").innerHTML = `<tr><td colspan="5" class="peer-loading-cell">Live peer data unavailable. Relative valuations are using static sector benchmarks instead.</td></tr>`;
  $("#peerMedianRow").innerHTML = "";
  $("#peerNote").textContent = "The rest of the valuation is unaffected; only the relative lenses lose their live peer support.";
}

function peerCompanyCell(peer) {
  const symbol = esc(peer.symbol || "—");
  const name = peer.name && peer.name !== peer.symbol ? `<span>${esc(peer.name)}</span>` : "";
  return `<div class="peer-company"><strong>${symbol}</strong>${name}</div>`;
}

function peerValue(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}×` : "—";
}

function peerGap(target, median) {
  if (!Number.isFinite(target) || !Number.isFinite(median) || median === 0) return null;
  return target / median - 1;
}

function renderPeerSection() {
  const section = $("#peerSection");
  if (!section) return;
  const data = state.peers;
  if (!data || !Array.isArray(data.peers) || !data.peers.length) {
    if (state.peerError) {
      renderPeerUnavailable();
    } else {
      section.hidden = false;
      $("#peerStatus").textContent = "No live peers";
      $("#peerHeading").textContent = `${state.company?.sector || "Sector"} peers, side by side.`;
      $("#peerIntro").textContent =
        "No usable live peer set was found. Relative multiples fall back to static sector benchmarks.";
      $("#peerSummary").innerHTML = "";
      $("#peerRows").innerHTML = `<tr><td colspan="5" class="peer-loading-cell">No live peer metrics were available for this company.</td></tr>`;
      $("#peerMedianRow").innerHTML = "";
      $("#peerNote").textContent = "The rest of the valuation is unaffected; only the relative lenses lose their live peer support.";
    }
    return;
  }
  section.hidden = false;
  const median = data.median || {};
  const target = data.target || {};
  const count = data.count || data.peers.length;
  const industryCount = data.industryCount || 0;
  $("#peerStatus").textContent = `${count} peers${industryCount ? ` · ${industryCount} same industry` : ""}`;
  $("#peerHeading").textContent = `${data.sector || "Sector"} peers, side by side.`;
  $("#peerIntro").textContent =
    `Live sector peers, median multiples and ${state.company?.symbol || "the subject"} in one place. This is the peer set behind the ${isFinancialCompany(state.company) ? "P/E and P/B" : "P/E and EV/EBITDA"} lenses.`;

  const stats = [
    { label: "P/E", target: target.pe, median: median.pe, count: median.peCount },
    { label: "EV / EBITDA", target: target.evEbitda, median: median.evEbitda, count: median.evCount },
    { label: "P / B", target: target.priceToBook, median: median.priceToBook, count: median.pbCount },
  ];
  $("#peerSummary").innerHTML = stats
    .map((stat) => {
      const gap = peerGap(stat.target, stat.median);
      const gapText = Number.isFinite(gap)
        ? `${pct(gap, 0, true)} vs peers`
        : stat.count
          ? "No comparable median"
          : "n/a";
      return `
        <div class="peer-stat">
          <span class="peer-stat-label">${esc(stat.label)}</span>
          <div class="peer-stat-values">${peerValue(stat.target)} <small>vs ${peerValue(stat.median)}</small></div>
          <span class="peer-stat-gap ${Number.isFinite(gap) ? (gap > 0 ? "negative" : "positive") : ""}">${esc(gapText)}</span>
        </div>`;
    })
    .join("");

  const peers = data.peers.slice().sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  $("#peerRows").innerHTML = `
    <tr class="subject">
      <td>${peerCompanyCell(target)}</td>
      <td>${moneyCompact(target.marketCap, target.currency || state.company?.currency || "USD")}</td>
      <td>${peerValue(target.pe)}</td>
      <td>${peerValue(target.evEbitda)}</td>
      <td>${peerValue(target.priceToBook)}</td>
    </tr>
    ${peers
      .map(
        (peer) => `
        <tr>
          <td>${peerCompanyCell(peer)}</td>
          <td>${moneyCompact(peer.marketCap, state.company?.currency || "USD")}</td>
          <td>${peerValue(peer.pe)}</td>
          <td>${peerValue(peer.evEbitda)}</td>
          <td>${peerValue(peer.priceToBook)}</td>
        </tr>`
      )
      .join("")}`;

  $("#peerMedianRow").innerHTML = `
    <tr>
      <td class="median-label">Peer median <span>n=${count}</span></td>
      <td>—</td>
      <td><strong>${peerValue(median.pe)}</strong></td>
      <td><strong>${peerValue(median.evEbitda)}</strong></td>
      <td><strong>${peerValue(median.priceToBook)}</strong></td>
    </tr>`;

  const notes = [
    `${count} live sector peers; medians exclude loss-makers and extreme multiples.`,
    Number.isFinite(median.peCount) ? `${median.peCount} P/E observations` : null,
    Number.isFinite(median.evCount) ? `${median.evCount} EV/EBITDA observations` : null,
    Number.isFinite(median.pbCount) ? `${median.pbCount} P/B observations` : null,
    isFinancialCompany(state.company)
      ? "EV/EBITDA is not meaningful for a bank or insurer; P/B is the weighted relative lens."
      : "P/B is shown for reference; it is not weighted for operating companies.",
  ].filter(Boolean);
  if (data.status === "limited") notes.push("This is a limited peer set — treat the relative lenses as low confidence.");
  $("#peerNote").textContent = notes.join(" · ");
}

function renderConfidence() {
  const confidence = state.analysis?.confidence;
  const pill = $("#confidencePill");
  if (!confidence || !pill) return;
  pill.className = `confidence-pill ${confidence.tone}`;
  $("#confidenceLabel").textContent = `${confidence.label} · ${confidence.score}`;
  pill.title = confidence.reasons.map((reason) => reason.text).join(" ");
  $("#confidenceDetailScore").textContent = String(confidence.score);
  const dcf = state.analysis?.dcf;
  $("#confidenceCopy").textContent =
    !dcf?.valid
      ? state.analysis?.isFinancial
        ? "The lenses and peer set agree; the DCF is deliberately excluded for this financial company."
        : "The lenses and peer set agree, but the DCF is excluded because free cash flow is not positive."
      : confidence.score >= 75
        ? "The lenses agree, the data is complete, and the DCF is not relying on an extreme terminal assumption."
        : confidence.score >= 55
          ? "Reasonable support, but at least one important input or model is pulling against the blend."
          : "Treat this valuation as directional. The model set, data or assumptions are not strong enough for a precise number.";
  $("#confidenceMeterFill").style.width = `${clamp(confidence.score, 2, 100)}%`;
  $("#confidenceReasons").innerHTML = confidence.reasons
    .map((reason) => `<li class="${esc(reason.tone)}">${esc(reason.text)}</li>`)
    .join("");
  const detail = $(".confidence-detail");
  if (detail) {
    detail.classList.toggle("medium", confidence.tone === "warning");
    detail.classList.toggle("low", confidence.tone === "negative");
  }
}

/* -------------------------------------------------------------------------- */
/* Company header + data note                                                   */
/* -------------------------------------------------------------------------- */

function renderQuoteHeader() {
  const c = state.company;
  if (!c) return;
  const price = c.price?.last;
  $("#quotePrice").textContent = money(price, c.currency);
  const changeNode = $("#quoteChange");
  const change = c.price?.change;
  const changePct = c.price?.changePercent;
  if (Number.isFinite(change) && Number.isFinite(changePct)) {
    changeNode.textContent = `${change >= 0 ? "+" : "−"}${money(Math.abs(change), c.currency)}  ${pct(changePct, 2, true)} today`;
    changeNode.classList.toggle("negative", change < 0);
  } else {
    changeNode.textContent = "Quote data delayed";
    changeNode.classList.remove("negative");
  }
  const marketTime = c.price?.quoteTime ? fmtQuoteTime(c.price.quoteTime) : null;
  $("#quoteTime").textContent = `${c.price?.marketState || "Market"}${marketTime ? ` · ${marketTime}` : ""} · ${c.currency}`;
  updateQuoteUpdatedLine();
}

function renderCompanyHeader() {
  const c = state.company;
  if (!c) return;
  const mark = (c.symbol || "?").replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase();
  $("#companyMark").textContent = mark;
  $("#companyTicker").textContent = c.symbol;
  $("#companyExchange").textContent = c.exchange || "Listed";
  $("#companyName").textContent = c.name || c.symbol;
  const sector = $("#companySector");
  sector.textContent = c.sector || "Equity";
  const metaParts = [c.industry, c.country, Number.isFinite(c.employees) ? `${nice(c.employees)} employees` : null].filter(Boolean);
  $("#companyMeta").textContent = metaParts.join(" · ") || "Public company";

  renderQuoteHeader();

  syncWatchButtons();

  const note = $("#dataNotice");
  const mode = c.meta?.dataMode || "live";
  const notes = [c.meta?.dataNote, c.meta?.warning, c.meta?.fxNote].filter(Boolean);
  if (mode !== "live" || notes.length) {
    const title =
      mode === "demo"
        ? "Demo snapshot."
        : mode === "cache"
          ? "Saved snapshot."
          : mode === "partial"
            ? "Partial data."
            : "Data note.";
    $("#dataNoticeTitle").textContent = title;
    $("#dataNoticeText").textContent = notes.join(" ");
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function renderSource() {
  const c = state.company;
  if (!c) return;
  $("#dataSourceLine").textContent = `Source: ${c.meta?.provider || "Yahoo Finance"} · fetched ${fmtDateTime(
    c.meta?.fetchedAt
  )} · quotes delayed at least ${nice(c.meta?.quoteDelayMinutes || 15)} minutes · fiscal year ends ${
    c.fiscalYearEnd ? fmtDate(c.fiscalYearEnd) : "—"
  } · reporting currency ${c.financialCurrency || c.currency}.`;
  renderPeriodLine();
}

function periodSnapshot(company) {
  const periods = company?.meta?.periods || {};
  return {
    ttm: periods.ttmAsOf || null,
    fiscalYear: periods.lastFiscalYearEnd || null,
    history: periods.historyLastDate || null,
  };
}

function renderPeriodLine() {
  const c = state.company;
  const node = $("#periodLine");
  if (!c || !node) return;
  const periods = c.meta?.periods || {};
  const ttmRow = (c.history || []).find((row) => row.period === "TTM");
  const ttmLabel = periods.ttmAsOf
    ? fmtDate(periods.ttmAsOf)
    : ttmRow?.date
      ? fmtDate(ttmRow.date)
      : null;
  const fyLabel = periods.lastFiscalYearEnd || c.fiscalYearEnd;
  const parts = [];
  if (ttmLabel) {
    parts.push(
      `Statements roll through ${ttmLabel}${periods.ttmSource === "quarters" ? " (four-quarter total)" : ""}`
    );
  }
  if (fyLabel) parts.push(`last fiscal year ended ${fmtDate(fyLabel)}`);
  const quarterlyCoverage = (periods.quarters || []).length;
  if (quarterlyCoverage) parts.push(`${quarterlyCoverage} quarterly filings in the total`);
  node.textContent = parts.length
    ? `Data periods: ${parts.join(" · ")}. New filings are detected the next time this page checks.`
    : "Data periods: not reported by this company's data feed.";
  node.className = "period-line";
}

/* -------------------------------------------------------------------------- */
/* Newer-data detection                                                        */
/* -------------------------------------------------------------------------- */

const UPDATE_POLL_MS = 5 * 60 * 1000;

function formatPeriod(value) {
  if (!value) return "—";
  const text = String(value);
  const date = text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return fmtDate(date);
  return text;
}

function describeChanges(changes = []) {
  return changes
    .map((change) => `${change.label} (${formatPeriod(change.from)} → ${formatPeriod(change.to)})`)
    .join(", ");
}

async function checkForUpdates(options = {}) {
  const c = state.company;
  if (!c || !c.symbol || state.updateChecking) return;
  if (c.meta?.dataMode === "demo") return;
  state.updateChecking = true;
  clearTimeout(state.updateTimer);
  state.updateTimer = null;
  try {
    const keys = periodSnapshot(c);
    const params = new URLSearchParams();
    if (keys.ttm) params.set("ttm", keys.ttm);
    if (keys.fiscalYear) params.set("fiscalYear", keys.fiscalYear);
    if (keys.history) params.set("history", keys.history);
    const response = await fetch(
      `/api/data-version/${encodeURIComponent(c.symbol)}${params.toString() ? `?${params}` : ""}`,
      { headers: { Accept: "application/json" } }
    );
    if (!response.ok) throw new Error("check failed");
    const data = await response.json();
    if (state.company !== c) return;
    if (data.updated) {
      showUpdatesBanner(data.changes || []);
    } else if (!options.keepBanner) {
      hideUpdatesBanner();
    }
  } catch {
    /* a failed check is silent; the next poll retries */
  } finally {
    state.updateChecking = false;
    if (state.live?.on && !document.hidden) {
      state.updateTimer = setTimeout(() => checkForUpdates(), UPDATE_POLL_MS);
    }
  }
}

function showUpdatesBanner(changes) {
  const banner = $("#updatesBanner");
  if (!banner) return;
  const detail = describeChanges(changes);
  $("#updatesTitle").textContent = "Newer financial data is available.";
  $("#updatesText").textContent = detail
    ? `${esc(detail)}. Your assumptions are kept; the models will be recalculated on the new data.`
    : "A newer filing is available. Your assumptions are kept.";
  banner.hidden = false;
  banner.classList.remove("busy");
}

function hideUpdatesBanner() {
  const banner = $("#updatesBanner");
  if (banner) banner.hidden = true;
}

async function applyUpdates() {
  const c = state.company;
  if (!c || state.updating) return;
  state.updating = true;
  const banner = $("#updatesBanner");
  banner?.classList.add("busy");
  const button = $("#updatesApply");
  if (button) button.disabled = true;
  const assumptions = state.assumptions ? { ...state.assumptions } : null;
  try {
    const response = await fetch(`/api/stock/${encodeURIComponent(c.symbol)}?refresh=1`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("refresh failed");
    const fresh = await response.json();
    if (!fresh || !fresh.financials) throw new Error("refresh failed");
    state.company = fresh;
    state.assumptions = assumptions || defaultAssumptions(fresh);
    state.analysis = buildAnalysis(fresh, state.assumptions);
    state.qRendered = true;
    renderCompanyHeader();
    renderSource();
    syncLabControls();
    renderAll();
    clearTimeout(state.updateTimer);
    state.updateTimer = null;
    hideUpdatesBanner();
    loadPeers(fresh.symbol || c.symbol, Date.now());
    toast("Valuation recalculated on the latest filing");
  } catch {
    banner?.classList.remove("busy");
    if (button) button.disabled = false;
    toast("Could not refresh the filing — try again in a moment");
  } finally {
    state.updating = false;
    if (button) button.disabled = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

function renderSummary() {
  const c = state.company;
  const a = state.analysis;
  if (!c || !a) return;
  renderSummaryValue();
  renderSummaryGap();
  renderSummaryRange();
  renderSummarySignal();
}

function renderSummaryValue() {
  const c = state.company;
  const a = state.analysis;
  const parts = splitValue(a.composite, c.currency);
  $("#summaryCurrency").textContent = parts.symbol;
  $("#summaryValue").innerHTML = `${esc(parts.main)}${parts.cents ? `<span class="cents">${esc(parts.cents)}</span>` : ""}`;
  $("#modelCount").textContent = `${a.models.filter((m) => m.weightPct > 0).length} / 7`;
  $("#summaryMarketCap").textContent = moneyCompact(c.price?.marketCap, c.currency);
}

function renderSummaryGap() {
  const c = state.company;
  const a = state.analysis;
  const composite = a.composite;
  const price = c.price?.last;
  const upside = a.upside;
  const verdict = a.verdict;
  const pill = $("#verdictPill");
  pill.className = `verdict-pill ${verdict.tone}`;
  $("#verdictLabel").textContent = verdict.label;

  if (Number.isFinite(upside)) {
    const above = upside >= 0;
    $("#summaryUpside").innerHTML = `Trading <b>${pct(Math.abs(upside), 1)} ${above ? "below" : "above"}</b> the blended value`;
    $("#gaugeUpside").textContent = pct(upside, 0, true);
    $("#gaugeCaption").textContent = above ? "upside to blended value" : "downside to blended value";
  } else {
    $("#summaryUpside").textContent = "Not enough positive models to blend";
    $("#gaugeUpside").textContent = "—";
    $("#gaugeCaption").textContent = "insufficient data";
  }

  const gaugePath = $("#gaugeProgress");
  if (gaugePath) {
    const length = gaugePath.getTotalLength();
    const gaugePosition = Number.isFinite(upside) ? clamp((upside + 0.6) / 1.2, 0, 1) : 0;
    gaugePath.style.strokeDasharray = `${(length * gaugePosition).toFixed(2)} ${length.toFixed(2)}`;
  }

  const priceToValue = Number.isFinite(composite) && composite > 0 && Number.isFinite(price) ? price / composite : null;
  $("#safetyValue").textContent = Number.isFinite(priceToValue) ? `${priceToValue.toFixed(2)}×` : "—";
  $("#safetyValue").title =
    Number.isFinite(priceToValue)
      ? priceToValue > 1
        ? `The market price is ${priceToValue.toFixed(2)}× the blended value.`
        : `The market price is ${priceToValue.toFixed(2)}× the blended value — a ${pct(1 - priceToValue, 1)} discount.`
      : "";
}

function renderSummaryRange() {
  const c = state.company;
  const a = state.analysis;
  const composite = a.composite;
  const price = c.price?.last;
  const low = a.low;
  const high = a.high;
  const values = [low, high, price, composite].filter(Number.isFinite);
  if (values.length >= 2 && Number.isFinite(composite)) {
    let scaleMin = Math.min(...values);
    let scaleMax = Math.max(...values);
    const padding = Math.max((scaleMax - scaleMin) * 0.08, scaleMax * 0.01);
    scaleMin -= padding;
    scaleMax += padding;
    const span = scaleMax - scaleMin || 1;
    const position = (value) => clamp(((value - scaleMin) / span) * 100, 0, 100);
    const fill = $("#summaryRangeFill");
    fill.style.left = `${position(low)}%`;
    fill.style.width = `${Math.max(1, position(high) - position(low))}%`;
    $("#summaryPriceMarker").style.left = `${position(price)}%`;
    $("#summaryValueMarker").style.left = `${position(composite)}%`;
    $("#summaryLow").textContent = money(low, c.currency, 0);
    $("#summaryBase").textContent = money(composite, c.currency, 0);
    $("#summaryHigh").textContent = money(high, c.currency, 0);
  } else {
    $("#summaryRangeFill").style.width = "0%";
    $("#summaryPriceMarker").style.left = "50%";
    $("#summaryValueMarker").style.left = "50%";
    $("#summaryLow").textContent = "—";
    $("#summaryBase").textContent = "—";
    $("#summaryHigh").textContent = "—";
  }
}

function renderSummarySignal() {
  const c = state.company;
  const a = state.analysis;
  const price = c.price?.last;
  const fcfYield = c.financials?.fcf && c.price?.marketCap ? c.financials.fcf / c.price.marketCap : null;
  $("#signalPrice").textContent = money(price, c.currency);
  $("#signalWeekRange").textContent =
    Number.isFinite(c.price?.fiftyTwoWeekLow) && Number.isFinite(c.price?.fiftyTwoWeekHigh)
      ? `${money(c.price.fiftyTwoWeekLow, c.currency, 0)} – ${money(c.price.fiftyTwoWeekHigh, c.currency, 0)}`
      : "—";
  $("#signalPE").textContent = `${ratio(c.financials?.pe)} · ${ratio(c.financials?.forwardPe)}`;
  $("#signalFcfYield").textContent = Number.isFinite(fcfYield) ? pct(fcfYield, 1) : "—";
  $("#analystMini").textContent = Number.isFinite(c.analysts?.targetMean)
    ? money(c.analysts.targetMean, c.currency, 0)
    : "No coverage";
  $("#analystMiniSub").textContent = Number.isFinite(c.analysts?.targetMean)
    ? `${pct(c.analysts.targetMean / price - 1, 1, true)} vs price`
    : "—";

  const note = [];
  if (isFinancialCompany(c)) {
    note.push(
      a.dcf?.valid
        ? "Financials: DCF and EV/EBITDA are down-weighted; earnings and book value lead."
        : "Financials: DCF and EV/EBITDA are excluded; earnings, dividends and book value lead."
    );
  }
  if (a.models.find((m) => m.id === "dcf")?.valid === false) note.push("DCF excluded: free cash flow is not positive.");
  if (a.ddm?.valid && !a.ddm.relevant) note.push("Dividend model shown but not weighted: payout is too low.");
  const includedCount = a.models.filter((m) => m.weightPct > 0).length;
  const peers = Number(c.peerStats?.count) || 0;
  $("#blendNote").textContent =
    note[0] ||
    (includedCount
      ? `Weighted across ${includedCount} lenses${peers ? ` and ${peers} live peers` : ""}. Not a price target.`
      : "No model produced a positive value. Adjust the DCF assumptions or treat the range as unavailable.");

  $("#sparkline").innerHTML = sparkline(c.price?.history || [], price);
}

function sparkline(points, currentPrice) {
  if (!Array.isArray(points) || points.length < 3) return "";
  const values = points.map((p) => p.c).filter(Number.isFinite);
  if (values.length < 3) return "";
  const w = 300;
  const h = 58;
  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i) => pad + (i / (values.length - 1)) * (w - pad * 2);
  const y = (value) => h - pad - ((value - min) / span) * (h - pad * 2);
  const line = values.map((value, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(values.length - 1).toFixed(1)} ${h} L${x(0).toFixed(1)} ${h} Z`;
  const positive = values[values.length - 1] >= values[0];
  const color = positive ? "var(--green)" : "var(--red)";
  const gradientId = `spark-${positive ? "up" : "down"}`;
  return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${positive ? "#8fe3a6" : "#ff816f"}" stop-opacity="0.22"></stop>
          <stop offset="100%" stop-color="${positive ? "#8fe3a6" : "#ff816f"}" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#${gradientId})"></path>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></path>
      <circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(values[values.length - 1]).toFixed(1)}" r="2.5" fill="${color}"></circle>
    </svg>`;
}

/* -------------------------------------------------------------------------- */
/* Reverse DCF                                                                 */
/* -------------------------------------------------------------------------- */

function renderReverse() {
  const c = state.company;
  const a = state.analysis;
  if (!c || !a) return;
  const reverse = a.reverse;
  if (!reverse?.valid) {
    $("#reverseHeadingLead").textContent = "A reverse DCF needs";
    $("#reverseGrowth").textContent = "positive free cash flow";
    $("#reverseHeadingTail").textContent = ".";
    $("#reverseText").textContent =
      "For businesses without positive FCF, the market-implied growth rate is not a meaningful question. Use the earnings-based lenses instead.";
    $("#reverseBase").textContent = "—";
    $("#reverseImplied").textContent = "—";
    $("#reverseBaseBar").style.width = "0%";
    $("#reverseImpliedBar").style.width = "0%";
    return;
  }
  $("#reverseHeadingLead").textContent = "The market expects";
  $("#reverseHeadingTail").textContent = " growth.";
  $("#reverseGrowth").textContent = pct(reverse.growth, 1);
  $("#reverseText").textContent = reverse.text;
  $("#reverseBase").textContent = pct(reverse.baseGrowth, 1);
  $("#reverseImplied").textContent = pct(reverse.growth, 1);
  const maxRate = Math.max(Math.abs(reverse.baseGrowth), Math.abs(reverse.growth), 0.1) * 1.14;
  $("#reverseBaseBar").style.width = `${clamp((Math.abs(reverse.baseGrowth) / maxRate) * 100, 2, 100)}%`;
  $("#reverseImpliedBar").style.width = `${clamp((Math.abs(reverse.growth) / maxRate) * 100, 2, 100)}%`;
}

/* -------------------------------------------------------------------------- */
/* Model cards                                                                 */
/* -------------------------------------------------------------------------- */

function renderModels() {
  const c = state.company;
  const a = state.analysis;
  const grid = $("#modelsGrid");
  if (!c || !a || !grid) return;

  grid.innerHTML = a.models
    .map((model) => {
      const excluded = model.valid && model.weightPct <= 0;
      const cls = ["model-card", model.id === "dcf" ? "dcf-card" : "", !model.valid ? "invalid" : "", excluded ? "excluded" : ""]
        .filter(Boolean)
        .join(" ");
      const delta = model.valid && !excluded && Number.isFinite(model.value) && Number.isFinite(c.price?.last)
        ? model.value / c.price.last - 1
        : null;
      const confidence = model.confidence || "Low";
      const confidenceDot = confidence.toLowerCase();

      let valueBlock;
      if (model.valid && Number.isFinite(model.value)) {
        valueBlock = `
          <div class="model-value">${money(model.value, c.currency)}</div>
          <div class="model-delta ${signedClass(delta)}">${excluded ? "not in blend" : delta === null ? "" : pct(delta, 1, true)}</div>`;
      } else {
        valueBlock = `<div class="model-value unavailable">${esc(model.reason || "Not meaningful for this company")}</div>`;
      }

      let rangeBlock = "";
      if (model.valid && Number.isFinite(model.value)) {
        const low = Number.isFinite(model.low) ? model.low : model.value;
        const high = Number.isFinite(model.high) ? model.high : model.value;
        const scaleMin = Math.min(low, model.value);
        const scaleMax = Math.max(high, model.value);
        const span = scaleMax - scaleMin || 1;
        const left = clamp(((low - scaleMin) / span) * 100, 0, 100);
        const width = clamp(((high - low) / span) * 100, 1, 100);
        const dot = clamp(((model.value - scaleMin) / span) * 100, 0, 100);
        rangeBlock = `
          <div class="model-range" title="Bear–bull range">
            <div class="model-range-fill" style="left:${left}%;width:${width}%"></div>
            <div class="model-range-dot" style="left:${dot}%"></div>
          </div>`;
      }

      const weightText = model.valid
        ? excluded
          ? "Not weighted"
          : `${Math.round(model.weightPct * 100)}% weight`
        : "Excluded";

      return `
        <article class="${cls}">
          <div class="model-head">
            <span class="model-index">${esc(model.index)}</span>
            <span class="model-family">${esc(model.family)}</span>
            <span class="model-confidence"><i class="confidence-dot ${esc(confidenceDot)}"></i>${esc(confidence)}</span>
          </div>
          <h3>${esc(model.name)}</h3>
          <p class="model-desc">${esc(model.description)}</p>
          <div class="model-value-row">${valueBlock}</div>
          ${rangeBlock}
          <div class="model-meta">
            <span class="model-weight">${weightText}</span>
            <span>${model.valid ? "Base case" : "Not available"}</span>
          </div>
          <details>
            <summary>How it works <svg class="icon"><use href="#i-chevron"></use></svg></summary>
            <div class="model-detail-body">
              <code class="model-formula">${esc(model.formula)}</code>
              ${model.inputs?.length ? `<div class="model-inputs">${model.inputs.map((item) => `<span>${esc(item)}</span>`).join("")}</div>` : ""}
              ${model.caveat ? `<p class="model-caveat">${esc(model.caveat)}</p>` : ""}
              ${model.valid && excluded ? `<p class="model-note">Shown for completeness; excluded from the blended value.</p>` : ""}
              ${!model.valid ? `<p class="model-note">${esc(model.reason || "")}</p>` : ""}
            </div>
          </details>
        </article>`;
    })
    .join("");
}

/* -------------------------------------------------------------------------- */
/* Football field                                                              */
/* -------------------------------------------------------------------------- */

function renderFootball() {
  const c = state.company;
  const a = state.analysis;
  const chart = $("#footballChart");
  if (!c || !a || !chart) return;

  const rows = [];
  for (const model of a.models) {
    if (!model.valid || !Number.isFinite(model.value)) continue;
    rows.push({
      id: model.id,
      label: model.short || model.name,
      low: Number.isFinite(model.low) ? model.low : model.value,
      high: Number.isFinite(model.high) ? model.high : model.value,
      value: model.value,
      confidence: model.confidence,
      excluded: model.weightPct <= 0,
      weight: model.weightPct,
      kind: "model",
    });
  }
  if (Number.isFinite(c.analysts?.targetMean)) {
    rows.push({
      id: "street",
      label: "Street target",
      low: Number.isFinite(c.analysts.targetLow) ? c.analysts.targetLow : c.analysts.targetMean,
      high: Number.isFinite(c.analysts.targetHigh) ? c.analysts.targetHigh : c.analysts.targetMean,
      value: c.analysts.targetMean,
      confidence: "Low",
      excluded: false,
      weight: null,
      kind: "street",
    });
  }

  const price = c.price?.last;
  const allValues = [...rows.flatMap((row) => [row.low, row.high, row.value]), price, a.composite].filter(Number.isFinite);
  if (!allValues.length) {
    chart.innerHTML = `<p class="muted">No comparable ranges available.</p>`;
    return;
  }
  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  const pad = Math.max((max - min) * 0.06, max * 0.01);
  min = Math.max(0, min - pad);
  max += pad;
  const span = max - min || 1;
  const pos = (value) => clamp(((value - min) / span) * 100, 0, 100);
  const ticks = Array.from({ length: 5 }, (_, i) => min + (span * i) / 4);

  const axis = `
    <div class="ff-axis">
      <div></div>
      <div class="ff-axis-scale">${ticks
        .map((tick, i) => `<span style="left:${i * 25}%">${money(tick, c.currency, 0)}</span>`)
        .join("")}</div>
      <div></div>
    </div>`;

  const body = rows
    .map((row) => {
      const left = pos(row.low);
      const right = pos(row.high);
      const valuePos = pos(row.value);
      const pricePos = pos(price);
      return `
        <div class="ff-row">
          <div class="ff-label">
            <i class="confidence-dot ${esc((row.confidence || "Low").toLowerCase())}"></i>
            <span class="truncate">${esc(row.label)}</span>
            ${row.excluded ? "<em>not weighted</em>" : row.weight ? `<em>${Math.round(row.weight * 100)}%</em>` : ""}
          </div>
          <div class="ff-track">
            <div class="ff-range ${row.excluded ? "excluded" : ""}" style="left:${left}%;width:${Math.max(1, right - left)}%">
              <span class="ff-dot" style="left:${clamp(((row.value - row.low) / (row.high - row.low || 1)) * 100, 0, 100)}%"></span>
            </div>
            <span class="ff-price-line" style="left:${pricePos}%"></span>
          </div>
          <div class="ff-value">${money(row.value, c.currency, 0)}<span>${row.kind === "street" ? "12-mo target" : row.excluded ? "excluded" : "base case"}</span></div>
        </div>`;
    })
    .join("");

  const pricePosition = pos(price);
  chart.innerHTML = `${axis}${body}
    <div class="ff-row price-row">
      <div class="ff-label">Market price</div>
      <div class="ff-track"><span class="ff-price-line" style="left:${pricePosition}%"></span></div>
      <div class="ff-value">${money(price, c.currency, 0)}<span>today</span></div>
    </div>`;
}

/* -------------------------------------------------------------------------- */
/* DCF lab                                                                     */
/* -------------------------------------------------------------------------- */

function setSliderFill(input) {
  if (!input) return;
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const fill = ((value - min) / (max - min)) * 100;
  input.style.setProperty("--fill", `${fill}%`);
}

function syncLabControls() {
  const a = state.assumptions;
  if (!a) return;
  const values = {
    growth: a.growth * 100,
    margin: a.fcfMargin * 100,
    wacc: a.wacc * 100,
    terminal: a.terminal * 100,
  };
  const ids = { growth: "growthSlider", margin: "marginSlider", wacc: "waccSlider", terminal: "terminalSlider" };
  for (const [key, id] of Object.entries(ids)) {
    const input = $(`#${id}`);
    if (!input) continue;
    input.value = String(values[key]);
    setSliderFill(input);
    const output = $(`#${key}Output`);
    if (output) output.textContent = `${values[key].toFixed(1)}%`;
  }
  const sbc = $("#sbcToggle");
  if (sbc) sbc.checked = Boolean(a.deductSbc);
  $$("#horizonControl button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.years) === Number(a.years));
  });
  renderLabOutput();
}

function readAssumptionsFromControls() {
  const a = state.assumptions;
  if (!a) return;
  a.growth = Number($("#growthSlider")?.value || 0) / 100;
  a.fcfMargin = Number($("#marginSlider")?.value || 0) / 100;
  a.wacc = Number($("#waccSlider")?.value || 0) / 100;
  a.terminal = Number($("#terminalSlider")?.value || 0) / 100;
  a.deductSbc = Boolean($("#sbcToggle")?.checked);
  for (const key of ["growth", "margin", "wacc", "terminal"]) {
    const input = $(`#${key}Slider`);
    const output = $(`#${key}Output`);
    if (input) setSliderFill(input);
    if (output) output.textContent = `${Number(input?.value || 0).toFixed(1)}%`;
  }
}

function recalculate() {
  if (!state.company || !state.assumptions) return;
  state.analysis = buildAnalysis(state.company, state.assumptions);
  renderSummary();
  renderConfidence();
  renderReverse();
  renderModels();
  renderFootball();
  renderLabOutput();
  renderSensitivity();
  renderMonteCarlo();
  renderWeights();
  renderAnalyst();
  renderThesis();
}

function applySbcToggle() {
  const c = state.company;
  const a = state.assumptions;
  if (!c || !a) return;
  const f = c.financials || {};
  const revenue = f.revenue || 1;
  const fcf = f.fcf || 0;
  const sbc = Math.abs(f.sbc || 0);
  const deduct = Boolean($("#sbcToggle")?.checked);
  a.deductSbc = deduct;
  a.fcfMargin = clamp((fcf - (deduct ? sbc : 0)) / revenue, -0.2, 0.75);
  if (fcf - (deduct ? sbc : 0) <= 0 && fcf > 0) a.fcfMargin = clamp(fcf / revenue, 0.005, 0.75);
  syncLabControls();
  recalculate();
  toast(deduct ? "Stock-based compensation treated as a cost" : "SBC add-back restored");
}

function renderLabOutput() {
  const c = state.company;
  const a = state.analysis;
  if (!c || !a) return;
  const dcf = a.dcf;
  const value = dcf?.valid ? dcf.value : null;
  $("#labValue").textContent = value ? money(value, c.currency) : "Not meaningful";
  if (value && Number.isFinite(c.price?.last)) {
    const delta = value / c.price.last - 1;
    const node = $("#labDelta");
    node.textContent = `${pct(delta, 1, true)} versus market price`;
    node.className = `lab-delta ${signedClass(delta)}`;
  } else {
    $("#labDelta").textContent = dcf?.reason || "Adjust the assumptions";
    $("#labDelta").className = "lab-delta";
  }
  $("#labEv").textContent = dcf?.valid ? moneyCompact(dcf.enterpriseValue, c.currency) : "—";
  $("#labEquity").textContent = dcf?.valid ? moneyCompact(dcf.equityValue, c.currency) : "—";
  $("#labTerminalShare").textContent = dcf?.valid ? pct(dcf.terminalShare, 0) : "—";
  $("#labStartFcf").textContent = dcf?.valid ? moneyCompact(dcf.startingFcf, c.currency) : "—";
  const printAssumptions = $("#printAssumptions");
  if (printAssumptions) {
    printAssumptions.innerHTML = dcf?.valid
      ? `<span>Growth <b>${pct(state.assumptions.growth, 1)}</b></span>
         <span>FCF margin <b>${pct(state.assumptions.fcfMargin, 1)}</b></span>
         <span>WACC <b>${pct(state.assumptions.wacc, 1)}</b></span>
         <span>Terminal <b>${pct(state.assumptions.terminal, 1)}</b></span>
         <span>Horizon <b>${state.assumptions.years} years</b></span>
         <span>SBC <b>${state.assumptions.deductSbc ? "deducted" : "added back"}</b></span>`
      : `<span>DCF unavailable: <b>${esc(dcf?.reason || "not enough data")}</b></span>`;
  }
  $("#projectionChart").innerHTML = dcf?.valid ? projectionChart(dcf, c.currency) : `<p class="muted" style="font-size:11px">${esc(dcf?.reason || "No projection available.")}</p>`;
}

function projectionChart(dcf, currency) {
  const data = dcf.projected;
  if (!data?.length) return "";
  const w = 660;
  const h = 245;
  const m = { top: 18, right: 18, bottom: 30, left: 58 };
  const innerW = w - m.left - m.right;
  const innerH = h - m.top - m.bottom;
  const maxValue = Math.max(...data.map((d) => Math.max(d.fcf, d.pv)), 1);
  const step = innerW / data.length;
  const barW = Math.min(30, step * 0.48);
  const y = (value) => m.top + innerH - (value / maxValue) * innerH;
  const bars = data
    .map((d, i) => {
      const x = m.left + step * i + step / 2;
      const nominalY = y(d.fcf);
      const pvY = y(d.pv);
      return `
        <g>
          <title>Year ${d.year}: FCF ${moneyCompact(d.fcf, currency)}, PV ${moneyCompact(d.pv, currency)}</title>
          <rect x="${(x - barW / 2).toFixed(1)}" y="${nominalY.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, m.top + innerH - nominalY).toFixed(1)}" rx="2" fill="color-mix(in srgb, var(--accent) 30%, transparent)"></rect>
          <circle cx="${x.toFixed(1)}" cy="${pvY.toFixed(1)}" r="2.4" fill="var(--accent)"></circle>
        </g>`;
    })
    .join("");
  const line = data
    .map((d, i) => {
      const x = m.left + step * i + step / 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y(d.pv).toFixed(1)}`;
    })
    .join(" ");
  const grid = Array.from({ length: 4 }, (_, i) => {
    const value = (maxValue * i) / 3;
    const yy = y(value);
    return `<line x1="${m.left}" y1="${yy.toFixed(1)}" x2="${w - m.right}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-dasharray="2 5"></line>
      <text x="${m.left - 9}" y="${(yy + 3).toFixed(1)}" text-anchor="end" fill="var(--faint)" font-family="var(--mono)" font-size="7">${moneyCompact(value, currency)}</text>`;
  }).join("");
  const xLabels = data
    .filter((d, i) => i === 0 || i === data.length - 1 || (i + 1) % 5 === 0)
    .map((d) => {
      const i = data.indexOf(d);
      const x = m.left + step * i + step / 2;
      return `<text x="${x.toFixed(1)}" y="${h - 8}" text-anchor="middle" fill="var(--faint)" font-family="var(--mono)" font-size="7">Y${d.year}</text>`;
    })
    .join("");
  const terminalLabel = `Terminal value ${pct(dcf.terminalShare, 0)} of EV`;
  return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Projected free cash flow and present value by year">
      ${grid}
      ${bars}
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.7" stroke-linejoin="round"></path>
      ${xLabels}
      <text x="${w - m.right}" y="${m.top + 3}" text-anchor="end" fill="var(--faint)" font-family="var(--mono)" font-size="7">${esc(terminalLabel)}</text>
    </svg>`;
}

function renderSensitivity() {
  const c = state.company;
  const a = state.analysis;
  const table = $("#sensitivityTable");
  if (!c || !a || !table) return;
  const sens = a.sensitivity;
  if (!sens?.rows?.length) {
    table.innerHTML = `<p class="muted" style="font-size:11px">Sensitivity is unavailable because the DCF is not meaningful for this company.</p>`;
    return;
  }
  const hasAnyValue = sens.rows.some((row) => row.cells.some((cell) => Number.isFinite(cell.value)));
  if (!hasAnyValue) {
    table.innerHTML = `<p class="muted" style="font-size:11px">Sensitivity is unavailable because starting free cash flow is not positive. Raise the FCF margin in the DCF lab to test a turnaround.</p>`;
    return;
  }
  const price = c.price?.last;
  const baseWacc = a.assumptions?.wacc ?? state.assumptions.wacc;
  const baseTerminal = a.assumptions?.terminal ?? state.assumptions.terminal;
  const baseValue = a.dcf?.valid ? a.dcf.value : a.composite;
  const header = `
    <div class="sens-row">
      <div class="sens-cell header">WACC ↓ / g →</div>
      ${sens.rows[0].cells.map((cell) => `<div class="sens-cell header">g ${pct(cell.terminal, 1)}</div>`).join("")}
    </div>`;
  const rows = sens.rows
    .map((row) => {
      const cells = row.cells
        .map((cell) => {
          if (!Number.isFinite(cell.value)) {
            return `<div class="sens-cell"><span>—</span></div>`;
          }
          const relative = Number.isFinite(price) ? cell.value / price - 1 : 0;
          const relativeToBase = Number.isFinite(baseValue) && baseValue > 0 ? cell.value / baseValue - 1 : 0;
          const intensity = clamp(Math.abs(relativeToBase) * 0.7, 0.025, 0.2);
          const heat = relativeToBase >= 0 ? `rgba(143,227,166,${intensity})` : `rgba(255,129,111,${intensity})`;
          const isBase = Math.abs(row.wacc - baseWacc) < 0.0001 && Math.abs(cell.terminal - baseTerminal) < 0.0001;
          return `<div class="sens-cell heat${isBase ? " base-cell" : ""}" style="--heat:${heat}" title="${money(cell.value, c.currency)} per share">
            <strong>${money(cell.value, c.currency, 0)}</strong><span>${pct(relative, 0, true)} vs price</span>
          </div>`;
        })
        .join("");
      return `<div class="sens-row"><div class="sens-cell rowhead">WACC ${pct(row.wacc, 1)}</div>${cells}</div>`;
    })
    .join("");
  table.innerHTML = header + rows;
}

/* -------------------------------------------------------------------------- */
/* Monte Carlo                                                                 */
/* -------------------------------------------------------------------------- */

function renderMonteCarlo() {
  const c = state.company;
  const a = state.analysis;
  if (!c || !a) return;
  const mc = a.monteCarlo;
  if (!mc) {
    $("#monteChart").innerHTML = `<p class="muted" style="font-size:11px">Not available: the base DCF needs positive free cash flow.</p>`;
    ["mcP10", "mcP50", "mcP90", "mcProb"].forEach((id) => ($(`#${id}`).textContent = "—"));
    $("#runsTag").textContent = "No simulation";
    return;
  }
  $("#mcP10").textContent = money(mc.p10, c.currency, 0);
  $("#mcP50").textContent = money(mc.p50, c.currency, 0);
  $("#mcP90").textContent = money(mc.p90, c.currency, 0);
  $("#mcProb").textContent = pct(mc.probabilityUndervalued, 1);
  $("#runsTag").textContent = `${nice(mc.runs)} paths`;
  $("#monteChart").innerHTML = monteChartSvg(mc, c.currency);
}

function monteChartSvg(mc, currency) {
  const w = 660;
  const h = 195;
  const m = { top: 18, right: 14, bottom: 29, left: 8 };
  const innerW = w - m.left - m.right;
  const innerH = h - m.top - m.bottom;
  const bins = mc.bins;
  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  const barStep = innerW / bins.length;
  const barW = Math.max(2, barStep - 3);
  const price = mc.price;
  const pricePos = clamp(((price - mc.low) / (mc.high - mc.low || 1)) * 100, 0, 100);
  const p10 = clamp(((mc.p10 - mc.low) / (mc.high - mc.low || 1)) * 100, 0, 100);
  const p50 = clamp(((mc.p50 - mc.low) / (mc.high - mc.low || 1)) * 100, 0, 100);
  const p90 = clamp(((mc.p90 - mc.low) / (mc.high - mc.low || 1)) * 100, 0, 100);
  const bars = bins
    .map((bin, i) => {
      const barH = (bin.count / maxCount) * innerH;
      return `<rect x="${(m.left + i * barStep).toFixed(1)}" y="${(m.top + innerH - barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5" fill="var(--accent)" opacity="${(0.28 + (bin.count / maxCount) * 0.5).toFixed(2)}"></rect>`;
    })
    .join("");
  const priceLine = `
    <line x1="${(m.left + (pricePos / 100) * innerW).toFixed(1)}" y1="${m.top - 5}" x2="${(m.left + (pricePos / 100) * innerW).toFixed(1)}" y2="${m.top + innerH}" stroke="var(--text)" stroke-width="1" stroke-dasharray="3 4" opacity="0.65"></line>
    <text x="${(m.left + (pricePos / 100) * innerW).toFixed(1)}" y="${m.top - 8}" text-anchor="${pricePos > 80 ? "end" : pricePos < 20 ? "start" : "middle"}" fill="var(--text)" font-family="var(--mono)" font-size="7">PRICE ${money(price, currency, 0)}</text>`;
  const ticks = [
    { p: p10, label: "P10" },
    { p: p50, label: "P50" },
    { p: p90, label: "P90" },
  ]
    .map((tick) => {
      const x = m.left + (tick.p / 100) * innerW;
      return `<line x1="${x.toFixed(1)}" y1="${m.top + innerH}" x2="${x.toFixed(1)}" y2="${m.top + innerH + 4}" stroke="var(--faint)" stroke-width="1"></line>
        <text x="${x.toFixed(1)}" y="${m.top + innerH + 24}" text-anchor="middle" fill="var(--faint)" font-family="var(--mono)" font-size="7">${tick.label} ${money(tick.p === p10 ? mc.p10 : tick.p === p50 ? mc.p50 : mc.p90, currency, 0)}</text>`;
    })
    .join("");
  return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Monte Carlo distribution of DCF values">
      <line x1="${m.left}" y1="${m.top + innerH}" x2="${w - m.right}" y2="${m.top + innerH}" stroke="var(--line-strong)"></line>
      ${bars}
      ${priceLine}
      ${ticks}
    </svg>`;
}

/* -------------------------------------------------------------------------- */
/* Quality                                                                     */
/* -------------------------------------------------------------------------- */

function renderQuality() {
  const c = state.company;
  const a = state.analysis;
  if (!c || !a) return;
  const q = a.quality;
  if (!q) return;
  $("#qualityScore").textContent = String(q.score);
  $("#scoreRing").style.setProperty("--score", String(q.score));
  $("#qualityGrade").textContent = q.grade;
  const comparable = q.metrics.filter((metric) => metric.display !== "n/a" && metric.value !== null && Number.isFinite(metric.value));
  const ranked = (comparable.length ? comparable : q.metrics).slice().sort((a, b) => b.score - a.score);
  const topMetric = ranked[0];
  const weakest = ranked[ranked.length - 1];
  const summary =
    q.score >= 80
      ? `Exceptional economics. ${topMetric.label} is ${topMetric.display}, and the business converts profit into cash. The risk is the price, not the machine.`
      : q.score >= 65
        ? `A strong business with ${topMetric.label.toLowerCase()} at ${topMetric.display}. Watch ${weakest.label.toLowerCase()} and the valuation multiple.`
        : q.score >= 45
          ? `Mixed economics. ${topMetric.label} is a bright spot, but ${weakest.label.toLowerCase()} is a weak point. Demand a wider margin of safety.`
          : `Weak fundamentals: ${weakest.label.toLowerCase()} is ${weakest.display}. A low multiple alone is not a reason to own it.`;
  $("#qualitySummary").textContent = summary;
  $("#qualityStrengths").innerHTML = q.strengths.map((s) => `<span>${esc(s)}</span>`).join("") || "<span>No standout strengths</span>";

  $("#qualityMetrics").innerHTML = q.metrics
    .map((metric) => {
      const tone = metric.score < 35 ? "low" : metric.score < 62 ? "mid" : "";
      return `
        <div class="quality-metric ${tone}" title="${esc(metric.hint)}">
          <div class="quality-metric-head"><span>${esc(metric.label)}</span><b>${esc(metric.display)}</b></div>
          <div class="metric-track"><div class="metric-fill" style="width:${clamp(metric.score, 2, 100)}%"></div></div>
        </div>`;
    })
    .join("");

  if (q.redFlags.length) {
    $("#qualityFlags").innerHTML = q.redFlags
      .map(
        (flag) =>
          `<li class="${esc(flag.severity)}"><svg class="icon"><use href="#i-alert"></use></svg><span><strong>${esc(flag.label)}.</strong> ${esc(flag.detail)}</span></li>`
      )
      .join("");
  } else {
    $("#qualityFlags").innerHTML = `<li class="clear"><svg class="icon"><use href="#i-check"></use></svg><span>No red flags in the metrics we track. That does not mean the business is risk-free.</span></li>`;
  }
}

/* -------------------------------------------------------------------------- */
/* Weights + analyst + thesis                                                  */
/* -------------------------------------------------------------------------- */

function renderWeights() {
  const c = state.company;
  const a = state.analysis;
  if (!c || !a) return;
  const rows = a.weights.slice().sort((x, y) => y.weight - x.weight);
  if (!rows.length) {
    $("#weightTotal").textContent = "No eligible models";
    $("#weightsTable").innerHTML =
      `<p class="muted" style="font-size:11px;line-height:1.6">None of the seven lenses produced a positive value. The company may be pre-revenue, loss-making or missing usable statement data.</p>`;
    $("#weightsNote").textContent =
      "No blended value is shown rather than forcing a misleading number from an inapplicable model.";
    return;
  }
  $("#weightTotal").textContent = `${rows.length} lenses · 100% allocated`;
  $("#weightsTable").innerHTML = rows
    .map(
      (row) => `
      <div class="weight-row">
        <span>${esc(row.name)}</span>
        <div class="weight-track"><div class="weight-fill" style="width:${Math.max(1, row.weight * 100)}%"></div></div>
        <span class="weight-pct">${Math.round(row.weight * 100)}%</span>
        <span class="weight-val">${money(row.value, c.currency, 0)}</span>
      </div>`
    )
    .join("");
  const notes = [];
  if (isFinancialCompany(c)) notes.push("Financial company: DCF and EV/EBITDA are not weighted; earnings, P/B and dividends lead.");
  else notes.push("DCF anchors the blend.");
  const peerCount = Number(c.peerStats?.count) || 0;
  if (peerCount) notes.push(`Relative multiples use ${peerCount} live sector peers.`);
  else notes.push("Relative multiples fall back to static sector benchmarks because no live peer set was available.");
  if (!a.dcf?.valid) notes.push("DCF is excluded because free cash flow is not positive.");
  if (a.ddm?.valid && !a.ddm.relevant) notes.push("Dividend discount is excluded because the payout is immaterial.");
  $("#weightsNote").textContent = notes.join(" ");
}

function renderAnalyst() {
  const c = state.company;
  const a = state.analysis;
  if (!c || !a) return;
  const target = c.analysts?.targetMean;
  const count = c.analysts?.count;
  const countNode = $("#analystCount");
  if (Number.isFinite(count)) countNode.textContent = `${nice(count)} analysts`;
  else countNode.textContent = "No coverage";

  if (!Number.isFinite(target)) {
    $("#analystTarget").innerHTML = `No street coverage <small>Use the model range instead</small>`;
    $("#analystTrack").style.display = "none";
    $("#analystLabels").style.display = "none";
    $("#analystRating").textContent = "Sell-side consensus is unavailable for this ticker.";
    $("#watchTrigger").textContent = Number.isFinite(a.composite)
      ? `A 20% margin of safety to the blended value implies buying below ${money(a.composite * 0.8, c.currency, 0)}.`
      : "Not enough positive models to set a valuation trigger.";
    return;
  }
  $("#analystTrack").style.display = "";
  $("#analystLabels").style.display = "flex";
  $("#analystTarget").innerHTML = `${money(target, c.currency, 0)}
    <small>mean target</small>
    <span class="street-upside"></span>`;

  const low = Number.isFinite(c.analysts.targetLow) ? c.analysts.targetLow : target;
  const high = Number.isFinite(c.analysts.targetHigh) ? c.analysts.targetHigh : target;
  const span = high - low || 1;
  const marker = clamp(((target - low) / span) * 100, 0, 100);
  $("#analystMarker").style.left = `${marker}%`;
  $("#analystLow").textContent = money(low, c.currency, 0);
  $("#analystMean").textContent = money(target, c.currency, 0);
  $("#analystHigh").textContent = money(high, c.currency, 0);

  const rec = recommendationLabel(c.analysts.recommendation);
  const mean = c.analysts.recommendationMean;
  $("#analystRating").innerHTML = `<span class="rating-badge">${esc(rec)}</span>${Number.isFinite(mean) ? `<span>${mean.toFixed(2)} / 5 consensus score</span>` : ""}`;
  renderAnalystPriceParts();
}

/** The price-dependent half of the Street panel, refreshed by the live toggle. */
function renderAnalystPriceParts() {
  const c = state.company;
  const a = state.analysis;
  if (!c || !a) return;
  const target = c.analysts?.targetMean;
  const price = c.price?.last;
  if (!Number.isFinite(target)) return;
  const upside = Number.isFinite(price) ? target / price - 1 : null;
  const street = $(".street-upside", $("#analystTarget"));
  if (street) {
    street.className = `street-upside ${signedClass(upside)}`;
    street.textContent = upside === null ? "" : pct(upside, 1, true);
  }
  $("#analystMiniSub").textContent = Number.isFinite(price)
    ? `${pct(target / price - 1, 1, true)} vs price`
    : "—";

  const trigger = Number.isFinite(a.composite)
    ? a.composite > price
      ? `A 20% margin of safety to the blended value implies buying below <strong>${money(a.composite * 0.8, c.currency, 0)}</strong>. Today's price is ${money(price, c.currency, 0)}.`
      : `The market is already above our blended value. Waiting for a 20% margin of safety implies a price below <strong>${money(a.composite * 0.8, c.currency, 0)}</strong>.`
    : "Not enough positive models to set a valuation trigger.";
  $("#watchTrigger").innerHTML = trigger;
}

function renderThesis() {
  const c = state.company;
  const a = state.analysis;
  if (!c || !a) return;
  const items = [];
  if (a.reverse?.valid) {
    items.push({
      title: "The growth gap",
      body: `The market is pricing in ${pct(a.reverse.growth, 1)} starting FCF growth; our base case is ${pct(
        state.assumptions?.growth ?? 0,
        1
      )}. That gap is the single most important debate.`,
    });
  } else {
    items.push({
      title: "The missing cash flow",
      body: "Free cash flow is not positive, so a conventional DCF cannot anchor the valuation. Earnings and balance-sheet lenses matter more here.",
    });
  }
  if (a.dcf?.valid) {
    items.push({
      title: "Terminal value dependence",
      body: `${pct(a.dcf.terminalShare, 0)} of the DCF's enterprise value sits in the terminal value. A 0.5% change in WACC or terminal growth moves the answer materially.`,
    });
  } else {
    items.push({
      title: "Quality over multiple",
      body: `The business scores ${a.quality?.score ?? "—"}/100 on our quality checklist. For a company without positive FCF, balance sheet and earnings durability are the key tests.`,
    });
  }
  if (Number.isFinite(a.composite)) {
    items.push({
      title: "The price you pay",
      body: `The blend is ${money(a.composite, c.currency, 0)} per share. A 20% margin of safety implies ${money(
        a.composite * 0.8,
        c.currency,
        0
      )}; today's price is ${money(c.price.last, c.currency, 0)}.`,
    });
  }
  $("#thesisGrid").innerHTML = items
    .slice(0, 3)
    .map(
      (item, index) => `
      <div class="thesis-item">
        <span class="thesis-num">0${index + 1}</span>
        <h3>${esc(item.title)}</h3>
        <p>${esc(item.body)}</p>
      </div>`
    )
    .join("");
}

/* -------------------------------------------------------------------------- */
/* Main render                                                                 */
/* -------------------------------------------------------------------------- */

function renderAll() {
  renderSummary();
  renderConfidence();
  renderReverse();
  renderModels();
  renderFootball();
  renderLabOutput();
  renderSensitivity();
  renderMonteCarlo();
  renderQuality();
  renderWeights();
  renderAnalyst();
  renderThesis();
}

/* -------------------------------------------------------------------------- */
/* Live quote refresh                                                          */
/* -------------------------------------------------------------------------- */

const LIVE_INTERVAL_MS = 60_000;
const LIVE_STORAGE_KEY = "intrinsic.live";

function parseQuoteTime(epoch) {
  if (!Number.isFinite(epoch)) return 0;
  const date = new Date(epoch * 1000);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function flashElement(node) {
  if (!node) return;
  node.classList.remove("flash-up", "flash-down");
  void node.offsetWidth;
  node.classList.add("flash-up");
  setTimeout(() => node.classList.remove("flash-up"), 950);
}

function applyQuote(quote) {
  const c = state.company;
  if (!c || !quote) return false;
  const previousPrice = c.price?.last;
  const nextPrice = Number(quote.price);
  if (!Number.isFinite(nextPrice) || nextPrice <= 0) return false;

  // Guard against a stale response from an older page state.
  const incomingTime = parseQuoteTime(quote.quoteTime);
  const currentTime = parseQuoteTime(c.price?.quoteTime);
  if (incomingTime && currentTime && incomingTime < currentTime) return false;

  c.price = {
    ...c.price,
    last: nextPrice,
    change: Number.isFinite(quote.change) ? quote.change : c.price?.change,
    changePercent: Number.isFinite(quote.changePercent) ? quote.changePercent : c.price?.changePercent,
    previousClose: Number.isFinite(quote.previousClose) ? quote.previousClose : c.price?.previousClose,
    dayLow: Number.isFinite(quote.dayLow) ? quote.dayLow : c.price?.dayLow,
    dayHigh: Number.isFinite(quote.dayHigh) ? quote.dayHigh : c.price?.dayHigh,
    fiftyTwoWeekLow: Number.isFinite(quote.fiftyTwoWeekLow) ? quote.fiftyTwoWeekLow : c.price?.fiftyTwoWeekLow,
    fiftyTwoWeekHigh: Number.isFinite(quote.fiftyTwoWeekHigh) ? quote.fiftyTwoWeekHigh : c.price?.fiftyTwoWeekHigh,
    marketState: quote.marketState || c.price?.marketState,
    quoteTime: quote.quoteTime || c.price?.quoteTime,
  };
  const shares = c.financials?.sharesOutstanding;
  if (nextPrice > 0 && Number.isFinite(shares)) {
    c.price.marketCap = nextPrice * shares;
  }
  state.lastQuoteAt = Date.now();

  state.analysis = buildAnalysis(c, state.assumptions);
  renderQuoteHeader();
  renderSummaryValue();
  renderSummaryGap();
  renderSummaryRange();
  renderSummarySignal();
  renderReverse();
  renderModels();
  renderFootball();
  renderAnalystPriceParts();
  renderThesis();
  if (Math.abs(nextPrice - previousPrice) > 0.0001) {
    flashElement($("#quotePrice"));
  }
  syncWatchButtons();
  return Math.abs(nextPrice - previousPrice) > 0.0001;
}

async function pollQuote() {
  const c = state.company;
  if (!c || !c.symbol || state.live.busy) return;
  if (c.meta?.dataMode === "demo") {
    setLiveCaption("demo data");
    return;
  }
  state.live.busy = true;
  setLiveCaption("checking…");
  const controller = new AbortController();
  state.liveAbort = controller;
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`/api/quote/${encodeURIComponent(c.symbol)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("quote request failed");
    const quote = await response.json();
    if (state.company !== c) return;
    state.live.failures = 0;
    state.liveButton?.classList.remove("failed");
    applyQuote(quote);
    setLiveCaption("updated");
    updateQuoteUpdatedLine();
  } catch (error) {
    state.live.failures += 1;
    if (state.live.failures >= 2) {
      state.liveButton?.classList.add("failed");
      setLiveCaption("retrying…");
    } else {
      setLiveCaption("checking…");
    }
  } finally {
    clearTimeout(timeout);
    state.live.busy = false;
    state.liveAbort = null;
  }
}

function updateQuoteUpdatedLine() {
  const node = $("#quoteUpdated");
  const ago = $("#quoteUpdatedAgo");
  if (!node || !ago) return;
  if (!state.lastQuoteAt) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.style.display = "block";
  const seconds = Math.max(0, Math.round((Date.now() - state.lastQuoteAt) / 1000));
  ago.textContent = seconds < 5 ? "just now" : seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

function setLiveCaption(text) {
  const node = $("#liveCaption");
  if (node) node.textContent = text;
}

function setLive(on, options = {}) {
  const button = state.liveButton;
  state.live.on = Boolean(on);
  try {
    localStorage.setItem(LIVE_STORAGE_KEY, state.live.on ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (button) {
    button.setAttribute("aria-checked", state.live.on ? "true" : "false");
    button.classList.remove("failed");
  }
  state.live.failures = 0;
  setLiveCaption(state.live.on ? (document.hidden ? "paused" : "waiting") : "off");

  clearInterval(state.live.timer);
  state.live.timer = null;
  clearInterval(state.live.ticker);
  state.live.ticker = null;

  if (state.live.on) {
    state.live.ticker = setInterval(updateQuoteUpdatedLine, 5000);
    startLiveLoop();
    if (options.immediate !== false && !document.hidden) pollQuote();
  }
}

function startLiveLoop() {
  clearInterval(state.live.timer);
  state.live.timer = null;
  if (!state.live.on || document.hidden || !state.company) return;
  state.live.timer = setInterval(pollQuote, LIVE_INTERVAL_MS);
  clearTimeout(state.updateTimer);
  state.updateTimer = setTimeout(() => checkForUpdates(), UPDATE_POLL_MS);
}

function handleVisibilityChange() {
  if (!state.live.on) return;
  if (document.hidden) {
    clearInterval(state.live.timer);
    state.live.timer = null;
    clearInterval(state.live.ticker);
    state.live.ticker = null;
    clearTimeout(state.updateTimer);
    state.updateTimer = null;
    setLiveCaption("paused");
  } else {
    setLiveCaption("waiting");
    startLiveLoop();
    pollQuote();
    checkForUpdates();
    state.live.ticker = setInterval(updateQuoteUpdatedLine, 5000);
  }
}

function initLive() {
  state.liveButton = $("#liveButton");
  state.live = {
    on: false,
    busy: false,
    failures: 0,
    timer: null,
    ticker: null,
    abort: null,
  };
  state.lastQuoteAt = null;

  let saved = "0";
  try {
    saved = localStorage.getItem(LIVE_STORAGE_KEY) || "0";
  } catch {
    saved = "0";
  }
  state.liveButton?.addEventListener("click", () => setLive(!state.live.on));
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("beforeunload", () => {
    clearInterval(state.live.timer);
    clearInterval(state.live.ticker);
    clearTimeout(state.updateTimer);
    state.liveAbort?.abort();
  });
  if (saved === "1") setLive(true, { immediate: true });
}

/* -------------------------------------------------------------------------- */
/* Event setup                                                                 */
/* -------------------------------------------------------------------------- */

function initSearch() {
  const input = $("#searchInput");
  const form = $("#searchForm");
  const dropdown = $("#suggestions");
  if (!input || !form) return;

  const compact = window.matchMedia("(max-width: 720px)");
  const updatePlaceholder = () => {
    input.placeholder = compact.matches
      ? "Search stock or ticker…"
      : "Search a company or ticker — Apple, NVDA, KO…";
  };
  updatePlaceholder();
  compact.addEventListener?.("change", updatePlaceholder);

  let debounceTimer = null;
  input.addEventListener("input", () => {
    const query = input.value.trim();
    clearTimeout(debounceTimer);
    if (!query) {
      hideSuggestions();
      return;
    }
    debounceTimer = setTimeout(() => searchStocks(query), 170);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim() && state.searchResults.length) setSearchExpanded(true);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && !$("#suggestions").hidden) {
      event.preventDefault();
      setActiveSuggestion(state.activeSuggestion + 1);
    } else if (event.key === "ArrowUp" && !$("#suggestions").hidden) {
      event.preventDefault();
      setActiveSuggestion(state.activeSuggestion - 1);
    } else if (event.key === "Escape") {
      hideSuggestions();
      input.blur();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    if (state.activeSuggestion >= 0 && state.searchResults[state.activeSuggestion]) {
      chooseSearchResult(state.searchResults[state.activeSuggestion]);
      return;
    }
    if (state.searchResults.length) {
      chooseSearchResult(state.searchResults[0]);
      return;
    }
    const symbol = query.split(/\s|—|-{2}/)[0].trim().toUpperCase();
    loadCompany(symbol, { scroll: true, push: true });
  });

  dropdown?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-symbol]");
    if (!item) return;
    const result = state.searchResults.find((entry) => entry.symbol === item.dataset.symbol) || {
      symbol: item.dataset.symbol,
      name: item.dataset.symbol,
    };
    chooseSearchResult(result);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search-zone")) hideSuggestions();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !event.target.matches("input, textarea, select")) {
      event.preventDefault();
      input.focus();
      input.select();
    }
    if (event.key === "Escape") {
      if ($("#watchlistDrawer")?.classList.contains("open")) closeWatchlist();
    }
  });
}

function initLab() {
  const fields = ["growth", "margin", "wacc", "terminal"];
  for (const field of fields) {
    const slider = $(`#${field}Slider`);
    slider?.addEventListener("input", () => {
      if (!state.assumptions) return;
      readAssumptionsFromControls();
      recalculate();
    });
  }
  $("#sbcToggle")?.addEventListener("change", applySbcToggle);
  $("#horizonControl")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-years]");
    if (!button || !state.assumptions) return;
    state.assumptions.years = Number(button.dataset.years);
    $$("#horizonControl button").forEach((item) => item.classList.toggle("active", item === button));
    recalculate();
  });
  $("#resetAssumptions")?.addEventListener("click", () => {
    if (!state.company) return;
    state.assumptions = defaultAssumptions(state.company);
    syncLabControls();
    recalculate();
    toast("Assumptions reset to the base case");
  });
}

function initGlobalActions() {
  $("#themeToggle")?.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  $("#watchlistButton")?.addEventListener("click", openWatchlist);
  $("#closeWatchlist")?.addEventListener("click", closeWatchlist);
  $("#drawerBackdrop")?.addEventListener("click", closeWatchlist);
  $("#watchToggle")?.addEventListener("click", saveCurrentToWatchlist);
  $("#clearWatchlist")?.addEventListener("click", () => {
    if (!state.watchlist.length) return;
    if (window.confirm("Clear every company from your watchlist?")) {
      state.watchlist = [];
      persistWatchlist();
      renderWatchlist();
      syncWatchButtons();
      toast("Watchlist cleared");
    }
  });
  $("#watchList")?.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-watch]");
    if (remove) {
      state.watchlist = state.watchlist.filter((item) => item.symbol !== remove.dataset.removeWatch);
      persistWatchlist();
      renderWatchlist();
      syncWatchButtons();
      return;
    }
    const load = event.target.closest("[data-load-watch]");
    if (load) {
      closeWatchlist();
      loadCompany(load.dataset.loadWatch, { scroll: true, push: true });
    }
  });

  $("#shareButton")?.addEventListener("click", async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied to clipboard");
    } catch {
      window.prompt("Copy this link:", url);
    }
  });

  $("#printButton")?.addEventListener("click", () => window.print());
  $("#retryButton")?.addEventListener("click", () => loadCompany(state.symbol || "AAPL", { scroll: true, push: true }));
  $("#dataNoticeClose")?.addEventListener("click", () => {
    $("#dataNotice").hidden = true;
  });
  $("#updatesApply")?.addEventListener("click", applyUpdates);
  $("#updatesDismiss")?.addEventListener("click", hideUpdatesBanner);
  window.addEventListener("focus", () => checkForUpdates());

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-symbol]");
    if (!trigger) return;
    if (trigger.closest("#suggestions") || trigger.closest(".search-zone")) return;
    event.preventDefault();
    loadCompany(trigger.dataset.symbol, { scroll: true, push: true });
  });

  for (const id of ["methodologyButton", "blendInfoButton"]) {
    $(`#${id}`)?.addEventListener("click", openMethodology);
  }
  $("#closeMethod")?.addEventListener("click", closeMethodology);
  $("#closeMethodBottom")?.addEventListener("click", closeMethodology);
  const dialog = $("#methodDialog");
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeMethodology();
  });
  dialog?.addEventListener("close", () => {
    document.body.classList.remove("dialog-open");
  });

  window.addEventListener("scroll", () => {
    document.body.classList.toggle("scrolled", window.scrollY > 12);
  }, { passive: true });
}

function openMethodology() {
  const dialog = $("#methodDialog");
  if (!dialog) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  document.body.classList.add("dialog-open");
}

function closeMethodology() {
  const dialog = $("#methodDialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  document.body.classList.remove("dialog-open");
}

function init() {
  initTheme();
  initSearch();
  initLab();
  initGlobalActions();
  initLive();
  renderWatchlist();
  syncWatchButtons();

  const params = new URLSearchParams(window.location.search);
  const initial = (params.get("ticker") || params.get("symbol") || "AAPL").toUpperCase();
  loadCompany(initial, { scroll: false, push: false });
}

init();
