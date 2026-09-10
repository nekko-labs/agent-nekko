# Phone remote control

Drive the Kotrain running on your computer from your phone: start and manage chats, watch and steer
training runs and goals, approve risky commands, and get a push when a long run finishes. Inference
and tools always execute on **your** machine, under its guardrails; the phone is a thin client.

## How it works

```
[ Phone ]  --TLS-->  [ relay ]  <--outbound WSS--  [ your computer (agent) ]
```

- Your computer **dials out** to a relay and claims a room. No inbound ports, no port-forwarding.
- Your phone connects to the same relay with the pairing credentials.
- Every payload is **end-to-end encrypted** (AES-GCM, key derived from the pairing secret). The
  relay routes ciphertext; it cannot read prompts, replies, files, or model output.
- On top of the encrypted transport, every device must pass a **handshake against your computer's
  device registry**: new devices enroll only through a **single-use pairing code that expires in
  10 minutes**, and your computer answers each device individually (never broadcast).

## Pairing a phone

1. On your computer: **Settings → Remote access → Enable** (the managed relay is prefilled; or
   paste your self-hosted relay URL), then **Pair a device**.
2. On your phone: scan the QR with the Kotrain app, or open the pairing link in a browser.
3. The phone shows up under **Paired devices**, with a live connection dot.

Manage devices from the same card: **rename** them, **revoke** one instantly (it's kicked live and
denied from then on), or **Rotate secret** to cryptographically reset the room, which unpairs
everything at once.

Remote access survives restarts: if it was enabled, the agent reconnects when Kotrain starts.

## Security model, honestly stated

| Threat | Defense |
|---|---|
| Relay operator reads your traffic | Impossible by construction: E2E encryption, relay sees ciphertext only |
| Stranger connects to your room | Needs the pairing secret (128-bit) for transport auth, then a registered device or a live pairing code |
| Leaked/stale pairing link | The one-time code is single-use and expires in 10 min; the link is scrubbed from the phone's URL/history after pairing |
| Lost/stolen phone | Revoke it in Settings: kicked immediately, denied afterward, push token dropped |
| Revoked device replays old creds | The agent refuses its handshake and unicasts nothing to it; rotate the secret for a full cryptographic reset |
| Malicious relay withholding/reordering | Availability only; it still can't read or forge frames (AES-GCM auth) |
| Phone asks for something dangerous | Tool calls run on your machine under your guardrails/sandbox and chat mode (Ask/Guardrails/YOLO) |

What the relay does see: connection metadata (IPs, timing, frame sizes), the room code, and, if you
enable push, device push tokens plus the content-free fact "a run finished". That's the whole list,
and it's why relayed local-model use is inherently zero-data-retention for content.

## Choosing a relay

### Managed relay (default): `wss://kotrain-relay.fly.dev`

Zero setup; free during beta with per-connection rate limits. When Kotrain Cloud launches, the
managed relay becomes part of the paid plans (it already supports gating via
`KOTRAIN_RELAY_AUTHZ_URL`), while self-hosting stays free forever.

### Self-host (free forever, one command)

The relay is a tiny stateless Node service; anything that runs a container can host it.

**Docker**

```bash
docker run -d --name kotrain-relay -p 4400:4400 --restart unless-stopped \
  -e KOTRAIN_RELAY_ALLOW_UNAUTHENTICATED=1 \
  ghcr.io/nekko-labs/kotrain-relay:latest
```

**Docker Compose**

```yaml
services:
  kotrain-relay:
    image: ghcr.io/nekko-labs/kotrain-relay:latest
    ports: ["4400:4400"]
    environment:
      KOTRAIN_RELAY_ALLOW_UNAUTHENTICATED: "1"
    restart: unless-stopped
```

**Coolify** (recommended if you already run one): add a new service → Docker image
`ghcr.io/nekko-labs/kotrain-relay:latest`, expose port 4400, attach a domain, and let Coolify's
proxy terminate TLS. Point Kotrain at `wss://relay.your-domain.com`.

**Fly.io**: `fly deploy -c apps/relay/fly.toml` from a repo checkout. Keep it at **one machine**
(`fly scale count 1`): rooms live in a machine's memory, so agent and phone must land on the same
instance.

Put any self-hosted relay behind TLS (`wss://`) for internet use; the E2E layer protects content
regardless, but TLS also protects the transport-auth query string. Then paste the URL into
**Settings → Remote access** before enabling.

Environment knobs:

| Env | Meaning |
|---|---|
| `KOTRAIN_RELAY_PORT` / `KOTRAIN_RELAY_HOST` | Bind (default `0.0.0.0:4400`) |
| `APNS_KEY_P8` / `APNS_KEY_ID` / `APNS_TEAM_ID` | Enable iOS push |
| `FCM_SERVICE_ACCOUNT` | Enable Android push (service-account JSON) |
| `KOTRAIN_RELAY_AUTHZ_URL` | Gate agent enrollment on a Kotrain Cloud account (managed hosting) |
| `KOTRAIN_RELAY_ALLOW_UNAUTHENTICATED=1` | Explicitly allow unauthenticated agent enrollment for trusted/private deployments; otherwise agent enrollment is disabled when no authz URL is configured |

The relay validates device IDs as UUIDs and push tokens as non-empty platform
tokens. A connected device cannot replace another connection's push token for
the same device ID. Keep the relay behind TLS (`wss://`) and do not enable the
unauthenticated mode on a public endpoint.

## Headless agents

A machine without a screen (server, homelab box) can expose itself with the relay-agent mode:

```bash
KOTRAIN_RELAY_URL=wss://your-relay KOTRAIN_ROOM=myroom KOTRAIN_PAIR_KEY=<secret> npx agent-nekko
```

It prints a one-time pairing code (10 minutes) at boot and keeps the same persistent device
registry as the desktop app.
