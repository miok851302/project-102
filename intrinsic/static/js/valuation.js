/**
 * Intrinsic valuation engine.
 *
 * Pure, dependency-free functions. Every valuation is intentionally
 * explainable: inputs are explicit and every model returns its assumptions.
 */

export const SECTOR_PE = {
  Technology: 28,
  "Communication Services": 20,
  "Consumer Cyclical": 21,
  "Consumer Defensive": 21,
  "Financial Services": 13,
  Healthcare: 20,
  Industrials: 20,
  Energy: 12,
  "Basic Materials": 15,
  Utilities: 17,
  "Real Estate": 25,
};

export const SECTOR_EV_EBITDA = {
  Technology: 20,
  "Communication Services": 13,
  "Consumer Cyclical": 12,
  "Consumer Defensive": 14,
  "Financial Services": null,
  Healthcare: 14,
  Industrials: 13,
  Energy: 7,
  "Basic Materials": 9,
  Utilities: 11,
  "Real Estate": 18,
};

export const SECTOR_PB = {
  Technology: 8,
  "Communication Services": 4,
  "Consumer Cyclical": 3,
  "Consumer Defensive": 4,
  "Financial Services": 1.6,
  Healthcare: 4,
  Industrials: 3,
  Energy: 2,
  "Basic Materials": 2,
  Utilities: 2,
  "Real Estate": 2.5,
};

const DCF_WEIGHTS = {
  dcf: 0.3,
  epv: 0.16,
  pe: 0.2,
  ev: 0.12,
  book: 0,
  grahamFormula: 0.08,
  grahamNumber: 0.04,
  ddm: 0.1,
};

const FINANCIAL_WEIGHTS = {
  dcf: 0,
  epv: 0.22,
  pe: 0.38,
  ev: 0,
  book: 0.12,
  grahamFormula: 0.14,
  grahamNumber: 0.1,
  ddm: 0.16,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v) => Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;
const firstFinite = (...values) => values.find((v) => finite(v));
const round = (v, places = 4) => (finite(v) ? Number(v.toFixed(places)) : v);

export function currencySymbol(code = "USD") {
  const symbols = {
    USD: "$",
    EUR: "€",
    GBP: "£",
    JPY: "¥",
    CNY: "¥",
    HKD: "HK$",
    CAD: "C$",
    AUD: "A$",
    INR: "₹",
    KRW: "₩",
    CHF: "CHF ",
    SEK: "kr ",
    NOK: "kr ",
    DKK: "kr ",
    SGD: "S$",
    TWD: "NT$",
    BRL: "R$",
    ZAR: "R",
    MXN: "MX$",
  };
  return symbols[code] || `${code} `;
}

export function isFinancialCompany(company) {
  const sector = String(company?.sector || "").toLowerCase();
  const industry = String(company?.industry || "").toLowerCase();
  return (
    sector.includes("financial") ||
    industry.includes("bank") ||
    industry.includes("insurance") ||
    industry.includes("capital markets") ||
    industry.includes("asset management")
  );
}

export function revenueCagr(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const first = history[0];
  const last = history[history.length - 1];
  if (!positive(first.revenue) || !positive(last.revenue)) return null;
  const years = Math.max(1, Number(last.year) - Number(first.year));
  return Math.pow(last.revenue / first.revenue, 1 / years) - 1;
}

export function epsCagr(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const first = history[0];
  const last = history[history.length - 1];
  if (!positive(first.eps) || !positive(last.eps)) return null;
  const years = Math.max(1, Number(last.year) - Number(first.year));
  return Math.pow(last.eps / first.eps, 1 / years) - 1;
}

export function defaultAssumptions(company) {
  const f = company?.financials || {};
  const price = company?.price || {};
  const revenue = positive(f.revenue) ? f.revenue : 1;
  const sbcRatio = Math.abs(f.sbc || 0) / revenue;
  const deductSbc = sbcRatio > 0.006;
  const rawFcf = finite(f.fcf) ? f.fcf : 0;
  let fcfBase = rawFcf - (deductSbc ? Math.abs(f.sbc || 0) : 0);
  if (fcfBase <= 0 && rawFcf > 0) fcfBase = rawFcf;
  const fcfMargin = positive(revenue) ? clamp(fcfBase / revenue, -0.2, 0.75) : -0.05;

  const growthBasis = firstFinite(
    f.forwardGrowth,
    f.revenueGrowth,
    revenueCagr(company.history),
    epsCagr(company.history),
    0.04
  );
  const growth = clamp(growthBasis, -0.08, 0.32);

  const beta = clamp(finite(f.beta) ? f.beta : 1, 0.4, 2.4);
  const riskFree = 0.042;
  const equityRiskPremium = 0.048;
  const costOfEquity = clamp(riskFree + beta * equityRiskPremium, 0.065, 0.155);
  const costOfDebt = 0.052;
  const tax = clamp(finite(f.taxRate) ? f.taxRate : 0.21, 0, 0.35);
  const marketCap = positive(price.marketCap) ? price.marketCap : positive(f.equity) ? f.equity : 1;
  const debt = Math.max(0, f.totalDebt || 0);
  const weightEquity = marketCap / (marketCap + debt);
  const weightDebt = 1 - weightEquity;
  const wacc = clamp(
    weightEquity * costOfEquity + weightDebt * costOfDebt * (1 - tax),
    0.065,
    0.14
  );
  const terminal = clamp(Math.min(0.03, riskFree * 0.62), 0.015, 0.03);
  const years = growth > 0.12 || fcfMargin > 0.24 ? 10 : 5;

  return {
    growth: round(growth, 4),
    fcfMargin: round(fcfMargin, 4),
    wacc: round(wacc, 4),
    terminal: round(terminal, 4),
    years,
    deductSbc,
    costOfEquity: round(costOfEquity, 4),
    aaaYield: 0.05,
  };
}

