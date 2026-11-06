#!/usr/bin/env python3
"""
Intrinsic — a local, no-API-key stock valuation workbench.

The server is deliberately dependency-free: Python's standard library only.
It pulls public Yahoo Finance endpoints (search, chart and fundamentals
time-series) and normalises them into a small, stable schema for the browser.

Run:  python server.py
Open: http://127.0.0.1:8765
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hmac
import http.cookiejar
import json
import math
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

try:
    import sec_provider  # SEC XBRL fundamentals + keyless price
except Exception:  # pragma: no cover - provider is optional at import time
    sec_provider = None

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
CACHE_DIR = APP_DIR / "cache"
FALLBACK_DIR = APP_DIR / "data" / "fallback"
VERSION = "1.2.0"
CACHE_TTL_SECONDS = 15 * 60
QUOTE_TTL_SECONDS = 45
PEER_CACHE_TTL = 60 * 60
FUNDAMENTALS_CACHE_TTL = 6 * 60 * 60
DISK_CACHE_MAX_AGE = 30 * 24 * 60 * 60
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
SYMBOL_RE = re.compile(r"^[A-Z0-9.\-=^]{1,18}$")

# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------
# Intrinsic holds no API keys, tokens, passwords or personal data. It reads
# public market data and keeps no user accounts, so there is no secret in the
# codebase to leak. Publishing it raises three different risks, and these are
# the controls that answer them:
#
#   * the URL being driven as an unpaid proxy against upstream data,
#   * internals leaking through error text or verbose endpoints,
#   * the page being framed, embedded or script-injected by another site.
#
# Everything here is on by default and needs no configuration.

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    # No inline scripts exist, so script-src can stay strict. Inline styles are
    # used by generated markup (charts, sizing), so style-src allows them.
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "font-src 'self'; "
        "connect-src 'self'; "
        "object-src 'none'; "
        "base-uri 'none'; "
        "form-action 'none'; "
        "frame-ancestors 'none'"
    ),
}

# Optional shared password. Off unless INTRINSIC_PASSWORD is set, so local use
# stays frictionless while a public link can be locked down in one variable.
AUTH_PASSWORD = os.environ.get("INTRINSIC_PASSWORD", "").strip()
AUTH_USER = os.environ.get("INTRINSIC_USERNAME", "intrinsic").strip() or "intrinsic"

# Diagnostics expose which upstream calls fail. Useful when deploying, unwise
# to leave open on a public host, so it is opt-in.
DIAG_ENABLED = os.environ.get("INTRINSIC_DIAG", "").strip() in ("1", "true", "yes")


class RateLimiter:
    """Fixed-window request limiter keyed on the client address.

    A public valuation page can be scripted to hammer upstream data through
    this server, which gets the host throttled or blocked. The default budget
    (120 requests a minute) is far above what normal browsing needs.
    """

    def __init__(self, limit=None, window=60):
        try:
            self.limit = int(os.environ.get("INTRINSIC_RATE_LIMIT", limit or 120))
        except ValueError:
            self.limit = 120
        self.limit = max(10, min(self.limit, 5000))
        self.window = window
        self._hits = {}
        self._lock = threading.Lock()

    def allow(self, key):
        """Return (allowed, remaining_seconds_or_remaining_requests)."""
        now = time.monotonic()
        with self._lock:
            bucket = self._hits.get(key)
            if bucket is None or now - bucket[0] >= self.window:
                self._hits[key] = [now, 1]
                self._prune(now)
                return True, self.limit - 1
            if bucket[1] >= self.limit:
                return False, max(1, int(self.window - (now - bucket[0])))
            bucket[1] += 1
            return True, self.limit - bucket[1]

    def _prune(self, now):
        if len(self._hits) < 1024:
            return
        stale = [k for k, v in self._hits.items() if now - v[0] >= self.window]
        for key in stale:
            self._hits.pop(key, None)


LIMITER = RateLimiter()


def _constant_time_compare(a, b):
    """Compare two strings without leaking length or content through timing."""
    try:
        return hmac.compare_digest(str(a), str(b))
    except Exception:
        return False


def log_internal_error(context, exc):
    """Log full detail on the server, return a short reference for the client.

    The browser gets the reference instead of the exception text, so a stack
    trace, file path or upstream URL never reaches a visitor.
    """
    ref = uuid.uuid4().hex[:8]
    print(f"  [{context}] ref={ref} {type(exc).__name__}: {exc}", file=sys.stderr)
    return ref


def public_error(message, ref=None):
    payload = {"error": message}
    if ref:
        payload["errorId"] = ref
    return payload


# A small offline search index. Yahoo search remains the primary source.
POPULAR = [
    ("AAPL", "Apple Inc.", "NASDAQ", "Technology", "Consumer Electronics"),
    ("MSFT", "Microsoft Corporation", "NASDAQ", "Technology", "Software—Infrastructure"),
    ("NVDA", "NVIDIA Corporation", "NASDAQ", "Technology", "Semiconductors"),
    ("AMZN", "Amazon.com, Inc.", "NASDAQ", "Consumer Cyclical", "Internet Retail"),
    ("GOOGL", "Alphabet Inc.", "NASDAQ", "Communication Services", "Internet Content & Information"),
    ("META", "Meta Platforms, Inc.", "NASDAQ", "Communication Services", "Internet Content & Information"),
    ("TSLA", "Tesla, Inc.", "NASDAQ", "Consumer Cyclical", "Auto Manufacturers"),
    ("BRK-B", "Berkshire Hathaway Inc.", "NYSE", "Financial Services", "Insurance—Diversified"),
    ("JPM", "JPMorgan Chase & Co.", "NYSE", "Financial Services", "Banks—Diversified"),
    ("V", "Visa Inc.", "NYSE", "Financial Services", "Credit Services"),
    ("MA", "Mastercard Incorporated", "NYSE", "Financial Services", "Credit Services"),
    ("JNJ", "Johnson & Johnson", "NYSE", "Healthcare", "Drug Manufacturers—General"),
    ("LLY", "Eli Lilly and Company", "NYSE", "Healthcare", "Drug Manufacturers—General"),
    ("UNH", "UnitedHealth Group Incorporated", "NYSE", "Healthcare", "Healthcare Plans"),
    ("XOM", "Exxon Mobil Corporation", "NYSE", "Energy", "Oil & Gas Integrated"),
    ("CVX", "Chevron Corporation", "NYSE", "Energy", "Oil & Gas Integrated"),
    ("KO", "The Coca-Cola Company", "NYSE", "Consumer Defensive", "Beverages—Non-Alcoholic"),
    ("PEP", "PepsiCo, Inc.", "NASDAQ", "Consumer Defensive", "Beverages—Non-Alcoholic"),
    ("PG", "The Procter & Gamble Company", "NYSE", "Consumer Defensive", "Household & Personal Products"),
    ("COST", "Costco Wholesale Corporation", "NASDAQ", "Consumer Defensive", "Discount Stores"),
    ("WMT", "Walmart Inc.", "NYSE", "Consumer Defensive", "Discount Stores"),
    ("HD", "The Home Depot, Inc.", "NYSE", "Consumer Cyclical", "Home Improvement Retail"),
    ("MCD", "McDonald's Corporation", "NYSE", "Consumer Cyclical", "Restaurants"),
    ("NKE", "NIKE, Inc.", "NYSE", "Consumer Cyclical", "Footwear & Accessories"),
    ("DIS", "The Walt Disney Company", "NYSE", "Communication Services", "Entertainment"),
    ("NFLX", "Netflix, Inc.", "NASDAQ", "Communication Services", "Entertainment"),
    ("ADBE", "Adobe Inc.", "NASDAQ", "Technology", "Software—Application"),
    ("CRM", "Salesforce, Inc.", "NYSE", "Technology", "Software—Application"),
    ("AMD", "Advanced Micro Devices, Inc.", "NASDAQ", "Technology", "Semiconductors"),
    ("INTC", "Intel Corporation", "NASDAQ", "Technology", "Semiconductors"),
    ("TSM", "Taiwan Semiconductor Manufacturing Company Limited", "NYSE", "Technology", "Semiconductors"),
    ("ASML", "ASML Holding N.V.", "NASDAQ", "Technology", "Semiconductor Equipment & Materials"),
    ("ORCL", "Oracle Corporation", "NYSE", "Technology", "Software—Infrastructure"),
    ("BAC", "Bank of America Corporation", "NYSE", "Financial Services", "Banks—Diversified"),
    ("WFC", "Wells Fargo & Company", "NYSE", "Financial Services", "Banks—Diversified"),
    ("GS", "The Goldman Sachs Group, Inc.", "NYSE", "Financial Services", "Capital Markets"),
    ("BLK", "BlackRock, Inc.", "NYSE", "Financial Services", "Asset Management"),
    ("CAT", "Caterpillar Inc.", "NYSE", "Industrials", "Farm & Heavy Construction Machinery"),
    ("BA", "The Boeing Company", "NYSE", "Industrials", "Aerospace & Defense"),
    ("GE", "GE Aerospace", "NYSE", "Industrials", "Aerospace & Defense"),
    ("UPS", "United Parcel Service, Inc.", "NYSE", "Industrials", "Integrated Freight & Logistics"),
    ("LIN", "Linde plc", "NASDAQ", "Basic Materials", "Specialty Chemicals"),
    ("NEE", "NextEra Energy, Inc.", "NYSE", "Utilities", "Utilities—Regulated Electric"),
    ("AMT", "American Tower Corporation", "NYSE", "Real Estate", "REIT—Specialty"),
    ("PLD", "Prologis, Inc.", "NYSE", "Real Estate", "REIT—Industrial"),
    ("BABA", "Alibaba Group Holding Limited", "NYSE", "Consumer Cyclical", "Internet Retail"),
    ("TM", "Toyota Motor Corporation", "NYSE", "Consumer Cyclical", "Auto Manufacturers"),
    ("SAP", "SAP SE", "NYSE", "Technology", "Software—Application"),
    ("SHOP", "Shopify Inc.", "NYSE", "Technology", "Software—Application"),
]

# A sector-constrained starting universe. Live metrics and profiles are fetched
# for a shortlist; this only prevents unrelated companies from entering a peer
# set when Yahoo's "people also watched" endpoint is noisy.
SECTOR_UNIVERSE = {
    "Technology": [
        "AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "ADBE", "AMD", "INTC",
        "QCOM", "TXN", "MU", "AMAT", "NOW", "INTU", "IBM", "SAP", "ASML", "TSM",
    ],
    "Communication Services": [
        "GOOGL", "META", "NFLX", "DIS", "TMUS", "VZ", "T", "CMCSA", "CHTR",
        "EA", "TTWO", "WBD", "SPOT", "PINS", "SNAP",
    ],
    "Consumer Cyclical": [
        "AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "LOW", "TJX", "BKNG",
        "ABNB", "GM", "F", "MAR", "ORLY", "AZO", "RCL", "CCL",
    ],
    "Consumer Defensive": [
        "KO", "PEP", "PG", "COST", "WMT", "PM", "MO", "MDLZ", "CL", "KMB",
        "GIS", "K", "HSY", "STZ", "KDP", "DG", "DLTR", "TGT",
    ],
    "Financial Services": [
        "JPM", "BAC", "WFC", "C", "GS", "MS", "USB", "PNC", "SCHW", "BLK",
        "AXP", "V", "MA", "PYPL", "SPGI", "MCO", "AIG", "MET", "PRU", "ALL",
        "BRK-B",
    ],
    "Healthcare": [
        "JNJ", "LLY", "UNH", "PFE", "MRK", "ABBV", "TMO", "ABT", "DHR",
        "BMY", "AMGN", "GILD", "CVS", "CI", "ELV", "ISRG", "MDT", "SYK",
        "VRTX", "REGN",
    ],
    "Industrials": [
        "CAT", "BA", "GE", "UPS", "HON", "UNP", "DE", "LMT", "RTX", "NOC",
        "GD", "MMM", "EMR", "ETN", "ITW", "CSX", "FDX", "WM", "CARR", "OTIS",
    ],
    "Energy": [
        "XOM", "CVX", "COP", "EOG", "SLB", "MPC", "PSX", "VLO", "OXY",
        "HAL", "BKR", "WMB", "KMI", "OKE",
    ],
    "Basic Materials": [
        "LIN", "APD", "SHW", "FCX", "NEM", "DOW", "DD", "PPG", "NUE",
        "VMC", "MLM", "ALB",
    ],
    "Utilities": [
        "NEE", "DUK", "SO", "D", "AEP", "EXC", "XEL", "SRE", "ED", "PEG",
        "WEC", "ES", "AWK",
    ],
    "Real Estate": [
        "AMT", "PLD", "CCI", "EQIX", "SPG", "O", "PSA", "WELL", "DLR",
        "AVB", "EQR", "VTR", "SBAC", "IRM",
    ],
}


KNOWN_NAMES = {row[0]: row[1] for row in POPULAR}
KNOWN_NAMES.update(
    {
        "AVGO": "Broadcom Inc.",
        "QCOM": "Qualcomm Incorporated",
        "TXN": "Texas Instruments Incorporated",
        "MU": "Micron Technology, Inc.",
        "AMAT": "Applied Materials, Inc.",
        "NOW": "ServiceNow, Inc.",
        "INTU": "Intuit Inc.",
        "IBM": "International Business Machines Corporation",
        "C": "Citigroup Inc.",
        "MS": "Morgan Stanley",
        "USB": "U.S. Bancorp",
        "PNC": "The PNC Financial Services Group, Inc.",
        "SCHW": "The Charles Schwab Corporation",
        "AXP": "American Express Company",
        "PYPL": "PayPal Holdings, Inc.",
        "SPGI": "S&P Global Inc.",
        "MCO": "Moody's Corporation",
        "AIG": "American International Group, Inc.",
        "MET": "MetLife, Inc.",
        "PRU": "Prudential Financial, Inc.",
        "ALL": "The Allstate Corporation",
        "PFE": "Pfizer Inc.",
        "MRK": "Merck & Co., Inc.",
        "ABBV": "AbbVie Inc.",
        "TMO": "Thermo Fisher Scientific Inc.",
        "ABT": "Abbott Laboratories",
        "DHR": "Danaher Corporation",
        "BMY": "Bristol-Myers Squibb Company",
        "AMGN": "Amgen Inc.",
        "GILD": "Gilead Sciences, Inc.",
        "CVS": "CVS Health Corporation",
        "CI": "The Cigna Group",
        "ELV": "Elevance Health, Inc.",
        "ISRG": "Intuitive Surgical, Inc.",
        "MDT": "Medtronic plc",
        "SYK": "Stryker Corporation",
        "VRTX": "Vertex Pharmaceuticals Incorporated",
        "REGN": "Regeneron Pharmaceuticals, Inc.",
        "HON": "Honeywell International Inc.",
        "UNP": "Union Pacific Corporation",
        "DE": "Deere & Company",
        "LMT": "Lockheed Martin Corporation",
        "RTX": "RTX Corporation",
        "NOC": "Northrop Grumman Corporation",
        "GD": "General Dynamics Corporation",
        "MMM": "3M Company",
        "EMR": "Emerson Electric Co.",
        "ETN": "Eaton Corporation plc",
        "ITW": "Illinois Tool Works Inc.",
        "CSX": "CSX Corporation",
        "FDX": "FedEx Corporation",
        "WM": "Waste Management, Inc.",
        "CARR": "Carrier Global Corporation",
        "OTIS": "Otis Worldwide Corporation",
        "COP": "ConocoPhillips",
        "EOG": "EOG Resources, Inc.",
        "SLB": "SLB",
        "MPC": "Marathon Petroleum Corporation",
        "PSX": "Phillips 66",
        "VLO": "Valero Energy Corporation",
        "OXY": "Occidental Petroleum Corporation",
        "HAL": "Halliburton Company",
        "BKR": "Baker Hughes Company",
        "WMB": "The Williams Companies, Inc.",
        "KMI": "Kinder Morgan, Inc.",
        "OKE": "ONEOK, Inc.",
        "APD": "Air Products and Chemicals, Inc.",
        "SHW": "The Sherwin-Williams Company",
        "FCX": "Freeport-McMoRan Inc.",
        "NEM": "Newmont Corporation",
        "DOW": "Dow Inc.",
        "DD": "DuPont de Nemours, Inc.",
        "PPG": "PPG Industries, Inc.",
        "NUE": "Nucor Corporation",
        "VMC": "Vulcan Materials Company",
        "MLM": "Martin Marietta Materials, Inc.",
        "ALB": "Albemarle Corporation",
        "DUK": "Duke Energy Corporation",
        "SO": "The Southern Company",
        "D": "Dominion Energy, Inc.",
        "AEP": "American Electric Power Company, Inc.",
        "EXC": "Exelon Corporation",
        "XEL": "Xcel Energy Inc.",
        "SRE": "Sempra",
        "ED": "Consolidated Edison, Inc.",
        "PEG": "Public Service Enterprise Group Incorporated",
        "WEC": "WEC Energy Group, Inc.",
        "ES": "Eversource Energy",
        "AWK": "American Water Works Company, Inc.",
        "CCI": "Crown Castle Inc.",
        "EQIX": "Equinix, Inc.",
        "SPG": "Simon Property Group, Inc.",
        "O": "Realty Income Corporation",
        "PSA": "Public Storage",
        "WELL": "Welltower Inc.",
        "DLR": "Digital Realty Trust, Inc.",
        "AVB": "AvalonBay Communities, Inc.",
        "EQR": "Equity Residential",
        "VTR": "Ventas, Inc.",
        "SBAC": "SBA Communications Corporation",
        "IRM": "Iron Mountain Incorporated",
        "TMUS": "T-Mobile US, Inc.",
        "T": "AT&T Inc.",
        "CMCSA": "Comcast Corporation",
        "CHTR": "Charter Communications, Inc.",
        "EA": "Electronic Arts Inc.",
        "TTWO": "Take-Two Interactive Software, Inc.",
        "WBD": "Warner Bros. Discovery, Inc.",
        "SPOT": "Spotify Technology S.A.",
        "PINS": "Pinterest, Inc.",
        "SNAP": "Snap Inc.",
        "LOW": "Lowe's Companies, Inc.",
        "TJX": "The TJX Companies, Inc.",
        "BKNG": "Booking Holdings Inc.",
        "ABNB": "Airbnb, Inc.",
        "GM": "General Motors Company",
        "F": "Ford Motor Company",
        "MAR": "Marriott International, Inc.",
        "ORLY": "O'Reilly Automotive, Inc.",
        "AZO": "AutoZone, Inc.",
        "RCL": "Royal Caribbean Cruises Ltd.",
        "CCL": "Carnival Corporation & plc",
        "PM": "Philip Morris International Inc.",
        "MO": "Altria Group, Inc.",
        "MDLZ": "Mondelez International, Inc.",
        "CL": "Colgate-Palmolive Company",
        "KMB": "Kimberly-Clark Corporation",
        "GIS": "General Mills, Inc.",
        "K": "Kellanova",
        "HSY": "The Hershey Company",
        "STZ": "Constellation Brands, Inc.",
        "KDP": "Keurig Dr Pepper Inc.",
        "DG": "Dollar General Corporation",
        "DLTR": "Dollar Tree, Inc.",
        "TGT": "Target Corporation",
    }
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class _PeriodLabels:
    """Labels fiscal years as FY ending in the company's fiscal month.

    Companies are not evenly spaced across the calendar, so an unlabeled
    fiscal year can collide with the latest TTM label: a retail year ending
    January 2027 and a TTM ending January 2027 would both read "2027".
    """

    def __init__(self, fiscal_end=None):
        self.month = None
        if fiscal_end:
            try:
                self.month = datetime.fromisoformat(str(fiscal_end)[:10]).month
            except ValueError:
                self.month = None

    def render(self, date):
        year = str(date)[:4]
        if not self.month:
            return year
        month = str(date)[5:7]
        return f"FY{year}" if month == str(self.month).zfill(2) else year


def safe_float(value, default=None):
    """Yahoo uses {'raw': 1.2} wrappers; also accept plain numbers."""
    if value is None:
        return default
    if isinstance(value, dict):
        if "raw" in value and value["raw"] is not None:
            try:
                return float(value["raw"])
            except (TypeError, ValueError):
                return default
        if "dataValue" in value and value["dataValue"] is not None:
            try:
                return float(value["dataValue"])
            except (TypeError, ValueError):
                return default
        return default
    if isinstance(value, bool):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def safe_num(value, default=0.0) -> float:
    out = safe_float(value, None)
    return default if out is None else out


def non_negative(value, default=0.0) -> float:
    out = safe_float(value, default)
    return max(0.0, default if out is None else out)


def pct_change(new, old):
    if not old or old <= 0 or new is None:
        return None
    return new / old - 1.0


def clamp(value, low, high):
    return max(low, min(high, value))


def clean_payload(value):
    """Recursively drop non-finite numbers and internal Yahoo boilerplate."""
    if isinstance(value, dict):
        return {k: clean_payload(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [clean_payload(v) for v in value]
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


class YahooError(RuntimeError):
    pass


class YahooClient:
    """Small Yahoo client with a cookie/crumb session and graceful degradation."""

    def __init__(self):
        self._lock = threading.Lock()
        self._opener = None
        self._crumb = None
        self._session_born = 0.0
        self._profile_cache = {}
        self._profile_lock = threading.Lock()

    # ---------- low-level ----------
    def _new_session(self):
        cookie_jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
        opener.addheaders = [
            ("User-Agent", UA),
            (
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            ),
            ("Accept-Language", "en-US,en;q=0.9"),
            ("Cache-Control", "no-cache"),
        ]
        # The quote page sets the A1/A3 cookies required by the crumb endpoint.
        req = urllib.request.Request(
            "https://finance.yahoo.com/quote/AAPL/",
            headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        )
        with opener.open(req, timeout=18) as response:
            response.read(64_000)
        crumb_req = urllib.request.Request(
            "https://query1.finance.yahoo.com/v1/test/getcrumb",
            headers={"User-Agent": UA, "Accept": "*/*"},
        )
        with opener.open(crumb_req, timeout=12) as response:
            crumb = response.read().decode("utf-8", "replace").strip()
        if not crumb or len(crumb) > 40:
            raise YahooError("Yahoo returned an invalid session crumb")
        self._opener = opener
        self._crumb = crumb
        self._session_born = time.time()

    def _reset_session(self):
        self._opener = None
        self._crumb = None
        self._session_born = 0.0

    def _get(self, url, timeout=20, accept="application/json,text/plain,*/*"):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": UA,
                "Accept": accept,
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://finance.yahoo.com/",
            },
        )
        opener = self._opener
        if opener is None:
            opener = urllib.request.build_opener()
            opener.addheaders = [("User-Agent", UA)]
        with opener.open(req, timeout=timeout) as response:
            return response.read()

    def _get_json(self, url, timeout=20):
        raw = self._get(url, timeout=timeout)
        return json.loads(raw.decode("utf-8", "replace"))

    # ---------- public data ----------
    def search(self, query: str):
        params = urllib.parse.urlencode(
            {
                "q": query,
                "quotesCount": 16,
                "newsCount": 0,
                "enableFuzzyQuery": "false",
                "quotesQueryId": "tss_match_phrase_query",
            }
        )
        url = f"https://query1.finance.yahoo.com/v1/finance/search?{params}"
        data = self._get_json(url, timeout=18)
        quotes = data.get("quotes", []) or []
        out = []
        for quote in quotes:
            if quote.get("quoteType") not in ("EQUITY", "ETF"):
                continue
            out.append(
                {
                    "symbol": quote.get("symbol"),
                    "name": quote.get("longname") or quote.get("shortname") or quote.get("symbol"),
                    "shortName": quote.get("shortname"),
                    "exchange": quote.get("exchDisp") or quote.get("exchange") or "",
                    "sector": quote.get("sectorDisp") or quote.get("sector") or "",
                    "industry": quote.get("industryDisp") or quote.get("industry") or "",
                    "type": quote.get("typeDisp") or quote.get("quoteType") or "Equity",
                }
            )
        return out

    def recommendations(self, symbol: str):
        encoded = urllib.parse.quote(symbol, safe="")
        url = f"https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/{encoded}"
        data = self._get_json(url, timeout=18)
        result = (data.get("finance", {}).get("result") or [{}])[0]
        return [
            item.get("symbol")
            for item in (result.get("recommendedSymbols") or [])
            if item.get("symbol")
        ]

    def profile(self, symbol: str):
        """Lightweight company profile from the public search endpoint."""
        key = symbol.upper()
        now = time.time()
        with self._profile_lock:
            cached = self._profile_cache.get(key)
            if cached and now - cached[0] < 3600:
                return cached[1]
        profile = {}
        try:
            for item in self.search(symbol):
                if (item.get("symbol") or "").upper() == key:
                    profile = item
                    break
        except Exception:
            profile = {}
        with self._profile_lock:
            self._profile_cache[key] = (now, profile)
        return profile

    def peer_metrics(self, symbol: str):
        """One lightweight trailing-metrics call for a peer."""
        types = [
            "MarketCap",
            "EnterpriseValue",
            "PeRatio",
            "ForwardPeRatio",
            "StockholdersEquity",
            "EBITDA",
            "TotalRevenue",
            "NetIncome",
            "DilutedEPS",
        ]
        type_param = ",".join(
            ["annualStockholdersEquity"] + ["trailing" + item for item in types]
        )
        now = int(time.time())
        encoded = urllib.parse.quote(symbol, safe="")
        params = urllib.parse.urlencode(
            {
                "symbol": symbol,
                "type": type_param,
                "period1": now - 3 * 365 * 86400,
                "period2": now + 86400,
            }
        )
        url = (
            "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/"
            f"finance/timeseries/{encoded}?{params}"
        )
        data = self._get_json(url, timeout=24)
        result = data.get("timeseries", {}).get("result") or []

        latest = {}
        annual_equity = None
        for item in result:
            meta = item.get("meta") or {}
            type_name = (meta.get("type") or [""])[0]
            if type_name == "annualStockholdersEquity":
                values = item.get(type_name) or []
                if values:
                    value = max(values, key=lambda entry: entry.get("asOfDate") or "")
                    annual_equity = safe_float(value.get("reportedValue"))
                continue
            if not type_name.startswith("trailing"):
                continue
            key = type_name[len("trailing") :]
            values = item.get(type_name) or []
            if not values:
                continue
            value = max(values, key=lambda entry: entry.get("asOfDate") or "")
            numeric = safe_float(value.get("reportedValue"))
            if numeric is None:
                numeric = safe_float(value.get("dataValue"))
            if numeric is not None:
                latest[key] = numeric

        market_cap = safe_float(latest.get("MarketCap"))
        enterprise_value = safe_float(latest.get("EnterpriseValue"))
        ebitda = safe_float(latest.get("EBITDA"))
        equity = safe_float(latest.get("StockholdersEquity")) or annual_equity
        net_income = safe_float(latest.get("NetIncome"))
        pe = safe_float(latest.get("PeRatio"))
        forward_pe = safe_float(latest.get("ForwardPeRatio"))
        if pe is None and market_cap and net_income and net_income > 0:
            pe = market_cap / net_income
        ev_ebitda = (
            enterprise_value / ebitda
            if enterprise_value and ebitda and ebitda > 0
            else None
        )
        price_to_book = (
            market_cap / equity
            if market_cap and equity and equity > 0
            else None
        )
        if not market_cap and not pe and not ev_ebitda:
            raise YahooError(f"No usable peer metrics for {symbol}")
        return {
            "marketCap": market_cap,
            "enterpriseValue": enterprise_value,
            "ebitda": ebitda,
            "equity": equity,
            "netIncome": net_income,
            "pe": pe,
            "forwardPe": forward_pe,
            "evEbitda": ev_ebitda,
            "priceToBook": price_to_book,
        }

    def quote(self, symbol: str):
        """A cheap, quote-only chart call for live refreshing (no 1-year history)."""
        encoded = urllib.parse.quote(symbol, safe="")
        params = urllib.parse.urlencode({"range": "1d", "interval": "1d", "includePrePost": "false"})
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?{params}"
        try:
            data = self._get_json(url, timeout=15)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise YahooError(f"No quote data for {symbol}") from exc
            raise
        result = (data.get("chart", {}).get("result") or [None])[0]
        if not result:
            error = data.get("chart", {}).get("error") or {}
            raise YahooError(error.get("description") or f"No quote data for {symbol}")
        return result.get("meta") or {}

    def chart(self, symbol: str):
        encoded = urllib.parse.quote(symbol, safe="")
        params = urllib.parse.urlencode(
            {"range": "1y", "interval": "1d", "includePrePost": "false", "events": "div,splits"}
        )
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?{params}"
        data = self._get_json(url, timeout=22)
        result = (data.get("chart", {}).get("result") or [None])[0]
        if not result:
            error = data.get("chart", {}).get("error") or {}
            raise YahooError(error.get("description") or f"No chart data for {symbol}")
        meta = result.get("meta") or {}
        timestamps = result.get("timestamp") or []
        quote = ((result.get("indicators", {}).get("quote") or [{}])[0]) or {}
        closes = quote.get("close") or []
        adj = ((result.get("indicators", {}).get("adjclose") or [{}])[0] or {}).get("adjclose")
        adjusted = adj or closes

        points = []
        for ts, close in zip(timestamps, adjusted):
            if close is None:
                continue
            points.append({"t": int(ts) * 1000, "c": round(float(close), 4)})
        # About 130 points is plenty for a sparkline and keeps payload small.
        if len(points) > 160:
            stride = max(1, len(points) // 140)
            sampled = points[::stride]
            if sampled[-1] is not points[-1]:
                sampled.append(points[-1])
            points = sampled
        return {"meta": meta, "points": points}

    def quote_summary(self, symbol: str):
        """Authenticated fundamentals. Returns {} rather than failing the request."""
        modules = (
            "price,summaryDetail,financialData,defaultKeyStatistics,"
            "assetProfile,earningsTrend"
        )
        last_error = None
        for attempt in range(2):
            with self._lock:
                try:
                    if self._opener is None or time.time() - self._session_born > 45 * 60:
                        self._reset_session()
                        self._new_session()
                    encoded_symbol = urllib.parse.quote(symbol, safe="")
                    encoded_crumb = urllib.parse.quote(self._crumb or "", safe="")
                    url = (
                        "https://query1.finance.yahoo.com/v10/finance/quoteSummary/"
                        f"{encoded_symbol}?modules={modules}&crumb={encoded_crumb}"
                    )
                    data = self._get_json(url, timeout=22)
                    error = data.get("quoteSummary", {}).get("error")
                    if error:
                        raise YahooError(error.get("description") or "quoteSummary error")
                    result = (data.get("quoteSummary", {}).get("result") or [None])[0]
                    if not result:
                        raise YahooError("Empty quoteSummary response")
                    return result
                except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, ValueError, YahooError) as exc:
                    last_error = exc
                    self._reset_session()
            if attempt == 0:
                time.sleep(1.0)
        print(f"  [yahoo] quoteSummary unavailable for {symbol}: {last_error}", file=sys.stderr)
        return {}

    def timeseries(self, symbol: str):
        """Annual + trailing statement data. No crumb required."""
        now = int(time.time())
        annual_types = [
            "TotalRevenue",
            "CostOfRevenue",
            "GrossProfit",
            "OperatingIncome",
            "EBIT",
            "EBITDA",
            "PretaxIncome",
            "TaxProvision",
            "NetIncome",
            "NetIncomeCommonStockholders",
            "DilutedEPS",
            "BasicEPS",
            "DilutedAverageShares",
            "InterestExpense",
            "TotalAssets",
            "TotalLiabilitiesNetMinorityInterest",
            "StockholdersEquity",
            "TotalDebt",
            "CashAndCashEquivalents",
            "CashCashEquivalentsAndShortTermInvestments",
            "CurrentAssets",
            "CurrentLiabilities",
            "NetPPE",
            "Goodwill",
            "OperatingCashFlow",
            "CapitalExpenditure",
            "FreeCashFlow",
            "ChangeInWorkingCapital",
            "StockBasedCompensation",
            "DepreciationAndAmortization",
            "RepurchaseOfCapitalStock",
            "CashDividendsPaid",
            "NetDebt",
            "WorkingCapital",
            "TangibleBookValue",
            "InvestedCapital",
        ]
        trailing_types = [
            "TotalRevenue",
            "NetIncome",
            "NetIncomeCommonStockholders",
            "EBIT",
            "EBITDA",
            "DilutedEPS",
            "OperatingCashFlow",
            "CapitalExpenditure",
            "FreeCashFlow",
            "StockBasedCompensation",
            "DepreciationAndAmortization",
            "InterestExpense",
            "TotalDebt",
            "CashAndCashEquivalents",
            "CashCashEquivalentsAndShortTermInvestments",
            "StockholdersEquity",
            "DilutedAverageShares",
            "CashDividendsPaid",
            "MarketCap",
            "EnterpriseValue",
            "PeRatio",
            "ForwardPeRatio",
            "PriceToBook",
            "EnterpriseToEbitda",
            "DividendYield",
        ]
        quarterly_types = [
            "TotalRevenue",
            "NetIncome",
            "NetIncomeCommonStockholders",
            "EBITDA",
            "EBIT",
            "DilutedEPS",
            "OperatingCashFlow",
            "CapitalExpenditure",
            "FreeCashFlow",
            "StockBasedCompensation",
            "TotalDebt",
            "CashCashEquivalentsAndShortTermInvestments",
            "StockholdersEquity",
            "DilutedAverageShares",
            "PretaxIncome",
            "TaxProvision",
            "InterestExpense",
            "GrossProfit",
            "OperatingIncome",
        ]
        types = ",".join(
            ["annual" + x for x in annual_types]
            + ["trailing" + x for x in trailing_types]
            + ["quarterly" + x for x in quarterly_types]
        )
        encoded = urllib.parse.quote(symbol, safe="")
        params = urllib.parse.urlencode(
            {
                "symbol": symbol,
                "type": types,
                "periodType": "annual",
                "period1": now - 5 * 365 * 86400,
                "period2": now + 86400,
            }
        )
        url = (
            "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/"
            f"finance/timeseries/{encoded}?{params}"
        )
        data = self._get_json(url, timeout=28)
        result = data.get("timeseries", {}).get("result") or []
        if not result:
            raise YahooError(f"No fundamentals found for {symbol}")
        return result

    def fx_rate(self, source: str, target: str):
        if not source or not target or source == target:
            return 1.0
        direct = f"{source}{target}=X"
        inverse = f"{target}{source}=X"
        for symbol, invert in ((direct, False), (inverse, True)):
            try:
                chart = self.chart(symbol)
                rate = safe_float(chart["meta"].get("regularMarketPrice"))
                if rate and rate > 0:
                    return (1.0 / rate) if invert else rate
            except Exception:
                continue
        return None


YAHOO = YahooClient()


class DataService:
    def __init__(self):
        self._stock_cache = {}
        self._search_cache = {}
        self._peer_cache = {}
        self._quote_cache = {}
        self._cache_lock = threading.Lock()
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        FALLBACK_DIR.mkdir(parents=True, exist_ok=True)

    # ---------- cache ----------
    def _read_disk(self, symbol):
        payload = self._read_disk_any_age(symbol)
        if payload is None:
            return None
        age = time.time() - payload.get("_cachedAt", 0)
        return payload if age <= DISK_CACHE_MAX_AGE else None

    def _read_disk_any_age(self, symbol):
        path = CACHE_DIR / f"{symbol.replace('/', '_')}.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def _cached_fundamentals(self, symbol):
        """Use a saved snapshot as fundamentals when live statements are missing.

        Saved snapshots carry their own ``meta.periods``, so period overlap
        checks still work after the fallback.
        """
        payload = self._read_disk_any_age(symbol)
        if not payload or not payload.get("financials"):
            return None
        return payload
        return None

    def _write_disk(self, symbol, payload):
        path = CACHE_DIR / f"{symbol.replace('/', '_')}.json"
        try:
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except Exception as exc:
            print(f"  [cache] write failed: {exc}", file=sys.stderr)

    @staticmethod
    def _keys_from_payload(payload):
        """The data-period fingerprint used to detect new filings.

        Periodic data arrives in two shapes: a dict of named period keys from
        the original source, or a plain list of period labels from the SEC
        provider. Both must work, because a mismatch here breaks the
        new-filing check rather than the page itself.
        """
        meta = (payload or {}).get("meta") or {}
        periods = meta.get("periods")
        if not isinstance(periods, dict):
            periods = {}
        history = (payload or {}).get("history") or []
        last_row = history[-1] if history and isinstance(history[-1], dict) else {}
        return {
            "ttmAsOf": periods.get("ttmAsOf") or last_row.get("date"),
            "quarters": periods.get("quarters") or [],
            "lastFiscalYearEnd": periods.get("lastFiscalYearEnd")
            or (payload or {}).get("fiscalYearEnd"),
            "mostRecentQuarter": periods.get("mostRecentQuarter") or last_row.get("date"),
            "historyYears": [
                row.get("year") for row in history if isinstance(row, dict)
            ],
            "historyLastDate": last_row.get("date"),
        }

    def _fallback(self, symbol):
        path = FALLBACK_DIR / f"{symbol.replace('/', '_')}.json"
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload.setdefault("meta", {})
            payload["meta"]["dataMode"] = "demo"
            payload["meta"]["dataNote"] = (
                "Live data was unavailable. Showing a bundled snapshot for this demo ticker."
            )
            return payload
        except Exception:
            return None

    # ---------- normalisation ----------
    @staticmethod
    def _expand_items(ts_result):
        """Flatten Yahoo results, whose entries may be grouped by periodType.

        A grouped item carries ``meta.type == ['annual', 'trailing']`` and holds
        one key per concrete series (``annualTotalRevenue``, ...). Ungrouped
        items already name the concrete key in ``meta.type``.
        """
        items = []
        for item in ts_result or []:
            types = (item.get("meta") or {}).get("type") or []
            concrete = {
                name: item.get(name)
                for name in types
                if item.get(name)
            }
            base = [name for name in types if not concrete.get(name)]
            for name, values in concrete.items():
                items.append((name, values))
            for name in base:
                items.append((name, item.get(name) or []))
        return items

    @staticmethod
    def _annual_series(ts_result):
        annual = {}
        for type_name, entries in DataService._expand_items(ts_result):
            if not type_name.startswith("annual"):
                continue
            key = type_name[len("annual") :]
            for entry in entries:
                as_of = entry.get("asOfDate")
                if not as_of:
                    continue
                annual.setdefault(as_of, {})[key] = safe_float(entry.get("reportedValue"))
        return annual

    @staticmethod
    def _trailing_series(ts_result):
        trailing = {}
        for type_name, values in DataService._expand_items(ts_result):
            if not type_name.startswith("trailing"):
                continue
            key = type_name[len("trailing") :]
            if not values:
                continue
            latest = max(values, key=lambda entry: entry.get("asOfDate") or "")
            trailing[key] = safe_float(latest.get("reportedValue"))
            if trailing[key] is None:
                trailing[key] = safe_float(latest.get("dataValue"))
        return trailing

    def _history(self, annual, fx, fmt):
        rows = []
        for date in sorted(annual.keys())[-5:]:
            row = annual[date]
            ocf = safe_num(row.get("OperatingCashFlow"))
            capex = safe_num(row.get("CapitalExpenditure"))
            fcf = safe_float(row.get("FreeCashFlow"))
            if fcf is None and ocf:
                fcf = ocf + capex
            equity = safe_num(row.get("StockholdersEquity"))
            shares = safe_num(row.get("DilutedAverageShares")) or 1.0
            rows.append(
                {
                    "date": date,
                    "period": "FY",
                    "year": fmt.render(date),
                    "revenue": safe_num(row.get("TotalRevenue")) * fx,
                    "grossProfit": safe_num(row.get("GrossProfit")) * fx,
                    "operatingIncome": safe_num(row.get("OperatingIncome")) * fx,
                    "ebit": safe_num(row.get("EBIT")) * fx,
                    "ebitda": safe_num(row.get("EBITDA")) * fx,
                    "netIncome": safe_num(row.get("NetIncomeCommonStockholders") or row.get("NetIncome")) * fx,
                    "eps": safe_num(row.get("DilutedEPS")) * fx,
                    "fcf": (fcf or 0.0) * fx,
                    "ocf": ocf * fx,
                    "capex": capex * fx,
                    "sbc": safe_num(row.get("StockBasedCompensation")) * fx,
                    "equity": equity * fx,
                    "debt": safe_num(row.get("TotalDebt")) * fx,
                    "cash": safe_num(row.get("CashCashEquivalentsAndShortTermInvestments") or row.get("CashAndCashEquivalents")) * fx,
                    "dividends": abs(safe_num(row.get("CashDividendsPaid"))) * fx,
                    "interestExpense": abs(safe_num(row.get("InterestExpense"))) * fx,
                    "shares": shares,
                    "taxRate": clamp(
                        (
                            safe_num(row.get("TaxProvision"))
                            / row.get("PretaxIncome")
                            if safe_num(row.get("PretaxIncome")) > 0
                            else 0.21
                        ),
                        0.0,
                        0.35,
                    ),
                }
            )
        return rows

    # ---------- trailing-twelve-month fundamentals ----------
    QUARTERLY_SUMS = (
        "TotalRevenue",
        "NetIncome",
        "EBITDA",
        "DilutedEPS",
        "FreeCashFlow",
        "OperatingCashFlow",
        "CapitalExpenditure",
    )
    # Annual-only fields whose most recent value stands in for a TTM figure.
    MOST_RECENT_FIELDS = (
        "TotalDebt",
        "CashCashEquivalentsAndShortTermInvestments",
        "CashAndCashEquivalents",
        "StockholdersEquity",
        "DilutedAverageShares",
        "EBIT",
        "PretaxIncome",
        "TaxProvision",
        "InterestExpense",
        "StockBasedCompensation",
        "GrossProfit",
        "OperatingIncome",
    )

    @staticmethod
    def _quarterly_series(ts_result):
        """Date-ordered quarterly rows, e.g. {'2026-06-30': {'NetIncome': 1.2e10, ...}}."""
        quarters = {}
        for type_name, entries in DataService._expand_items(ts_result):
            if not type_name.startswith("quarterly"):
                continue
            key = type_name[len("quarterly") :]
            for entry in entries:
                date = entry.get("asOfDate")
                if not date:
                    continue
                value = safe_float(entry.get("reportedValue"))
                if value is not None:
                    quarters.setdefault(date, {})[key] = value
        return quarters

    @classmethod
    def _ttm(cls, quarters):
        """Roll the latest four quarters into a trailing-twelve-month row.

        Returns (ttm_row, quarter_dates) or (None, []). Quarters must be
        consecutive: a missing quarter means the four-quarter sum would
        silently mix in stale or double-counted periods.
        """
        dates = sorted(quarters.keys())
        if len(dates) < 4:
            return None, []
        last4 = dates[-4:]
        spans = []
        for date in last4:
            try:
                spans.append(datetime.fromisoformat(date[:10]))
            except ValueError:
                return None, []
        gaps = [(spans[i + 1] - spans[i]).days for i in range(3)]
        if any(gap < 60 or gap > 100 for gap in gaps):
            return None, []

        row = {}
        for key in cls.QUARTERLY_SUMS:
            values = [quarters[date].get(key) for date in last4]
            if all(v is not None for v in values):
                row[key] = sum(values)
        for key in cls.MOST_RECENT_FIELDS:
            for date in reversed(dates):
                if quarters[date].get(key) is not None:
                    row[key] = quarters[date][key]
                    break
        return (row if row else None), last4

    @staticmethod
    def _ttm_share_basis(annual, last_fy):
        """Latest diluted share count as of the TTM end."""
        annual = annual or {}
        if not annual:
            return None
        if last_fy in annual and safe_num(annual[last_fy].get("DilutedAverageShares")):
            return safe_num(annual[last_fy].get("DilutedAverageShares"))
        for date in sorted(annual.keys(), reverse=True):
            if date <= last_fy and safe_num(annual[date].get("DilutedAverageShares")):
                return safe_num(annual[date].get("DilutedAverageShares"))
        return None

    def _normalize(self, symbol, qs, chart, ts_result, fallback_profile=None, ttm=None):
        price_mod = qs.get("price") or {}
        summary = qs.get("summaryDetail") or {}
        financial = qs.get("financialData") or {}
        stats = qs.get("defaultKeyStatistics") or {}
        profile = qs.get("assetProfile") or {}
        trend = qs.get("earningsTrend") or {}
        meta = chart.get("meta") or {}
        fiscal_ends = [
            (stats.get("lastFiscalYearEnd") or {}).get("fmt")
            if isinstance(stats.get("lastFiscalYearEnd"), dict)
            else None
        ]
        fmt = _PeriodLabels(fiscal_ends[0])
        annual = self._annual_series(ts_result)
        trailing = self._trailing_series(ts_result)
        history = self._history(annual, 1.0, fmt)

        quote_currency = (
            price_mod.get("currency")
            or summary.get("currency")
            or meta.get("currency")
            or "USD"
        ).upper()
        financial_currency = "USD"
        for item in ts_result:
            for entry in item.get((item.get("meta") or {}).get("type", [""])[0]) or []:
                cur = entry.get("currencyCode")
                if cur:
                    financial_currency = cur.upper()
                    break
            if financial_currency != "USD":
                break
        # Yahoo doesn't always stamp every row; infer from quoteSummary.
        financial_currency = (financial.get("financialCurrency") or financial_currency or quote_currency).upper()
        fx = 1.0
        fx_note = None
        if financial_currency != quote_currency:
            maybe_fx = YAHOO.fx_rate(financial_currency, quote_currency)
            if maybe_fx:
                fx = maybe_fx
                history = self._history(annual, fx, fmt)
                fx_note = f"Converted from {financial_currency} at 1 {financial_currency} = {fx:.4f} {quote_currency}."
            else:
                fx_note = (
                    f"Financials are reported in {financial_currency}; FX conversion was unavailable. "
                    "Per-share figures should be treated as approximate."
                )

        current_price = (
            safe_float(price_mod.get("regularMarketPrice"))
            or safe_float(financial.get("currentPrice"))
            or safe_float(meta.get("regularMarketPrice"))
        )
        shares = (
            safe_float(stats.get("sharesOutstanding"))
            or safe_float(stats.get("impliedSharesOutstanding"))
            or (history[-1].get("shares") if history else None)
            or 1.0
        )
        market_cap = (
            safe_float(price_mod.get("marketCap"))
            or safe_float(summary.get("marketCap"))
            or safe_float(trailing_safe.get("MarketCap"))
            or (current_price * shares if current_price else 0.0)
        )
        if current_price is None and shares and market_cap:
            current_price = market_cap / shares
        # A confirmed four-quarter TTM row rolls the latest filing in even when
        # Yahoo's ready-made trailing figure has not caught up yet.
        ttm = ttm if isinstance(ttm, dict) else None
        trailing_safe = trailing or {}
        revenue = (
            (ttm or {}).get("TotalRevenue")
            or safe_float(financial.get("totalRevenue"))
            or safe_float(trailing_safe.get("TotalRevenue"))
            or (history[-1]["revenue"] if history else 0.0)
        ) * fx
        net_income = (
            (ttm or {}).get("NetIncome")
            or safe_float(stats.get("netIncomeToCommon"))
            or safe_float(trailing_safe.get("NetIncomeCommonStockholders"))
            or safe_float(trailing_safe.get("NetIncome"))
            or (history[-1]["netIncome"] if history else 0.0)
        ) * fx
        eps = (
            (ttm or {}).get("DilutedEPS")
            or safe_float(stats.get("trailingEps"))
            or safe_float(trailing_safe.get("DilutedEPS"))
            or (history[-1]["eps"] if history else 0.0)
        ) * fx
        ebit = (
            (ttm or {}).get("EBIT")
            or safe_float(trailing_safe.get("EBIT"))
            or (history[-1]["ebit"] if history else 0.0)
        ) * fx
        ebitda = (
            (ttm or {}).get("EBITDA")
            or safe_float(financial.get("ebitda"))
            or safe_float(trailing_safe.get("EBITDA"))
            or (history[-1]["ebitda"] if history else 0.0)
        ) * fx
        ocf = (
            (ttm or {}).get("OperatingCashFlow")
            or safe_float(financial.get("operatingCashflow"))
            or safe_float(trailing_safe.get("OperatingCashFlow"))
            or (history[-1]["ocf"] if history else 0.0)
        ) * fx
        capex = safe_float((ttm or {}).get("CapitalExpenditure"))
        if capex is None:
            capex = safe_float(trailing_safe.get("CapitalExpenditure"))
        if capex is None:
            capex = history[-1]["capex"] if history else 0.0
        capex *= fx
        fcf = safe_float((ttm or {}).get("FreeCashFlow"))
        if fcf is None:
            fcf = safe_float(trailing_safe.get("FreeCashFlow"))
        if fcf is None:
            fcf = safe_float(financial.get("freeCashflow"))
        if fcf is None:
            fcf = ocf + capex
        fcf *= fx
        cash = (
            (ttm or {}).get("CashCashEquivalentsAndShortTermInvestments")
            or (ttm or {}).get("CashAndCashEquivalents")
            or safe_float(financial.get("totalCash"))
            or safe_float(trailing_safe.get("CashCashEquivalentsAndShortTermInvestments"))
            or safe_float(trailing_safe.get("CashAndCashEquivalents"))
            or 0.0
        ) * fx
        debt = (
            (ttm or {}).get("TotalDebt")
            or safe_float(financial.get("totalDebt"))
            or safe_float(trailing_safe.get("TotalDebt"))
            or 0.0
        ) * fx
        sbc = (
            (ttm or {}).get("StockBasedCompensation")
            or safe_float(trailing_safe.get("StockBasedCompensation"))
            or (history[-1]["sbc"] if history else 0.0)
        ) * fx
        equity = (
            (ttm or {}).get("StockholdersEquity")
            or safe_float(trailing_safe.get("StockholdersEquity"))
            or (history[-1]["equity"] if history else 0.0)
        ) * fx
        book_value = safe_float(stats.get("bookValue"))
        if book_value is not None:
            book_value *= fx
        else:
            book_value = equity / shares if shares else 0.0
        dividend_per_share = safe_float(summary.get("dividendRate"))
        if dividend_per_share is not None:
            dividend_per_share *= fx
        else:
            paid = abs(safe_float(trailing_safe.get("CashDividendsPaid")) or 0.0) * fx
            dividend_per_share = paid / shares if shares else 0.0
        dividend_yield = safe_float(summary.get("dividendYield"))
        if dividend_yield is None:
            dividend_yield = safe_float(trailing_safe.get("DividendYield"))
        if dividend_yield is None and current_price:
            dividend_yield = dividend_per_share / current_price
        if dividend_yield is not None and dividend_yield > 1.0:
            dividend_yield /= 100.0
        payout = safe_float(summary.get("payoutRatio"))
        if payout is None and net_income > 0:
            payout = abs(dividend_per_share * shares) / net_income
        beta = safe_float(stats.get("beta")) or safe_float(summary.get("beta")) or 1.0

        gross_margin = safe_float(financial.get("grossMargins"))
        if gross_margin is None and revenue:
            gross_margin = safe_num((ttm or {}).get("GrossProfit") or trailing_safe.get("GrossProfit")) * fx / revenue
        operating_margin = safe_float(financial.get("operatingMargins"))
        if operating_margin is None and revenue:
            operating_margin = ebit / revenue
        profit_margin = safe_float(financial.get("profitMargins"))
        if profit_margin is None and revenue:
            profit_margin = net_income / revenue

        forward_eps = safe_float(stats.get("forwardEps"))
        if forward_eps is not None:
            forward_eps *= fx
        forward_growth = None
        for row in trend.get("trend") or []:
            if row.get("period") == "+1y":
                forward_growth = safe_float(row.get("growth"))
                estimate = safe_float((row.get("earningsEstimate") or {}).get("avg"))
                if estimate is not None and forward_eps is None:
                    forward_eps = estimate * fx
                break
        revenue_growth = safe_float(financial.get("revenueGrowth"))
        if revenue_growth is None and len(history) >= 2 and history[-2]["revenue"]:
            revenue_growth = pct_change(history[-1]["revenue"], history[-2]["revenue"])
        earnings_growth = safe_float(financial.get("earningsGrowth"))
        if earnings_growth is None and len(history) >= 2 and history[-2]["netIncome"]:
            earnings_growth = pct_change(history[-1]["netIncome"], history[-2]["netIncome"])

        prev_close = (
            safe_float(summary.get("previousClose"))
            or safe_float(price_mod.get("regularMarketPreviousClose"))
            or safe_float(meta.get("chartPreviousClose"))
            or safe_float(meta.get("previousClose"))
        )
        change = safe_float(price_mod.get("regularMarketChange"))
        change_pct = safe_float(price_mod.get("regularMarketChangePercent"))
        if change is None and current_price and prev_close:
            change = current_price - prev_close
        if change_pct is None and change is not None and prev_close:
            change_pct = change / prev_close

        fiscal_end = None
        if stats.get("lastFiscalYearEnd"):
            fiscal_end = stats["lastFiscalYearEnd"].get("fmt") if isinstance(stats["lastFiscalYearEnd"], dict) else None
        if not fiscal_end and history:
            fiscal_end = history[-1]["date"]
        if (ttm or {}).get("_asOf") and history and (ttm or {}).get("_asOf") > history[-1]["date"]:
            merged = {
                "date": ttm["_asOf"],
                "period": "TTM",
                "year": f"TTM {ttm['_asOf'][:7]}",
                "revenue": revenue,
                "grossProfit": safe_num(ttm.get("GrossProfit")) * fx,
                "operatingIncome": safe_num(ttm.get("OperatingIncome")) * fx,
                "ebit": ebit,
                "ebitda": ebitda,
                "netIncome": net_income,
                "eps": eps,
                "fcf": fcf,
                "ocf": ocf,
                "capex": capex,
                "sbc": sbc,
                "equity": equity,
                "debt": debt,
                "cash": cash,
                "dividends": safe_num(trailing_safe.get("CashDividendsPaid")) * fx,
                "interestExpense": safe_num(ttm.get("InterestExpense")) * fx,
                "shares": safe_num(ttm.get("DilutedAverageShares")) or shares,
                "taxRate": clamp(
                    safe_num(ttm.get("TaxProvision")) / ttm.get("PretaxIncome")
                    if safe_num(ttm.get("PretaxIncome")) > 0
                    else (history[-1]["taxRate"] if history else 0.21),
                    0.0,
                    0.35,
                ),
            }
            history = history + [merged]

        target_mean = safe_float(financial.get("targetMeanPrice"))
        if target_mean is not None:
            target_mean *= fx

        history_summary = trend.get("trend")
        recommendation = financial.get("recommendationKey") or ""
        warning_parts = []
        if not qs:
            warning_parts.append(
                "Live analyst targets and profile details were unavailable; valuation uses statement data only."
            )

        payload = {
            "symbol": price_mod.get("symbol") or symbol,
            "name": price_mod.get("longName")
            or price_mod.get("shortName")
            or summary.get("displayName")
            or (fallback_profile or {}).get("name")
            or symbol,
            "shortName": price_mod.get("shortName") or symbol,
            "exchange": price_mod.get("exchangeName")
            or meta.get("exchangeName")
            or (fallback_profile or {}).get("exchange")
            or "",
            "currency": quote_currency,
            "financialCurrency": financial_currency,
            "quoteType": price_mod.get("quoteType") or "EQUITY",
            "sector": profile.get("sector") or (fallback_profile or {}).get("sector") or "",
            "industry": profile.get("industry") or (fallback_profile or {}).get("industry") or "",
            "country": profile.get("country") or "",
            "website": profile.get("website") or "",
            "description": profile.get("longBusinessSummary") or "",
            "employees": safe_float(profile.get("fullTimeEmployees")),
            "price": {
                "last": current_price,
                "change": change,
                "changePercent": change_pct,
                "previousClose": prev_close,
                "dayLow": safe_float(summary.get("dayLow")) or safe_float(meta.get("regularMarketDayLow")),
                "dayHigh": safe_float(summary.get("dayHigh")) or safe_float(meta.get("regularMarketDayHigh")),
                "fiftyTwoWeekLow": safe_float(summary.get("fiftyTwoWeekLow")) or safe_float(meta.get("fiftyTwoWeekLow")),
                "fiftyTwoWeekHigh": safe_float(summary.get("fiftyTwoWeekHigh")) or safe_float(meta.get("fiftyTwoWeekHigh")),
                "marketCap": market_cap,
                "enterpriseValue": safe_float(stats.get("enterpriseValue")) or (market_cap + debt - cash if market_cap else None),
                "history": chart.get("points") or [],
                "marketState": price_mod.get("marketState") or meta.get("marketState") or "",
                "quoteTime": price_mod.get("regularMarketTime") or meta.get("regularMarketTime"),
            },
            "financials": {
                "revenue": revenue,
                "netIncome": net_income,
                "eps": eps,
                "forwardEps": forward_eps,
                "ebit": ebit,
                "ebitda": ebitda,
                "ocf": ocf,
                "capex": capex,
                "fcf": fcf,
                "sbc": sbc,
                "cash": cash,
                "totalDebt": debt,
                "netDebt": debt - cash,
                "equity": equity,
                "bookValuePerShare": book_value,
                "sharesOutstanding": shares,
                "grossMargin": gross_margin,
                "operatingMargin": operating_margin,
                "profitMargin": profit_margin,
                "fcfMargin": (fcf / revenue) if revenue else None,
                "revenueGrowth": revenue_growth,
                "earningsGrowth": earnings_growth,
                "forwardGrowth": forward_growth,
                "returnOnEquity": safe_float(financial.get("returnOnEquity")),
                "returnOnAssets": safe_float(financial.get("returnOnAssets")),
                "currentRatio": safe_float(financial.get("currentRatio")),
                "debtToEquity": safe_float(financial.get("debtToEquity")),
                "interestExpense": (
                    safe_float(trailing_safe.get("InterestExpense"))
                    or (history[-1].get("interestExpense") if history else 0.0)
                    or 0.0
                )
                * fx,
                "dividendPerShare": dividend_per_share,
                "dividendYield": dividend_yield,
                "payoutRatio": payout,
                "beta": beta,
                "pe": safe_float(summary.get("trailingPE")) or safe_float(trailing_safe.get("PeRatio")),
                "forwardPe": safe_float(summary.get("forwardPE")) or safe_float(trailing_safe.get("ForwardPeRatio")),
                "priceToBook": safe_float(stats.get("priceToBook")) or safe_float(trailing_safe.get("PriceToBook")),
                "evToEbitda": safe_float(stats.get("enterpriseToEbitda")) or safe_float(trailing_safe.get("EnterpriseToEbitda")),
                "taxRate": history[-1]["taxRate"] if history else 0.21,
            },
            "analysts": {
                "targetMean": target_mean,
                "targetHigh": (safe_float(financial.get("targetHighPrice")) or 0) * fx or None,
                "targetLow": (safe_float(financial.get("targetLowPrice")) or 0) * fx or None,
                "targetMedian": (safe_float(financial.get("targetMedianPrice")) or 0) * fx or None,
                "count": safe_float(financial.get("numberOfAnalystOpinions")),
                "recommendation": recommendation,
                "recommendationMean": safe_float(financial.get("recommendationMean")),
            },
            "history": history,
            "fiscalYearEnd": fiscal_end,
            "meta": {
                "provider": "Yahoo Finance",
                "fetchedAt": utc_now(),
                "dataMode": "live",
                "fxRate": fx,
                "fxNote": fx_note,
                "warning": " ".join(warning_parts) or None,
                "quoteDelayMinutes": safe_float(price_mod.get("exchangeDataDelayedBy")) or 15,
                "earningsTrend": history_summary is not None,
                "periods": {
                    "lastFiscalYearEnd": fiscal_end,
                    "mostRecentQuarter": (
                        stats["mostRecentQuarter"].get("fmt")
                        if isinstance(stats.get("mostRecentQuarter"), dict)
                        else None
                    ),
                    "ttmAsOf": (ttm or {}).get("_asOf"),
                    "ttmSource": "quarters" if ttm else "reported",
                    "quarters": [row.get("date") for row in (ttm or {}).get("_quarters", [])],
                },
            },
        }
        return clean_payload(payload)

    # ---------- public ----------
    # ---------- public ----------
    @staticmethod
    def _changes(base, current):
        """Human-readable list of data periods that moved since `base`."""
        if not base:
            return []
        changes = []
        base_ttm = base.get("ttmAsOf")
        current_ttm = current.get("ttmAsOf")
        if current_ttm and base_ttm and current_ttm > str(base_ttm):
            changes.append(
                {"field": "ttm", "label": "Latest report", "from": base_ttm, "to": current_ttm}
            )
        base_fy = base.get("lastFiscalYearEnd")
        current_fy = current.get("lastFiscalYearEnd")
        if current_fy and base_fy and str(current_fy) > str(base_fy):
            changes.append(
                {"field": "fiscalYear", "label": "Fiscal year end", "from": base_fy, "to": current_fy}
            )
        base_years = [y for y in (base.get("historyYears") or []) if y and not str(y).startswith("TTM")]
        current_years = [y for y in (current.get("historyYears") or []) if y and not str(y).startswith("TTM")]
        if current_years and base_years and current_years != base_years:
            changes.append(
                {
                    "field": "history",
                    "label": "Annual statements",
                    "from": base_years[-1] if base_years else None,
                    "to": current_years[-1] if current_years else None,
                }
            )
        return changes

    def check_update(self, symbol: str, client_keys=None):
        """Compare live data periods with the ones the page is showing."""
        symbol = symbol.upper()
        if not SYMBOL_RE.match(symbol):
            raise ValueError("Invalid ticker symbol")
        with self._cache_lock:
            cached = self._stock_cache.get(symbol)
        if not cached:
            return {"symbol": symbol, "updated": False, "reason": "not-loaded"}
        server_keys = self._keys_from_payload(cached[1])
        if not (server_keys.get("ttmAsOf") or server_keys.get("lastFiscalYearEnd")):
            return {"symbol": symbol, "updated": False, "reason": "unknown-periods"}
        base = client_keys if isinstance(client_keys, dict) else server_keys
        changes = self._changes(base, server_keys)
        return {
            "symbol": symbol,
            "updated": bool(changes),
            "changes": changes,
            "checkedAt": utc_now(),
            "serverFetchedAt": (cached[1].get("meta") or {}).get("fetchedAt"),
        }

    def stock_fresh(self, symbol: str):
        """Force a live refetch, bypassing the 15-minute valuation cache."""
        symbol = symbol.upper()
        if not SYMBOL_RE.match(symbol):
            raise ValueError("Invalid ticker symbol")
        with self._cache_lock:
            self._stock_cache.pop(symbol, None)
        return self.stock(symbol)

    def _enrich_profile(self, symbol, payload):
        """Fill sector and industry from search, which needs no session cookie.

        Sector matters because it decides which valuation models the engine
        applies, so a blank value would silently change the analysis.
        """
        if payload.get("sector"):
            return
        try:
            for item in YAHOO.search(symbol):
                if (item.get("symbol") or "").upper() == symbol.upper():
                    payload["sector"] = item.get("sector") or ""
                    payload["industry"] = item.get("industry") or ""
                    if not payload.get("exchange"):
                        payload["exchange"] = item.get("exchange") or ""
                    return
        except Exception:
            return

    def stock(self, symbol: str, force: bool = False):
        symbol = symbol.upper()
        if not SYMBOL_RE.match(symbol):
            raise ValueError("Invalid ticker symbol")
        now = time.time()
        if not force:
            with self._cache_lock:
                cached = self._stock_cache.get(symbol)
                if cached and now - cached[0] < CACHE_TTL_SECONDS:
                    return cached[1]
        else:
            with self._cache_lock:
                cached = self._stock_cache.get(symbol)

        # Primary source: SEC XBRL filings + keyless price. This path needs no
        # session cookie or crumb, so it keeps working on hosts whose IP range
        # Yahoo throttles.
        if sec_provider is not None:
            try:
                payload = sec_provider.build(symbol)
                self._enrich_profile(symbol, payload)
                with self._cache_lock:
                    self._stock_cache[symbol] = (now, payload)
                self._write_disk(symbol, {**payload, "_cachedAt": now})
                return payload
            except Exception as exc:
                print(f"  [sec] {symbol}: {type(exc).__name__}: {exc}", file=sys.stderr)

        chart = None
        ts_result = None
        qs = {}
        errors = []
        try:
            chart = YAHOO.chart(symbol)
        except Exception as exc:
            errors.append(f"price: {exc}")
        try:
            ts_result = YAHOO.timeseries(symbol)
        except Exception as exc:
            errors.append(f"fundamentals: {exc}")
        if chart is None:
            disk = self._read_disk(symbol)
            if disk:
                disk.setdefault("meta", {})
                disk["meta"]["dataMode"] = "cache"
                disk["meta"]["dataNote"] = (
                    "Live refresh failed. Showing the most recent saved snapshot for this ticker."
                )
                return disk
            demo = self._fallback(symbol)
            if demo:
                return demo
            if not symbol:
                raise YahooError("Enter a ticker symbol.")
            raise YahooError(
                f"No usable market or fundamental data was found for {symbol}. "
                "Check the ticker and any exchange suffix (for example .HK, .T, .L or .NS)."
            )

        qs = YAHOO.quote_summary(symbol)
        fallback_profile = None
        if not qs:
            # Keep sector/industry weights sensible when the authenticated
            # profile endpoint is unavailable but the rest of the data works.
            try:
                for item in YAHOO.search(symbol):
                    if (item.get("symbol") or "").upper() == symbol.upper():
                        fallback_profile = item
                        break
            except Exception:
                fallback_profile = None

        if ts_result is None:
            # Price and quoteSummary are available but statements are not.
            # Reuse the last statements for this ticker so the page still loads,
            # and label the mix clearly instead of failing outright.
            prior = self._read_disk(symbol)
            if prior and prior.get("financials"):
                recovered = {
                    "meta": {
                        **(prior.get("meta") or {}),
                        "flavour": "fundamentals-missing",
                        "livePrice": True,
                    },
                    "summaryDetail": prior.get("summaryDetail"),
                    "financialData": prior.get("financialData"),
                }
                chart["meta"] = {**(chart.get("meta") or {}), "recovered": True}
                try:
                    payload = self._normalize(
                        symbol, qs or recovered, chart, [], fallback_profile
                    )
                except Exception:
                    payload = None
                if payload:
                    payload.setdefault("meta", {})
                    payload["meta"]["dataMode"] = "partial"
                    payload["meta"]["dataNote"] = (
                        "Live price loaded, but statement data could not be refreshed. "
                        "Valuations use the most recent saved fundamentals."
                    )
                    return payload
            raise YahooError(
                f"Price data loaded for {symbol}, but statement data was unavailable. "
                "Try again in a moment."
            )
        ttm_row = None
        ttm_quarters = []
        try:
            ttm_row, ttm_quarters = self._ttm(self._quarterly_series(ts_result))
        except Exception:
            ttm_row, ttm_quarters = None, []
        if ttm_row and ttm_quarters:
            ttm_row = dict(ttm_row)
            ttm_row["_asOf"] = ttm_quarters[-1]
            ttm_row["_quarters"] = [{"date": date} for date in ttm_quarters]
        try:
            payload = self._normalize(symbol, qs, chart, ts_result, fallback_profile, ttm_row)
        except Exception as exc:
            # Full detail stays in the server log. The visitor gets a plain
            # message and a reference, never an exception string.
            ref = log_internal_error(f"normalize:{symbol}", exc)
            raise YahooError(
                f"Could not parse fundamentals for {symbol} (reference {ref})"
            ) from exc

        self._write_disk(symbol, {**payload, "_cachedAt": now})
        with self._cache_lock:
            self._stock_cache[symbol] = (now, payload)
        return payload

    def quote_refresh(self, symbol: str):
        """Lightweight price refresh for the live toggle."""
        symbol = symbol.upper()
        if not SYMBOL_RE.match(symbol):
            raise ValueError("Invalid ticker symbol")
        now = time.time()
        with self._cache_lock:
            cached = self._quote_cache.get(symbol)
            if cached and now - cached[0] < QUOTE_TTL_SECONDS:
                return cached[1]

        meta = YAHOO.quote(symbol)
        price = safe_float(meta.get("regularMarketPrice"))
        if price is None:
            raise YahooError(f"No quote data for {symbol}")
        previous_close = (
            safe_float(meta.get("chartPreviousClose"))
            or safe_float(meta.get("previousClose"))
            or safe_float(meta.get("regularMarketPreviousClose"))
        )
        change_pct = safe_float(meta.get("regularMarketChangePercent"))
        if change_pct is not None and abs(change_pct) > 1:
            change_pct = change_pct / 100.0
        change = price - previous_close if previous_close else None
        if change is None and change_pct is not None and previous_close:
            change = previous_close * change_pct
        if change is not None and previous_close:
            change_pct = change / previous_close

        quote_payload = {
            "symbol": (meta.get("symbol") or symbol).upper(),
            "price": price,
            "change": change,
            "changePercent": change_pct,
            "previousClose": previous_close,
            "dayLow": safe_float(meta.get("regularMarketDayLow")),
            "dayHigh": safe_float(meta.get("regularMarketDayHigh")),
            "fiftyTwoWeekLow": safe_float(meta.get("fiftyTwoWeekLow")),
            "fiftyTwoWeekHigh": safe_float(meta.get("fiftyTwoWeekHigh")),
            "marketState": meta.get("marketState") or "UNKNOWN",
            "quoteTime": meta.get("regularMarketTime"),
            "currency": (meta.get("currency") or "").upper() or None,
            "asOf": utc_now(),
        }
        with self._cache_lock:
            self._quote_cache[symbol] = (now, quote_payload)
        return quote_payload

    # ---------- peer set ----------
    @staticmethod
    def _median_filter(values, low, high):
        clean = sorted(v for v in values if v is not None and low < v < high)
        if not clean:
            return None, 0
        return round(median(clean), 4), len(clean)

    def peers(self, symbol: str):
        symbol = symbol.upper()
        if not SYMBOL_RE.match(symbol):
            raise ValueError("Invalid ticker symbol")
        now = time.time()
        with self._cache_lock:
            cached = self._peer_cache.get(symbol)
            if cached and now - cached[0] < PEER_CACHE_TTL:
                return cached[1]

        try:
            company = self.stock(symbol)
        except Exception as exc:
            raise YahooError(str(exc)) from exc

        sector = company.get("sector") or ""
        industry = company.get("industry") or ""
        candidates = []
        seen = {symbol}
        use_profiles = False
        if sector in SECTOR_UNIVERSE:
            # Sector-universe candidates already have a trustworthy sector, so
            # skip the slow per-symbol profile lookup.
            for item in SECTOR_UNIVERSE[sector][:7]:
                if item.upper() not in seen:
                    seen.add(item.upper())
                    candidates.append({"symbol": item.upper(), "expectedSector": sector})
        else:
            use_profiles = True
            try:
                recs = YAHOO.recommendations(symbol)[:5]
            except Exception:
                recs = []
            for item in recs:
                if item and item.upper() not in seen:
                    seen.add(item.upper())
                    candidates.append({"symbol": item.upper(), "expectedSector": None})

        def collect(candidate):
            peer_symbol = candidate["symbol"]
            profile = {}
            if use_profiles:
                try:
                    profile = YAHOO.profile(peer_symbol)
                except Exception:
                    profile = {}
            try:
                metrics = YAHOO.peer_metrics(peer_symbol)
            except Exception:
                return None
            peer_sector = profile.get("sector") or candidate.get("expectedSector") or ""
            if sector and peer_sector and peer_sector.lower() != sector.lower():
                return None
            if sector and not peer_sector:
                return None
            return {
                "symbol": peer_symbol,
                "name": profile.get("name") or KNOWN_NAMES.get(peer_symbol) or peer_symbol,
                "exchange": profile.get("exchange") or "",
                "sector": peer_sector,
                "industry": profile.get("industry") or "",
                "marketCap": metrics.get("marketCap"),
                "pe": metrics.get("pe"),
                "forwardPe": metrics.get("forwardPe"),
                "evEbitda": metrics.get("evEbitda"),
                "priceToBook": metrics.get("priceToBook"),
            }

        fetched = []
        if candidates:
            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = [pool.submit(collect, candidate) for candidate in candidates]
                for future in as_completed(futures):
                    try:
                        item = future.result()
                    except Exception:
                        item = None
                    if item:
                        fetched.append(item)

        # Prefer peers in the same industry, then the same sector. Within each
        # bucket, larger companies make a more stable multiple benchmark.
        same_industry = [
            p for p in fetched
            if industry and p.get("industry") and p["industry"].lower() == industry.lower()
        ]
        same_sector = [p for p in fetched if p not in same_industry]
        same_industry.sort(key=lambda p: p.get("marketCap") or 0, reverse=True)
        same_sector.sort(key=lambda p: p.get("marketCap") or 0, reverse=True)
        selected = (same_industry + same_sector)[:6]

        pe, pe_count = self._median_filter([p.get("pe") for p in selected], 0, 120)
        ev_ebitda, ev_count = self._median_filter([p.get("evEbitda") for p in selected], 0, 60)
        price_to_book, pb_count = self._median_filter([p.get("priceToBook") for p in selected], 0, 15)

        target = {
            "symbol": symbol,
            "name": company.get("name") or symbol,
            "exchange": company.get("exchange") or "",
            "sector": sector,
            "industry": industry,
            "marketCap": company.get("price", {}).get("marketCap"),
            "pe": company.get("financials", {}).get("pe"),
            "forwardPe": company.get("financials", {}).get("forwardPe"),
            "evEbitda": company.get("financials", {}).get("evToEbitda"),
            "priceToBook": company.get("financials", {}).get("priceToBook"),
        }
        payload = {
            "symbol": symbol,
            "sector": sector,
            "industry": industry,
            "target": target,
            "peers": selected,
            "count": len(selected),
            "industryCount": len(same_industry),
            "median": {
                "pe": pe,
                "peCount": pe_count,
                "evEbitda": ev_ebitda,
                "evCount": ev_count,
                "priceToBook": price_to_book,
                "pbCount": pb_count,
            },
            "status": "ok" if len(selected) >= 3 else "limited",
            "asOf": utc_now(),
            "source": "Yahoo Finance public data",
        }
        with self._cache_lock:
            self._peer_cache[symbol] = (now, payload)
        return clean_payload(payload)

    def search(self, query: str):
        query = query.strip()
        if not query:
            return []
        key = query.lower()
        now = time.time()
        with self._cache_lock:
            cached = self._search_cache.get(key)
            if cached and now - cached[0] < 1800:
                return cached[1]
        try:
            results = YAHOO.search(query)
        except Exception:
            results = []
        if not results:
            needle = key.replace(" ", "")
            results = [
                {
                    "symbol": symbol,
                    "name": name,
                    "shortName": name,
                    "exchange": exchange,
                    "sector": sector,
                    "industry": industry,
                    "type": "Equity",
                }
                for symbol, name, exchange, sector, industry in POPULAR
                if needle in symbol.lower() or needle in name.lower().replace(" ", "")
            ][:10]
        with self._cache_lock:
            self._search_cache[key] = (now, results)
        return results


SERVICE = DataService()


class Handler(SimpleHTTPRequestHandler):
    # Do not advertise the version: it tells an attacker which bugs to try.
    server_version = "Intrinsic"
    sys_version = ""

    def version_string(self):
        return self.server_version

    def end_headers(self):
        # Applied centrally so no response path can forget them.
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("INTRINSIC_QUIET") == "1":
            return
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    # ---------- access control ----------
    def _client_key(self):
        # Behind a platform proxy the socket address is the proxy; the first
        # X-Forwarded-For entry is the real client. Only the first entry is
        # trusted, and never for authentication.
        forwarded = self.headers.get("X-Forwarded-For") or ""
        if forwarded:
            first = forwarded.split(",")[0].strip()
            if first:
                return first
        return self.client_address[0] if self.client_address else "unknown"

    def _authorised(self):
        if not AUTH_PASSWORD:
            return True
        header = self.headers.get("Authorization") or ""
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:].strip()).decode("utf-8", "replace")
        except Exception:
            return False
        username, _, password = decoded.partition(":")
        if username != AUTH_USER:
            return False
        # Compare in constant time so response timing reveals nothing.
        return _constant_time_compare(password, AUTH_PASSWORD)

    def _require_auth(self):
        body = b"Authentication required."
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Intrinsic", charset="UTF-8"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _rate_limited(self):
        allowed, remaining = LIMITER.allow(self._client_key())
        if allowed:
            return False
        body = json.dumps(
            {
                "error": "Too many requests. Wait a moment and try again.",
                "retryAfterSeconds": remaining,
            }
        ).encode("utf-8")
        self.send_response(429)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Retry-After", str(remaining))
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
        return True

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _serve_static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        if rel.startswith("static/"):
            rel = rel[len("static/") :]
        target = (STATIC_DIR / rel).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self.send_error(403, "Forbidden")
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.exists() or not target.is_file():
            # SPA fallback for an unknown path without a file extension.
            if "." not in Path(rel).name:
                target = STATIC_DIR / "index.html"
            else:
                self.send_error(404, "Not found")
                return
        mime, _ = mimetypes.guess_type(str(target))
        content = target.read_bytes()
        # Compress text assets for slow or mobile connections. Small files are
        # cheaper to send uncompressed.
        encoding = None
        accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "").lower()
        compressible = (mime or "").startswith("text/") or mime in (
            "application/javascript",
            "application/json",
            "image/svg+xml",
        )
        if accepts_gzip and compressible and len(content) > 1024:
            content = gzip.compress(content, compresslevel=6)
            encoding = "gzip"
        self.send_response(200)
        self.send_header("Content-Type", (mime or "application/octet-stream") + ("; charset=utf-8" if (mime or "").startswith("text/") or mime in ("application/javascript", "application/json") else ""))
        self.send_header("Content-Length", str(len(content)))
        if encoding:
            self.send_header("Content-Encoding", encoding)
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._authorised():
            self._require_auth()
            return
        if self._rate_limited():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        if path == "/api/health":
            # Deliberately minimal: no cache timings or data inventory.
            self._json({"ok": True, "version": VERSION, "time": utc_now()})
            return
        if path == "/healthz":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/diag":
            # Deployment self-check: which upstream calls work from this host?
            # Opt-in only, because it exposes upstream failure detail.
            if not DIAG_ENABLED:
                self._json({"error": "Not found"}, 404)
                return
            result = {}
            for name, call in (
                ("chart", lambda: bool(YAHOO.chart("AAPL")["points"])),
                ("quote", lambda: bool(YAHOO.quote("AAPL"))),
                ("timeseries", lambda: len(YAHOO.timeseries("AAPL")) > 0),
                ("quoteSummary", lambda: bool(YAHOO.quote_summary("AAPL"))),
            ):
                try:
                    result[name] = "ok" if call() else "empty"
                except Exception as exc:
                    result[name] = f"{type(exc).__name__}: {str(exc)[:180]}"
            self._json({"host": "intrinsic", "version": VERSION, "checks": result})
            return
        if path == "/api/search":
            query = (urllib.parse.parse_qs(parsed.query).get("q") or [""])[0]
            if len(query) > 80:
                self._json({"error": "Search query is too long."}, 400)
                return
            try:
                self._json({"results": SERVICE.search(query)})
            except Exception as exc:
                ref = log_internal_error("search", exc)
                self._json(public_error("Search is temporarily unavailable.", ref), 502)
            return
        match = re.match(r"^/api/quote/([^/]+)$", path)
        if match:
            symbol = match.group(1).upper()
            if not SYMBOL_RE.match(symbol):
                self._json({"error": "That does not look like a ticker symbol."}, 400)
                return
            try:
                self._json(SERVICE.quote_refresh(symbol))
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except YahooError as exc:
                self._json({"error": str(exc), "symbol": symbol}, 404)
            except Exception as exc:
                ref = log_internal_error("quote", exc)
                self._json(public_error("Could not load that quote.", ref), 500)
            return
        match = re.match(r"^/api/peers/([^/]+)$", path)
        if match:
            symbol = match.group(1).upper()
            if not SYMBOL_RE.match(symbol):
                self._json({"error": "That does not look like a ticker symbol."}, 400)
                return
            try:
                self._json(SERVICE.peers(symbol))
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except YahooError as exc:
                self._json({"error": str(exc), "symbol": symbol}, 404)
            except Exception as exc:
                ref = log_internal_error("peers", exc)
                self._json(public_error("Could not load peer data.", ref), 500)
            return
        match = re.match(r"^/api/data-version/([^/]+)$", path)
        if match:
            symbol = match.group(1).upper()
            if not SYMBOL_RE.match(symbol):
                self._json({"error": "That does not look like a ticker symbol."}, 400)
                return
            keys = None
            for key in ("ttm", "fiscalYear", "history"):
                value = (urllib.parse.parse_qs(parsed.query).get(key) or [None])[0]
                if value:
                    keys = keys or {}
                    keys_key = {"ttm": "ttmAsOf", "fiscalYear": "lastFiscalYearEnd", "history": "historyLastDate"}[key]
                    keys[keys_key] = value
            try:
                self._json(SERVICE.check_update(symbol, keys))
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except Exception as exc:
                ref = log_internal_error("data-version", exc)
                self._json(public_error("Could not check for new data.", ref), 500)
            return
        match = re.match(r"^/api/stock/([^/]+)$", path)
        if match:
            symbol = match.group(1).upper()
            if not SYMBOL_RE.match(symbol):
                self._json({"error": "That does not look like a ticker symbol."}, 400)
                return
            refresh = (urllib.parse.parse_qs(parsed.query).get("refresh") or ["0"])[0] in ("1", "true")
            try:
                payload = SERVICE.stock(symbol, force=refresh)
                self._json(payload)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except YahooError as exc:
                self._json(
                    {
                        "error": str(exc),
                        "hint": "Check the ticker or try a larger, more liquid company.",
                        "symbol": symbol,
                    },
                    404,
                )
            except Exception as exc:
                ref = log_internal_error("stock", exc)
                self._json(public_error("Could not build the valuation for that company.", ref), 500)
            return
        if path.startswith("/api/"):
            self._json({"error": "Unknown API route"}, 404)
            return
        self._serve_static(path)


def port_available(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def main():
    parser = argparse.ArgumentParser(description="Intrinsic stock valuation workbench")
    parser.add_argument("--host", default=None, help="Bind address (default: HOST env var, else 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="Port (default: PORT env var, else 8765)")
    parser.add_argument("--open", action="store_true", help="Open the app in your browser")
    args = parser.parse_args()

    # Hosting platforms inject PORT and expect a public bind. Locally we keep
    # the safe loopback default.
    env_port = os.environ.get("PORT", "").strip()
    env_host = os.environ.get("HOST", "").strip()
    cloud = bool(env_port) or env_host == "0.0.0.0"
    host = args.host or env_host or ("0.0.0.0" if cloud else "127.0.0.1")
    try:
        port = args.port or int(env_port or 8765)
    except ValueError:
        raise SystemExit(f"PORT must be a number, got {env_port!r}")

    # Locally, step forward instead of failing when the default is busy.
    for candidate in range(port, port + 25):
        if port_available(host, candidate):
            port = candidate
            break
    else:
        raise SystemExit(f"No free port found in range {port}-{port + 24}")

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    url = f"http://{host}:{port}"
    print()
    print("  INTRINSIC — stock valuation workbench")
    print(f"  {url}")
    print("  Press Ctrl+C to stop.")
    print(flush=True)
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
