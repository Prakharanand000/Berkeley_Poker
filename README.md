# Berkeley Poker

A 10-seat no-limit Texas hold'em table for a group of friends. Everyone opens the same link, picks who they are from the "Who are you?" screen, and plays from their own phone or laptop. Seats nobody picks are played by bots, and the table trash-talks in Hinglish the whole time (Tolendi sticks to English).

Players: Prakhar, Vedant, Tanmay, Saurav, Niti, Vaishali, Vedika, Jasjyot, Amal, Tolendi.

## Play

| Where | What you get |
| --- | --- |
| Your Render deploy (see below), e.g. `https://berkeley-poker.onrender.com` | Live multiplayer: up to 10 people on their own devices |
| GitHub Pages: `https://prakharanand000.github.io/Berkeley_Poker/` | Solo demo: you against 9 bots (Pages has no server, so no multiplayer) |
| `http://localhost:3000` after `npm start` | Multiplayer on your machine; friends on the same Wi-Fi join at `http://<your-ip>:3000` |

Want a separate game? Add `?table=friday` (any name) to the link. Each table keeps its own seats and chips.

## Run it locally

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Deploy for multiplayer (Render, free)

1. Push this folder to GitHub.
2. Go to https://render.com/deploy?repo=https://github.com/Prakharanand000/Berkeley_Poker and sign in with GitHub. Render reads `render.yaml` and creates a free Node web service.
3. When the deploy finishes, share the `onrender.com` link with your friends.

Things to know about Render's free plan:

- The server sleeps after 15 minutes with nobody connected. The first visit after that takes about a minute to wake it up.
- Chip counts live in the server's memory, so they reset when it sleeps or redeploys.

Any other Node 18+ host that supports WebSockets works the same way (Railway, Fly.io, a small VPS): install, then `npm start`. Static hosts such as GitHub Pages or Netlify only run the solo mode.

## Turn on the GitHub Pages demo

Repository Settings → Pages → Build and deployment → Source: "Deploy from a branch", Branch: `main`, folder `/ (root)` → Save. The demo appears at `https://prakharanand000.github.io/Berkeley_Poker/` a minute later.

## How it works

- `index.html` is the whole game: table UI, hand evaluator, side pots, bots with their own playing styles, and the banter.
- `claude-shim.js` gives the game the same shared-state interface it uses when it runs as a Claude artifact (`db`, `room`, `user`), backed by this project's WebSocket server. With no server it reports that multiplayer is unavailable, and the game falls back to solo mode.
- `server.js` serves the page, relays presence and events between browsers, stores each table's state, and hands the "host" lease to one browser.
- The first browser to open a table becomes the host: it shuffles, deals, runs the bots and settles pots. If the host closes the page, another player's browser takes over within about 15 seconds, and the hand in progress is cancelled with bets returned.
- Each player's hole cards are encrypted for that player only (ECDH + AES-GCM in the browser), so other players can't read them from network traffic. The host's browser does know every card, so the host is on the honour system.
- A player who disconnects for 30 seconds is replaced by a bot until they pick their name again. Anyone who hits zero chips rebuys for 1,000 automatically.

## Controls

- Keyboard: `F` fold, `C` check or call, `R` raise.
- Gaali mode (top right) censors the swearing on your screen only.
- The host also sees Speed (bots think twice as fast) and Reset chips.