export function runDCF(company, assumptions, overrides = {}) {
  const a = { ...assumptions, ...overrides };
  const f = company.financials;
  const price = company.price;
  const shares = positive(f.sharesOutstanding) ? f.sharesOutstanding : 1;
  const baseRevenue = positive(f.revenue) ? f.revenue : 0;
  const wacc = clamp(a.wacc, 0.01, 0.3);
  const terminal = clamp(a.terminal, -0.02, 0.08);
  const years = clamp(Math.round(a.years), 1, 20);
  const margin = clamp(a.fcfMargin, -0.2, 0.9);
  const netDebt = (f.totalDebt || 0) - (f.cash || 0);

  if (!baseRevenue) return { valid: false, reason: "Revenue is unavailable." };
  if (!positive(shares)) return { valid: false, reason: "Share count is unavailable." };
  if (wacc <= terminal + 0.005) {
    return { valid: false, reason: "Discount rate must be comfortably above terminal growth." };
  }
  const startingFcf = baseRevenue * margin;
  if (startingFcf <= 0) {
    return { valid: false, reason: "Starting free cash flow is not positive." };
  }

  let revenue = baseRevenue;
  let fcf = startingFcf;
  let pvExplicit = 0;
  const projected = [];
  for (let t = 1; t <= years; t += 1) {
    const fade = years === 1 ? 1 : (t - 1) / (years - 1);
    const growth = a.growth + (terminal - a.growth) * fade;
    revenue *= 1 + growth;
    fcf = revenue * margin;
    const discount = Math.pow(1 + wacc, t);
    pvExplicit += fcf / discount;
    projected.push({
      year: t,
      growth,
      revenue,
      fcf,
      discount,
      pv: fcf / discount,
    });
  }

  const terminalFcf = fcf * (1 + terminal);
  const terminalValue = terminalFcf / (wacc - terminal);
  const pvTerminal = terminalValue / Math.pow(1 + wacc, years);
  const enterpriseValue = pvExplicit + pvTerminal;
  const equityValue = enterpriseValue - netDebt;
  const valuePerShare = equityValue / shares;

  if (!finite(valuePerShare) || valuePerShare <= 0) {
    return { valid: false, reason: "These assumptions produce no positive equity value." };
  }

  return {
    valid: true,
    value: valuePerShare,
    enterpriseValue,
    equityValue,
    pvExplicit,
    pvTerminal,
    terminalValue,
    terminalShare: pvTerminal / enterpriseValue,
    startingFcf,
    endingFcf: fcf,
    netDebt,
    projected,
    assumptions: {
      growth: a.growth,
      fcfMargin: margin,
      wacc,
      terminal,
      years,
    },
    price: price.last,
  };
}

export function dcfScenarios(company, assumptions) {
  const bear = runDCF(company, assumptions, {
    growth: assumptions.growth - Math.max(0.02, Math.abs(assumptions.growth) * 0.35),
    fcfMargin: assumptions.fcfMargin * 0.85,
    wacc: assumptions.wacc + 0.01,
    terminal: assumptions.terminal - 0.005,
  });
  const bull = runDCF(company, assumptions, {
    growth: assumptions.growth + Math.max(0.02, Math.abs(assumptions.growth) * 0.28),
    fcfMargin: Math.min(0.7, assumptions.fcfMargin * 1.06),
    wacc: assumptions.wacc - 0.005,
    terminal: assumptions.terminal + 0.0025,
  });
  return {
    bear: bear.valid ? bear.value : null,
    bull: bull.valid ? bull.value : null,
  };
}

export function reverseDCF(company, assumptions) {
  const base = runDCF(company, assumptions);
  if (!base.valid) return null;
  const target = company.price?.last;
  if (!positive(target)) return null;

  const valueAt = (growth) => {
    const result = runDCF(company, assumptions, { growth });
    return result.valid ? result.value : 0;
  };

  let low = -0.5;
  let high = 1.0;
  let lowValue = valueAt(low);
  let highValue = valueAt(high);
  if (highValue < target) {
    return {
      valid: true,
      growth: high,
      aboveRange: true,
      target,
      baseGrowth: assumptions.growth,
      text: "The market is pricing in more than 100% near-term FCF growth.",
    };
  }
  if (lowValue > target) {
    return {
      valid: true,
      growth: low,
      belowRange: true,
      target,
      baseGrowth: assumptions.growth,
      text: "Even a steep decline would leave the business above today's price.",
    };
  }
  for (let i = 0; i < 70; i += 1) {
    const mid = (low + high) / 2;
    if (valueAt(mid) < target) low = mid;
    else high = mid;
  }
  const implied = (low + high) / 2;
  return {
    valid: true,
    growth: implied,
    target,
    baseGrowth: assumptions.growth,
    gap: implied - assumptions.growth,
    text:
      implied > assumptions.growth
        ? `The market expects faster growth than our ${(assumptions.growth * 100).toFixed(1)}% base case.`
        : `The market is embedding less growth than our ${(assumptions.growth * 100).toFixed(1)}% base case.`,
  };
}

