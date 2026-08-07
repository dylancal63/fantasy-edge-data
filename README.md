# Fantasy Edge — data pipeline

Weekly precompute that turns free **nflverse** data into two tiny JSON files the app fetches:

- `profiles_{season}.json` — per-team scheme tendencies (pass/run **EPA funnel**, **aDOT**, **PROE**, pace).
- `usage_{season}.json` — per-player **opportunity** (snap %, target share, air-yards share, **WOPR**),
  **keyed by Sleeper id** (joined via the DynastyProcess id crosswalk) so the app needs no crosswalk.

Only dependency is `csv-parse`; everything is downloaded at runtime. No Mac, no R, no API keys.

```sh
npm install
node build-data.mjs 2025      # writes out/profiles_2025.json, out/usage_2025.json
```

## Hosting it (free, auto-refresh)

The app already points at `https://raw.githubusercontent.com/dylancal63/fantasy-edge-data/main`
(`DATA_BASE_URL` in `src/config/remoteData.ts`). You just need to create that public repo and push the
**contents of this `server/` folder** to its root — the seed `profiles_2025.json` / `usage_2025.json`
are already here, so the raw URLs serve real data the moment you push. Until then the app uses the
bundled `src/data/*.json`, so nothing breaks.

This folder lives inside the app's git repo, so publish it as a **fresh, separate repo** from a copy:

```sh
# from a COPY of this server/ folder (not the app repo)
# Option A — GitHub CLI (one command):
gh repo create dylancal63/fantasy-edge-data --public --source=. --push

# Option B — manual: create an empty public repo named fantasy-edge-data on github.com, then:
git init
git add .
git commit -m "seed data repo"
git branch -M main
git remote add origin https://github.com/dylancal63/fantasy-edge-data.git
git push -u origin main
```

Then in the repo on GitHub: **Actions → refresh-data → Run workflow** once to confirm a green run. It
rebuilds the current season and commits the JSON, and re-runs automatically every **Wednesday**. No
secrets are required (it uses the default `GITHUB_TOKEN` with `permissions: contents: write`).

**Verify it's live:**
```sh
curl -s https://raw.githubusercontent.com/dylancal63/fantasy-edge-data/main/usage_2025.json | head -c 120
```
should return JSON. (`raw.githubusercontent.com` is CDN-cached ~5 min.)

`build-profiles.mjs` is the older profiles-only script (kept as `npm run build:profiles-only`); it reads a
local `data/pbp_{season}.csv`. Prefer `build-data.mjs`, which downloads everything.
