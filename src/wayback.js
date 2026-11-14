// "Find my way back": save a place, then show a map (online) or a compass arrow (offline).
import { load, save } from "./store.js";

const HOME_KEY = "universal-ai-home";
const $ = (id) => document.getElementById(id);

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function distanceM(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearingDeg(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
const DIRS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const dirName = (deg) => DIRS[Math.round(deg / 45) % 8];
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

function locate(opts = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This device can't share its location."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => reject(new Error(
        e.code === 1 ? "Location permission is blocked. Allow location in the address bar and try again."
        : "Couldn't find your location. On a laptop this often needs Wi-Fi; on a phone, turn on GPS and step outside."
      )),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000, ...opts }
    );
  });
}

export function initWayback() {
  let home = load(HOME_KEY, null);
  let here = null;
  let heading = null; // degrees from north, if the device has a compass
  let watchId = null;

  const status = $("wayStatus");
  const describeHome = () => home
    ? `Saved place: ${home.lat.toFixed(5)}, ${home.lng.toFixed(5)} (saved ${new Date(home.at).toLocaleDateString()}).`
    : "No place saved yet. Save your home while you're there.";
  status.textContent = describeHome();

  $("saveHomeBtn").addEventListener("click", async () => {
    status.textContent = "Finding where you are…";
    try {
      const p = await locate();
      home = { lat: p.lat, lng: p.lng, at: Date.now() };
      save(HOME_KEY, home);
      status.textContent = `Saved. ${describeHome()} Accuracy about ${Math.round(p.acc)} m.`;
    } catch (e) {
      status.textContent = e.message;
    }
  });

  function render() {
    if (!home || !here) return;
    const dist = distanceM(here, home);
    const brg = bearingDeg(here, home);
    $("compass").hidden = false;
    $("wayDistance").textContent = fmtDist(dist);
    const rel = heading == null ? brg : (brg - heading + 360) % 360;
    $("needle").style.transform = `rotate(${rel}deg)`;
    $("wayDirection").textContent = heading == null
      ? `Head ${dirName(brg)}. The arrow points that way with north at the top.`
      : `Follow the arrow. Your saved place is to the ${dirName(brg)}.`;

    const online = navigator.onLine;
    $("mapWrap").hidden = !online;
    if (online) {
      const frame = $("mapFrame");
      const src = `https://maps.google.com/maps?q=${home.lat},${home.lng}&z=15&output=embed`;
      if (frame.src !== src) frame.src = src;
      $("mapLink").href = `https://www.google.com/maps/dir/?api=1&origin=${here.lat},${here.lng}&destination=${home.lat},${home.lng}&travelmode=walking`;
    }
  }

  function onOrientation(e) {
    if (typeof e.webkitCompassHeading === "number") heading = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === "number") heading = (360 - e.alpha) % 360;
    else return;
    render();
  }

  $("guideBtn").addEventListener("click", async () => {
    if (!home) { status.textContent = "Save a place first: tap “Save where I am now” when you're at home."; return; }
    status.textContent = "Finding where you are…";
    // iPhone needs permission for the compass.
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        await DeviceOrientationEvent.requestPermission();
      }
    } catch {}
    addEventListener("deviceorientationabsolute", onOrientation);
    addEventListener("deviceorientation", onOrientation);
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    try {
      here = await locate();
      status.textContent = navigator.onLine
        ? "Here's your saved place. Use the map or follow the arrow."
        : "No signal, so no map. Follow the arrow; it works with GPS alone.";
      render();
      watchId = navigator.geolocation.watchPosition(
        (p) => { here = { lat: p.coords.latitude, lng: p.coords.longitude }; render(); },
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
    } catch (e) {
      status.textContent = e.message;
    }
  });

  addEventListener("online", render);
  addEventListener("offline", render);
}