export function earningsPowerValue(company, assumptions) {
  const f = company.financials;
  const shares = f.sharesOutstanding;
  if (!positive(f.revenue) || !positive(shares)) {
    return { valid: false, reason: "Revenue or share count is unavailable." };
  }

  // Banks and insurers are valued on equity earnings, not enterprise cash flow.
  if (isFinancialCompany(company)) {
    const margins = (company.history || [])
      .slice(-4)
      .map((row) => (positive(row.revenue) && positive(row.netIncome) ? row.netIncome / row.revenue : null))
      .filter((v) => finite(v) && v > 0);
    const normalizedNetMargin = margins.length
      ? margins.reduce((a, b) => a + b, 0) / margins.length
      : positive(f.profitMargin)
        ? f.profitMargin
        : null;
    if (!finite(normalizedNetMargin) || normalizedNetMargin <= 0) {
      return { valid: false, reason: "Normalized net income is not positive." };
    }
    const normalizedNetIncome = f.revenue * normalizedNetMargin;
    const costOfEquity = clamp(assumptions.costOfEquity, 0.06, 0.18);
    const value = normalizedNetIncome / costOfEquity / shares;
    if (!positive(value)) return { valid: false, reason: "This produces no positive equity value." };
    return {
      valid: true,
      mode: "equity",
      value,
      normalizedMargin: normalizedNetMargin,
      normalizedNetIncome,
      costOfEquity,
      low: value * 0.8,
      high: value * 1.2,
    };
  }

  const margins = (company.history || [])
    .slice(-4)
    .map((row) => (positive(row.revenue) ? row.operatingIncome / row.revenue : null))
    .filter((v) => finite(v) && v > -0.2);
  const normalizedMargin = margins.length
    ? margins.reduce((a, b) => a + b, 0) / margins.length
    : positive(f.operatingMargin)
      ? f.operatingMargin
      : null;
  if (!finite(normalizedMargin) || normalizedMargin <= 0) {
    return { valid: false, reason: "Operating earnings are not positive." };
  }
  const tax = clamp(finite(f.taxRate) ? f.taxRate : 0.21, 0, 0.35);
  const normalizedEbit = f.revenue * normalizedMargin;
  const nopat = normalizedEbit * (1 - tax);
  const wacc = clamp(assumptions.wacc, 0.055, 0.18);
  const enterpriseValue = nopat / wacc;
  const equityValue = enterpriseValue + (f.cash || 0) - (f.totalDebt || 0);
  const value = equityValue / shares;
  if (!positive(value)) return { valid: false, reason: "This produces no positive equity value." };

  return {
    valid: true,
    mode: "enterprise",
    value,
    normalizedMargin,
    normalizedEbit,
    nopat,
    enterpriseValue,
    equityValue,
    wacc,
    low: value * 0.8,
    high: value * 1.2,
  };
}

export function grahamNumber(company) {
  const eps = company.financials?.eps;
  const bvps = company.financials?.bookValuePerShare;
  if (!positive(eps) || !positive(bvps)) {
    return { valid: false, reason: "Requires positive EPS and book value per share." };
  }
  const value = Math.sqrt(22.5 * eps * bvps);
  return { valid: true, value, low: value * 0.75, high: value * 1.25 };
}

export function grahamFormula(company, assumptions) {
  const eps = company.financials?.eps;
  if (!positive(eps)) return { valid: false, reason: "Requires positive earnings per share." };
  const growthPercent = clamp(assumptions.growth * 100, 0, 15);
  const aaaYield = clamp(assumptions.aaaYield * 100, 2, 12);
  const value = (eps * (8.5 + 2 * growthPercent) * 4.4) / aaaYield;
  return {
    valid: true,
    value,
    low: value * 0.75,
    high: value * 1.25,
    growthPercent,
    aaaYield,
  };
}

export function dividendDiscount(company, assumptions) {
  const f = company.financials;
  const d0 = f.dividendPerShare || 0;
  const shares = f.sharesOutstanding;
  if (!positive(d0)) return { valid: false, reason: "The company does not pay a dividend." };
  if (!positive(shares)) return { valid: false, reason: "Share count is unavailable." };

  const required = clamp(assumptions.costOfEquity, 0.055, 0.18);
  const terminal = clamp(assumptions.terminal, 0.0, 0.045);
  if (required <= terminal + 0.005) {
    return { valid: false, reason: "Cost of equity must exceed terminal dividend growth." };
  }
  const nearTerm = clamp(
    firstFinite(f.forwardGrowth, f.earningsGrowth, 0.04),
    -0.05,
    0.13
  );
  const years = 5;
  let dividend = d0;
  let pv = 0;
  const projected = [];
  for (let t = 1; t <= years; t += 1) {
    dividend *= 1 + nearTerm;
    const discounted = dividend / Math.pow(1 + required, t);
    pv += discounted;
    projected.push({ year: t, dividend, pv: discounted });
  }
  const terminalValue = (dividend * (1 + terminal)) / (required - terminal);
  const pvTerminal = terminalValue / Math.pow(1 + required, years);
  const value = pv + pvTerminal;
  if (!positive(value)) return { valid: false, reason: "No positive value under these assumptions." };

  const payout = f.payoutRatio;
  const relevant = finite(payout) ? payout >= 0.2 : d0 / (company.price?.last || 1) >= 0.012;
  return {
    valid: true,
    value,
    low: value * 0.75,
    high: value * 1.25,
    nearTerm,
    required,
    terminal,
    payout,
    relevant,
    projected,
  };
}

