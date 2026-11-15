# Electron app survey

Scripts behind [docs/APP-SURVEY.md](../../docs/APP-SURVEY.md). They count
which Electron APIs, `webPreferences` flags, Node built-ins and helper
packages open-source Electron apps use, so the roadmap can be ranked by how
many apps each gap affects. Not part of the published package.

The scan is regex-based, not a type checker: module calls (`app.getPath`)
are exact, instance calls (`win.maximize()`, `webContents.on('…')`) are
attributed by method or event name and can over- or under-count. Treat the
numbers as "how many apps", not "how many calls".

```bash
mkdir -p /tmp/survey/repos && cd /tmp/survey/repos
grep -v '^#' path/to/scripts/survey/apps.txt | while read dir repo _; do
  git clone -q --depth 1 --filter=blob:limit=300k "https://github.com/$repo.git" "$dir"
done
(cd vscode && git sparse-checkout set src/vs)   # optional: VS Code is large
```

```bash
cd /tmp/survey && npm pack electron@45 && tar xzf electron-*.tgz package/electron.d.ts
```

```bash
node scripts/survey/scan.mjs /tmp/survey/package/electron.d.ts /tmp/survey/repos scan.json
```

```bash
node scripts/survey/agg.mjs scan.json api-usage.tsv       # API → number of apps → apps
```

```bash
node scripts/survey/blockers.mjs /tmp/survey/repos scan.json   # per-app structural blockers
```

`data/` holds the output of the November 2026 run (`apps.txt` has the
commits): `api-usage.tsv` (every API with the number of apps and their
names), `scan.json` (per app: Electron version, API counts, flags, Node
modules, native dependencies) and `blockers.json`.
