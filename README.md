# Orbit

Orbit is a real-time world chat with guest access, registered accounts, open rooms, invite-only parties, reactions, shared music, browser voice, and followed rooms saved in each browser.

## Run

Use Node.js 20 or newer. From this folder, run:

```sh
npm run start:cloud
```

Then open `http://localhost:3001`. The command starts the page, API, events, and voice relay together, and confirms the health endpoint is ready. For a foreground server, use `npm start`.

There are no third-party runtime packages. `data/orbit.json` is created as people use chat. Keep that folder on persistent storage to retain accounts, rooms, parties, messages, and shared music. The header starts at 1,428 registered members toward the 1,500 community goal; live presence is counted separately.

The Now Playing room has four computer-generated originals: retro pop, synthwave, dream pop, and ambient pop. Run `npm run music:generate` to recreate the bundled tracks. Shared audio supports YouTube, SoundCloud, and direct audio links.

Voice needs microphone permission and a secure context (HTTPS or localhost). It uses a room-scoped WebSocket audio relay on the same server as chat, so it does not depend on public STUN or TURN servers. For public use, run it behind HTTPS as a long-lived Node service with persistent storage. Static hosting alone cannot run the chat API or voice relay.

## Deploy the website on Vercel

Import `https://github.com/TurboTwitch0/TurboChat` in Vercel. The included `vercel.json` builds the static site into `dist` and forwards `/api/*` requests to the existing Orbit service on Netlify. No extra Vercel environment variables are required for this setup.

The frontend can be hosted on Vercel this way, while chat storage and voice signaling continue to run through the Netlify deployment. To move the backend completely to Vercel, the server API and persistent storage need a Vercel-compatible backend deployment.