export function relativeValuation(company, assumptions) {
  const f = company.financials;
  const sector = company.sector || "";
  const shares = f.sharesOutstanding;
  const peers = company.peerStats || {};
  const peerPE = positive(peers.pe) && peers.peCount >= 3 ? peers.pe : null;
  const peerEV = positive(peers.evEbitda) && peers.evCount >= 3 ? peers.evEbitda : null;
  const peerPB = positive(peers.priceToBook) && peers.pbCount >= 3 ? peers.priceToBook : null;
  const pe = peerPE || SECTOR_PE[sector] || 18;
  const evMultiple = peerEV || SECTOR_EV_EBITDA[sector] || 13;
  const pbMultiple = peerPB || SECTOR_PB[sector] || 2;
  const out = {};
  const peerLabel = (count) => (count ? `${count} live peers` : `${sector || "sector"} benchmark`);

  if (positive(f.eps) && positive(shares)) {
    const value = f.eps * pe;
    out.pe = {
      valid: true,
      value,
      low: value * 0.8,
      high: value * 1.2,
      multiple: pe,
      metric: f.eps,
      sector,
      source: peerPE ? "peers" : "benchmark",
      peerCount: peerPE ? peers.peCount : 0,
      sourceLabel: peerLabel(peerPE ? peers.peCount : 0),
    };
  } else {
    out.pe = { valid: false, reason: "Requires positive earnings per share." };
  }

  if (isFinancialCompany(company)) {
    out.ev = { valid: false, reason: "EV/EBITDA is not meaningful for banks and insurers." };
    if (positive(f.bookValuePerShare) && positive(shares)) {
      const value = f.bookValuePerShare * pbMultiple;
      out.book = {
        valid: true,
        value,
        low: value * 0.8,
        high: value * 1.2,
        multiple: pbMultiple,
        metric: f.bookValuePerShare,
        sector,
        source: peerPB ? "peers" : "benchmark",
        peerCount: peerPB ? peers.pbCount : 0,
        sourceLabel: peerLabel(peerPB ? peers.pbCount : 0),
      };
    } else {
      out.book = { valid: false, reason: "Requires positive book value per share." };
    }
  } else if (positive(f.ebitda) && positive(shares)) {
    const enterpriseValue = f.ebitda * evMultiple;
    const equityValue = enterpriseValue - (f.totalDebt || 0) + (f.cash || 0);
    const value = equityValue / shares;
    if (positive(value)) {
      out.ev = {
        valid: true,
        value,
        low: value * 0.8,
        high: value * 1.2,
        multiple: evMultiple,
        metric: f.ebitda,
        sector,
        source: peerEV ? "peers" : "benchmark",
        peerCount: peerEV ? peers.evCount : 0,
        sourceLabel: peerLabel(peerEV ? peers.evCount : 0),
      };
    } else {
      out.ev = { valid: false, reason: "Net debt exceeds the implied enterprise value." };
    }
  } else {
    out.ev = {
      valid: false,
      reason: "Requires positive EBITDA.",
    };
  }
  return out;
}

