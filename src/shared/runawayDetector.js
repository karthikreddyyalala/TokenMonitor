'use strict';

// Flags a live session that burns tokens far faster than this user normally does.
//
// Input is a stream of cumulative samples per session ({ key, t, freshTokens, turns }),
// where freshTokens counts input + output + cache writes. Cache reads are left out
// on purpose: they track how long a conversation is, not how hard it is working.
// Samples are bucketed per minute. Every finished active minute from a session that
// is not currently flagged feeds one shared baseline, the user's normal pace,
// summarised with median and MAD so that one wild minute cannot drag it around.
//
// Two signals, each needing several minutes so a single burst never fires:
//   rate: SUSTAIN_MINUTES in a row above max(floor, RATIO * median, median + K * MAD)
//   loop: LOOP_MINUTES in a row with several turns of nearly the same size, at a
//         pace well above normal, which is how an agent repeating a failing step looks.

const MIN = 60_000;
const DEFAULTS = Object.freeze({
  sustainMinutes: 3,
  ratio: 5,
  madK: 6,
  floorTokensPerMinute: 15_000,
  loopMinutes: 6,
  loopMinTurns: 2,
  loopMaxSpread: 0.12,
  loopMinRatio: 1.5,
  minBaseline: 30,
  maxBaseline: 2_000,
  cooldownMs: 30 * MIN,
  keepMinutes: 15
});

function robustStats(values) {
  if (!values.length) return { median: 0, mad: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (list) => (list.length % 2 ? list[(list.length - 1) / 2] : (list[list.length / 2 - 1] + list[list.length / 2]) / 2);
  const median = mid(sorted);
  const mad = mid(sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b));
  return { median, mad };
}

// Spread of tokens-per-turn across minutes: standard deviation over mean.
function spread(minutes) {
  const sizes = minutes.map((m) => m.tokens / m.turns);
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  if (!(mean > 0)) return Infinity;
  const variance = sizes.reduce((a, b) => a + (b - mean) ** 2, 0) / sizes.length;
  return Math.sqrt(variance) / mean;
}

function createRunawayDetector(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const sessions = new Map();
  const baseline = [];
  // ponytail: stats are re-sorted at most every 10 new minutes; a running quantile sketch if baselines get huge.
  let cached = null;
  let pushesSinceStats = Infinity;
  const baselineStats = () => {
    if (pushesSinceStats >= 10) { cached = robustStats(baseline); pushesSinceStats = 0; }
    return cached;
  };

  function threshold(stats) {
    return Math.max(o.floorTokensPerMinute, stats.median * o.ratio, stats.median + o.madK * 1.4826 * stats.mad);
  }

  function evaluate(session, now) {
    if (baseline.length < o.minBaseline) return null;
    if (now - session.lastAlertAt < o.cooldownMs) return null;
    const stats = baselineStats();
    const recent = session.minutes.slice(-o.sustainMinutes);
    const limit = threshold(stats);
    if (recent.length === o.sustainMinutes && recent.every((m) => m.tokens > limit)) {
      const pace = recent.reduce((a, m) => a + m.tokens, 0) / recent.length;
      return { reason: 'rate', ratio: pace / Math.max(1, stats.median), tokensPerMinute: Math.round(pace) };
    }
    const loop = session.minutes.slice(-o.loopMinutes);
    if (
      loop.length === o.loopMinutes
      && loop.every((m) => m.turns >= o.loopMinTurns && m.tokens > stats.median * o.loopMinRatio)
      && spread(loop) <= o.loopMaxSpread
    ) {
      const pace = loop.reduce((a, m) => a + m.tokens, 0) / loop.length;
      return { reason: 'loop', ratio: pace / Math.max(1, stats.median), tokensPerMinute: Math.round(pace) };
    }
    return null;
  }

  // Closes every minute between the session's open bucket and `minute`, then judges it.
  function closeMinutes(session, minute) {
    let alert = null;
    while (session.openMinute < minute) {
      const closed = { tokens: session.open.tokens, turns: session.open.turns };
      session.minutes.push(closed);
      if (session.minutes.length > o.keepMinutes) session.minutes.shift();
      const now = (session.openMinute + 1) * MIN;
      const found = evaluate(session, now);
      if (found) {
        session.lastAlertAt = now;
        alert = alert || found;
      }
      if (closed.tokens > 0 && now - session.lastAlertAt >= o.cooldownMs) {
        baseline.push(closed.tokens);
        pushesSinceStats += 1;
        if (baseline.length > o.maxBaseline) baseline.shift();
      }
      session.openMinute += 1;
      session.open = { tokens: 0, turns: 0 };
    }
    return alert;
  }

  function observe({ key, label, t, freshTokens, turns }) {
    const minute = Math.floor(t / MIN);
    let session = sessions.get(key);
    if (!session || freshTokens < session.lastTokens || turns < session.lastTurns) {
      session = { minutes: [], open: { tokens: 0, turns: 0 }, openMinute: minute, lastTokens: freshTokens, lastTurns: turns, lastAlertAt: -Infinity };
      sessions.set(key, session);
      return null;
    }
    const alert = closeMinutes(session, minute);
    session.open.tokens += freshTokens - session.lastTokens;
    session.open.turns += turns - session.lastTurns;
    session.lastTokens = freshTokens;
    session.lastTurns = turns;
    return alert ? { key, label, ...alert } : null;
  }

  return { observe, baselineSize: () => baseline.length };
}

module.exports = { DEFAULTS, createRunawayDetector, robustStats };
