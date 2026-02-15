# AI Radio Companion

24/7 personal AI radio — an always-on audio companion that blends conversation, music, news, and productivity into a single stream.

## What is this?

Your personal radio station where the DJ is an AI that knows you, works for you, and plays what you love.

- 🎵 **Music** — Spotify integration, AI-curated playlists
- 🗣️ **Voice AI** — Talk anytime, AI responds naturally
- 📰 **Automated segments** — News, markets, calendar briefings
- ⚙️ **Background work** — Email, Notion, scheduling — all running silently
- 🚗 **Drive mode** — Optimized for car use

## Stack

- **Voice AI**: ElevenLabs Conversational AI (GPT-5.2 / GPT-4.1)
- **Backend**: OpenClaw Gateway (Clawdbot)
- **Music**: Spotify Web Playback SDK
- **Audio**: Web Audio API (mixing, ducking)
- **Search**: Brave Search + GPT synthesis

## Quick Start

```bash
cp .env.example .env
# Fill in your API keys
cd server && node server.js
# Open http://localhost:18795/call
```

## Architecture

See [docs/PRODUCT.md](docs/PRODUCT.md) for full product spec.

## License

Private — All rights reserved.