export function modelRanges(company, assumptions) {
  const sector = company.sector || "";
  const financial = isFinancialCompany(company);
  const dcf = runDCF(company, assumptions);
  const scenarios = dcfScenarios(company, assumptions);
  const epv = earningsPowerValue(company, assumptions);
  const graham = grahamNumber(company);
  const grahamF = grahamFormula(company, assumptions);
  const ddm = dividendDiscount(company, assumptions);
  const rel = relativeValuation(company, assumptions);
  const multiple = financial ? rel.book : rel.ev;
  const multipleId = financial ? "book" : "ev";

  const models = [
    {
      id: "dcf",
      index: "01",
      name: "Discounted cash flow",
      short: "DCF",
      family: "Cash flow",
      description:
        "Projects the free cash the business produces, fades growth to a steady rate, and discounts it back to today.",
      value: dcf.valid ? dcf.value : null,
      low: scenarios.bear,
      high: scenarios.bull,
      valid: dcf.valid,
      reason: dcf.reason,
      weight: DCF_WEIGHTS.dcf,
      confidence: "High",
      formula:
        "Value = Σ FCFₜ / (1 + WACC)ᵗ + [FCFₙ × (1 + g)] / [(WACC − g) × (1 + WACC)ⁿ]",
      inputs: dcf.valid
        ? [
            `${(assumptions.growth * 100).toFixed(1)}% starting FCF growth`,
            `${(assumptions.fcfMargin * 100).toFixed(1)}% FCF margin`,
            `${(assumptions.wacc * 100).toFixed(1)}% WACC`,
            `${(assumptions.terminal * 100).toFixed(1)}% terminal growth`,
            `${assumptions.years}-year fade`,
          ]
        : [],
      caveat:
        "A DCF is only as good as its inputs. Terminal value often accounts for most of the answer; use the range, not a single point.",
    },
    {
      id: "epv",
      index: "02",
      name: "Earnings power value",
      short: "EPV",
      family: "Earnings",
      description:
        epv.valid && epv.mode === "equity"
          ? "Values the bank as if growth stopped: normalized net income capitalised at the cost of equity."
          : "Values the business as if growth stopped tomorrow: normalized after-tax operating earnings capitalised at the cost of capital.",
      value: epv.valid ? epv.value : null,
      low: epv.valid ? epv.low : null,
      high: epv.valid ? epv.high : null,
      valid: epv.valid,
      reason: epv.reason,
      weight: DCF_WEIGHTS.epv,
      confidence: "Medium",
      formula:
        epv.valid && epv.mode === "equity"
          ? "Value = Normalized net income / cost of equity / shares"
          : "Value = [Normalized EBIT × (1 − tax)] / WACC + cash − debt",
      inputs: epv.valid
        ? epv.mode === "equity"
          ? [
              `${(epv.normalizedMargin * 100).toFixed(1)}% normalized net margin`,
              `${(epv.costOfEquity * 100).toFixed(1)}% cost of equity`,
              `${company.currency || "USD"} figures`,
            ]
          : [
              `${(epv.normalizedMargin * 100).toFixed(1)}% normalized operating margin`,
              `${(epv.wacc * 100).toFixed(1)}% WACC`,
              `${company.currency || "USD"} figures`,
            ]
        : [],
      caveat:
        epv.valid && epv.mode === "equity"
          ? "Banks are balance-sheet businesses. Net income capitalization is a rough earnings-power floor; book value and credit quality need separate work."
          : "EPV deliberately excludes growth. It is a conservative floor for a durable business, not a forecast.",
    },
    {
      id: "pe",
      index: "03",
      name: rel.pe.source === "peers" ? "Peer P/E" : "Sector P/E",
      short: "P/E",
      family: "Relative",
      description:
        "Applies a median price-to-earnings multiple to current EPS. A market shortcut, not an intrinsic truth.",
      value: rel.pe.valid ? rel.pe.value : null,
      low: rel.pe.valid ? rel.pe.low : null,
      high: rel.pe.valid ? rel.pe.high : null,
      valid: rel.pe.valid,
      reason: rel.pe.reason,
      weight: DCF_WEIGHTS.pe,
      confidence: rel.pe.source === "peers" ? "Medium" : "Low",
      formula: "Value = EPS × median P/E",
      inputs: rel.pe.valid
        ? [`${rel.pe.multiple.toFixed(1)}× ${rel.pe.sourceLabel} P/E`]
        : [],
      caveat:
        rel.pe.source === "peers"
          ? "The multiple is a live median of sector peers. It does not adjust for differences in growth, margins, leverage or accounting."
          : "Sector medians are static long-run benchmarks, not a live peer set. Growth, margins and risk can justify a large premium or discount.",
    },
    {
      id: multipleId,
      index: "04",
      name: financial ? "Price / book" : "EV / EBITDA",
      short: financial ? "P/B" : "EV/EBITDA",
      family: "Relative",
      description: financial
        ? "Applies a peer median price-to-book multiple to current book value per share — the natural relative check for a bank."
        : "Compares enterprise value with operating cash earnings, then backs out net debt to reach equity value per share.",
      value: multiple.valid ? multiple.value : null,
      low: multiple.valid ? multiple.low : null,
      high: multiple.valid ? multiple.high : null,
      valid: multiple.valid,
      reason: multiple.reason,
      weight: financial ? FINANCIAL_WEIGHTS.book : DCF_WEIGHTS.ev,
      confidence:
        multiple.valid && multiple.source === "peers" && multiple.peerCount >= 4 ? "Medium" : "Low",
      formula: financial
        ? "Value = book value per share × median P/B"
        : "Value = (EBITDA × median EV/EBITDA − net debt) / shares",
      inputs: multiple.valid
        ? [
            financial
              ? `${multiple.multiple.toFixed(1)}× ${multiple.sourceLabel} P/B`
              : `${multiple.multiple.toFixed(1)}× ${multiple.sourceLabel} EV/EBITDA`,
          ]
        : [],
      caveat: financial
        ? "Book value is an accounting number. It ignores loan-book credit quality, capital adequacy and the value of fee franchises."
        : "Capital intensity and accounting differences make cross-sector comparisons noisy. Banks and insurers use P/B instead.",
    },
    {
      id: "grahamFormula",
      index: "05",
      name: "Revised Graham formula",
      short: "Graham",
      family: "Earnings",
      description:
        "Benjamin Graham's growth-adjusted earnings formula, updated with a current AAA corporate bond yield.",
      value: grahamF.valid ? grahamF.value : null,
      low: grahamF.valid ? grahamF.low : null,
      high: grahamF.valid ? grahamF.high : null,
      valid: grahamF.valid,
      reason: grahamF.reason,
      weight: DCF_WEIGHTS.grahamFormula,
      confidence: "Low",
      formula: "V = EPS × (8.5 + 2g) × 4.4 / AAA yield",
      inputs: grahamF.valid
        ? [`${grahamF.growthPercent.toFixed(1)}% growth`, `${grahamF.aaaYield.toFixed(1)}% AAA yield`]
        : [],
      caveat:
        "A heuristic from a different market era. It caps growth at 15% and ignores capital intensity, debt and competitive advantage.",
    },
    {
      id: "grahamNumber",
      index: "06",
      name: "Graham number",
      short: "Graham no.",
      family: "Balance sheet",
      description:
        "A defensive asset-and-earnings cross-check: the maximum price Graham's rules would pay for current earnings and book value.",
      value: graham.valid ? graham.value : null,
      low: graham.valid ? graham.low : null,
      high: graham.valid ? graham.high : null,
      valid: graham.valid,
      reason: graham.reason,
      weight: DCF_WEIGHTS.grahamNumber,
      confidence: "Low",
      formula: "V = √(22.5 × EPS × book value per share)",
      inputs: graham.valid
        ? [
            `${currencySymbol(company.currency)}${company.financials.eps.toFixed(2)} EPS`,
            `${currencySymbol(company.currency)}${company.financials.bookValuePerShare.toFixed(2)} book value`,
          ]
        : [],
      caveat:
        "Almost useless for asset-light businesses, where book value omits brand, software, research and network effects.",
    },
    {
      id: "ddm",
      index: "07",
      name: "Dividend discount",
      short: "DDM",
      family: "Cash flow",
      description:
        "Values a shareholder's stream of dividends directly, using a two-stage model and the cost of equity.",
      value: ddm.valid ? ddm.value : null,
      low: ddm.valid ? ddm.low : null,
      high: ddm.valid ? ddm.high : null,
      valid: ddm.valid,
      reason: ddm.reason,
      weight: DCF_WEIGHTS.ddm,
      confidence: ddm.valid && ddm.relevant ? "Medium" : "Low",
      formula: "Value = Σ Dₜ / (1 + r)ᵗ + terminal dividend value",
      inputs: ddm.valid
        ? [
            `${(ddm.nearTerm * 100).toFixed(1)}% near-term dividend growth`,
            `${(ddm.required * 100).toFixed(1)}% cost of equity`,
            `${(ddm.payout * 100).toFixed(0)}% payout ratio`,
          ]
        : [],
      caveat: ddm.valid && !ddm.relevant
        ? "The payout ratio is low, so this model is shown for completeness but excluded from the blended value."
        : "Dividends are only part of total return. Buybacks and retained cash can create value without appearing here.",
      includeInComposite: ddm.valid && ddm.relevant,
    },
  ];

  // Apply eligibility rules and dynamic weights.
  const baseWeights = financial ? FINANCIAL_WEIGHTS : DCF_WEIGHTS;
  for (const model of models) {
    if (!model.valid) {
      model.effectiveWeight = 0;
      continue;
    }
    let weight = baseWeights[model.id] ?? 0;
    if (model.id === "ddm" && !model.includeInComposite) weight = 0;
    if (model.id === "ddm" && model.includeInComposite) weight = baseWeights.ddm ?? 0.1;
    model.effectiveWeight = weight;
  }
  const totalWeight = models.reduce((sum, m) => sum + (m.effectiveWeight || 0), 0);
  for (const model of models) {
    model.weightPct = totalWeight > 0 ? (model.effectiveWeight || 0) / totalWeight : 0;
  }

  const included = models.filter((m) => m.valid && m.weightPct > 0);
  const composite =
    included.length > 0
      ? included.reduce((sum, m) => sum + m.value * m.weightPct, 0)
      : null;
  const low =
    included.length > 0
      ? included.reduce((sum, m) => sum + (m.low ?? m.value) * m.weightPct, 0)
      : null;
  const high =
    included.length > 0
      ? included.reduce((sum, m) => sum + (m.high ?? m.value) * m.weightPct, 0)
      : null;

  return {
    models,
    composite,
    low,
    high,
    coverage: totalWeight,
    weights: models
      .filter((m) => m.weightPct > 0)
      .map((m) => ({ id: m.id, name: m.name, weight: m.weightPct, value: m.value })),
    dcf,
    epv,
    graham,
    grahamF,
    ddm,
    rel,
    isFinancial: financial,
    totalWeight,
  };
}

