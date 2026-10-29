# Orbit

TurboChat's Orbit community keeps its existing Vercel frontend and Netlify API. The current interface includes room-specific drafts saved on this device, retry controls for failed messages, mobile conversation search, and keyboard-accessible account dialogs.

The readable interface uses one layout stylesheet, `styles.css`, with a 16px default body/message size, natural wrapping, and normal-flow public room previews. Tablets give the conversation the full available column; compact screens keep room navigation, search and the composer accessible. Dialog headers stay visible while their content scrolls. The optional voice panel opens only when requested. Drafts, message recovery, account/session handling, search and voice keep their existing data and behavior.

The create-space menu works on phones and offers community servers, public rooms and private parties. Profile privacy controls can remove an unused account only after password confirmation. A new private party can be removed only by its registered owner when it has no other members or their messages; legacy and shared spaces are protected. Account deletion is refused while messages or server/private-party memberships remain. Local deletion markers are kept in `data/deletions.json`, so retain the whole data directory when backing up the app.

The static build writes content-hashed CSS/JavaScript filenames into its HTML and records their SHA-256 values in `asset-manifest.json`. This keeps the page and assets matched on ordinary loads without clearing browser data. Unhashed script/style URLs and empty legacy `brand.css`/`showcase.css` compatibility files remain available for older pages. No service worker is installed by the app.

## Run

Use Node.js 20 or newer. From this folder, run:

```sh
npm run start:cloud
```

Then open `http://localhost:3001`. The command starts the page, API, events, and voice relay together, and confirms the health endpoint is ready. For a foreground server, use `npm start`.

Run `npm ci`, `npm test`, and `npm run build` before publishing. Tests use isolated local data and in-memory hosted storage, and never create production accounts or send production messages. They cover sign-in errors, session persistence, expiry and logout revocation, private room access, room-switching races, drafts, failed sends, and IME input. Sessions last up to 30 days and local sessions survive server restarts; passwords are stored as salted hashes.

The standalone Node server uses built-in modules; the hosted Netlify API uses `@netlify/blobs`. `data/orbit.json` is created as people use local chat. Keep that folder on persistent storage to retain accounts, rooms, parties, messages, and shared music. The header starts at a configured baseline of 1,428 registered members toward the 1,500 community goal; live presence is counted separately. This starting count is not marketing evidence of verified active users.

The Now Playing room has four computer-generated originals: retro pop, synthwave, dream pop, and ambient pop. Run `npm run music:generate` to recreate the bundled tracks. Shared audio supports YouTube, SoundCloud, and direct audio links.

Voice needs microphone permission and a secure context (HTTPS or localhost). The local Node server uses a room-scoped WebSocket audio relay. The hosted Netlify/Vercel app uses browser WebRTC with STUN and serverless signaling; restrictive networks may require a TURN relay. For public use, run it behind HTTPS as a long-lived Node service with persistent storage. Static hosting alone cannot run the chat API or voice relay.

## Deploy the website on Vercel

Import `https://github.com/TurboTwitch0/TurboChat` in Vercel. The included `vercel.json` builds the static site into `dist` and forwards `/api/*` requests to the existing Orbit service on Netlify. No extra Vercel environment variables are required for this setup.

The frontend can be hosted on Vercel this way, while chat storage and voice signaling continue to run through the Netlify deployment. To move the backend completely to Vercel, the server API and persistent storage need a Vercel-compatible backend deployment.
