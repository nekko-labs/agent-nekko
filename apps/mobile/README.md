# Agent Nekko, Mobile (iOS & Android)

Native phone apps built with **Capacitor**. They run the same React UI as the
desktop/web editions and connect to the model on your computer over the
**end-to-end encrypted relay**: your phone never holds your model or keys; it
drives the agent running on your machine.

> This is the "drive your local model from your phone" edition. The UI is the
> shared renderer; only the transport (relay) and a pairing screen differ.

## How pairing works

1. On your **computer**: Agent Nekko → *Settings → Remote access → Enable*. It shows
   a room code, key, a pairing link, and a QR.
2. In the **phone app**: **Scan QR code** (camera) or paste the pairing link on the
   first-run screen. The creds are stored locally and the app connects to your
   computer through the relay.

## Notifications

When a task you started finishes while the app is backgrounded, you get a **local
notification** ("Agent Nekko finished"), no push server, no APNs/FCM setup needed
(uses `@capacitor/local-notifications`). True remote/background push (when the app
is fully closed) would need APNs + FCM + a sender backend, not wired yet.

## Permissions (native projects)

After `cap add`, add these to the generated native projects:

- **iOS**: in `ios/App/App/Info.plist`:
  - `NSCameraUsageDescription` = "Scan the pairing QR code from your computer." (QR scan)
- **Android**: `cap add android` already declares camera/notification permissions
  for the plugins; the QR scanner requests camera at runtime.

## Build & run

Prereqs: **iOS** needs macOS + Xcode + CocoaPods; **Android** needs Android Studio + SDK.

```bash
# 1. Build the shared web UI (from the repo root)
npm run build -w @agent-nekko/desktop

# 2. Install + sync the web assets into this Capacitor project
cd apps/mobile
npm install
npm run sync-web          # copies ../desktop/out/renderer → ./www

# 3. Add the native platforms (first time only)
npx cap add ios           # macOS only
npx cap add android

# 4. Open in the native IDE to run on a simulator/device
npx cap open ios          # Xcode
npx cap open android      # Android Studio
```

After changing the web UI, re-run `npm run sync-web && npx cap sync`.

`appId` is `dev.nekkolabs.agentnekko`, matching the desktop bundle id.

## Next steps (tracked)

- Native **secure storage** (`@capacitor/preferences` is installed) for the relay key.
- **Remote push** (APNs + FCM + sender) for notifications when the app is closed.
- App Store / Play Store metadata + signing (needs the developer accounts).
