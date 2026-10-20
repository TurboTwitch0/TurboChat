# Netlify deployment

Orbit's page and serverless API are built from this folder. Netlify builds the static files into `dist/` and deploys `netlify/functions/api.mjs`.

1. Use the repository folder containing this file as the Netlify base directory.
2. Set build command to `npm run build` and publish directory to `dist` (already set in `netlify.toml`).
3. Enable Netlify Blobs for the site so accounts, rooms, and messages persist.
4. Verify `/api/health` returns JSON with `"ok":true` and `/api/me` returns JSON.

Chat, typing indicators, presence, accounts, rooms, parties, and music use the serverless API and poll for updates. Netlify voice uses browser WebRTC with function-based signaling. Peers connect directly using STUN; very restrictive networks may also require a TURN relay.