export function verdictFor(value, price) {
  if (!positive(value) || !positive(price)) {
    return { key: "unknown", label: "Insufficient data", tone: "neutral" };
  }
  const upside = value / price - 1;
  if (upside >= 0.15) return { key: "undervalued", label: "Undervalued", tone: "positive", upside };
  if (upside <= -0.15) return { key: "overvalued", label: "Overvalued", tone: "negative", upside };
  return { key: "fair", label: "Fairly valued", tone: "warning", upside };
}

export function marginOfSafety(value, price) {
  if (!positive(value) || !positive(price)) return null;
  return (value - price) / value;
}

export function qualityScore(company) {
  const f = company.financials || {};
  const history = company.history || [];
  const financial = isFinancialCompany(company);
  const map = (value, low, high) => {
    if (!finite(value)) return 50;
    return clamp(((value - low) / (high - low)) * 100, 0, 100);
  };

  const roeRaw = finite(f.returnOnEquity) ? f.returnOnEquity : f.netIncome / (f.equity || 1);
  const roe = clamp(roeRaw, -0.5, 1);
  const opMargin = finite(f.operatingMargin) ? f.operatingMargin : 0;
  const grossMargin = finite(f.grossMargin) ? f.grossMargin : 0;
  const revGrowth = finite(f.revenueGrowth) ? f.revenueGrowth : 0;
  const epsGrowth = finite(f.earningsGrowth) ? f.earningsGrowth : 0;
  const fcfMargin = finite(f.fcfMargin) ? f.fcfMargin : 0;
  const netMargin = finite(f.profitMargin) ? f.profitMargin : 0;
  const roa = finite(f.returnOnAssets) ? f.returnOnAssets : 0;
  const netDebtToEbitda = f.ebitda > 0 ? (f.totalDebt - f.cash) / f.ebitda : null;
  const fcfConversion = f.netIncome > 0 ? f.fcf / f.netIncome : null;
  const currentRatio = finite(f.currentRatio) ? f.currentRatio : 1;

  const positiveYears = history.filter((row) => row.netIncome > 0).length;
  const positiveRevenueYears = history.filter((row) => row.revenue > 0).length;
  const consistency = history.length
    ? ((positiveYears + positiveRevenueYears) / (history.length * 2)) * 100
    : 50;

  const profitability = 0.45 * map(roe, 0.0, 0.3) + 0.3 * map(opMargin, 0, 0.3) + 0.25 * map(grossMargin, 0.15, 0.6);
  const growth = 0.55 * map(revGrowth, -0.1, 0.2) + 0.45 * map(epsGrowth, -0.15, 0.3);
  const balanceDebt = netDebtToEbitda === null ? 55 : map(-netDebtToEbitda, -4, 1);
  const balance = 0.7 * balanceDebt + 0.3 * map(currentRatio, 0.8, 2.0);
  const cash = financial
    ? 0.55 * map(netMargin, 0.05, 0.3) + 0.45 * map(roa, 0.005, 0.02)
    : 0.55 * map(fcfMargin, 0, 0.3) + 0.45 * map(fcfConversion, 0.3, 1.2);
  const score = round(
    clamp(0.3 * profitability + 0.2 * growth + 0.2 * balance + 0.2 * cash + 0.1 * consistency, 0, 100),
    0
  );

  let grade = "Weak";
  if (score >= 80) grade = "Elite";
  else if (score >= 65) grade = "Strong";
  else if (score >= 45) grade = "Average";

  const metrics = [
    {
      label: "Return on equity",
      value: roeRaw,
      display: `${(roeRaw * 100).toFixed(1)}%`,
      score: map(roe, 0, 0.3),
      hint: "Profit generated per dollar of shareholder capital. Can exceed 100% when buybacks make equity small.",
    },
    {
      label: "Operating margin",
      value: opMargin,
      display: `${(opMargin * 100).toFixed(1)}%`,
      score: map(opMargin, 0, 0.3),
      hint: "How much revenue survives after running the business.",
    },
    {
      label: "Revenue growth",
      value: revGrowth,
      display: `${(revGrowth * 100).toFixed(1)}%`,
      score: map(revGrowth, -0.1, 0.2),
      hint: "Latest period versus the prior period.",
    },
    {
      label: financial ? "Net margin" : "FCF margin",
      value: financial ? netMargin : fcfMargin,
      display: `${((financial ? netMargin : fcfMargin) * 100).toFixed(1)}%`,
      score: financial ? map(netMargin, 0.05, 0.3) : map(fcfMargin, 0, 0.3),
      hint: financial
        ? "Net income as a share of revenue."
        : "Free cash flow as a share of revenue.",
    },
    {
      label: "Net debt / EBITDA",
      value: netDebtToEbitda,
      display: netDebtToEbitda === null ? "n/a" : `${netDebtToEbitda.toFixed(1)}×`,
      score: netDebtToEbitda === null ? 55 : map(-netDebtToEbitda, -4, 1),
      hint: "Lower is safer. Negative means net cash.",
    },
    {
      label: financial ? "Return on assets" : "FCF conversion",
      value: financial ? roa : fcfConversion,
      display: financial
        ? `${(roa * 100).toFixed(1)}%`
        : fcfConversion === null
          ? "n/a"
          : `${(fcfConversion * 100).toFixed(0)}%`,
      score: financial
        ? map(roa, 0.005, 0.02)
        : fcfConversion === null
          ? 50
          : map(fcfConversion, 0.3, 1.2),
      hint: financial
        ? "Profit generated per dollar of assets — the core bank profitability test."
        : "Free cash flow divided by accounting net income.",
    },
  ];

  const redFlags = [];
  if (!financial && f.fcf <= 0) redFlags.push({ label: "Free cash flow is negative", severity: "high", detail: "The business is currently burning cash after capital expenditure." });
  if (f.netIncome <= 0) redFlags.push({ label: "Earnings are negative", severity: "high", detail: "Earnings-based models need positive profits to be meaningful." });
  if (netDebtToEbitda !== null && netDebtToEbitda > 3) redFlags.push({ label: "Leverage is elevated", severity: "high", detail: `${netDebtToEbitda.toFixed(1)}× net debt to EBITDA is above our 3× warning line.` });
  if (revGrowth < 0) redFlags.push({ label: "Revenue is shrinking", severity: "medium", detail: "A declining top line puts pressure on the growth premium." });
  if (f.sbc > 0 && f.revenue > 0 && f.sbc / f.revenue > 0.08) redFlags.push({ label: "Heavy stock-based compensation", severity: "medium", detail: `${((f.sbc / f.revenue) * 100).toFixed(1)}% of revenue is paid in stock, which dilutes owners.` });
  if (f.dividendPerShare > 0 && f.payoutRatio > 1) redFlags.push({ label: "Dividend exceeds earnings", severity: "high", detail: "The payout is above 100% of net income and may not be sustainable." });
  if (!financial && currentRatio < 1) redFlags.push({ label: "Thin liquidity buffer", severity: "low", detail: `Current ratio is ${currentRatio.toFixed(2)}; current liabilities exceed current assets.` });
  if (f.interestExpense > 0 && f.ebit > 0 && f.ebit / f.interestExpense < 3) redFlags.push({ label: "Low interest coverage", severity: "high", detail: `Operating income covers interest only ${(f.ebit / f.interestExpense).toFixed(1)}×.` });

  return {
    score,
    grade,
    metrics,
    redFlags,
    strengths: [
      grossMargin > 0.45 && !financial ? "Pricing power" : null,
      financial ? (netMargin > 0.2 ? "Profitable" : null) : fcfMargin > 0.2 ? "Cash generative" : null,
      financial && roa > 0.01 ? "Efficient balance sheet" : null,
      revGrowth > 0.1 ? "Growing demand" : null,
      netDebtToEbitda !== null && netDebtToEbitda < 0 ? "Net cash balance sheet" : null,
      roe > 0.18 ? "High returns on capital" : null,
    ].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function monteCarlo(company, assumptions, runs = 1800, seed = 20261028) {
  const base = runDCF(company, assumptions);
  if (!base.valid) return null;
  const random = mulberry32(seed);
  const results = [];
  const growthSigma = Math.max(0.025, Math.abs(assumptions.growth) * 0.35);
  const marginSigma = Math.max(0.018, assumptions.fcfMargin * 0.14);
  for (let i = 0; i < runs; i += 1) {
    const growth = clamp(assumptions.growth + gaussian(random) * growthSigma, -0.2, 0.5);
    let margin = clamp(assumptions.fcfMargin * (1 + gaussian(random) * 0.14), 0.02, 0.75);
    const wacc = clamp(assumptions.wacc + gaussian(random) * 0.009, 0.06, 0.17);
    let terminal = clamp(assumptions.terminal + gaussian(random) * 0.0045, 0.0, 0.045);
    if (terminal > wacc - 0.012) terminal = wacc - 0.012;
    const result = runDCF(company, assumptions, { growth, fcfMargin: margin, wacc, terminal });
    if (result.valid && result.value < (company.price.last || 1) * 8) {
      results.push(result.value);
    }
  }
  if (results.length < 20) return null;
  results.sort((a, b) => a - b);
  const p10 = percentile(results, 0.1);
  const p25 = percentile(results, 0.25);
  const p50 = percentile(results, 0.5);
  const p75 = percentile(results, 0.75);
  const p90 = percentile(results, 0.9);
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  const price = company.price.last;
  const below = results.filter((v) => v > price).length;

  const low = percentile(results, 0.02);
  const high = percentile(results, 0.98);
  const binCount = 22;
  const width = (high - low) / binCount || 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: low + i * width,
    to: low + (i + 1) * width,
    count: 0,
  }));
  for (const value of results) {
    const index = clamp(Math.floor((value - low) / width), 0, binCount - 1);
    bins[index].count += 1;
  }

  return {
    p10,
    p25,
    p50,
    p75,
    p90,
    mean,
    price,
    probabilityUndervalued: below / results.length,
    runs: results.length,
    bins,
    low,
    high,
    maxCount: Math.max(...bins.map((b) => b.count)),
  };
}

