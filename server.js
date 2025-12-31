// server.js (ESM)
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// -------------------- Species catalog --------------------
const SPECIES = [
  { genus: "Camponotus", species: "modoc", months: [5,6,7,8], params: { t_opt:28, t_width:6, rh_k:0.15, rain_sens:1.0, wind_penalty:0.1 } },
  { genus: "Formica", species: null, months: [5,6,7,8,9], params: { t_opt:26, t_width:7, rh_k:0.12, rain_sens:0.9, wind_penalty:0.1 } },
  { genus: "Lasius", species: null, months: [8,9,10], params: { t_opt:24, t_width:5, rh_k:0.18, rain_sens:1.2, wind_penalty:0.05 } },
  { genus: "Tetramorium", species: null, months: [6,7,8], params: { t_opt:27, t_width:5.5, rh_k:0.14, rain_sens:1.0, wind_penalty:0.1 } },
  { genus: "Solenopsis", species: null, months: [6,7,8,9], params: { t_opt:29, t_width:6, rh_k:0.16, rain_sens:1.1, wind_penalty:0.15 } },
  { genus: "Pogonomyrmex", species: null, months: [7,8,9], params: { t_opt:31, t_width:5, rh_k:0.10, rain_sens:0.8, wind_penalty:0.2 } },
  { genus: "Prenolepis", species: null, months: [2,3,4], params: { t_opt:18, t_width:4, rh_k:0.12, rain_sens:1.0, wind_penalty:0.05 } },
  { genus: "Tapinoma", species: null, months: [5,6,7,8], params: { t_opt:26, t_width:6, rh_k:0.13, rain_sens:1.0, wind_penalty:0.1 } },
  { genus: "Myrmica", species: null, months: [8,9], params: { t_opt:23, t_width:4.5, rh_k:0.17, rain_sens:1.1, wind_penalty:0.08 } },
  { genus: "Temnothorax", species: null, months: [6,7,8], params: { t_opt:25, t_width:5, rh_k:0.14, rain_sens:1.0, wind_penalty:0.05 } }
];

// -------------------- In-memory sightings store --------------------
const sightings = []; // { datetime, lat, lon, genus, species, confidence }

// -------------------- Utilities --------------------
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = v => v * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xs = Array.from({length:n}, (_,i) => i);
  const xMean = xs.reduce((a,b)=>a+b,0)/n;
  const yMean = values.reduce((a,b)=>a+b,0)/n;
  let num = 0, den = 0;
  for (let i=0;i<n;i++){ num += (xs[i]-xMean)*(values[i]-yMean); den += (xs[i]-xMean)**2; }
  return den === 0 ? 0 : num/den;
}

function softmax(arr) {
  const max = Math.max(...arr);
  const exps = arr.map(x => Math.exp(x - max));
  const sum = exps.reduce((a,b)=>a+b,0) || 1;
  return exps.map(e => e / sum);
}

// -------------------- Open-Meteo hourly fetch --------------------
async function getHourlyWeather(lat, lon, hoursBack = 72, hoursForward = 48) {
  const now = new Date();
  const start = new Date(now.getTime() - hoursBack * 3600 * 1000);
  const end = new Date(now.getTime() + hoursForward * 3600 * 1000);
  const start_date = start.toISOString().slice(0,10);
  const end_date = end.toISOString().slice(0,10);

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("hourly", [
    "temperature_2m",
    "relativehumidity_2m",
    "precipitation",
    "wind_speed_10m",
    "pressure_msl"
  ].join(","));
  url.searchParams.set("start_date", start_date);
  url.searchParams.set("end_date", end_date);
  url.searchParams.set("timezone", "UTC");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const j = await res.json();
  const h = j.hourly;
  if (!h || !Array.isArray(h.time)) throw new Error("No hourly data");

  const hourly = [];
  for (let i = 0; i < h.time.length; i++) {
    hourly.push({
      time: h.time[i],
      temp: h.temperature_2m[i],
      rh: h.relativehumidity_2m[i],
      precip: h.precipitation[i],
      wind: h.wind_speed_10m[i],
      pressure: h.pressure_msl[i]
    });
  }
  return hourly;
}

// -------------------- Feature extraction --------------------
function hoursSinceLastRain(hourly) {
  for (let i = hourly.length - 1; i >= 0; i--) {
    if ((hourly[i].precip ?? 0) > 0.5) {
      const last = new Date(hourly[i].time);
      const now = new Date(hourly[hourly.length - 1].time);
      return Math.max(0, Math.round((now - last) / (1000 * 60 * 60)));
    }
  }
  return 999;
}

function pressureTrendLast24(hourly) {
  const last = hourly.slice(-24);
  const pressures = last.map(h => h.pressure ?? 1013);
  return linearSlope(pressures);
}

function dailyAggregatesFromHourly(hourly, days) {
  const map = new Map();
  for (const h of hourly) {
    const d = h.time.slice(0,10);
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(h);
  }
  const dates = Array.from(map.keys()).sort();
  const out = [];
  for (const d of dates.slice(0, days)) {
    const arr = map.get(d);
    const tmax = Math.max(...arr.map(x => x.temp ?? -999));
    const rhMean = arr.reduce((a,b)=>a+(b.rh??0),0)/arr.length;
    const precipSum = arr.reduce((a,b)=>a+(b.precip??0),0);
    const windMax = Math.max(...arr.map(x => x.wind ?? 0));
    const pressureMean = arr.reduce((a,b)=>a+(b.pressure??1013),0)/arr.length;
    out.push({
      date: d,
      tmax,
      rhMean,
      precipSum,
      windMax,
      pressureMean
    });
  }
  return out;
}

