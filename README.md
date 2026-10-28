# Orbit

TurboChat's Orbit community keeps its existing Vercel frontend and Netlify API. The current interface includes room-specific drafts saved on this device, retry controls for failed messages, mobile conversation search, and keyboard-accessible account dialogs.

The product design uses the original TurboChat speech/orbit mark in `assets/`, warm ink, lilac and mint, with Manrope headings and DM Sans body text. `brand.css` carries this system through the discovery home, real room navigation, chat, accounts, loading, reconnect, empty and mobile states. The home screen links directly to existing conversations and search. Voice motion starts only in an active unmuted session; motion and scrolling respect reduced-motion preferences. Draft copy distinguishes device persistence from tab-only storage when browser storage is blocked. The published social preview is included in `assets/`; editable launch artwork is maintained with the release deliverables.

`showcase.css` adds a dimensional public-room stage to discovery. Five public room previews use native CSS lighting and perspective, with explicit previous/next and room-choice buttons. Arrow keys, Home and End work only on those choices; selection never opens a room until its Open button is activated. There is no autoplay or pointer tracking. Private rooms, people and message content never appear in this stage. Reduced-motion mode keeps the composition static. Daily chat, drafts, search, accounts and voice retain their existing controls.

Orbit is a real-time world chat with guest access, registered accounts, open rooms, invite-only parties, reactions, shared music, browser voice, and followed rooms saved in each browser.

## Run

Use Node.js 20 or newer. From this folder, run:

```sh
npm run start:cloud
```

Then open `http://localhost:3001`. The command starts the page, API, events, and voice relay together, and confirms the health endpoint is ready. For a foreground server, use `npm start`.

Run `npm ci`, `npm test`, and `npm run build` before publishing. Tests use isolated local data and in-memory hosted storage, and never create production accounts or send production messages. They cover sign-in errors, session persistence, expiry and logout revocation, private room access, room-switching races, drafts, failed sends, and IME input. Sessions last up to 30 days and local sessions survive server restarts; passwords are stored as salted hashes.

The standalone Node server uses built-in modules; the hosted Netlify API uses `@netlify/blobs`. `data/orbit.json` is created as people use local chat. Keep that folder on persistent storage to retain accounts, rooms, parties, messages, and shared music. The header starts at a configured baseline of 1,428 registered members toward the 1,500 community goal; live presence is counted separately. This starting count is not marketing evidence of verified active users.

The Now Playing room has four computer-generated originals: retro pop, synthwave, dream pop, and ambient pop. Run `npm run music:generate` to recreate the bundled tracks. Shared audio supports YouTube, SoundCloud, and direct audio links.

Voice needs microphone permission and a secure context (HTTPS or localhost). It uses a room-scoped WebSocket audio relay on the same server as chat, so it does not depend on public STUN or TURN servers. For public use, run it behind HTTPS as a long-lived Node service with persistent storage. Static hosting alone cannot run the chat API or voice relay.

## Deploy the website on Vercel

Import `https://github.com/TurboTwitch0/TurboChat` in Vercel. The included `vercel.json` builds the static site into `dist` and forwards `/api/*` requests to the existing Orbit service on Netlify. No extra Vercel environment variables are required for this setup.

The frontend can be hosted on Vercel this way, while chat storage and voice signaling continue to run through the Netlify deployment. To move the backend completely to Vercel, the server API and persistent storage need a Vercel-compatible backend deployment.
