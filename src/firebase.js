// Firebase setup: app, App Check, and Firebase AI Logic (hybrid inference).
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, ResponseModality } from "firebase/ai";

// Your web app's Firebase configuration (safe to be public; App Check protects the API).
const firebaseConfig = {
  apiKey: "AIzaSyDkz8imt5MHC3QIF_yttPd22efiB8wqLHA",
  authDomain: "universal-5658e.firebaseapp.com",
  projectId: "universal-5658e",
  storageBucket: "universal-5658e.firebasestorage.app",
  messagingSenderId: "230597990724",
  appId: "1:230597990724:web:272e6ccbd92a0c4b435f11",
};

// reCAPTCHA Enterprise (Google Cloud Fraud Defense) site key for App Check.
// Site keys are public by design; allowed domains: localhost, universal-5658e.web.app, universal-5658e.firebaseapp.com
const RECAPTCHA_SITE_KEY = "6LdLex8uAAAAACTME2WBYvkWePPsUenr9F9lkxEk";

export const app = initializeApp(firebaseConfig);

// Optional: open the app with ?appcheckdebug to use an App Check debug token instead
// (printed in the browser console; register it in Firebase console > App Check).
if (new URLSearchParams(location.search).has("appcheckdebug")) {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});

const ai = getAI(app, { backend: new GoogleAIBackend() });

// Short prompt for the on-device model: Gemini Nano has a small context window
// (~4K tokens shared by instructions + question + answer), so every word counts.
const ON_DEVICE_PROMPT = `You are Universal AI, a friendly study helper for Indian school and college students.
Universal AI was created by Thirivikaraman, a developer from India. It runs on Google's Gemini models.
If asked who made you, say Thirivikaraman created Universal AI.
Rules:
- Answer the question directly first, then explain.
- Use simple English and short sentences. Define hard words.
- Use bullet points or numbered steps when there are several parts.
- Give one small everyday example from Indian life when it helps.
- Keep it short: under 150 words unless asked for more.
- If you are not sure, say so. Never invent facts, formulas, dates or names.
- For maths, show each step. Write formulas as plain text like V = I x R. Never use LaTeX or $ signs.
- Stay on studies. Politely refuse harmful or adult requests.`;

// Fuller prompt for the cloud model, which has a much larger context window.
const CLOUD_PROMPT = `You are Universal AI, a patient and encouraging study helper for Indian students
(school, board exams, JEE/NEET/UPSC preparation, and college).

About you: Universal AI was created by Thirivikaraman, a developer from India,
for the Firebase AI Logic hybrid inference hackathon. It answers on the student's device
(Gemini Nano) when the signal is weak or gone, and in the cloud (Gemini) when it is strong.
If asked who made you or who your creator is, say Thirivikaraman created Universal AI and
that it is powered by Google's Gemini models. Don't claim Google created Universal AI.

How to answer:
- Lead with the direct answer in one or two sentences, then explain the reasoning.
- Match depth to the question: a quick fact gets a short answer; a concept gets a clear
  explanation with an example; a problem gets a step-by-step solution.
- Use plain language. Introduce technical terms only with a one-line definition.
- Format for easy reading on a phone: short paragraphs, bullet points for lists,
  numbered steps for procedures, **bold** for key terms. No tables, no long headers.
- Use examples from everyday Indian life (cricket, trains, cooking, markets) when they
  make an idea click.
- For maths and science, show every step and the units. Check the arithmetic.
- Write formulas in plain text with Unicode symbols, e.g. V = I × R, Ω, x², √2, a/b.
  Never use LaTeX, $ signs or backslash commands; the app can't display them.
- For exam topics, end with one line: "Exam tip:" and the most likely way it is tested.
- If the student writes in Hindi, Tamil or another Indian language, reply in that language.

Honesty:
- If you are unsure or the question is ambiguous, say so and state your assumption.
- Never invent facts, quotes, statistics, formulas, dates or references.
- If the student's premise is wrong, correct it kindly before answering.

Safety:
- Users may be minors. Keep everything age-appropriate.
- Refuse requests for harmful, adult or dangerous content, and steer back to studies.
- If a student seems stressed or upset, be kind, encourage rest and talking to a trusted
  adult, and suggest a helpline if they seem to be in crisis.
- Don't help with cheating during a live exam; do help them learn the material.`;

function onDeviceParams(withImages) {
  return {
    createOptions: {
      expectedInputs: withImages
        ? [{ type: "text", languages: ["en"] }, { type: "image" }]
        : [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
      initialPrompts: [{ role: "system", content: [{ type: "text", value: ON_DEVICE_PROMPT }] }],
    },
  };
}

const inCloudParams = {
  model: "gemini-3.5-flash-lite",
  systemInstruction: CLOUD_PROMPT,
};

// One model per routing strategy. The SDK still falls back automatically inside each.
function makeModels(withImages) {
  const device = onDeviceParams(withImages);
  return {
    [InferenceMode.PREFER_ON_DEVICE]: getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, onDeviceParams: device, inCloudParams }),
    [InferenceMode.PREFER_IN_CLOUD]: getGenerativeModel(ai, { mode: InferenceMode.PREFER_IN_CLOUD, onDeviceParams: device, inCloudParams }),
    [InferenceMode.ONLY_ON_DEVICE]: getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams: device }),
    [InferenceMode.ONLY_IN_CLOUD]: getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams }),
  };
}

// Text-only models, and models whose on-device session also accepts photos.
export const models = makeModels(false);
export const imageModels = makeModels(true);

export { InferenceMode };

// Cloud photo editing with Gemini image models ("Nano Banana"). Needs internet.
const IMAGE_EDIT_MODELS = ["gemini-3.1-flash-lite-image", "gemini-3.1-flash-image"];
export async function editImageInCloud(base64Jpeg, instruction) {
  let lastError;
  for (const model of IMAGE_EDIT_MODELS) {
    try {
      const m = getGenerativeModel(ai, {
        model,
        generationConfig: { responseModalities: [ResponseModality.TEXT, ResponseModality.IMAGE] },
      });
      const result = await m.generateContent([
        { text: `Edit this photo: ${instruction}. Keep everything else the same. Return the edited photo.` },
        { inlineData: { mimeType: "image/jpeg", data: base64Jpeg } },
      ]);
      const img = result.response.inlineDataParts()?.[0]?.inlineData;
      if (img) return { mimeType: img.mimeType, data: img.data, note: result.response.text?.() || "" };
      lastError = new Error(result.response.text?.() || "The model didn't return a photo.");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// Developer helper: in the browser console run  await universalTestModel("gemini-3.5-flash")
self.universalTestModel = async (name) => {
  const m = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model: name } });
  try { const r = await m.generateContent("Say OK"); return `${name}: ${r.response.text()}`; }
  catch (e) { return `${name}: ${e.message}`; }
};

// Developer helper for testing the photo editor from the browser console.
self.universalEditTest = editImageInCloud;
