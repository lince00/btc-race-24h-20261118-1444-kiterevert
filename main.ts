// KiteRevert: a two-leg, long-only dip bot for cbBTC on 1-minute bars.
//
// The dev window (18 Nov 2026) falls 2.8% with a mid-day recovery, and the
// three earlier race windows fell 4-5% or went flat. Across those four
// windows every trend-following family loses money (EMA cross about -60 on
// the dev window alone, momentum about -14 to -32 per window), and plain
// dip-buying catches falling knives on the downtrend days. This bot only
// trades two rare, confirmed shapes, and otherwise stays in cash:
//
//   Leg 1 — the dip (at most 2 round trips per window). Buy when the close
//   sits at least 1.1% below its 120-bar simple moving average, then exit
//   when the close climbs back to that average, or at +0.6% take-profit,
//   -0.5% stop, -0.5% trailing stop, or 240 bars. A 360-bar trend block
//   refuses the dip while the 360-bar return is below -1% (a falling
//   market keeps falling). Before bar 360 the signal is less proven, so
//   the leg only spends half the cash; from bar 360 it spends it all.
//   A 120-bar cooldown follows every exit, so one bad read cannot chain.
//
//   Leg 2 — the deep recovery (unlimited, but it almost never fires). Buy
//   when the price fell at least 3% over 120 bars and the last 10 bars are
//   no longer falling, then ride it: +5% take-profit, -0.5% stop, -0.5%
//   trailing stop, 240 bars. No exit at the moving average — this leg is
//   the one that is allowed to run.
//
// Both legs are long only, full position or nothing (one open position at
// most), one order per reply, slippage capped at 100 bps. Everything is
// computed from the bars themselves: no clock, no randomness, no network,
// so two runs on the same data give the same orders.
//
// Swept and graded offline on the kit's dev window plus the three earlier
// race windows (13, 15, 17 Nov): dev +2.38 USDC (1 round trip, max
// drawdown 0.16%), 17 Nov 0.00 (no trade), 15 Nov +47.52, 13 Nov -0.13.
// Mean +12.44, worst window -0.13, worst drawdown 0.9%.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Prices arrive at price_scale 5: one unit is 1e-5 USDC. */
const PRICE_DIVISOR = 100000;
const MAX_SLIPPAGE_BPS = 100;

/** Mean-reversion leg. */
const SMA_SPAN = 120;
const MR_DIP = 0.011; // close at least 1.1% below the 120-bar average
const MR_TP = 0.006; // take profit +0.6% over the entry close
const MR_MAX_ROUNDS = 2; // at most two dip round trips per window
/** Recovery leg. */
const REC_DROP_BARS = 120;
const REC_DROP = 0.03; // down at least 3% over 120 bars
const REC_BOUNCE_BARS = 10;
const REC_BOUNCE = 0.0; // and the last 10 bars no longer falling
const REC_TP = 0.05; // take profit +5% over the entry close
/** Shared risk controls. */
const STOP = 0.005; // hard stop -0.5% under the entry close
const TRAIL = 0.005; // trailing stop -0.5% under the peak close
const MAX_HOLD = 240; // bars
const COOLDOWN = 120; // bars after an exit before a new entry
/** Trend block for the dip leg: refuse while the 360-bar return is under this. */
const TREND_BARS = 360;
const TREND_MIN = -0.01;
/** Before this bar the dip signal is less proven: spend only half the cash. */
const EARLY_BARS = 360;

type Leg = 'mr' | 'rec';

interface Held {
  entry: number; // close (USDC) of the bar the entry was decided on
  peak: number; // highest close seen while holding
  hold: number; // bars held
  tp: number; // take-profit fraction for this leg
  leg: Leg;
}

/** Closes in USDC, in bar order; the running sum behind the 120-bar average. */
const closes: number[] = [];
let smaSum = 0;
let cooldown = 0;
let mrRounds = 0;
let held: Held | null = null;

/** The 120-bar simple moving average after the current close, or null before bar 119. */
function sma120(): number | null {
  if (closes.length < SMA_SPAN) return null;
  return smaSum / SMA_SPAN;
}

/** Return of the close against the close `bars` bars back, or null when too early. */
function retBack(bars: number): number | null {
  const i = closes.length - 1;
  if (i < bars) return null;
  return closes[i] / closes[i - bars] - 1;
}

function push(bar: Bar): void {
  const c = Number(bar.c) / PRICE_DIVISOR;
  const i = closes.length;
  smaSum += c;
  if (i >= SMA_SPAN) smaSum -= closes[i - SMA_SPAN];
  closes.push(c);
}

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[] }) {
    if (cooldown > 0) cooldown -= 1;
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) push(bar);
    }
    if (closes.length === 0 || state.warmingUp) return [];

    const c = closes[closes.length - 1];
    const position = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    // Fill hygiene: a buy the market refused (fill past the slippage cap)
    // leaves a planned hold with no position — clear it so the entry can
    // be decided again. A sell refused the same way leaves a position with
    // no plan — track it again from this close so the bot never buys while
    // it already holds.
    if (position === undefined && held !== null) held = null;
    if (position !== undefined && held === null) {
      held = { entry: c, peak: c, hold: 0, tp: MR_TP, leg: 'mr' };
    }

    if (position !== undefined && held !== null) {
      held.hold += 1;
      if (c > held.peak) held.peak = c;
      const avg = sma120();
      const exitAtAverage = held.leg === 'mr' && avg !== null && c >= avg;
      const exitNow =
        exitAtAverage ||
        c >= held.entry * (1 + held.tp) ||
        c <= held.entry * (1 - STOP) ||
        c <= held.peak * (1 - TRAIL) ||
        held.hold >= MAX_HOLD;
      if (exitNow) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        held = null;
        cooldown = COOLDOWN;
      }
      return orders;
    }

    if (cooldown > 0) return [];
    const seq = closes.length - 1;

    // Leg 2: the deep recovery. Checked first; it almost never fires.
    const drop = retBack(REC_DROP_BARS);
    const bounce = retBack(REC_BOUNCE_BARS);
    if (drop !== null && drop <= -REC_DROP && bounce !== null && bounce >= REC_BOUNCE) {
      held = { entry: c, peak: c, hold: 0, tp: REC_TP, leg: 'rec' };
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
      return orders;
    }

    // Leg 1: the dip below the 120-bar average.
    const avg = sma120();
    if (mrRounds < MR_MAX_ROUNDS && avg !== null && c <= avg * (1 - MR_DIP)) {
      const trend = retBack(TREND_BARS);
      if (trend !== null && trend < TREND_MIN) return [];
      const stake = seq >= EARLY_BARS ? state.cash : state.cash / 2n;
      held = { entry: c, peak: c, hold: 0, tp: MR_TP, leg: 'mr' };
      mrRounds += 1;
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
      return orders;
    }

    return [];
  },
});
