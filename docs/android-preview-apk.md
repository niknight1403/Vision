# Android production APK

This document describes the reproducible Android preview build for the
AutonomAgent mobile app, what evidence it produces, and what still has to be
confirmed on a physical device before any pre-release is published.

## Guardrails

The preview APK is a research artifact. It must never be able to trade, buy or
publish:

- `apps/mobile/app.json` keeps the autonomous runtime configuration and
  `extra.liveTradingEnabled: false`.
- CI runs the repository typecheck, unit tests and dependency audit before the
  APK workflow. The API remains fail-closed when no real provider is configured.
- The APK contains the autonomous dashboard, but no server credentials. Product
  data and analysis arrive only through the authenticated API.
- No secret is passed to the mobile build. `EXPO_PUBLIC_API_URL` is optional,
  must be `https://`, and is rejected if it looks like a credential.

## How to build

The build runs on GitHub Actions, not on a developer machine, because a native
release build needs the Android SDK, NDK and CMake:

1. Actions -> **Android production APK** -> *Run workflow*.
2. Optional inputs:
   - `api_url`: backend origin baked into the bundle as `EXPO_PUBLIC_API_URL`.
     Leave empty for an app that starts without a backend.
   - `architectures`: `arm64-v8a` (default, fastest) or a wider ABI set.
3. The job runs `npm ci` (lockfile only), `expo prebuild
   --platform android`, and `./gradlew :app:assembleRelease`.

The run takes roughly 15-25 minutes on a cold Gradle cache.

## Artifact and evidence

Each run uploads the artifact `autonomagent-paper-preview-<commit>` containing:

- `app-release.apk` — installable release build, signed with the debug keystore
  that the generated project uses for preview releases. It is not a Play Store
  signing key.
- `build-info.json` — package id, version name/code, SHA-256, size, bundle
  path, baked-in API URL, commit and ABIs.

The job summary additionally shows `apksigner verify --print-certs` output and
the same fields as a table. Copy the SHA-256 from there when reporting a release.

Local equivalent, for someone with an Android SDK installed:

```bash
npm ci
cd apps/mobile
npm run typecheck
npm run prebuild:android
cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

## Verified builds

| Field | Preview build 2026-11-17 |
| --- | --- |
| Workflow run | [44068390911](https://github.com/niknight1403/Vision/actions/runs/44068390911) (success) |
| Commit | `b331f35df3a14df9f9e6b2eb326b9510007174e6` |
| Artifact | `autonomagent-paper-preview-b331f35df3a1` (retained 30 days) |
| Package / version | `com.autonomagent.trader` / `0.3.0` (code 3) |
| ABIs | `arm64-v8a` |
| Size | 20 580 305 bytes |
| SHA-256 | `748c5535f6f36bae92ef9be6e96a169300601fb2160a3cf877d10b65fe447d40` |
| Signature | APK Signature Scheme v2, certificate `CN=Android Debug` |
| Build checks | AUTONOMOUS runtime configuration present |
| Baked-in API URL | none |

The downloaded artifact was re-verified outside CI: the APK hash matches
`build-info.json`, the ZIP is intact (597 entries), `AndroidManifest.xml` declares
`com.autonomagent.trader`, versionName `0.3.0` and `android.permission.INTERNET`,
and the bundle inside the APK still carries the marker.

Device verification for this build is still open, so no GitHub pre-release exists
yet.

## Device verification (still manual)

The build proves that the artifact is well formed and provider-backed autonomous; it cannot
prove that it installs and starts. The remaining acceptance step:

1. Download the artifact, compare `sha256sum app-release.apk` with
   `build-info.json`.
2. Install with `adb install -r app-release.apk`, or copy the file to the device
   and allow installation from that source.
3. Start the app and confirm:
   - it reaches the dashboard without crashing,
   - the banner "AUTONOMER BETRIEB · ECHTE PROVIDER-DATEN" is visible,
   - no live/testnet switch exists,
   - with an empty `api_url` the app shows the explicit "API-URL nicht gesetzt"
     notice instead of silently pretending to have data.
4. Record device model, Android version, date and the SHA-256 in the release
   issue.

## Release gate

Only after the device check above:

- create the GitHub pre-release and attach the matching APK,
- document CI run, artifact SHA-256, device evidence and the migration/health
  status (see [release-gates.md](release-gates.md)),
- never publish a production AAB from this path. `apps/mobile/eas.json` keeps
  the `production` profile for a real signed store build, which needs an Expo
  account, `EXPO_TOKEN` and EAS credentials as repository secrets.

## Why not EAS

`eas build` would require an Expo project id, an authenticated Expo account and
an EAS keystore. None of that exists for this repository, and the acceptance
criteria allow a documented, reproducible CI build instead. The workflow stays
inside GitHub Actions so the artifact, the evidence file and the source commit
are provably tied together.
