/* TailTrip Mini App — W2 single-page wizard.
 *
 * Replaces M4's 4-step state machine with one scrolling form. The
 * "state" is just the DOM — submit walks each section and gathers
 * the current values. Two pieces of stateful UI persist outside the
 * DOM tree because they need server-derived data:
 *
 *   - `selected.origin` / `selected.destination` — picked airport
 *     objects. Stored separately so we don't have to look them back
 *     up from the visible search results on submit.
 *   - `airports` — the loaded airport directory.
 *
 * Submit gates on: origin + destination + start date set. Other
 * fields are optional (empty handle lists, min-approvals defaults
 * to 0, announce-mode defaults to pinned).
 *
 * Payload schema → `src/tailtrip/bot/handlers/miniapp_wizard.py`.
 * Bot-side `_validate` is permissive about missing W2 fields so we
 * remain compatible with the M4-era payload during rollout.
 */

(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  // ----- read URL params -----
  // Set by /newtrip when redirecting from a group → DM. Carries the
  // group's chat_id + (optionally) a display name so we can show the
  // user which chat their trip will land in.
  const url = new URLSearchParams(window.location.search);
  const TARGET_CHAT_ID = url.get("target") || null;
  const TARGET_CHAT_NAME = url.get("target_name") || null;

  if (TARGET_CHAT_NAME || TARGET_CHAT_ID) {
    const banner = document.getElementById("target-banner");
    const nameEl = document.getElementById("target-banner-name");
    banner.classList.remove("hidden");
    nameEl.textContent = TARGET_CHAT_NAME || "chat " + TARGET_CHAT_ID;
  }

  // ----- selection state (only what we can't derive from the DOM) -----
  const selected = {
    origin: null, // {iata, name, city, country, region}
    destination: null,
  };

  // ----- airport directory -----
  let airports = [];
  fetch("./airports.json", { cache: "force-cache" })
    .then((r) => r.json())
    .then((data) => {
      airports = data;
      // Re-render any prior searches (in case user typed before fetch).
      renderPicker("origin");
      renderPicker("dest");
    })
    .catch((err) => {
      console.error("airports.json failed:", err);
    });

  // ----- ranking (mirrors domain/airports.py::search) -----
  function rankAirport(q, a) {
    const iata = a.iata.toLowerCase();
    const city = a.city.toLowerCase();
    const name = a.name.toLowerCase();
    if (iata === q) return [0, 0];
    if (iata.startsWith(q)) return [1, 0];
    if (city === q) return [2, 0];
    if (city.startsWith(q)) return [3, 0];
    const nameIdx = name.indexOf(q);
    if (nameIdx !== -1) return [4, nameIdx];
    const cityIdx = city.indexOf(q);
    if (cityIdx !== -1) return [4, cityIdx + 100];
    return null;
  }
  function searchAirports(query, limit) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const a of airports) {
      const rank = rankAirport(q, a);
      if (rank !== null) scored.push({ rank: rank[0], pos: rank[1], a: a });
    }
    scored.sort((x, y) => {
      if (x.rank !== y.rank) return x.rank - y.rank;
      if (x.pos !== y.pos) return x.pos - y.pos;
      return x.a.iata.localeCompare(y.a.iata);
    });
    return scored.slice(0, limit || 5).map((s) => s.a);
  }

  function describeAirport(a) {
    const where = a.region
      ? a.city + ", " + a.region + ", " + a.country
      : a.city + ", " + a.country;
    return a.iata + " — " + a.name + " · " + where;
  }

  // ----- airport picker (shared origin + destination) -----

  function renderPicker(which) {
    const inputId = which === "origin" ? "origin-q" : "dest-q";
    const listId = which === "origin" ? "origin-results" : "dest-results";
    const selId = which === "origin" ? "origin-selection" : "dest-selection";
    const lineId = which === "origin" ? "origin-line" : "dest-line";
    const stateKey = which === "origin" ? "origin" : "destination";

    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    const selEl = document.getElementById(selId);
    const lineEl = document.getElementById(lineId);

    list.innerHTML = "";
    const q = input.value.trim();

    if (!q) {
      const prior = selected[stateKey];
      if (prior) {
        selEl.classList.remove("hidden");
        lineEl.textContent = describeAirport(prior);
      } else {
        selEl.classList.add("hidden");
      }
      refreshSubmitGate();
      return;
    }

    if (!airports.length) return; // still fetching

    const hits = searchAirports(q, 5);
    if (hits.length === 0) {
      const li = document.createElement("li");
      li.className = "results-empty";
      li.textContent = 'No airports match "' + q + '".';
      list.appendChild(li);
      return;
    }
    for (const a of hits) {
      const li = makeResultRow(a, () => {
        selected[stateKey] = a;
        selEl.classList.remove("hidden");
        lineEl.textContent = describeAirport(a);
        for (const r of list.querySelectorAll(".result")) {
          r.classList.remove("selected");
        }
        li.classList.add("selected");
        autoFillTripName();
        refreshSubmitGate();
      });
      if (selected[stateKey] && selected[stateKey].iata === a.iata) {
        li.classList.add("selected");
      }
      list.appendChild(li);
    }
  }

  function makeResultRow(a, onPick) {
    const li = document.createElement("li");
    li.className = "result";
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    const iataEl = document.createElement("span");
    iataEl.className = "result-iata";
    iataEl.textContent = a.iata;
    const textWrap = document.createElement("div");
    textWrap.className = "result-text";
    const nameEl = document.createElement("div");
    nameEl.className = "result-name";
    nameEl.textContent = a.name;
    const whereEl = document.createElement("div");
    whereEl.className = "result-where";
    whereEl.textContent = a.region
      ? a.city + ", " + a.region + ", " + a.country
      : a.city + ", " + a.country;
    textWrap.appendChild(nameEl);
    textWrap.appendChild(whereEl);
    li.appendChild(iataEl);
    li.appendChild(textWrap);
    li.addEventListener("click", onPick);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onPick();
      }
    });
    return li;
  }

  function wirePicker(which) {
    const inputId = which === "origin" ? "origin-q" : "dest-q";
    const input = document.getElementById(inputId);
    let timer = null;
    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => renderPicker(which), 100);
    });
  }
  wirePicker("origin");
  wirePicker("dest");

  // ----- date pickers + presets -----

  const dateStart = document.getElementById("date-start");
  const dateEnd = document.getElementById("date-end");

  function toISO(d) {
    return d.toISOString().slice(0, 10);
  }
  function thisWeekend() {
    const today = new Date();
    const dow = today.getDay();
    const sat = new Date(today);
    sat.setDate(today.getDate() + ((6 - dow) % 7 || 7));
    const sun = new Date(sat);
    sun.setDate(sat.getDate() + 1);
    return { start: toISO(sat), end: toISO(sun) };
  }
  function nextWeekend() {
    const tw = thisWeekend();
    const sat = new Date(tw.start);
    sat.setDate(sat.getDate() + 7);
    const sun = new Date(sat);
    sun.setDate(sat.getDate() + 1);
    return { start: toISO(sat), end: toISO(sun) };
  }
  function nextWeek() {
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() + 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: toISO(start), end: toISO(end) };
  }
  function setDates(start, end) {
    dateStart.value = start || "";
    dateEnd.value = end || "";
    refreshSubmitGate();
  }
  dateStart.addEventListener("change", () => {
    if (dateEnd.value && dateEnd.value < dateStart.value) {
      dateEnd.value = "";
    }
    refreshSubmitGate();
  });
  dateEnd.addEventListener("change", refreshSubmitGate);

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      const preset = chip.dataset.preset;
      if (preset === "weekend") {
        const w = thisWeekend();
        setDates(w.start, w.end);
      } else if (preset === "next-weekend") {
        const w = nextWeekend();
        setDates(w.start, w.end);
      } else if (preset === "next-week") {
        const w = nextWeek();
        setDates(w.start, w.end);
      } else if (preset === "clear") {
        setDates(null, null);
      }
    });
  });

  // ----- auto-fill trip name -----
  // Only fires if the field is empty OR holds the previous auto-fill.
  // Once the user types something custom, we leave it alone.
  let lastAutoFill = "";
  function autoFillTripName() {
    if (!selected.origin || !selected.destination) return;
    const next = selected.origin.iata + " → " + selected.destination.iata;
    const el = document.getElementById("trip-name");
    if (!el.value || el.value === lastAutoFill) {
      el.value = next;
      lastAutoFill = next;
    }
  }

  // ----- submit gating -----

  const submitBtn = document.getElementById("submit-btn");
  const submitHint = document.getElementById("submit-hint");
  function refreshSubmitGate() {
    const missing = [];
    if (!selected.origin) missing.push("origin");
    if (!dateStart.value) missing.push("start date");
    if (!selected.destination) missing.push("destination");
    if (missing.length) {
      submitBtn.disabled = true;
      submitHint.textContent =
        "Still need: " + missing.join(", ") + ".";
    } else {
      submitBtn.disabled = false;
      submitHint.textContent = "Ready to create — submit when you're set.";
    }
  }

  // ----- handle list parsing -----
  // Permissive on the frontend: bot-side `_clean_handles` is the
  // source of truth for validation, dedup, and casing. We just split
  // on commas/whitespace and forward.
  function parseHandles(raw) {
    if (!raw) return [];
    return raw
      .split(/[\s,]+/)
      .map((h) => h.trim())
      .filter(Boolean);
  }

  // ----- submit -----

  submitBtn.addEventListener("click", () => {
    if (submitBtn.disabled) return;
    const payload = {
      type: "m4-wizard",
      ts: Date.now(),
      trip: {
        name: (document.getElementById("trip-name").value || "").trim() ||
              (selected.origin.iata + " → " + selected.destination.iata),
        target_chat_id: TARGET_CHAT_ID ? Number(TARGET_CHAT_ID) : null,
        origin: selected.origin,
        destination: selected.destination,
        start_date: dateStart.value,
        end_date: dateEnd.value || null,
        // W2 additions:
        traveler_handles: parseHandles(
          document.getElementById("traveler-handles").value
        ),
        notify_handles: parseHandles(
          document.getElementById("notify-handles").value
        ),
        approver_handles: parseHandles(
          document.getElementById("approver-handles").value
        ),
        min_approvals: pickedRadio("min-approvals", "0"),
        announce_mode: pickedRadio("announce-mode", "pinned"),
      },
    };
    if (tg) {
      tg.sendData(JSON.stringify(payload));
    } else {
      alert("Not in Telegram; payload would have been:\n" +
            JSON.stringify(payload, null, 2));
    }
  });

  function pickedRadio(name, fallback) {
    const checked = document.querySelector(
      'input[name="' + name + '"]:checked'
    );
    return checked ? checked.value : fallback;
  }

  // ----- boot -----
  refreshSubmitGate();
})();
