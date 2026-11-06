#!/usr/bin/env python3
"""
Fundamentals provider for Intrinsic.

Replaces the Yahoo quoteSummary/crumb path, which returns HTTP 429 from
datacentre IPs (every free host) because Yahoo throttles cloud ranges.

Sources, both keyless and cloud-safe:

  * **SEC EDGAR XBRL company facts** — revenue, margins, cash flow, capex,
    balance sheet and share counts, straight from the company's own 10-K and
    10-Q filings. Authoritative rather than aggregated, and SEC permits
    automated access with a descriptive User-Agent.
  * **Yahoo chart endpoint** — last price and one year of closes. This route
    needs no cookie or crumb, so it keeps working from a datacentre.

Output matches the schema the browser already expects, so only the data layer
changed, not the valuation engine or the UI contract.
"""

from __future__ import annotations

import gzip
import json
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
CACHE_DIR = APP_DIR / "cache"

SEC_UA = "Intrinsic valuation app contact@example.com"
SEC_UA = __import__("os").environ.get("INTRINSIC_SEC_UA", SEC_UA).strip() or SEC_UA
# SEC rejects requests whose User-Agent carries no contact address, so make
# sure one is always present even if the variable is set badly.
if "@" not in SEC_UA:
    SEC_UA = f"{SEC_UA} contact@example.com"
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

CIK_TTL = 24 * 60 * 60
FACTS_TTL = 12 * 60 * 60
PRICE_TTL = 60

