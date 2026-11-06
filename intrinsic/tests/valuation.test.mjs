import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  defaultAssumptions,
  buildAnalysis,
  runDCF,
  reverseDCF,
  monteCarlo,
  grahamNumber,
  earningsPowerValue,
  isFinancialCompany,
} from "../static/js/valuation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const load = (symbol) =>
  JSON.parse(fs.readFileSync(path.join(root, "data", "fallback", `${symbol}.json`), "utf8"));

const apple = load("AAPL");
const boeing = load("BA");
const jpm = load("JPM");

// Stand-in for a company whose TTM free cash flow is negative. Bundled
// snapshots are regenerated from live data, so their FCF sign is not stable
// enough to pin a negative-FCF test to a real ticker.
const cashBurner = {
  ...boeing,
  financials: { ...boeing.financials, fcf: -3_200_000_000, ocf: 4_100_000_000, capex: -7_300_000_000, sbc: 900_000_000 },
  history: [...boeing.history.slice(0, -1), { ...boeing.history[boeing.history.length - 1], fcf: -3_200_000_000 }],
};

const closeTo = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} not within ${tolerance} of ${expected}`);

test("DCF is monotonic in growth and inversely related to WACC", () => {
  const assumptions = defaultAssumptions(apple);
  const lowGrowth = runDCF(apple, assumptions, { growth: 0.04 });
  const highGrowth = runDCF(apple, assumptions, { growth: 0.14 });
  const highWacc = runDCF(apple, assumptions, { wacc: assumptions.wacc + 0.02 });
  assert.equal(lowGrowth.valid, true);
  assert.equal(highGrowth.valid, true);
  assert.ok(highGrowth.value > lowGrowth.value);
  assert.ok(highWacc.value < runDCF(apple, assumptions).value);
});

test("reverse DCF recovers the market-implied growth rate", () => {
  const assumptions = defaultAssumptions(apple);
  const reverse = reverseDCF(apple, assumptions);
  assert.equal(reverse.valid, true);
  const atImplied = runDCF(apple, assumptions, { growth: reverse.growth });
  closeTo(atImplied.value / apple.price.last, 1, 0.01);
});

test("negative free cash flow cannot produce a DCF value", () => {
  const assumptions = defaultAssumptions(cashBurner);
  assert.ok(assumptions.fcfMargin < 0);
  const dcf = runDCF(cashBurner, assumptions);
  assert.equal(dcf.valid, false);
  assert.match(dcf.reason, /free cash flow/i);
});

test("banks use an equity earnings-power model", () => {
  assert.equal(isFinancialCompany(jpm), true);
  const epv = earningsPowerValue(jpm, defaultAssumptions(jpm));
  assert.equal(epv.valid, true);
  assert.equal(epv.mode, "equity");
  assert.ok(epv.value > 0);
});

test("blended weights sum to one and exclude ineligible models", () => {
  const analysis = buildAnalysis(apple, defaultAssumptions(apple));
  const sum = analysis.models.reduce((total, model) => total + model.weightPct, 0);
  closeTo(sum, 1, 1e-9);
  assert.equal(analysis.models.find((model) => model.id === "ddm").weightPct, 0);
  assert.ok(analysis.models.find((model) => model.id === "dcf").weightPct > 0);
});

test("negative-FCF company gets a blend without a DCF weight", () => {
  const analysis = buildAnalysis(cashBurner, defaultAssumptions(cashBurner));
  const dcf = analysis.models.find((model) => model.id === "dcf");
  assert.equal(dcf.valid, false);
  assert.equal(dcf.weightPct, 0);
  assert.ok(analysis.composite > 0);
});

test("live peer medians replace static sector benchmarks", () => {
  const withPeers = load("AAPL");
  withPeers.peerStats = {
    pe: 24.8,
    peCount: 6,
    evEbitda: 16.4,
    evCount: 6,
    priceToBook: 12,
    pbCount: 6,
    count: 6,
  };
  const analysis = buildAnalysis(withPeers, defaultAssumptions(withPeers));
  const pe = analysis.models.find((model) => model.id === "pe");
  const ev = analysis.models.find((model) => model.id === "ev");
  assert.equal(pe.name, "Peer P/E");
  closeTo(pe.value, withPeers.financials.eps * 24.8, 1e-9);
  const expectedEv =
    (withPeers.financials.ebitda * 16.4 -
      withPeers.financials.totalDebt +
      withPeers.financials.cash) /
    withPeers.financials.sharesOutstanding;
  closeTo(ev.value, expectedEv, 1e-6);
  assert.ok(analysis.confidence.score >= 75);
});

test("banks receive a P/B lens and confidence output", () => {
  const bank = load("JPM");
  bank.peerStats = {
    pe: 12.5,
    peCount: 6,
    priceToBook: 1.4,
    pbCount: 6,
    count: 6,
  };
  const analysis = buildAnalysis(bank, defaultAssumptions(bank));
  const book = analysis.models.find((model) => model.id === "book");
  assert.equal(book.valid, true);
  assert.equal(book.name, "Price / book");
  assert.ok(book.weightPct > 0);
  assert.ok(analysis.confidence.score >= 0 && analysis.confidence.score <= 100);
  assert.ok(analysis.confidence.reasons.length >= 3);
});

test("Graham number follows its formula", () => {
  const result = grahamNumber(apple);
  const expected = Math.sqrt(22.5 * apple.financials.eps * apple.financials.bookValuePerShare);
  closeTo(result.value, expected, 1e-9);
});

test("Monte Carlo percentiles are ordered and deterministic", () => {
  const assumptions = defaultAssumptions(apple);
  const first = monteCarlo(apple, assumptions, 300, 42);
  const second = monteCarlo(apple, assumptions, 300, 42);
  assert.equal(first.p10, second.p10);
  assert.ok(first.p10 <= first.p50);
  assert.ok(first.p50 <= first.p90);
  assert.ok(first.probabilityUndervalued >= 0 && first.probabilityUndervalued <= 1);
  assert.equal(first.bins.reduce((total, bin) => total + bin.count, 0), first.runs);
});

test("analysis output is finite and serialisable", () => {
  const analysis = buildAnalysis(apple, defaultAssumptions(apple));
  assert.ok(Number.isFinite(analysis.composite));
  assert.ok(Number.isFinite(analysis.low));
  assert.ok(Number.isFinite(analysis.high));
  assert.ok(analysis.quality.score >= 0 && analysis.quality.score <= 100);
  JSON.stringify(analysis);
});
