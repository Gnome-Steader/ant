// public/client.js
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function weekdayName(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

function pctClass(p) {
  if (p >= 0.5) return "best";
  if (p >= 0.25) return "better";
  return "good";
}

function renderCalendar(days) {
  const grid = document.getElementById("calendar");
  grid.innerHTML = "";
  days.forEach(day => {
    const div = document.createElement("div");
    div.className = "day";
    const header = `
      <div class="day-header">
        <div class="date">${day.date}</div>
        <div class="weekday">${weekdayName(day.date)}</div>
      </div>
    `;
    const speciesRows = day.top5.map(s => {
      const p = s.probability;
      const pct = Math.round(p * 100) + "%";
      const cls = pctClass(p);
      return `<div class="species">
        <span class="name"><i>${s.genus}</i>${s.species ? " " + s.species : ""}</span>
        <span class="pct ${cls}">${pct}</span>
      </div>`;
    }).join("");
    div.innerHTML = header + `<div class="species-list">${speciesRows}</div>`;
    grid.appendChild(div);
  });
}

function showHint(text) {
  let hint = document.querySelector(".hint");
  if (!hint) {
    hint = document.createElement("div");
    hint.className = "hint";
    document.querySelector("main").appendChild(hint);
  }
  hint.textContent = text;
}

async function doPredict() {
  const lat = parseFloat(document.getElementById("lat").value);
  const lon = parseFloat(document.getElementById("lon").value);
  let days = parseInt(document.getElementById("days").value, 10);

  const MAX_FORECAST_DAYS = 16;
  if (days > MAX_FORECAST_DAYS) {
    showHint(`Requested ${days} days exceeds live forecast limit. Showing ${MAX_FORECAST_DAYS} days.`);
    days = MAX_FORECAST_DAYS;
  } else {
    showHint("Tip: Post‑rain warm, humid evenings with low wind often spike flights. Species windows vary by region.");
  }

  try {
    const rows = await fetchJSON(`/api/predict?lat=${lat}&lon=${lon}&days=${days}`);
    renderCalendar(rows);
  } catch (e) {
    showHint("Prediction failed. Check server logs or network.");
    console.error(e);
  }
}

function wireEvents() {
  document.getElementById("predict").addEventListener("click", doPredict);

  document.getElementById("locate").addEventListener("click", async () => {
    const btn = document.getElementById("locate");
    btn.disabled = true;
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true })
      );
      document.getElementById("lat").value = pos.coords.latitude.toFixed(4);
      document.getElementById("lon").value = pos.coords.longitude.toFixed(4);
      await doPredict();
    } catch {
      alert("Location not available. Enter coordinates manually.");
    } finally {
      btn.disabled = false;
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  wireEvents();
  await doPredict();
});
