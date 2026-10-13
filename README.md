# MARC Transportation Resilience Phase 2

High Street's working repo for the Mid-America Regional Council (MARC) Transportation Resilience Phase 2
study: network build and analysis scripts (`scripts/`, `config/`, `tests/`) and the public
**Transportation Resilience Explorer** web app (`app/`). Client documents (`knowledge/`) and data (`data/`)
are not tracked.

## Web app (`app/`)

Vite + React + ArcGIS Maps SDK, forked from Sun Cloud Explorer 2.0 (Explore module only). It reads one
web map on High Street's ArcGIS Online, whose id lives in `app/src/config/webmap.json`.

```
cd app
npm ci
npm run dev        # http://localhost:5173/
npm run typecheck
npm run build && npm run preview   # http://localhost:4173/
```

Deployed to GitHub Pages by `.github/workflows/deploy.yml` on push to `main` (changes under `app/`).

## Publishing to ArcGIS Online

Both scripts read `config/publish.toml` and run with ArcGIS Pro's Python (signed in to High Street's org):

```
"C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\publish_agol.py
"C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\build_webmap.py [--sharing private|org|everyone]
```

`publish_agol.py` publishes the FGDB layers as hosted feature layers; `build_webmap.py` builds (or updates)
the web map from the `[webmap]` sections, sets sharing, and writes the id to `app/src/config/webmap.json`.