export function sensitivity(company, assumptions) {
  const waccSteps = [-0.02, -0.01, 0, 0.01, 0.02];
  const termSteps = [-0.01, -0.005, 0, 0.005, 0.01];
  const rows = waccSteps.map((delta) => {
    const wacc = clamp(assumptions.wacc + delta, 0.04, 0.2);
    return {
      wacc,
      cells: termSteps.map((termDelta) => {
        const terminal = clamp(assumptions.terminal + termDelta, -0.01, 0.06);
        const result = runDCF(company, assumptions, { wacc, terminal });
        return {
          terminal,
          value: result.valid ? result.value : null,
        };
      }),
    };
  });
  const values = rows.flatMap((row) => row.cells.map((c) => c.value)).filter(positive);
  return {
    rows,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

export function confidenceFor(company, analysis) {
  const included = (analysis.models || []).filter((model) => model.weightPct > 0);
  if (!included.length || !positive(analysis.composite)) {
    return {
      score: 0,
      label: "No confidence",
      tone: "negative",
      reasons: [{ tone: "negative", text: "No valuation lens produced a positive, applicable value." }],
      components: [],
    };
  }

  const composite = analysis.composite;
  const weightedVariance =
    included.reduce(
      (sum, model) => sum + model.weightPct * Math.pow(model.value - composite, 2),
      0
    ) / included.reduce((sum, model) => sum + model.weightPct, 0);
  const coefficientOfVariation = Math.sqrt(weightedVariance) / Math.abs(composite);
  const dispersion = 1 - clamp(coefficientOfVariation / 0.9, 0, 1);
  const coverage = clamp(Number(analysis.totalWeight) || 0, 0, 1);

  const f = company.financials || {};
  const checks = [
    positive(company.price?.last),
    positive(f.revenue),
    positive(f.eps),
    finite(f.fcf),
    positive(f.ebitda),
    positive(f.equity),
    positive(f.sharesOutstanding),
    finite(f.totalDebt),
    finite(f.cash),
    (company.history || []).length >= 3,
    positive(company.analysts?.targetMean),
  ];
  const completeness = checks.filter(Boolean).length / checks.length;

  const dcf = analysis.dcf;
  let dcfScore = analysis.isFinancial ? 0.58 : 0.16;
  if (dcf?.valid) {
    dcfScore = 1 - clamp(((dcf.terminalShare || 0) - 0.45) / 0.5, 0, 1) * 0.72;
  }

  const peerCount = Math.max(
    Number(company.peerStats?.count) || 0,
    Array.isArray(company.peers) ? company.peers.length : 0
  );
  const peerScore = clamp(peerCount / 6, 0, 1);
  const quality = Number(analysis.quality?.score) || 50;
  const flags = analysis.quality?.redFlags || [];
  const penalty = Math.min(
    12,
    flags.reduce(
      (sum, flag) => sum + (flag.severity === "high" ? 4 : flag.severity === "medium" ? 2 : 1),
      0
    )
  );

  const score = round(
    clamp(
      0.22 * coverage * 100 +
        0.2 * completeness * 100 +
        0.2 * dispersion * 100 +
        0.14 * dcfScore * 100 +
        0.12 * peerScore * 100 +
        0.12 * quality -
        penalty,
      0,
      100
    ),
    0
  );

  let label = "Low confidence";
  let tone = "negative";
  if (score >= 75) {
    label = "High confidence";
    tone = "positive";
  } else if (score >= 55) {
    label = "Medium confidence";
    tone = "warning";
  }

  const reasons = [];
  reasons.push({
    tone: included.length >= 5 ? "positive" : "warning",
    text: `${included.length} of ${analysis.models.length} lenses are applicable and weighted.`,
  });
  reasons.push({
    tone: coefficientOfVariation < 0.4 ? "positive" : coefficientOfVariation < 0.65 ? "warning" : "negative",
    text:
      coefficientOfVariation < 0.4
        ? `The lenses cluster around the blend; dispersion is ${(coefficientOfVariation * 100).toFixed(0)}% of value.`
        : `The lenses disagree materially; dispersion is ${(coefficientOfVariation * 100).toFixed(0)}% of value.`,
  });
  if (dcf?.valid) {
    reasons.push({
      tone: dcf.terminalShare > 0.72 ? "negative" : dcf.terminalShare > 0.6 ? "warning" : "positive",
      text: `DCF terminal value is ${(dcf.terminalShare * 100).toFixed(0)}% of enterprise value.`,
    });
  } else {
    reasons.push({
      tone: analysis.isFinancial ? "warning" : "negative",
      text: analysis.isFinancial
        ? "DCF is intentionally excluded for this financial company."
        : "DCF is excluded because free cash flow is not positive.",
    });
  }
  reasons.push({
    tone: peerCount >= 4 ? "positive" : peerCount >= 2 ? "warning" : "negative",
    text: peerCount
      ? `${peerCount} live sector peers inform the relative multiples.`
      : "No live peer set was available; static sector benchmarks are being used.",
  });
  if (flags.length) {
    reasons.push({
      tone: flags.some((flag) => flag.severity === "high") ? "negative" : "warning",
      text: `${flags.length} red flag${flags.length === 1 ? "" : "s"} ${flags.length === 1 ? "reduces" : "reduce"} the confidence score.`,
    });
  }

  return {
    score,
    label,
    tone,
    reasons,
    components: [
      { label: "Model coverage", value: round(coverage * 100, 0) },
      { label: "Data completeness", value: round(completeness * 100, 0) },
      { label: "Agreement", value: round(dispersion * 100, 0) },
      { label: "Peer support", value: round(peerScore * 100, 0) },
    ],
  };
}

export function buildAnalysis(company, assumptions) {
  const ranges = modelRanges(company, assumptions);
  const reverse = reverseDCF(company, assumptions);
  const quality = qualityScore(company);
  const mc = monteCarlo(company, assumptions);
  const sens = sensitivity(company, assumptions);
  const verdict = verdictFor(ranges.composite, company.price?.last);
  const mos = marginOfSafety(ranges.composite, company.price?.last);
  const confidence = confidenceFor(company, { ...ranges, quality });
  return {
    ...ranges,
    reverse,
    quality,
    monteCarlo: mc,
    sensitivity: sens,
    verdict,
    marginOfSafety: mos,
    upside:
      positive(ranges.composite) && positive(company.price?.last)
        ? ranges.composite / company.price.last - 1
        : null,
    confidence,
  };
}
