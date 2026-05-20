/* TailTrip Mini App — M6 Live Board view.
 *
 * Renders a base64-encoded snapshot from `?snapshot=…` in the URL.
 * Mirrors the Python helper at src/tailtrip/bot/board_snapshot.py —
 * any field renamed here must be renamed there too (and vice versa).
 *
 * Refresh: tap → `Telegram.WebApp.sendData({type:"refresh-board",
 * trip_id})` → Mini App closes → bot re-sends a fresh button with the
 * new snapshot. (No backend needed.)
 */

(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  // ----- decode snapshot -----

  function decode(param) {
    if (!param) return null;
    // Restore base64 padding that the Python side strips.
    const padded = param + "=".repeat((4 - (param.length % 4)) % 4);
    // urlsafe_b64 uses `-_`; atob expects `+/`. Swap before decode.
    const standard = padded.replace(/-/g, "+").replace(/_/g, "/");
    try {
      const json = decodeURIComponent(
        Array.from(atob(standard))
          .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
          .join("")
      );
      return JSON.parse(json);
    } catch (e) {
      console.error("snapshot decode failed:", e);
      return null;
    }
  }

  const url = new URLSearchParams(window.location.search);
  const snapshot = decode(url.get("snapshot"));

  const tripNameEl = document.getElementById("trip-name");
  const tripMetaEl = document.getElementById("trip-meta");
  const boardEl = document.getElementById("board");
  const emptyEl = document.getElementById("empty");
  const errorEl = document.getElementById("error");

  if (!snapshot) {
    errorEl.classList.remove("hidden");
    return;
  }

  // ----- header -----

  tripNameEl.textContent = snapshot.trip.name || "(unnamed trip)";
  const dates = snapshot.trip.start_date
    ? snapshot.trip.end_date && snapshot.trip.end_date !== snapshot.trip.start_date
      ? snapshot.trip.start_date + " → " + snapshot.trip.end_date
      : snapshot.trip.start_date
    : "no dates yet";
  const travelerCount = snapshot.travelers.length;
  const tcLabel = travelerCount === 1 ? "1 traveler" : travelerCount + " travelers";
  tripMetaEl.textContent =
    dates + " · " + snapshot.trip.status + " · " + tcLabel;

  // ----- travelers -----

  if (snapshot.travelers.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }

  const myUserId =
    tg && tg.initDataUnsafe && tg.initDataUnsafe.user
      ? tg.initDataUnsafe.user.id
      : null;

  for (const t of snapshot.travelers) {
    boardEl.appendChild(renderTraveler(t, myUserId));
  }

  // ----- refresh / close -----

  document.getElementById("refresh").addEventListener("click", () => {
    if (tg) {
      tg.sendData(
        JSON.stringify({
          type: "refresh-board",
          trip_id: snapshot.trip.id,
        })
      );
    } else {
      alert("Not in Telegram; refresh payload would have shipped here.");
    }
  });

  document.getElementById("close").addEventListener("click", () => {
    if (tg) tg.close();
  });

  // ===== rendering helpers =====

  function renderTraveler(t, myUserId) {
    const card = el("div", "traveler");

    // Header row: handle + countdown
    const head = el("div", "traveler-head");
    const handle = el("div", "traveler-handle");
    handle.textContent = "@" + t.handle;
    if (myUserId && t.user_id === myUserId) {
      const youBadge = el("span", "you");
      youBadge.textContent = "you";
      handle.appendChild(youBadge);
    }
    head.appendChild(handle);

    if (t.countdown_seconds !== null && t.countdown_seconds !== undefined) {
      const cd = el("div", "traveler-countdown");
      cd.textContent = formatCountdown(t.countdown_seconds);
      if (t.countdown_seconds < 3 * 3600) cd.classList.add("urgent");
      head.appendChild(cd);
    }
    card.appendChild(head);

    // 11-stage bar + label
    card.appendChild(renderStages(t.stage));
    const label = el("div", "stage-label");
    const num = el("span", "stage-num");
    num.textContent = t.stage + "/11";
    label.appendChild(num);
    label.appendChild(document.createTextNode(" · " + t.stage_label));
    card.appendChild(label);

    // Mini route ribbon (next leg)
    if (t.next_event) {
      card.appendChild(renderRibbon(t.next_event));
    }

    // Status note
    const note = el("div", "traveler-note");
    if (/^✅/.test(t.note)) note.classList.add("ok");
    if (/^⚠/.test(t.note) || /unconfirmed/i.test(t.note) || /awaiting/i.test(t.note)) {
      note.classList.add("warn");
    }
    note.textContent = "🐾 " + t.note;
    card.appendChild(note);

    return card;
  }

  function renderStages(currentStage) {
    const row = el("div", "stages");
    for (let i = 1; i <= 11; i++) {
      const dot = el("div", "stage-dot");
      if (i < currentStage) dot.classList.add("filled");
      if (i === currentStage) dot.classList.add("current");
      dot.title = "stage " + i + "/11";
      row.appendChild(dot);
    }
    return row;
  }

  function renderRibbon(next) {
    const ribbon = el("div", "ribbon");
    if (next.dep_iata) {
      const leg = el("span", "ribbon-leg");
      const iata = el("span", "ribbon-iata");
      iata.textContent = next.dep_iata;
      leg.appendChild(iata);
      ribbon.appendChild(leg);
    }
    const mode = el("span", "ribbon-mode");
    mode.textContent = modeGlyph(next.mode);
    ribbon.appendChild(mode);
    if (next.arr_iata) {
      const leg = el("span", "ribbon-leg");
      const iata = el("span", "ribbon-iata");
      iata.textContent = next.arr_iata;
      leg.appendChild(iata);
      ribbon.appendChild(leg);
    }
    if (next.flight_no) {
      const fn = el("span", "ribbon-mode");
      fn.textContent = "· " + next.flight_no;
      ribbon.appendChild(fn);
    }
    if (next.dep_at) {
      const t = el("span", "ribbon-time");
      const d = new Date(next.dep_at);
      // Display as "Jun 10 18:30 UTC" — terse and unambiguous.
      const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
      const day = d.getUTCDate();
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      t.textContent = month + " " + day + " " + hh + ":" + mm + " UTC";
      ribbon.appendChild(t);
    }
    return ribbon;
  }

  function modeGlyph(mode) {
    switch (mode) {
      case "flight": return "─ ✈️ ─";
      case "drive":  return "─ 🚗 ─";
      case "train":  return "─ 🚆 ─";
      case "boat":   return "─ ⛴ ─";
      case "walk":   return "─ 🚶 ─";
      default:       return "─ ⋯ ─";
    }
  }

  function formatCountdown(seconds) {
    if (seconds <= 0) return "now";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return days + "d " + hours + "h to next";
    if (hours > 0) return hours + "h " + mins + "m to next";
    return mins + "m to next";
  }

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
})();
