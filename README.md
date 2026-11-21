# PuTtAppu — backend-enabled starter

This project includes a mobile-first web client and a Node.js backend with SQLite persistence, profile/avatar endpoints, Socket.IO live presence, room invite URLs and WebRTC signaling.

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set `PUBLIC_URL` to your local or deployed URL.
3. In this folder run:

   ```bash
   npm install
   npm start
   ```
4. Open `http://localhost:3000` in a browser. For microphone access on phones, deploy behind HTTPS (or use localhost on the same device).

## Deploy

Deploy this folder to a Node.js host that supports persistent disk storage and WebSocket connections. Set `PUBLIC_URL` to the final HTTPS domain and `NODE_ENV=production`. Keep `data/` and `uploads/` on persistent storage. Configure HTTPS at the host or reverse proxy. Do not expose the SQLite file publicly.

## What's implemented

- Profiles stored in SQLite; unique handles; avatar upload (3 MB max).
- Room creation records, invite links, room joining.
- Real-time participant presence with profile picture, display name, role, listener count and speaker count.
- Socket.IO signaling relay for browser WebRTC peer connections.
- Device-local audio/video file picker and player; selected media is not uploaded.
- Microphone capture with browser echo cancellation, noise suppression and auto gain control constraints.

## Important limitations before public launch

- **This is a runnable starter, not a production-certified service.** It has not been load-tested or security-audited.
- WebRTC media is peer-to-peer mesh. This is suitable only for small test rooms; for larger rooms, replace mesh media with an SFU such as LiveKit, mediasoup or Janus. A TURN server is also needed for reliable connectivity across restrictive mobile networks. The included public STUN servers alone do not guarantee connection.
- Profiles currently have no password/OTP authentication. Anyone with a user ID in browser storage can act as that profile. Add verified authentication, authorization, rate limiting, abuse reporting and moderation before public use.
- Room presence is in server memory, so it resets on server restart and does not work across multiple server instances without a shared adapter/store. SQLite room records persist.
- Listener count means connected sockets in the room, not a verified count of people watching a screen.
- App invite link points to the deployed site. Room invite link is generated per room. The server must be deployed at a stable HTTPS URL for links and microphone access to work reliably.
- Audio quality depends on device, browser, network and codec negotiation. Browser audio constraints are requests, not guarantees. No recording is performed.

## API overview

- `GET /api/health`
- `POST /api/users` — create/update profile (`name`, `handle`, optional `bio`, optional `id`)
- `GET /api/users/:id`
- `POST /api/users/:id/avatar` — multipart field `avatar`
- `GET /api/rooms`

Socket events include `profile:set`, `room:create`, `room:join`, `room:role`, `room:presence`, `room:leave`, `rtc:offer`, `rtc:answer`, and `rtc:ice`.
