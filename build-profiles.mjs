// Aggregate nflverse play-by-play into compact per-team scheme-tendency profiles.
// Usage: node build-profiles.mjs [season]   (expects data/pbp_{season}.csv)
// Output: out/profiles_{season}.json  (defense + offense profiles + league averages)
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';

const season = process.argv[2] ?? '2024';
const inFile = path.join('data', `pbp_${season}.csv`);
const outDir = 'out';
const outFile = path.join(outDir, `profiles_${season}.json`);

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const r3 = (x) => Math.round(x * 1000) / 1000;

const D = new Map();
const O = new Map();
const dget = (k) => {
  let a = D.get(k);
  if (!a) {
    a = { plays: 0, pass: 0, rush: 0, epaP: 0, epaPn: 0, epaR: 0, epaRn: 0, ay: 0, ayn: 0 };
    D.set(k, a);
  }
  return a;
};
const oget = (k) => {
  let a = O.get(k);
  if (!a) {
    a = { plays: 0, pass: 0, rush: 0, proe: 0, proen: 0, ay: 0, ayn: 0, sh: 0, nh: 0, epa: 0, epan: 0, games: new Set() };
    O.set(k, a);
  }
  return a;
};

const parser = parse({ columns: true, relax_quotes: true, skip_records_with_error: true });
let rows = 0;

parser.on('readable', () => {
  let r;
  while ((r = parser.read()) !== null) {
    if (r.season_type !== 'REG') continue;
    const pt = r.play_type;
    if (pt !== 'pass' && pt !== 'run') continue;
    const off = r.posteam;
    const def = r.defteam;
    if (!off || !def) continue;
    rows++;
    const isPass = pt === 'pass';
    const epa = num(r.epa);
    const ay = num(r.air_yards);

    const d = dget(def);
    d.plays++;
    if (isPass) d.pass++;
    else d.rush++;
    if (epa != null) {
      if (isPass) { d.epaP += epa; d.epaPn++; }
      else { d.epaR += epa; d.epaRn++; }
    }
    if (isPass && ay != null) { d.ay += ay; d.ayn++; }

    const o = oget(off);
    o.plays++;
    if (isPass) o.pass++;
    else o.rush++;
    const poe = num(r.pass_oe);
    if (poe != null) { o.proe += poe; o.proen++; }
    if (isPass && ay != null) { o.ay += ay; o.ayn++; }
    if (r.shotgun === '1') o.sh++;
    if (r.no_huddle === '1') o.nh++;
    if (epa != null) { o.epa += epa; o.epan++; }
    if (r.game_id) o.games.add(r.game_id);
  }
});

parser.on('error', (e) => {
  console.error('parse error', e.message);
  process.exit(1);
});

parser.on('end', () => {
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
      plays: a.plays,
      games,
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
  const dv = Object.values(defense);
  const ov = Object.values(offense);
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

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    outFile,
    JSON.stringify({ season, generated: null, leagueAvg, defense, offense }),
  );
  console.log(
    `rows=${rows} defenses=${dv.length} offenses=${ov.length} -> ${outFile}`,
  );
});

fs.createReadStream(inFile).pipe(parser);
