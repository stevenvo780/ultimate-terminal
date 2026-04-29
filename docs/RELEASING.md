# Releasing the Worker

This repo publishes prebuilt worker artifacts (Ubuntu `.deb` + Node prebuilt
tarball) to GitHub Releases. The universal installer
(`packaging/universal_install.sh`) prefers the prebuilt `.deb` and falls back
to compiling from source when the host distro / GLIBC doesn't match.

A release is produced **automatically** by GitHub Actions when a tag matching
`worker-v*` is pushed.

---

## TL;DR — cut a new release

```bash
# from main, with a clean tree
git pull
git tag -a worker-v1.0.1 -m "Worker v1.0.1"
git push origin worker-v1.0.1
```

That's it. In ~5 minutes, the workflow publishes:

- `ultimate-terminal-worker_<version>_ubuntu20.04_amd64_x86_64.deb`
- `ultimate-terminal-worker_<version>_ubuntu22.04_amd64_x86_64.deb`
- `ultimate-terminal-worker_<version>_ubuntu24.04_amd64_x86_64.deb`
- `worker-source-prebuilt.tar.gz`

at `https://github.com/stevenvo780/ultimate-terminal/releases/tag/worker-v<version>`,
and the universal installer's `releases/latest/download/...` URLs start
serving the new build automatically.

---

## What runs under the hood

`.github/workflows/release-worker.yml` triggers on:
- `push` of any tag matching `worker-v*` (the normal path)
- `workflow_dispatch` with a tag input (manual rerun)

It runs three jobs in parallel:

| Job | Runner | What it does |
|---|---|---|
| `build-debs` (matrix: 20.04, 22.04, 24.04) | `ubuntu-latest` | Calls `packaging/worker/build-ubuntu-debs.sh <version>` inside the matching Ubuntu container so the embedded Node binary links against that version's GLIBC. Uploads `*.deb` as artifact. |
| `build-tarball` | `ubuntu-22.04` | Copies `worker/` to `RUNNER_TEMP` (escapes the workspaces hoisting at the repo root), runs `npm install + npx tsc + npm rebuild node-pty`, packs `dist/` + `node_modules/` + `package.json` into `worker-source-prebuilt.tar.gz`. |
| `release` | `ubuntu-latest` | Downloads all artifacts, then `softprops/action-gh-release@v2` creates / updates the Release named after the tag and uploads every `*.deb` and `*.tar.gz` to it. |

The `release` job has `permissions: contents: write` — that's the only
permission needed, granted by the workflow itself, no PAT required.

---

## Versioning

Versions follow `worker-vMAJOR.MINOR.PATCH`. The numeric part after `worker-v`
is what ends up in the `.deb` filename and in `worker/package.json` when the
.deb is built (the build script reads it from the tag).

Decide the bump based on the change:
- `PATCH` (`worker-v1.0.1`) — bug fix, no behavior change for nexus.
- `MINOR` (`worker-v1.1.0`) — new feature, backwards-compatible socket protocol.
- `MAJOR` (`worker-v2.0.0`) — breaking change in worker↔nexus protocol or env config.

---

## Pre-flight checklist (before tagging)

1. `main` is green and contains the change you want to ship.
2. Worker source builds locally:
   ```bash
   cd worker && npx tsc && npm rebuild node-pty --build-from-source
   ```
3. If you bumped any worker dependency, push that to `main` first — the tag
   builds from the tagged commit, not from `main`.
4. (Optional) Smoke-test the `.deb` locally:
   ```bash
   bash packaging/worker/build-ubuntu-debs.sh 22.04
   sudo dpkg -i dist/packages/ultimate-terminal-worker_*_ubuntu22.04_*.deb
   /usr/bin/ultimate-terminal-worker --help
   ```

---

## Re-running a failed release

If a workflow run fails partway, the easiest path is:

```bash
# delete tag locally and remote, then recreate at the new commit
git tag -d worker-v1.0.0
git push origin :refs/tags/worker-v1.0.0
git tag -a worker-v1.0.0 -m "Worker v1.0.0"
git push origin worker-v1.0.0
```

> Side effect: any `Draft` release that was created by the failing run becomes
> orphaned (its tag no longer exists). Clean it up in the GitHub UI under
> *Releases → Drafts*, or via API:
> ```bash
> gh api repos/stevenvo780/ultimate-terminal/releases \
>   --jq '.[] | select(.draft==true) | .id' \
>   | xargs -I{} gh api -X DELETE repos/stevenvo780/ultimate-terminal/releases/{}
> ```

You can also rerun **without** moving the tag, via dispatch:

```bash
gh workflow run release-worker.yml --ref worker-v1.0.0 -f tag=worker-v1.0.0
```

This re-runs the build against the tagged commit and overwrites the existing
release's assets.

---

## Verifying after publish

```bash
# Release exists, assets uploaded, not draft:
gh release view worker-v<version> --repo stevenvo780/ultimate-terminal \
  --json tagName,isDraft,publishedAt,assets \
  -q '{tagName, isDraft, publishedAt, assetCount: (.assets|length)}'

# `latest` URL serves the new .deb (HTTP 200):
curl -sIL "https://github.com/stevenvo780/ultimate-terminal/releases/latest/download/ultimate-terminal-worker_<version>_ubuntu22.04_amd64_x86_64.deb" \
  | grep -E '^HTTP|content-length' | tail -2
```

---

## What the universal installer does with a release

`packaging/universal_install.sh` runs on each worker host. Relevant env vars:

| Variable | Default | Effect |
|---|---|---|
| `RELEASE_BASE_URL` | `https://github.com/stevenvo780/ultimate-terminal/releases/latest/download` | Where to fetch the `.deb`. Override to test a specific tag (e.g. `…/download/worker-v1.0.0`). |
| `PREFER_BINARY` | `1` | Set to `0` to force source build (skips the `.deb` download). |
| `WORKER_REPO_OWNER` / `WORKER_REPO_NAME` / `WORKER_REPO_URL` / `WORKER_REPO_REF` | `stevenvo780` / `ultimate-terminal` / derived / `main` | Used by the source-build fallback (`git clone`). |

The installer maps the host's `ID` + `VERSION_ID` from `/etc/os-release` to one
of the 3 published Ubuntu builds (Debian / Kali / Mint / Pop are mapped to the
closest Ubuntu LTS). On any of:
- 404 from the chosen `.deb`
- `dpkg -i` failure
- post-install smoke-test failure (GLIBC mismatch)
- distro not in the supported map (Fedora / RHEL / Arch)

…it cleanly removes the half-installed package (`dpkg -r`) and falls back to
the source build path (clone repo, `npm install` at the workspace root, `tsc`,
copy artifacts to `/opt/ultimate-terminal-worker`, register service).

---

## Adding a new target distro

To publish a `.deb` for a new Ubuntu version (e.g. `26.04`):

1. Add it to the workflow matrix in `.github/workflows/release-worker.yml`:
   ```yaml
   matrix:
     ubuntu: ['20.04', '22.04', '24.04', '26.04']
   ```
2. Add the same version to the OS-version → `.deb` mapping in
   `packaging/universal_install.sh` (look for the `case "$VERSION_ID"` block).
3. Push to `main`, then cut a new tag.

For non-Debian families (Fedora / RHEL / Arch), source build remains the only
path — adding a `.rpm` matrix would require building inside the matching
distro container and is not currently part of the release pipeline.
