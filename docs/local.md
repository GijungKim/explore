# Local-first fork

This fork of [expo/explore](https://github.com/expo/explore) keeps Explore's
principles — a screenshot of every screen, connected by the taps between them,
with a before/after visual review of the screens a change touches — and moves
every step that upstream runs on paid Expo Services onto your own machine.

Upstream remains the default-off escape hatch, not the default path.

## What runs where

| Step | Upstream default | This fork |
| --- | --- | --- |
| Native build | Expo Build (`eas build`) | `eas build --local` on this machine |
| Build reuse lookup | `eas build:list` by fingerprint | No lookup; each commit builds locally |
| Bundle environment | `eas env:pull` from Expo Services | The profile's `env` in `eas.json` |
| Repack download | `eas build:download` | The local build artifact is repacked in place |
| Route-observer repack | Hosted Expo Workflows job | `repack-app` on this machine |
| Simulator | Expo Simulators session | A simulator/emulator this machine creates and deletes |
| Report | Expo Hosting link (`--upload`) | The local Viewer; hosting stays opt-in |
| CI review | GitHub Actions + Expo Simulators | `expo-explore capture` on your Mac |

Deterministic mode needs no model and no API key in either version. Agent mode
on this machine uses your local Claude Code or Codex login, as upstream does.

## Quick start

Requirements: Node.js 24.12+, Xcode 26+ for iOS (or the Android SDK with
`ANDROID_HOME` for Android), and the app's dependencies installed. No Expo
account, `EXPO_TOKEN`, or repository secrets are needed for a local capture.

```sh
# In your app's repository, with this fork installed (npm link / a git install):
npx @expo/explore setup          # writes .expo-explore/config.yaml (local defaults)
npx @expo/explore doctor         # checks this Mac, the profile, and the routes
npx @expo/explore capture        # reviews HEAD (+ uncommitted changes) against the base
```

`setup` already writes the fork defaults; a config written by upstream works
unchanged and is read as local unless it explicitly chose `eas`.

## Choosing a cloud piece back

Each seam is a config choice (or the matching `--build` / `--simulator` /
`--repack` flag for one run):

```yaml
capture:
  build: local      # eas build --local (default with a local simulator)
  simulator: local  # a device this machine creates (default)
  repack: local     # repack-app here (default with a local simulator)
```

Set any of them to `eas` to use the upstream Expo Services path for that step;
a capture that uses any `eas` piece again requires `EXPO_TOKEN` (or your
`eas login`) exactly as upstream does. Hosted previews (`report.preview`) and
`--upload` are unchanged and remain opt-in Expo Hosting features.

## Notes and limits

- `eas build --local` is eas-cli running the build on your machine; it does
  not consume Expo Build quota. eas-cli itself may still ask for a free
  `eas login` for project configuration on some setups — no paid plan is
  involved, and a fully local capture never uploads the app or its build.
- A local review builds each side it captures (no cloud build cache), so the
  first review of a native change takes as long as a local build takes.
  Local native builds have a 90-minute allowance for a first source build;
  the screenshot capture budget starts after installation.
- iOS archives containing a Watch companion are supported: capture selects
  the application matching the configured bundle ID.
- The generated GitHub workflows under `templates/` are upstream's CI path
  (Expo Simulators on hosted runners). They are kept for compatibility; this
  fork's supported review path is the local `capture` above, and `doctor`
  does not require the workflows or any repository secret for a local setup.
- Android local capture needs the SDK build-tools and a JDK 17 for repacking,
  as upstream's local repack always did; `doctor` checks for them.

## Staying in sync with upstream

This fork's `origin` is the fork and `upstream` is `expo/explore`:

```sh
git fetch upstream
git rebase upstream/main   # the local-first changes live on the fork branch
```

The local-first change is intentionally small and concentrated: the config
defaults and resolvers (`src/config/explore-config.ts`), the local build and
repack seam (`src/capture/run.ts`, `src/capture/eas-build.ts`), the token
gates (`src/ci/pipeline.ts`, `src/ci/local-review.ts`), and `doctor`'s
local-only branch (`src/ci/doctor.ts`).