// -------------------- Sightings boost --------------------
function sightingsBoostForDay(lat, lon, dayDate, sightingsList) {
  let boost = 0;
  for (const s of sightingsList) {
    const distKm = haversineKm(lat, lon, s.lat, s.lon);
    const distWeight = Math.exp(-distKm / 30);
    const ageDays = Math.max(0, (new Date(dayDate) - new Date(s.datetime)) / (1000*60*60*24));
    const recency = Math.exp(-ageDays / 3);
    boost += (s.confidence ?? 0.7) * distWeight * recency;
  }
  return Math.min(boost, 3.0);
}

// -------------------- Environmental probability (global) --------------------
function environmentalFlightProbability(features) {
  const ft = Math.exp(-((features.tmax - 28)**2) / (2 * 6**2));
  const fh = 1 / (1 + Math.exp(-0.12 * (features.rhMean - 60)));
  const fr = features.hoursSinceRain < 72 ? Math.exp(-features.hoursSinceRain / 24) * 0.9 : 0;
  const fw = Math.max(0, 1 - Math.max(0, (features.windMax - 8)) / 12);
  const fp = 1 - Math.min(0.5, Math.abs(features.pressureTrend) * 0.1);
  const sight = Math.min(1.0, features.sightingsBoost * 0.25);

  const linear = 1.0*ft + 0.8*fh + 1.0*fr + 0.9*fw + 0.3*fp + 0.6*sight - 3.5;
  return sigmoid(linear);
}

// -------------------- Species relative scoring --------------------
function speciesRelativeScores(features) {
  const raw = SPECIES.map(s => {
    const p = s.params;
    const ft = Math.exp(-((features.tmax - p.t_opt)**2) / (2 * p.t_width**2));
    const fh = 1 / (1 + Math.exp(-p.rh_k * (features.rhMean - 60)));
    const fr = features.hoursSinceRain < 72 ? Math.exp(-features.hoursSinceRain / 24) * p.rain_sens : 0;
    const fw = Math.max(0, 1 - Math.max(0, (features.windMax - 8)) / 12) * (1 - p.wind_penalty);
    const season = s.months.includes(features.month) ? 1.0 : 0.3;
    return 1.2*ft + 0.9*fh + 1.0*fr + 0.9*fw + 0.5*season;
  });
  return softmax(raw);
}

// -------------------- API endpoints --------------------
app.get("/api/predict", async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    let days = parseInt(req.query.days || "7", 10);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return res.status(400).json({ error: "lat/lon required" });

    const MAX_FORECAST_DAYS = 16;
    const requestedDays = days;
    days = Math.min(Math.max(days, 1), MAX_FORECAST_DAYS);

    let hourly;
    try {
      hourly = await getHourlyWeather(lat, lon, 72, days * 24);
    } catch (err) {
      console.error("Hourly weather fetch failed:", err.message);
      hourly = [];
      const now = new Date();
      for (let i = -72; i < days * 24; i++) {
        const t = new Date(now.getTime() + i * 3600 * 1000);
        hourly.push({
          time: t.toISOString(),
          temp: 26 + 6 * Math.sin(i / 24),
          rh: 55 + 15 * Math.sin(i / 36),
          precip: (i % 48 === 1) ? 3 : 0,
          wind: 8 + 4 * Math.cos(i / 24),
          pressure: 1013 + 2 * Math.sin(i / 48)
        });
      }
    }

    const hoursSince = hoursSinceLastRain(hourly);
    const pressureTrend = pressureTrendLast24(hourly);
    const dailyAgg = dailyAggregatesFromHourly(hourly, days);

    const calendar = [];
    for (const day of dailyAgg) {
      const month = Number(day.date.slice(5,7));
      const features = {
        tmax: day.tmax,
        rhMean: day.rhMean,
        hoursSinceRain: hoursSince,
        windMax: day.windMax,
        pressureTrend,
        month,
        sightingsBoost: sightingsBoostForDay(lat, lon, day.date, sightings)
      };

      const envProb = environmentalFlightProbability(features);
      const rel = speciesRelativeScores(features);

      const scored = SPECIES.map((s, i) => ({
        genus: s.genus,
        species: s.species,
        probability: Number((envProb * rel[i]).toFixed(3))
      })).sort((a,b) => b.probability - a.probability);

      calendar.push({ date: day.date, top5: scored.slice(0,5) });
    }

    if (requestedDays > MAX_FORECAST_DAYS) {
      res.setHeader("X-Note", `Requested ${requestedDays} days; returned ${MAX_FORECAST_DAYS} days (forecast limit).`);
    }

    res.json(calendar);
  } catch (e) {
    console.error("Predict error:", e);
    res.status(500).json({ error: "failed to compute predictions" });
  }
});

app.post("/api/sightings", (req, res) => {
  try {
    const { datetime, lat, lon, genus, species, confidence } = req.body || {};
    if (typeof lat !== "number" || typeof lon !== "number") return res.status(400).json({ error: "lat/lon required" });
    const rec = {
      datetime: datetime || new Date().toISOString(),
      lat, lon,
      genus: genus || null,
      species: species || null,
      confidence: typeof confidence === "number" ? confidence : 0.7
    };
    sightings.push(rec);
    res.json({ status: "stored" });
  } catch (e) {
    res.status(500).json({ error: "failed to store sighting" });
  }
});

app.get("/api/sightings", (req, res) => {
  res.json([...sightings].sort((a,b) => new Date(b.datetime) - new Date(a.datetime)));
});

// -------------------- Static files --------------------
app.use("/", express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ant Nuptial Flight Predictor running on http://localhost:${PORT}`);
});
