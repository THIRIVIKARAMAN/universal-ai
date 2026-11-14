// Speech in and out using the browser's built-in speech features.

const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
export const canListen = Boolean(SR);
export const canSpeak = "speechSynthesis" in self;

let rec = null;

/**
 * Start listening. onText(text, isFinal) is called as words arrive.
 * Returns a stop() function. Rejects with a readable message.
 */
export async function listen({ lang = "en-IN", onText, onEnd, onError }) {
  if (!SR) throw new Error("Voice input isn't supported in this browser. Try Chrome.");
  stopListening();
  rec = new SR();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;

  // Newer Chrome can recognise speech on the device itself, which works offline.
  if (!navigator.onLine) {
    if ("processLocally" in rec && typeof SR.available === "function") {
      const state = await SR.available({ langs: [lang], processLocally: true }).catch(() => "unavailable");
      if (state === "available") rec.processLocally = true;
      else if ((state === "downloadable" || state === "downloading") && typeof SR.install === "function") {
        throw new Error("Offline voice isn't downloaded yet. Connect to Wi-Fi once and tap the mic so Chrome can get it.");
      } else {
        throw new Error("Voice input needs internet on this device. You can still type your question.");
      }
    } else {
      throw new Error("Voice input needs internet in this browser. You can still type your question.");
    }
  } else if ("processLocally" in rec && typeof SR.install === "function") {
    // While online, quietly fetch the offline voice pack for later, if Chrome offers it.
    SR.available?.({ langs: [lang], processLocally: true })
      .then((s) => { if (s === "downloadable") SR.install({ langs: [lang], processLocally: true }).catch(() => {}); })
      .catch(() => {});
  }

  rec.onresult = (e) => {
    let text = "";
    let final = false;
    for (const r of e.results) { text += r[0].transcript; final = r.isFinal; }
    onText?.(text, final);
  };
  rec.onerror = (e) => {
    const map = {
      "not-allowed": "Microphone permission was blocked. Allow the mic in the address bar and try again.",
      "no-speech": "I didn't hear anything. Tap the mic and speak again.",
      network: "Voice input needs internet right now. You can type instead.",
    };
    onError?.(map[e.error] || `Voice input stopped (${e.error}).`);
  };
  rec.onend = () => { rec = null; onEnd?.(); };
  rec.start();
  return stopListening;
}

export function stopListening() {
  try { rec?.stop(); } catch {}
  rec = null;
}

// Read text aloud. Picks a Hindi voice for Devanagari text, otherwise Indian English if available.
export function speak(text, onEnd) {
  if (!canSpeak) return false;
  speechSynthesis.cancel();
  const clean = text.replace(/\*\*/g, "").replace(/^\s*[-*•]\s+/gm, "");
  const u = new SpeechSynthesisUtterance(clean);
  const hindi = /[ऀ-ॿ]/.test(clean);
  const voices = speechSynthesis.getVoices();
  const want = hindi ? ["hi-IN"] : ["en-IN", "en-GB", "en-US"];
  u.voice = want.map((l) => voices.find((v) => v.lang === l)).find(Boolean) || null;
  u.lang = hindi ? "hi-IN" : "en-IN";
  u.rate = 1;
  u.onend = () => onEnd?.();
  speechSynthesis.speak(u);
  return true;
}

export function stopSpeaking() {
  if (canSpeak) speechSynthesis.cancel();
}
