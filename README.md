# Universal AI — study help that keeps working on slow internet

Universal AI is a free study helper for students in places with patchy mobile data.
It uses **Firebase AI Logic hybrid inference**:

- **On-device AI (Gemini Nano in Chrome)** — fast, private, works offline.
- **Cloud AI (Gemini)** — best quality when the internet is good.

## What makes it different: network-aware routing
Most hybrid apps only switch to on-device when the internet is *completely gone*.
In India the usual problem is *slow* 2G/3G. Universal AI reads the connection quality
(`navigator.connection.effectiveType`) and routes every request:

| Network | Routing | Why |
|---|---|---|
| 4G / Wi-Fi | Prefer cloud | Best answers |
| 3G / 2G / data saver | Prefer on-device | No 30-second waits |
| Offline | On-device | Still works |

Every answer shows a badge: **⚡ On-device** or **☁️ Cloud**, the time taken, and the network.

Features: Ask a doubt · Explain simply · Summarize notes · Quiz me.

## Tech
- Firebase AI Logic Web SDK (`firebase/ai`) with `InferenceMode` + `inferenceSource`
- Firebase App Check (reCAPTCHA v3; debug token on localhost)
- Vite, plain JavaScript

## Run it locally
Requirements: Node.js 20+, Chrome (desktop).

**Quick start (no install needed):** the built app is in `dist/`.
```bash
node serve.js
```
Then open http://localhost:5173 in **Chrome** (on Windows you can just double-click `run.bat`).

**Develop / rebuild from source:**
```bash
npm install
npm run dev      # live dev server
npm run build    # writes dist/
```

### App Check
App Check uses reCAPTCHA Enterprise (Google Cloud Fraud Defense). The site key in `src/firebase.js`
is public by design and is limited to `localhost` and the Firebase Hosting domains.
For debugging you can open the app with `?appcheckdebug` to use a debug token instead.

### On-device model
Gemini Nano needs Chrome on Windows/macOS/Linux with 22 GB free disk and either a GPU with more than
4 GB VRAM or 16 GB RAM. Click **Download offline AI** once. On devices that can't run it, the app uses
the cloud automatically.

## License
MIT — see [LICENSE](LICENSE).
