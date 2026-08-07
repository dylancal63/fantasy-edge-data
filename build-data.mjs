// Weekly precompute for Fantasy Edge. Downloads free nflverse CSVs + the
// DynastyProcess id crosswalk and emits two small JSON files the app fetches:
//   profiles_{season}.json  — per-team scheme tendencies (EPA funnel, aDOT, PROE, pace)
//   usage_{season}.json     — per-player opportunity (snap %, target share, air-yards
//                             share, WOPR), KEYED BY SLEEPER ID so the app needs no crosswalk
//
// Usage: node build-data.mjs [season]   (defaults to current year)
// Self-contained: only dependency is csv-parse. Designed to run in a GitHub Action.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';

const season = process.argv[2] ?? String(new Date().getFullYear());
const outDir = 'out';

const REL = 'https://github.com/nflverse/nflverse-data/releases/download';
const URLS = {
  pbp: `${REL}/pbp/play_by_play_${season}.csv`,
  stats: `${REL}/stats_player/stats_player_week_${season}.csv`,
  snaps: `${REL}/snap_counts/snap_counts_${season}.csv`,
  crosswalk: 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv',
};

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Stream a CSV url row-by-row into onRow. Resolves false (not fatal) on 404. */
async function streamCsv(url, onRow) {
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  skip ${url} (${res.status})`);
    return false;
  }
  await new Promise((resolve, reject) => {
    const parser = parse({ columns: true, relax_quotes: true, skip_records_with_error: true });
    parser.on('readable', () => {
      let r;
      while ((r = parser.read()) !== null) onRow(r);
    });
    parser.on('error', reject);
    parser.on('end', resolve);
    Readable.fromWeb(res.body).pipe(parser);
  });
  return true;
}

// ---- 1. id crosswalk: gsis_id / pfr_id -> sleeper_id ----
async function buildCrosswalk() {
  const byGsis = new Map();
  const byPfr = new Map();
  await streamCsv(URLS.crosswalk, (r) => {
    if (!r.sleeper_id) return;
    if (r.gsis_id) byGsis.set(r.gsis_id, r.sleeper_id);
    if (r.pfr_id) byPfr.set(r.pfr_id, r.sleeper_id);
  });
  return { byGsis, byPfr };
}

// ---- 2. play-by-play -> team scheme profiles (same aggregation as before) ----
async function buildProfiles() {
  const D = new Map();
  const O = new Map();
  const dget = (k) => {
    let a = D.get(k);
    if (!a) { a = { plays: 0, pass: 0, rush: 0, epaP: 0, epaPn: 0, epaR: 0, epaRn: 0, ay: 0, ayn: 0 }; D.set(k, a); }
    return a;
  };
  const oget = (k) => {
    let a = O.get(k);
    if (!a) { a = { plays: 0, pass: 0, rush: 0, proe: 0, proen: 0, ay: 0, ayn: 0, sh: 0, nh: 0, epa: 0, epan: 0, games: new Set() }; O.set(k, a); }
    return a;
  };
  let rows = 0;
  const ok = await streamCsv(URLS.pbp, (r) => {
    if (r.season_type !== 'REG') return;
    const pt = r.play_type;
    if (pt !== 'pass' && pt !== 'run') return;
    const off = r.posteam, def = r.defteam;
    if (!off || !def) return;
    rows++;
    const isPass = pt === 'pass';
    const epa = num(r.epa);
    const ay = num(r.air_yards);
    const d = dget(def);
    d.plays++; if (isPass) d.pass++; else d.rush++;
    if (epa != null) { if (isPass) { d.epaP += epa; d.epaPn++; } else { d.epaR += epa; d.epaRn++; } }
    if (isPass && ay != null) { d.ay += ay; d.ayn++; }
    const o = oget(off);
    o.plays++; if (isPass) o.pass++; else o.rush++;
    const poe = num(r.pass_oe);
    if (poe != null) { o.proe += poe; o.proen++; }
    if (isPass && ay != null) { o.ay += ay; o.ayn++; }
    if (r.shotgun === '1') o.sh++;
    if (r.no_huddle === '1') o.nh++;
    if (epa != null) { o.epa += epa; o.epan++; }
    if (r.game_id) o.games.add(r.game_id);
  });
  if (!ok || rows === 0) return null;

  const defense = {};
  for (const [team, a] of D) {
    defense[team] = {
      plays: a.plays,
      passRateFaced: r3(a.pass / (a.pass + a.rush)),
      passEpaAllowed: a.epaPn ? r3(a.epaP / a.epaPn) : 0,
      rushEpaAllowed: a.epaRn ? r3(a.epaR / a.epaRn) : 0,
      aDOTAllowed: a.ayn ? r3(a.ay / a.ayn) : 0,
    };
  }
  const offense = {};
  for (const [team, a] of O) {
    const games = a.games.size || 1;
    offense[team] = {
      plays: a.plays, games,
      proe: a.proen ? r3(a.proe / a.proen) : 0,
      passRate: r3(a.pass / (a.pass + a.rush)),
      aDOT: a.ayn ? r3(a.ay / a.ayn) : 0,
      shotgunRate: r3(a.sh / a.plays),
      noHuddleRate: r3(a.nh / a.plays),
      epaPerPlay: a.epan ? r3(a.epa / a.epan) : 0,
      playsPerGame: r3(a.plays / games),
    };
  }
  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
  const dv = Object.values(defense), ov = Object.values(offense);
  const leagueAvg = {
    passEpaAllowed: r3(mean(dv.map((x) => x.passEpaAllowed))),
    rushEpaAllowed: r3(mean(dv.map((x) => x.rushEpaAllowed))),
    aDOTAllowed: r3(mean(dv.map((x) => x.aDOTAllowed))),
    passRateFaced: r3(mean(dv.map((x) => x.passRateFaced))),
    proe: r3(mean(ov.map((x) => x.proe))),
    aDOT: r3(mean(ov.map((x) => x.aDOT))),
    passRate: r3(mean(ov.map((x) => x.passRate))),
    playsPerGame: r3(mean(ov.map((x) => x.playsPerGame))),
  };
  return { season, generated: null, leagueAvg, defense, offense };
}

// ---- 3. weekly stats + snaps -> per-player usage keyed by sleeper_id ----
async function buildUsage(cw) {
  // key: `${sleeperId}|${week}` -> partial usage row
  const byKey = new Map();
  const upsert = (sleeperId, week, patch) => {
    if (!sleeperId) return;
    const k = `${sleeperId}|${week}`;
    byKey.set(k, { sleeperId, week: +week, ...(byKey.get(k) ?? {}), ...patch });
  };

  await streamCsv(URLS.stats, (r) => {
    const sleeperId = cw.byGsis.get(r.player_id);
    if (!sleeperId || r.season_type !== 'REG') return;
    upsert(sleeperId, r.week, {
      targetShare: num(r.target_share),
      airYardsShare: num(r.air_yards_share),
      wopr: num(r.wopr),
    });
  });
  await streamCsv(URLS.snaps, (r) => {
    const sleeperId = cw.byPfr.get(r.pfr_player_id);
    if (!sleeperId || r.game_type !== 'REG') return;
    upsert(sleeperId, r.week, { snapPct: num(r.offense_pct) });
  });

  // Recency-weighted aggregate (mirrors src/lib/usageModel.ts aggregateUsage).
  const rows = [...byKey.values()];
  const maxWeek = rows.reduce((m, x) => Math.max(m, x.week), 0);
  const decay = Math.pow(0.5, 1 / 6);
  const byPlayer = new Map();
  for (const r of rows) {
    const list = byPlayer.get(r.sleeperId) ?? [];
    list.push(r);
    byPlayer.set(r.sleeperId, list);
  }
  const usage = {};
  for (const [sleeperId, games] of byPlayer) {
    const acc = { snapPct: [0, 0], targetShare: [0, 0], airYardsShare: [0, 0], wopr: [0, 0] };
    for (const g of games) {
      const w = Math.pow(decay, maxWeek - g.week);
      for (const key of Object.keys(acc)) {
        const v = g[key];
        if (v == null || Number.isNaN(v)) continue;
        acc[key][0] += w; acc[key][1] += w * v;
      }
    }
    const avg = (a) => (a[0] > 0 ? r3(a[1] / a[0]) : 0);
    usage[sleeperId] = {
      snapPct: avg(acc.snapPct),
      targetShare: avg(acc.targetShare),
      airYardsShare: avg(acc.airYardsShare),
      wopr: avg(acc.wopr),
      games: games.length,
    };
  }
  return { season, generated: null, usage };
}

async function main() {
  console.log(`Building Fantasy Edge data for ${season}...`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('- id crosswalk');
  const cw = await buildCrosswalk();

  console.log('- team scheme profiles (play-by-play)');
  const profiles = await buildProfiles();
  if (profiles) {
    fs.writeFileSync(path.join(outDir, `profiles_${season}.json`), JSON.stringify(profiles));
    console.log(`  wrote profiles_${season}.json (${Object.keys(profiles.defense).length} defenses)`);
  } else {
    console.log(`  no play-by-play yet for ${season} — skipped profiles`);
  }

  console.log('- player usage (weekly stats + snap counts)');
  const usage = await buildUsage(cw);
  const n = Object.keys(usage.usage).length;
  if (n > 0) {
    fs.writeFileSync(path.join(outDir, `usage_${season}.json`), JSON.stringify(usage));
    console.log(`  wrote usage_${season}.json (${n} players)`);
  } else {
    console.log(`  no usage data yet for ${season} — skipped usage`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