# ---------------------------------------------------------------------------
# XBRL tag groups. Each list is tried in order; the first tag with usable
# values wins. Companies label the same concept differently, so fallbacks are
# what make this work across the whole market rather than just the majors.
# ---------------------------------------------------------------------------
FLOW_TAGS = {
    "revenue": [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
        "SalesRevenueGoodsNet",
        "RevenuesNetOfInterestExpense",
        "InterestAndDividendIncomeOperating",
    ],
    "grossProfit": ["GrossProfit"],
    "operatingIncome": [
        "OperatingIncomeLoss",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    ],
    "netIncome": ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
    "ocf": [
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    "capex": [
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
        "PaymentsForCapitalImprovements",
        "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets",
    ],
    "sbc": ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
    "dividends": [
        "PaymentsOfDividendsCommonStock",
        "PaymentsOfDividends",
        "PaymentsOfDividendsAndDividendEquivalentsOnCommonStockAndPreferredStock",
    ],
    "dna": [
        "DepreciationDepletionAndAmortization",
        "DepreciationAmortizationAndAccretionNet",
        "DepreciationAndAmortization",
    ],
    "tax": ["IncomeTaxExpenseBenefit"],
    "pretax": [
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ],
    "interest": ["InterestExpense", "InterestExpenseNonoperating"],
}

INSTANT_TAGS = {
    "equity": [
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    "assets": ["Assets"],
    "currentAssets": ["AssetsCurrent"],
    "currentLiabilities": ["LiabilitiesCurrent"],
    "cash": [
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        "CashAndCashEquivalentsAtCarryingValueIncludingDiscontinuedOperations",
    ],
    "debt": ["LongTermDebtNoncurrent", "LongTermDebt", "DebtLongtermAndShorttermCombinedAmount"],
}

EPS_TAGS = ["EarningsPerShareDiluted", "EarningsPerShareBasic", "EarningsPerShareBasicAndDiluted"]


def _now():
    return time.time()


def _http_json(url, host=None, timeout=45):
    """Fetch JSON, choosing the User-Agent the target actually accepts.

    SEC rejects a generic browser string with 403 and wants a declared
    application identity. Yahoo's public endpoints behave the other way round
    and are happiest with a normal browser string.
    """
    is_sec = "sec.gov" in url
    headers = {
        "User-Agent": SEC_UA if is_sec else BROWSER_UA,
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
    }
    if host:
        headers["Host"] = host
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
        if (response.headers.get("Content-Encoding") or "").lower() == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8", "replace"))


class _DiskCache:
    def __init__(self, name):
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self.path = CACHE_DIR / name

    def read(self, ttl):
        if not self.path.exists():
            return None
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if _now() - data.get("_at", 0) > ttl:
            return None
        return data.get("value")

    def write(self, value):
        try:
            self.path.write_text(
                json.dumps({"_at": _now(), "value": value}, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            pass


class SecProvider:
    def __init__(self):
        self._lock = threading.Lock()
        self._cik_map = None
        self._facts = {}
        self._prices = {}
        self._cik_disk = _DiskCache("sec-cik-map.json")
        self._facts_disk = _DiskCache("sec-facts.json")

    # ---------------- ticker -> CIK ----------------
    def cik_map(self):
        with self._lock:
            if self._cik_map:
                return self._cik_map
        cached = self._cik_disk.read(CIK_TTL)
        if cached:
            with self._lock:
                self._cik_map = cached
            return cached
        data = _http_json("https://www.sec.gov/files/company_tickers.json")
        mapping = {}
        for row in data.values():
            ticker = str(row.get("ticker", "")).upper()
            if ticker:
                mapping[ticker] = {
                    "cik": int(row["cik_str"]),
                    "title": row.get("title", ""),
                }
        with self._lock:
            self._cik_map = mapping
        self._cik_disk.write(mapping)
        return mapping

    def cik_for(self, symbol):
        symbol = symbol.upper()
        # Class shares are written BRK-B in Yahoo but BRK.B at the SEC.
        candidates = [symbol, symbol.replace("-", "."), symbol.replace(".", "-")]
        mapping = self.cik_map()
        for candidate in candidates:
            hit = mapping.get(candidate)
            if hit:
                return hit
        return None

    # ---------------- company facts ----------------
    def facts(self, cik):
        with self._lock:
            hit = self._facts.get(cik)
        if hit and _now() - hit[0] < FACTS_TTL:
            return hit[1]
        padded = str(cik).zfill(10)
        data = _http_json(
            f"https://data.sec.gov/api/xbrl/companyfacts/CIK{padded}.json",
            host="data.sec.gov",
            timeout=60,
        )
        with self._lock:
            self._facts[cik] = (_now(), data)
        return data

    # ---------------- price ----------------
    def price(self, symbol):
        with self._lock:
            hit = self._prices.get(symbol)
        if hit and _now() - hit[0] < PRICE_TTL:
            return hit[1]
        encoded = urllib.parse.quote(symbol, safe="")
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}"
            "?range=1y&interval=1d&includePrePost=false"
        )
        payload = _http_json(url, timeout=25)
        result = ((payload.get("chart") or {}).get("result") or [None])[0] or {}
        meta = result.get("meta") or {}
        stamps = result.get("timestamp") or []
        quote = (((result.get("indicators") or {}).get("quote") or [{}])[0]) or {}
        closes = quote.get("close") or []
        history = [
            {"t": int(t) * 1000, "c": float(c)}
            for t, c in zip(stamps, closes)
            if c is not None
        ]
        last = meta.get("regularMarketPrice")
        if last is None and history:
            last = history[-1]["c"]
        info = {
            "last": last,
            "previousClose": meta.get("chartPreviousClose") or meta.get("previousClose"),
            "dayLow": meta.get("regularMarketDayLow"),
            "dayHigh": meta.get("regularMarketDayHigh"),
            "fiftyTwoWeekLow": meta.get("fiftyTwoWeekLow"),
            "fiftyTwoWeekHigh": meta.get("fiftyTwoWeekHigh"),
            "currency": meta.get("currency") or "USD",
            "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
            "marketState": meta.get("marketState") or "CLOSED",
            "quoteTime": meta.get("regularMarketTime"),
            "history": history,
            "longName": meta.get("longName") or meta.get("shortName") or symbol,
        }
        with self._lock:
            self._prices[symbol] = (_now(), info)
        return info


SEC = SecProvider()


# ---------------------------------------------------------------------------
# Fact extraction
# ---------------------------------------------------------------------------
def _gaap(facts):
    return ((facts.get("facts") or {}).get("us-gaap") or {}), (
        ((facts.get("facts") or {}).get("dei") or {})
    )


def _duration_ok(start, end):
    if not start or not end:
        return None
    try:
        a = datetime.strptime(start, "%Y-%m-%d")
        b = datetime.strptime(end, "%Y-%m-%d")
    except ValueError:
        return None
    return (b - a).days


def _annual_flows(gaap, tags):
    """Fiscal-year duration values: {end_date: value}."""
    for tag in tags:
        node = gaap.get(tag)
        if not node:
            continue
        units = node.get("units") or {}
        for unit, rows in units.items():
            if unit not in ("USD", "USD/shares"):
                continue
            series = {}
            for row in rows:
                if row.get("form") not in ("10-K", "10-K/A", "20-F", "40-F"):
                    continue
                end = row.get("end")
                days = _duration_ok(row.get("start"), end)
                if days is None or not (340 <= days <= 400):
                    continue
                series[end] = float(row["val"])
            if len(series) >= 2:
                return tag, dict(sorted(series.items()))
    return None, {}


def _annual_instants(gaap, tags):
    """Balance-sheet values at a fiscal year end: {end_date: value}."""
    for tag in tags:
        node = gaap.get(tag)
        if not node:
            continue
        units = node.get("units") or {}
        for unit, rows in units.items():
            if unit != "USD":
                continue
            series = {}
            for row in rows:
                if row.get("form") not in ("10-K", "10-K/A", "20-F", "40-F"):
                    continue
                end = row.get("end")
                if not end or row.get("start"):
                    continue
                series[end] = float(row["val"])
            if series:
                return tag, dict(sorted(series.items()))
    return None, {}


def _parse_date(value):
    try:
        return datetime.strptime(value, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def _row_points(node, units=("USD", "USD/shares", "shares")):
    """Flatten one XBRL tag into comparable (start, end, days, value) points.

    SEC reports the same period more than once across filings (a Q3 figure
    appears in the 10-Q and again in the 10-K). Keeping the newest filing's
    value for each distinct period avoids double counting and restatements.
    """
    best = {}
    for unit, rows in (node.get("units") or {}).items():
        if unit not in units:
            continue
        for row in rows:
            end = row.get("end")
            if not end:
                continue
            value = row.get("val")
            if value is None:
                continue
            start = row.get("start")
            days = _duration_ok(start, end)
            filed = row.get("filed") or ""
            key = (start, end)
            previous = best.get(key)
            if previous is None or (filed, row.get("accn") or "") >= previous[0]:
                best[key] = ((filed, row.get("accn") or ""), days, float(value))
    return [
        {"start": start, "end": end, "days": meta[1], "value": meta[2]}
        for (start, end), meta in best.items()
    ]


def _best_series(candidates):
    """Pick the candidate whose data reaches furthest forward.

    Companies switch tags over time — NVIDIA filed revenue under
    RevenueFromContractWithCustomerExcludingAssessedTax up to 2022 and under a
    different tag afterwards. Taking the first tag with any data would silently
    report a stale fiscal year, so choose the one with the latest period and
    merge older history from the others.
    """
    chosen = None
    for tag, series in candidates:
        if not series:
            continue
        latest = max(series.keys())
        if chosen is None or latest > chosen[2]:
            chosen = (tag, series, latest)
    if not chosen:
        return None, {}
    tag, primary, _ = chosen
    merged = {}
    # Older tags fill gaps the primary does not cover; the primary wins.
    for other_tag, series in candidates:
        if not series or other_tag == tag:
            continue
        for key, value in series.items():
            merged.setdefault(key, value)
    merged.update(primary)
    return tag, dict(sorted(merged.items()))


def _annual_flows(gaap, tags):
    """Fiscal-year duration values: {end_date: value}."""
    candidates = []
    for tag in tags:
        node = gaap.get(tag)
        if not node:
            continue
        series = {}
        for point in _row_points(node):
            if point["days"] is None or not (340 <= point["days"] <= 400):
                continue
            series[point["end"]] = point["value"]
        if series:
            candidates.append((tag, series))
    return _best_series(candidates)


def _annual_instants(gaap, tags):
    """Balance-sheet values at a fiscal year end: {end_date: value}."""
    candidates = []
    for tag in tags:
        node = gaap.get(tag)
        if not node:
            continue
        series = {}
        for point in _row_points(node, units=("USD",)):
            if point["days"] is not None:
                continue
            series[point["end"]] = point["value"]
        if series:
            candidates.append((tag, series))
    return _best_series(candidates)


def _derive_quarter(point, all_points):
    """Get a single quarter's value.

    Companies tag cash-flow items either as a true quarter (about 91 days) or
    only cumulatively year-to-date. A YTD figure becomes a quarter by
    subtracting the *next shorter* YTD period that starts on the same day:

        9 months - 6 months = Q3
        6 months - 3 months = Q2

    Picking the immediate predecessor matters. Subtracting the wrong period
    yields a number that looks plausible and is wildly wrong.
    """
    if point["days"] is None:
        return None
    if 80 <= point["days"] <= 100:
        return point["value"]
    if not (150 <= point["days"] <= 290):
        return None
    prior = [
        p
        for p in all_points
        if p["start"] == point["start"]
        and p["days"] is not None
        and 80 <= p["days"] < point["days"]
    ]
    if not prior:
        return None
    # The longest period shorter than this one is the immediately preceding YTD.
    prior.sort(key=lambda p: p["days"])
    return point["value"] - prior[-1]["value"]


def _quarter_from_full_year(point, all_points):
    """Fourth quarter, which is only ever reported as a full-year figure.

    FY total minus the nine-month year-to-date equals Q4.
    """
    if point["days"] is None or not (340 <= point["days"] <= 400):
        return None
    nine = [
        p
        for p in all_points
        if p["start"] == point["start"]
        and p["days"] is not None
        and 250 <= p["days"] <= 290
    ]
    if not nine:
        return None
    nine.sort(key=lambda p: p["days"])
    return point["value"] - nine[-1]["value"]


def _quarter_points(gaap, tags, max_age_days=200):
    """Four consecutive recent quarters, newest last, or nothing.

    Returns (quarters, end_date) where quarters is a list of quarter values.
    Refuses to return a set unless the periods are genuinely contiguous and
    recent, because a plausible-looking but wrong TTM silently distorts every
    valuation built on it.
    """
    today = datetime.now(timezone.utc).replace(tzinfo=None)
    for tag in tags:
        node = gaap.get(tag)
        if not node:
            continue
        points = _row_points(node)
        if not points:
            continue
        points.sort(key=lambda p: p["end"])

        quarters = []
        for point in points:
            value = _derive_quarter(point, points)
            # Q4 only exists implicitly: full year minus nine months.
            if value is None:
                value = _quarter_from_full_year(point, points)
            if value is None:
                continue
            end = _parse_date(point["end"])
            if not end:
                continue
            quarters.append({"end": end, "value": value})

        if not quarters:
            continue
        # Newest first, then walk backwards accepting only contiguous quarters.
        quarters.sort(key=lambda q: q["end"], reverse=True)
        chain = [quarters[0]]
        for candidate in quarters[1:]:
            gap = (chain[-1]["end"] - candidate["end"]).days
            if 80 <= gap <= 100:
                chain.append(candidate)
            elif gap < 80:
                # Same period filed twice; the de-duplication above should
                # have removed this, so skip rather than break the chain.
                continue
            else:
                break
            if len(chain) == 4:
                break
        if len(chain) < 4:
            continue
        chain = list(reversed(chain))
        newest = chain[-1]["end"]
        if (today - newest).days > max_age_days:
            continue
        return tag, [c["value"] for c in chain], newest.strftime("%Y-%m-%d")
    return None, None, None


def _ttm_from_quarters(gaap, tags, max_age_days=200):
    tag, quarters, end = _quarter_points(gaap, tags, max_age_days)
    if not quarters:
        return None, None
    return sum(quarters), end


def _latest_ttm_from_ytd(gaap, tags):
    """Trailing twelve months from year-to-date figures, ahead of a 10-K.

    A company that has just filed Q3 has about nine months of the current year
    plus a comparative prior-year period. That is enough for a defensible TTM:
    current YTD + (prior full year - prior YTD to the same date). Used only
    when four clean quarters are not available.
    """
    today = datetime.now(timezone.utc).replace(tzinfo=None)
    for tag in tags:
        node = gaap.get(tag)
        if not node:
            continue
        points = _row_points(node)
        if not points:
            continue
        dated = []
        for point in points:
            if point["days"] is None:
                continue
            start = _parse_date(point["start"])
            end = _parse_date(point["end"])
            if not start or not end:
                continue
            dated.append({**point, "_start": start, "_end": end})
        if not dated:
            continue
        dated.sort(key=lambda p: (p["_end"], p["days"]))

        # Latest year-to-date figure that is not a full year.
        ytd = [
            p for p in dated
            if 150 <= p["days"] <= 290 and (today - p["_end"]).days <= 200
        ]
        if not ytd:
            continue
        current = ytd[-1]

        # Prior full year covering the same fiscal year as the YTD start.
        full = [
            p for p in dated
            if 340 <= p["days"] <= 400
            and p["_start"] < current["_start"]
        ]
        if not full:
            continue
        prior_year = full[-1]

        # Prior-year figure covering the same months as the current YTD.
        prior_ytd = [
            p for p in dated
            if p["days"] is not None
            and abs(p["_end"] - (current["_end"].replace(year=current["_end"].year - 1))) .days <= 20
            and (prior_year["_start"] <= p["_start"])
            and 150 <= p["days"] <= 290
        ]
        if not prior_ytd:
            continue
        prior_part = prior_ytd[-1]

        remaining = prior_year["value"] - prior_part["value"]
        total = current["value"] + remaining
        return total, current["end"]
    return None, None


def _shares(gaap, dei):
    node = dei.get("EntityCommonStockSharesOutstanding")
    if node:
        units = node.get("units") or {}
        for unit, rows in units.items():
            if unit != "shares":
                continue
            dated = [r for r in rows if r.get("end") and r.get("val")]
            if dated:
                dated.sort(key=lambda r: r["end"])
                return float(dated[-1]["val"])
    # Weighted average diluted shares live under us-gaap.
    node = gaap.get("WeightedAverageNumberOfDilutedSharesOutstanding")
    if node:
        for unit, rows in (node.get("units") or {}).items():
            if unit != "shares":
                continue
            dated = [r for r in rows if r.get("end") and r.get("val")]
            if dated:
                dated.sort(key=lambda r: r["end"])
                return float(dated[-1]["val"])
    return None


def _safe_div(a, b):
    if a is None or b in (None, 0):
        return None
    try:
        return a / b
    except ZeroDivisionError:
        return None


def build_series(facts):
    """Return (annual_rows, ttm_row) using the same key names as the UI."""
    gaap, dei = _gaap(facts)
    if not gaap:
        return [], None

    flow = {}
    for key, tags in FLOW_TAGS.items():
        tag, series = _annual_flows(gaap, tags)
        if series:
            flow[key] = series

    instant = {}
    for key, tags in INSTANT_TAGS.items():
        tag, series = _annual_instants(gaap, tags)
        if series:
            instant[key] = series

    eps_tag, eps_series = _annual_flows(gaap, EPS_TAGS)

    # Fiscal years present in revenue (or net income as a fallback).
    anchor = flow.get("revenue") or flow.get("netIncome") or {}
    years = list(anchor.keys())[-6:]
    shares_now = _shares(gaap, dei)

    def value_at(series_map, year, default=None):
        series = series_map.get(year)
        return series if series is not None else default

    rows = []
    for year in years:
        revenue = value_at(flow.get("revenue", {}), year)
        net_income = value_at(flow.get("netIncome", {}), year)
        ocf = value_at(flow.get("ocf", {}), year)
        capex = value_at(flow.get("capex", {}), year)
        gross = value_at(flow.get("grossProfit", {}), year)
        operating = value_at(flow.get("operatingIncome", {}), year)
        dna = value_at(flow.get("dna", {}), year)
        sbc = value_at(flow.get("sbc", {}), year)
        dividends = value_at(flow.get("dividends", {}), year)
        tax = value_at(flow.get("tax", {}), year)
        pretax = value_at(flow.get("pretax", {}), year)
        interest = value_at(flow.get("interest", {}), year)

        fcf = (ocf - capex) if (ocf is not None and capex is not None) else None
        ebitda = (operating + dna) if (operating is not None and dna is not None) else None
        eps = eps_series.get(year) if eps_series else None
        if eps is None and net_income is not None and shares_now:
            eps = net_income / shares_now

        equity = value_at(instant.get("equity", {}), year) or _nearest(instant.get("equity", {}), year)
        cash = value_at(instant.get("cash", {}), year) or _nearest(instant.get("cash", {}), year)
        debt = value_at(instant.get("debt", {}), year) or _nearest(instant.get("debt", {}), year)
        assets = value_at(instant.get("assets", {}), year) or _nearest(instant.get("assets", {}), year)
        cur_assets = value_at(instant.get("currentAssets", {}), year) or _nearest(instant.get("currentAssets", {}), year)
        cur_liab = value_at(instant.get("currentLiabilities", {}), year) or _nearest(instant.get("currentLiabilities", {}), year)

        rows.append(
            {
                "date": year,
                "period": f"FY {year[:4]}",
                "year": f"FY {year[:4]}",
                "revenue": revenue,
                "grossProfit": gross,
                "operatingIncome": operating,
                "ebit": operating,
                "ebitda": ebitda,
                "netIncome": net_income,
                "eps": eps,
                "fcf": fcf,
                "ocf": ocf,
                "capex": -capex if capex is not None else None,
                "sbc": sbc,
                "equity": equity,
                "assets": assets,
                "currentAssets": cur_assets,
                "currentLiabilities": cur_liab,
                "debt": debt,
                "cash": cash,
                "dividends": -dividends if dividends is not None else None,
                "interestExpense": interest or 0.0,
                "shares": shares_now,
                "taxRate": _safe_div(tax, pretax) if (tax is not None and pretax) else None,
            }
        )

    # ---- TTM ----
    ttm_parts = {}
    ttm_end = None
    for key in ("revenue", "grossProfit", "operatingIncome", "netIncome", "ocf", "capex", "sbc", "dividends", "dna"):
        total, end = _ttm_from_quarters(gaap, FLOW_TAGS[key])
        if total is None:
            total, end = _latest_ttm_from_ytd(gaap, FLOW_TAGS[key])
        if total is not None:
            ttm_parts[key] = total
            ttm_end = ttm_end or end
    eps_ttm, eps_end = _ttm_from_quarters(gaap, EPS_TAGS)
    if eps_ttm is None:
        eps_ttm, eps_end = _latest_ttm_from_ytd(gaap, EPS_TAGS)
    if eps_ttm is not None:
        ttm_parts["eps"] = eps_ttm
        ttm_end = ttm_end or eps_end

    ttm_row = None
    if ttm_parts.get("revenue") or ttm_parts.get("netIncome"):
        latest = rows[-1] if rows else {}
        ocf = ttm_parts.get("ocf")
        capex = ttm_parts.get("capex")
        operating = ttm_parts.get("operatingIncome")
        dna = ttm_parts.get("dna")
        net_income = ttm_parts.get("netIncome")
        ttm_row = {
            "date": ttm_end or latest.get("date"),
            "period": "TTM",
            "year": f"TTM {ttm_end[:7]}" if ttm_end else "TTM",
            "revenue": ttm_parts.get("revenue"),
            "grossProfit": ttm_parts.get("grossProfit"),
            "operatingIncome": operating,
            "ebit": operating,
            "ebitda": (operating + dna) if (operating is not None and dna is not None) else None,
            "netIncome": net_income,
            "eps": ttm_parts.get("eps"),
            "fcf": (ocf - capex) if (ocf is not None and capex is not None) else None,
            "ocf": ocf,
            "capex": -capex if capex is not None else None,
            "sbc": ttm_parts.get("sbc"),
            "equity": latest.get("equity"),
            "assets": latest.get("assets"),
            "currentAssets": latest.get("currentAssets"),
            "currentLiabilities": latest.get("currentLiabilities"),
            "debt": latest.get("debt"),
            "cash": latest.get("cash"),
            "dividends": -ttm_parts["dividends"] if ttm_parts.get("dividends") is not None else None,
            "interestExpense": latest.get("interestExpense") or 0.0,
            "shares": shares_now,
            "taxRate": latest.get("taxRate"),
        }
    return rows, ttm_row


def _nearest(series, year):
    """Closest earlier balance-sheet value, so a gap does not blank a column."""
    if not series:
        return None
    candidates = [d for d in series if d <= year]
    if not candidates:
        return series[min(series)]
    return series[max(candidates)]


def _growth(series):
    values = [v for v in series if v is not None]
    if len(values) < 2 or values[-2] in (None, 0):
        return None
    return values[-1] / values[-2] - 1


def build_payload(symbol, price_info, annual, ttm, title, sector_hint="", industry_hint=""):
    """Assemble the payload the browser expects."""
    latest = ttm or (annual[-1] if annual else {})
    if not latest or latest.get("revenue") in (None, 0):
        raise ValueError("no revenue data in SEC filings")

    last = price_info.get("last")
    shares = latest.get("shares") or (annual[-1].get("shares") if annual else None)
    market_cap = (last * shares) if (last and shares) else None

    revenue = latest.get("revenue")
    net_income = latest.get("netIncome")
    eps = latest.get("eps")
    fcf = latest.get("fcf")
    equity = latest.get("equity")
    assets = latest.get("assets")
    cur_assets = latest.get("currentAssets")
    cur_liab = latest.get("currentLiabilities")
    cash = latest.get("cash") or 0.0
    debt = latest.get("debt") or 0.0
    net_debt = debt - cash

    ebit = latest.get("ebit")
    ebitda = latest.get("ebitda")
    tax_rate = latest.get("taxRate")
    if tax_rate is None or not (0 <= tax_rate <= 0.6):
        tax_rate = 0.21

    dividends = abs(latest.get("dividends") or 0.0)
    dividend_per_share = _safe_div(dividends, shares)

    history = annual[::1]
    revs = [h.get("revenue") for h in history]
    ni = [h.get("netIncome") for h in history]

    financials = {
        "revenue": revenue,
        "netIncome": net_income,
        "eps": eps,
        "forwardEps": None,
        "ebit": ebit,
        "ebitda": ebitda,
        "ocf": latest.get("ocf"),
        "capex": latest.get("capex"),
        "fcf": fcf,
        "sbc": latest.get("sbc"),
        "cash": cash,
        "totalDebt": debt,
        "netDebt": net_debt,
        "equity": equity,
        "bookValuePerShare": _safe_div(equity, shares),
        "sharesOutstanding": shares,
        "grossMargin": _safe_div(latest.get("grossProfit"), revenue),
        "operatingMargin": _safe_div(latest.get("operatingIncome"), revenue),
        "profitMargin": _safe_div(net_income, revenue),
        "fcfMargin": _safe_div(fcf, revenue),
        "revenueGrowth": _growth(revs),
        "earningsGrowth": _growth(ni),
        "forwardGrowth": None,
        "returnOnEquity": _safe_div(net_income, equity),
        "returnOnAssets": _safe_div(net_income, assets),
        "currentRatio": _safe_div(cur_assets, cur_liab),
        "debtToEquity": _safe_div(debt, equity),
        "interestExpense": latest.get("interestExpense") or 0.0,
        "dividendPerShare": dividend_per_share,
        "dividendYield": _safe_div(dividend_per_share, last),
        "payoutRatio": _safe_div(dividends, net_income),
        "beta": None,
        "pe": _safe_div(last, eps) if eps else _safe_div(market_cap, net_income),
        "forwardPe": None,
        "priceToBook": _safe_div(market_cap, equity),
        "evToEbitda": _safe_div(market_cap + net_debt, ebitda) if ebitda else None,
        "taxRate": tax_rate,
    }

    return {
        "symbol": symbol,
        "name": title or price_info.get("longName") or symbol,
        "shortName": title or symbol,
        "exchange": price_info.get("exchange") or "",
        "currency": price_info.get("currency") or "USD",
        "financialCurrency": "USD",
        "quoteType": "EQUITY",
        "sector": sector_hint,
        "industry": industry_hint,
        "country": "United States",
        "website": "",
        "description": (
            "Fundamentals are taken directly from this company's SEC filings "
            "(10-K and 10-Q XBRL data). Figures shown are as filed, not vendor estimates."
        ),
        "employees": None,
        "price": {
            "last": last,
            "previousClose": price_info.get("previousClose"),
            "change": (last - price_info["previousClose"]) if (last and price_info.get("previousClose")) else None,
            "changePercent": (
                last / price_info["previousClose"] - 1
                if (last and price_info.get("previousClose"))
                else None
            ),
            "dayLow": price_info.get("dayLow"),
            "dayHigh": price_info.get("dayHigh"),
            "fiftyTwoWeekLow": price_info.get("fiftyTwoWeekLow"),
            "fiftyTwoWeekHigh": price_info.get("fiftyTwoWeekHigh"),
            "marketCap": market_cap,
            "enterpriseValue": (market_cap + net_debt) if market_cap else None,
            "history": price_info.get("history") or [],
            "marketState": price_info.get("marketState") or "CLOSED",
            "quoteTime": price_info.get("quoteTime"),
        },
        "financials": financials,
        "analysts": None,
        "history": history,
        "fiscalYearEnd": (annual[-1].get("date") if annual else None),
        "meta": {
            "provider": "SEC EDGAR XBRL · Yahoo chart",
            "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "dataMode": "live",
            "fxRate": 1.0,
            "quoteDelayMinutes": 15.0,
            "earningsTrend": None,
            "periods": [h.get("period") for h in history],
            "fundamentalsSource": "SEC EDGAR (company filings)",
            "priceSource": "Yahoo Finance chart endpoint",
        },
    }


def build(symbol, sector_hint="", industry_hint=""):
    """Full payload for one ticker, or raise ValueError with a clear reason."""
    entry = SEC.cik_for(symbol)
    if not entry:
        raise ValueError(
            f"{symbol} is not in the SEC company list. Intrinsic now covers "
            "US-registered filers, which is where SEC XBRL data exists."
        )
    facts = SEC.facts(entry["cik"])
    annual, ttm = build_series(facts)
    if not annual and not ttm:
        raise ValueError(
            f"{symbol} has no complete fiscal year in SEC XBRL yet. Newly formed "
            "or newly registered entities file partial-year data only, and "
            "Intrinsic will not estimate a year from two quarters."
        )
    price_info = SEC.price(symbol)
    return build_payload(symbol, price_info, annual, ttm, entry.get("title"), sector_hint, industry_hint)
