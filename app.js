/* TailTrip Mini App — M4 full wizard.
 *
 * Vanilla JS state machine driving four screens:
 *   1. Origin (airport picker)
 *   2. Dates (single day or range; chip presets)
 *   3. Destination (airport picker)
 *   4. Summary + submit (auto-filled trip name, editable)
 *
 * State lives in a single `state` object in this module. Step transitions
 * update the visible <section>, step indicator, and disable/enable
 * forward buttons based on validity.
 *
 * On submit the entire trip envelope ships back to the bot via
 * `Telegram.WebApp.sendData(JSON)`; the bot's `m4-wizard` dispatcher
 * (see src/tailtrip/bot/handlers/miniapp.py) emits the corresponding
 * domain events.
 *
 * No build step. No framework. Keep this readable; the next dev to
 * touch it shouldn't need to learn anything but the DOM.
 */

(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  // ----- read URL params (carries target_chat_id from the bot) -----

  const url = new URLSearchParams(window.location.search);
  const TARGET_CHAT_ID = url.get("target") || null;
  const TARGET_CHAT_NAME = url.get("target_name") || null;

  // ----- wizard state -----

  const state = {
    step: 1,
    origin: null,         // { iata, name, city, country, region }
    destination: null,    // same shape
    dateStart: null,      // ISO 'YYYY-MM-DD'
    dateEnd: null,        // ISO or null
    name: "",             // auto-filled; user-editable on summary
  };

  // ----- airport directory -----

  /** @type {Array<object>} */
  let airports = [];
  fetch("./airports.json", { cache: "force-cache" })
    .then((r) => r.json())
    .then((data) => {
      airports = data;
      // If the user has already started typing, render now.
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

  // ----- step navigation -----

  /** Show the view for the given step (1..4). Updates the indicator. */
  function showStep(n) {
    state.step = n;
    // Toggle view visibility
    for (const view of document.querySelectorAll("[data-view]")) {
      view.classList.toggle("hidden", view.dataset.view !== viewFor(n));
    }
    // Update step indicator
    const stepEls = document.querySelectorAll(".step");
    const railEls = document.querySelectorAll(".step-rail");
    stepEls.forEach((el, i) => {
      const idx = i + 1;
      el.classList.toggle("active", idx === n);
      el.classList.toggle("done", idx < n);
    });
    railEls.forEach((el, i) => {
      el.classList.toggle("done", i + 1 < n);
    });
    // Refresh summary when entering step 4
    if (n === 4) refreshSummary();
    // Scroll to top so the user sees the new view's header
    window.scrollTo(0, 0);
  }

  function viewFor(step) {
    return { 1: "origin", 2: "dates", 3: "destination", 4: "summary" }[step];
  }

  // ----- picker (origin + destination share the impl) -----

  /**
   * `which` is "origin" or "dest"; we map to the right input/list/state.
   */
  function renderPicker(which) {
    const inputId = which === "origin" ? "origin-q" : "dest-q";
    const listId = which === "origin" ? "origin-results" : "dest-results";
    const selId = which === "origin" ? "origin-selection" : "dest-selection";
    const lineId = which === "origin" ? "origin-line" : "dest-line";
    const nextId = which === "origin" ? "origin-next" : "dest-next";
    const stateKey = which === "origin" ? "origin" : "destination";

    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    const selEl = document.getElementById(selId);
    const lineEl = document.getElementById(lineId);
    const nextBtn = document.getElementById(nextId);

    list.innerHTML = "";
    const q = input.value.trim();
    if (!q) {
      // Empty query — keep prior selection visible if any.
      const prior = state[stateKey];
      if (prior) {
        selEl.classList.remove("hidden");
        lineEl.textContent = describeAirport(prior);
        nextBtn.disabled = false;
      } else {
        selEl.classList.add("hidden");
        nextBtn.disabled = true;
      }
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
        state[stateKey] = a;
        selEl.classList.remove("hidden");
        lineEl.textContent = describeAirport(a);
        // Mark this row as selected; clear siblings
        for (const r of list.querySelectorAll(".result")) {
          r.classList.remove("selected");
        }
        li.classList.add("selected");
        nextBtn.disabled = false;
      });
      if (state[stateKey] && state[stateKey].iata === a.iata) {
        li.classList.add("selected");
      }
      list.appendChild(li);
    }
  }

  function describeAirport(a) {
    const where = a.region
      ? a.city + ", " + a.region + ", " + a.country
      : a.city + ", " + a.country;
    return a.iata + " — " + a.name + " · " + where;
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

  // Debounced search wiring
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

  // ----- step 2: dates -----

  const dateStart = document.getElementById("date-start");
  const dateEnd = document.getElementById("date-end");
  const datesNextBtn = document.getElementById("dates-next");

  /** Compute ISO YYYY-MM-DD strings for date math. */
  function toISO(d) {
    return d.toISOString().slice(0, 10);
  }

  /** Saturday/Sunday of *this* week. If it's already Sun/Mon evening,
   *  this is "this past weekend" — that's fine; user can adjust. */
  function thisWeekend() {
    const today = new Date();
    const dow = today.getDay(); // 0=Sun … 6=Sat
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
    state.dateStart = start || null;
    state.dateEnd = end || null;
    dateStart.value = start || "";
    dateEnd.value = end || "";
    refreshDatesNext();
  }

  function refreshDatesNext() {
    datesNextBtn.disabled = !state.dateStart;
  }

  dateStart.addEventListener("change", () => {
    state.dateStart = dateStart.value || null;
    // If the end is before the start, clear it
    if (state.dateEnd && dateEnd.value && dateEnd.value < dateStart.value) {
      state.dateEnd = null;
      dateEnd.value = "";
    }
    refreshDatesNext();
  });

  dateEnd.addEventListener("change", () => {
    state.dateEnd = dateEnd.value || null;
    refreshDatesNext();
  });

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

  // ----- next / back / jump wiring -----

  document.getElementById("origin-next").addEventListener("click", () => {
    if (state.origin) showStep(2);
  });
  document.getElementById("dates-next").addEventListener("click", () => {
    if (state.dateStart) showStep(3);
  });
  document.getElementById("dest-next").addEventListener("click", () => {
    if (state.destination) showStep(4);
  });

  document.querySelectorAll(".btn-back").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      const stepIdx = { origin: 1, dates: 2, destination: 3 }[target];
      if (stepIdx) showStep(stepIdx);
    });
  });

  document.querySelectorAll(".btn-link[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.jump;
      const stepIdx = { origin: 1, dates: 2, destination: 3 }[target];
      if (stepIdx) showStep(stepIdx);
    });
  });

  document.querySelectorAll('[data-action="close"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      if (tg) tg.close();
    });
  });

  // ----- step 4: summary -----

  const tripNameInput = document.getElementById("trip-name");
  tripNameInput.addEventListener("input", () => {
    state.name = tripNameInput.value;
  });

  function refreshSummary() {
    document.getElementById("summary-origin").textContent =
      state.origin ? describeAirport(state.origin) : "—";
    document.getElementById("summary-dest").textContent =
      state.destination ? describeAirport(state.destination) : "—";

    let dateLabel = "—";
    if (state.dateStart && state.dateEnd && state.dateStart !== state.dateEnd) {
      dateLabel = state.dateStart + " → " + state.dateEnd;
    } else if (state.dateStart) {
      dateLabel = state.dateStart;
    }
    document.getElementById("summary-dates").textContent = dateLabel;

    // Auto-fill trip name on first arrival to step 4 if user hasn't
    // typed anything custom yet. Re-arriving keeps their edit.
    if (!state.name && state.origin && state.destination) {
      state.name = state.origin.iata + " → " + state.destination.iata;
      tripNameInput.value = state.name;
    }

    // Target chat hint
    const noteEl = document.getElementById("summary-target-note");
    if (TARGET_CHAT_NAME) {
      noteEl.classList.remove("hidden");
      document.getElementById("summary-target").textContent = TARGET_CHAT_NAME;
    } else if (TARGET_CHAT_ID) {
      noteEl.classList.remove("hidden");
      document.getElementById("summary-target").textContent =
        "chat " + TARGET_CHAT_ID;
    } else {
      noteEl.classList.add("hidden");
    }
  }

  // ----- submit -----

  document.getElementById("submit-btn").addEventListener("click", () => {
    if (!state.origin || !state.destination || !state.dateStart) {
      // Should never get here — the Next buttons gate. Defensive.
      alert("Please fill in all steps before submitting.");
      return;
    }
    const payload = {
      type: "m4-wizard",
      ts: Date.now(),
      trip: {
        name: (state.name || "").trim() ||
              (state.origin.iata + " → " + state.destination.iata),
        target_chat_id: TARGET_CHAT_ID ? Number(TARGET_CHAT_ID) : null,
        origin: state.origin,
        destination: state.destination,
        start_date: state.dateStart,
        end_date: state.dateEnd,
      },
    };
    if (tg) {
      tg.sendData(JSON.stringify(payload));
    } else {
      alert("Not in Telegram; payload would have been:\n" +
            JSON.stringify(payload, null, 2));
    }
  });

  // ----- boot -----

  showStep(1);
})();
