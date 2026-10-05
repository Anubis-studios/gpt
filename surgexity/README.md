# Surgexity — AI Search & Answer Engine

Surgexity preserves the supplied search app’s screen structure, search and conversation flows, source citations, focus modes, history, spaces, discovery, settings, and PWA behavior.

## Features

- AI-powered web search with source cards and inline citations
- Related follow-up questions and threaded multi-turn conversations
- Focus modes: Search, Academic, Writing, Videos, and Social
- History and Spaces, including per-space instructions
- Discover page and theme/content settings
- Copy, share, and rewrite message actions
- Installable PWA shell, offline cache, and responsive mobile sidebar

## Project structure

- `index.html` — application layout, styles, metadata, and bootstrap
- `src/app.js` — search, answer generation, markdown, and citations
- `src/history.js` — history and Spaces persistence
- `src/ui.js` — UI state, navigation, rendering, and events
- `src/manifest.json` — Surgexity PWA identity and local icon references
- `src/icons/` — Surgexity app icons
- `src/sw.js` — offline shell and asset caching
- `main.pjs` — host-side plugin imports and app metadata for the supplied Perchance runtime
- `server.js` — lightweight static HTTP server for local/managed Preview

## Run

Use Node.js 22 or later and run `npm start`. The provided `main.pjs` plugin imports remain available for the original Perchance host; its AI generation and CORS-bypassing search helpers are supplied by that host.
