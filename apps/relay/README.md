# Agent Nekko relay

A dumb, end-to-end-encrypted pipe that pairs remote devices (your phone) with a
local agent (your desktop) by room code, so a phone can drive your local model
with no inbound ports. The relay never sees conversation content, only the
routing envelope and content-free control frames.

v2 protocol: each device connection gets a `cid`; the relay tags device→agent
frames (`{type:'c', cid, data}`) and the agent unicasts back (`{type:'d', cid,
data}`), so no device ever receives another's traffic. The agent can `kick` a
cid (revocation). Device auth itself is end-to-end (the HELLO handshake rides
the ciphertext); the relay just enforces the room key, frame-size caps, a
per-connection rate limit, and client/room limits. Full user-facing guide,
including self-hosting (Docker / Compose / Coolify / Fly): [docs/REMOTE.md](../../docs/REMOTE.md).

```bash
npm run build -w @agent-nekko/relay
npm run start -w @agent-nekko/relay      # ws://0.0.0.0:4400/relay

# or the container (build from the repo root)
docker build -f apps/relay/Dockerfile -t agent-nekko-relay .
docker run -p 4400:4400 agent-nekko-relay
```

Env: `NEKKO_RELAY_PORT` (4400), `NEKKO_RELAY_HOST` (0.0.0.0),
`NEKKO_RELAY_AUTHZ_URL` (optional: gate agent enrollment on a Agent Nekko Cloud
account for managed hosting; agents then connect with `&access=<bearer>` and the
relay POSTs it to this URL, expecting `{ok:true}`).

The managed instance lives at `wss://kotrain-relay.fly.dev`
(`fly deploy -c apps/relay/fly.toml --dockerfile apps/relay/Dockerfile .` from
the repo root; keep it at one machine, rooms are in-memory).

## Remote push (optional)

When a desktop finishes a run, it sends a content-free `notify` control frame.
If the paired phone is **offline**, the relay sends it a push notification using
the token the phone registered (`register-push` frame). Configure APNs:

| Env var | What |
| --- | --- |
| `APNS_KEY_P8` | Contents of the APNs auth key `.p8` (PEM, with newlines) |
| `APNS_KEY_ID` | The key's 10-char Key ID |
| `APNS_TEAM_ID` | Apple Team ID |
| `APNS_BUNDLE_ID` | App bundle id (default `dev.nekkolabs.agentnekko`) |
| `APNS_PRODUCTION` | `1` for the production APNs host (default: sandbox) |

**Android (FCM)**: set `FCM_SERVICE_ACCOUNT` to the full service-account JSON
(with `client_email`, `private_key`, `project_id`). The relay mints an OAuth
token (RS256 assertion) and sends via FCM HTTP v1.

Without these the relay runs normally and just logs that push is disabled.

The privacy model holds: the push body is generic ("Your task finished"); the
relay only learns *that* a run completed, never its contents.
