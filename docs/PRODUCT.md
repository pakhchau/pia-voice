# AI Radio Companion — Product Concept

**Created:** 2026-02-15
**Author:** Pak Hou Chau
**Status:** Concept / Ideation

---

## Vision

A **24/7 personal AI radio** — an always-on audio companion that blends conversation, music, news, and productivity into a single stream. Think of it as your personal radio station, but the DJ is an AI that knows you, works for you, and plays what you love.

## Core Experience

You open the app (or tune in via browser). What you hear:

1. **Music** — Your Spotify playing songs the AI knows you like
2. **AI conversation** — Talk anytime, the AI responds naturally, then music resumes
3. **Background work** — AI runs tasks silently (checking email, monitoring markets, scheduling)
4. **Automated segments** — Periodic news briefings, market updates, weather, calendar reminders — all generated and narrated by AI
5. **Audiobooks/podcasts** — AI can read articles, play audiobooks, or summarize long content

## User Modes

| Mode | What Happens |
|------|-------------|
| **Work Mode** | Light ambient music + AI available for questions + periodic task updates |
| **Drive Mode** | Music-forward + voice-first interaction + calendar/navigation alerts |
| **Focus Mode** | Lo-fi/ambient + minimal interruptions + only critical alerts |
| **Chill Mode** | Music + audiobooks + no work stuff unless asked |
| **Brief Mode** | AI narrates a full situation report: calendar, emails, markets, weather, tasks |

## Interaction Model

- **Always listening** (wake-word optional) — talk anytime, AI responds, then returns to music/content
- **Music ducking** — when AI speaks or user talks, music volume drops automatically, comes back after
- **Interruption priority** — AI knows what's worth interrupting for (urgent email? yes. Newsletter? no.)
- **Context-aware** — AI remembers everything discussed in the session, carries context across segments

## Automated Segments (AI-Programmed Radio)

The AI schedules and generates "radio segments" throughout the day:

| Time | Segment |
|------|---------|
| 8:00 AM | ☀️ Morning Brief — weather, calendar, top 3 priorities |
| 10:00 AM | 📰 News Digest — headlines relevant to your interests |
| 12:00 PM | 📊 Market Update — crypto, stocks, positions |
| 3:00 PM | ✅ Progress Check — tasks completed, what's left |
| 6:00 PM | 🌅 Evening Wrap — day summary, tomorrow preview |
| Custom | 🔔 Alert — urgent email, meeting in 5 min, price alert |

Segments are **TTS-narrated** using the AI's voice, feel natural, not robotic.

## Music Integration

- **Spotify Connect** — AI controls playback via Spotify API
- **Taste learning** — AI observes skips/likes, builds preference model
- **Contextual playlists** — energetic for mornings, chill for evenings, focus for deep work
- **Smooth transitions** — music fades out before AI speaks, fades back in after
- **"Play something like..."** — natural language music requests

## Technical Architecture

```
┌─────────────────────────────────────┐
│         AI Radio Companion          │
│                                     │
│  ┌─────────┐  ┌──────────────────┐  │
│  │ Voice   │  │ Audio Mixer      │  │
│  │ Engine  │  │ (Web Audio API)  │  │
│  │ (11Labs)│  │                  │  │
│  └────┬────┘  │  Music ────┐     │  │
│       │       │  AI Voice ─┤ OUT │  │
│       │       │  Alerts ───┘     │  │
│  ┌────┴────┐  └──────────────────┘  │
│  │ OpenClaw│                        │
│  │ Gateway │  ┌──────────────────┐  │
│  │ (pia)   │  │ Segment Scheduler│  │
│  └────┬────┘  │ (cron-based)     │  │
│       │       └──────────────────┘  │
│  ┌────┴─────────────────────────┐   │
│  │ Integrations                 │   │
│  │ Spotify · Notion · Calendar  │   │
│  │ Email · Markets · WhatsApp   │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Key Components

1. **Audio Mixer** (Web Audio API) — Manages multiple audio streams, handles ducking, crossfades
2. **Voice Engine** (ElevenLabs) — Always-on voice conversation with the AI
3. **OpenClaw Gateway** (pia) — All the tools, memory, integrations
4. **Segment Scheduler** — Cron-based system that triggers AI-generated audio segments
5. **Spotify Integration** — OAuth + Spotify Web API for playback control
6. **Content Pipeline** — Fetches news, market data, emails → AI summarizes → TTS narrates

## What Makes This Different

| Existing Products | AI Radio Companion |
|---|---|
| Spotify — plays music, no intelligence | Music + AI + productivity in one stream |
| Siri/Alexa — responds to commands, then silent | Always-on, continuous experience |
| Podcasts — pre-recorded, no interaction | Live, personalized, interactive |
| ChatGPT Voice — conversation only | Conversation + music + automated content |
| Traditional radio — one-to-many, generic | One-to-one, deeply personal |

## MVP (What We Can Build Now)

With the current voice client + OpenClaw:

1. ✅ Voice conversation with AI (ElevenLabs)
2. ✅ Background tool execution (Tier 1/2/3)
3. ✅ Session memory
4. 🔨 Add: Spotify Web Playback SDK (in-browser player)
5. 🔨 Add: Audio ducking (Web Audio API gain nodes)
6. 🔨 Add: Scheduled segments (server-side cron → TTS → inject into stream)
7. 🔨 Add: News/market data pipeline

## Open Questions

- Wake word vs always-listening? (Battery/privacy tradeoff)
- Native app vs PWA? (Background audio is easier in native)
- Multi-device? (Start on phone, continue on laptop?)
- Sharing? (Can someone else "tune in" to your radio?)
- Monetization? (Personal tool vs product for others?)

---

*"The AI work companion that's always on, always listening, always helpful — like having a brilliant colleague who also happens to be your DJ."*
