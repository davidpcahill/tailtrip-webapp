/* TailTrip Mini App — single-page wizard.
 *
 * The "state" is just the DOM — submit walks each section and
 * gathers the current values. Two pieces of stateful UI persist
 * outside the DOM tree because they need server-derived data:
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
 * The bot-side `_validate` is permissive about missing fields so
 * older clients (and the rollout window itself) stay compatible.
 *
 * Next: V4 splits this app into a router — wizard stays at this
 * URL, but `?view=menu` lands the main menu, `?view=board&trip_id=`
 * lands the live board (currently a separate board.html). See
 * DESIGN.md §V4.
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
  // user which chat their trip will land in. W5 adds `chats` which
  // is a base64-urlsafe JSON list of chats the user could pick from.
  const url = new URLSearchParams(window.location.search);
  const TARGET_CHAT_ID = url.get("target") || null;
  const TARGET_CHAT_NAME = url.get("target_name") || null;
  const CHATS_ENCODED = url.get("chats") || null;

  // W5: decode the candidate chat list. Empty list / decode failure →
  // wizard hides the picker section and falls back to TARGET_CHAT_ID
  // (or DM if neither is set). Mirrors `decode_candidates` in
  // src/tailtrip/bot/chat_picker.py.
  function decodeChats(encoded) {
    if (!encoded) return [];
    try {
      const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
      const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data
        .filter(
          (c) =>
            c &&
            typeof c.id === "number" &&
            typeof c.title === "string" &&
            typeof c.type === "string"
        )
        .map((c) => ({ id: c.id, title: c.title, type: c.type }));
    } catch (err) {
      console.warn("chat decode failed:", err);
      return [];
    }
  }
  const CHAT_CANDIDATES = decodeChats(CHATS_ENCODED);

  // W2.5: past-trips decoder mirrors the Python encoder in
  // src/tailtrip/bot/past_trips.py. Defensive — never throws.
  function decodePastTrips(encoded) {
    if (!encoded) return [];
    try {
      const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
      const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data.filter((t) => t && typeof t === "object");
    } catch (err) {
      console.warn("past_trips decode failed:", err);
      return [];
    }
  }
  const PAST_TRIPS = decodePastTrips(url.get("past") || null);

  if (TARGET_CHAT_NAME || TARGET_CHAT_ID) {
    const banner = document.getElementById("target-banner");
    const nameEl = document.getElementById("target-banner-name");
    banner.classList.remove("hidden");
    nameEl.textContent = TARGET_CHAT_NAME || "chat " + TARGET_CHAT_ID;
  }

  // W5: render the chat picker if we have candidates. Otherwise hide
  // the whole section so the wizard isn't cluttered with a useless
  // empty box. Selected value defaults to the redirected-from target
  // when there is one, else the most-recent chat, else "dm".
  function renderChatPicker() {
    const section = document.getElementById("chat-picker-section");
    const group = document.getElementById("chat-picker-group");
    if (!CHAT_CANDIDATES.length) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    group.innerHTML = "<legend>Trip board location</legend>";
    const targetId = TARGET_CHAT_ID ? Number(TARGET_CHAT_ID) : null;
    // "DM only" choice — always present so the user can opt out of a
    // group if they want a solo trip. Stored as id=0 in the radio
    // value; submit translates back to target_chat_id=null.
    const dmRow = makeChatRow(0, "💬 DM only — just me", "dm", targetId === null);
    group.appendChild(dmRow);
    for (const c of CHAT_CANDIDATES) {
      const icon = c.type === "supergroup" || c.type === "group" ? "👥" : "📢";
      const label = `${icon} ${c.title}`;
      group.appendChild(makeChatRow(c.id, label, c.type, c.id === targetId));
    }
  }
  function makeChatRow(chatId, label, type, checked) {
    const wrap = document.createElement("label");
    wrap.className = "radio";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "target-chat";
    input.value = String(chatId);
    input.dataset.type = type;
    if (checked) input.checked = true;
    const span = document.createElement("span");
    span.textContent = label;
    wrap.appendChild(input);
    wrap.appendChild(span);
    return wrap;
  }
  renderChatPicker();

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
    // Keep end ≥ start: floor the native end picker at start, and when
    // end is empty or now-before-start, snap it up to start (a same-day
    // trip is valid; the user can bump it later). Previously we just
    // CLEARED end, which felt broken.
    if (dateStart.value) {
      dateEnd.min = dateStart.value;
      if (!dateEnd.value || dateEnd.value < dateStart.value) {
        dateEnd.value = dateStart.value;
      }
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

  // ----- W3 people picker -----
  // Decode the `people` URL param the bot pre-loaded with the
  // creator's candidate set. Same defensive decode pattern as
  // chats (returns [] on any malformed input).
  function decodePeople(encoded) {
    if (!encoded) return [];
    try {
      const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
      const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data
        .filter(
          (p) =>
            p &&
            typeof p.id === "number" &&
            typeof p.handle === "string" &&
            typeof p.via === "string"
        )
        .map((p) => ({ id: p.id, handle: p.handle, via: p.via }));
    } catch (err) {
      console.warn("people decode failed:", err);
      return [];
    }
  }
  const PEOPLE_CANDIDATES = decodePeople(url.get("people") || null);

  /**
   * Build a multi-select chip picker into the container.
   *
   * Three of these are instantiated (travelers, notify, approvers).
   * Each maintains its OWN selected set so removing @alice from
   * "travelers" doesn't unselect her from "approvers".
   *
   * Public surface:
   *   - createPeoplePicker(containerId, candidates, opts) → {getValues, clear}
   *   - getValues() returns the current handle list (lowercased + deduped
   *     by the bot-side cleaner, but we forward casing as the user typed it)
   *
   * UX:
   *   - Selected handles render as removable chips at the top
   *   - A search input below filters candidates by handle substring
   *   - Click a candidate → chip
   *   - Type a custom @handle + Enter → outsider chip (any string matching
   *     `^@?[A-Za-z][A-Za-z0-9_]{3,31}$` — same rule as bot's `_HANDLE_RE`)
   *   - Click an existing chip → remove
   *
   * Custom @handles get an "outsider" badge so the user can see which
   * ones aren't from their resolved candidate set.
   */
  function createPeoplePicker(containerId, candidates, opts) {
    opts = opts || {};
    const container = document.getElementById(containerId);
    if (!container) return { getValues: () => [], clear: () => {} };

    // `selected` is the source of truth — array of {handle, via} preserving
    // insertion order. `via` for outsiders is "custom".
    const selected = [];

    // Build chrome
    const chipsBox = document.createElement("div");
    chipsBox.className = "picker-chips";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "picker-input";
    input.placeholder = opts.placeholder || "Search or type @handle…";
    input.autocomplete = "off";
    input.autocapitalize = "none";
    input.spellcheck = false;
    const dropdown = document.createElement("ul");
    dropdown.className = "picker-dropdown";
    container.appendChild(chipsBox);
    container.appendChild(input);
    container.appendChild(dropdown);

    function isAlreadySelected(handle) {
      const k = handle.toLowerCase();
      return selected.some((s) => s.handle.toLowerCase() === k);
    }

    function addHandle(handle, via) {
      handle = handle.replace(/^@/, "");
      if (!handle || isAlreadySelected(handle)) return;
      selected.push({ handle: handle, via: via || "custom" });
      renderChips();
      input.value = "";
      renderDropdown();
    }

    function removeHandle(handle) {
      const k = handle.toLowerCase();
      const idx = selected.findIndex((s) => s.handle.toLowerCase() === k);
      if (idx >= 0) {
        selected.splice(idx, 1);
        renderChips();
        renderDropdown();
      }
    }

    function renderChips() {
      chipsBox.innerHTML = "";
      if (!selected.length) {
        const empty = document.createElement("div");
        empty.className = "picker-empty";
        empty.textContent = "Nobody selected yet.";
        chipsBox.appendChild(empty);
        return;
      }
      for (const s of selected) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "picker-chip";
        if (s.via === "custom") chip.classList.add("picker-chip-outsider");
        chip.title = "Click to remove";
        chip.textContent = "@" + s.handle + " ✕";
        chip.addEventListener("click", () => removeHandle(s.handle));
        chipsBox.appendChild(chip);
      }
    }

    // Same handle rule as bot's _HANDLE_RE — relaxed to 4 chars min so
    // test fixtures stay short. Telegram's true minimum is 5.
    const HANDLE_RE = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/;

    function renderDropdown() {
      dropdown.innerHTML = "";
      const q = input.value.trim().toLowerCase().replace(/^@/, "");
      let matches = candidates;
      if (q) {
        matches = candidates.filter((c) =>
          c.handle.toLowerCase().includes(q)
        );
      }
      // Skip already-selected candidates
      matches = matches.filter((c) => !isAlreadySelected(c.handle));

      if (!matches.length) {
        // Offer "Add @handle" if the typed text looks like a valid
        // outsider handle — covers the "person I know isn't on my
        // resolver list" case.
        if (q && HANDLE_RE.test(q)) {
          const li = document.createElement("li");
          li.className = "picker-row picker-row-add";
          li.textContent = "+ Add @" + q + " (not in your contacts)";
          li.addEventListener("click", () => addHandle(q, "custom"));
          dropdown.appendChild(li);
        } else if (q) {
          const li = document.createElement("li");
          li.className = "picker-row picker-row-hint";
          li.textContent = "No match. Try typing the full @handle.";
          dropdown.appendChild(li);
        } else if (!candidates.length) {
          const li = document.createElement("li");
          li.className = "picker-row picker-row-hint";
          li.textContent = "No suggestions yet. Type an @handle to add anyone.";
          dropdown.appendChild(li);
        }
        return;
      }
      for (const c of matches.slice(0, 12)) {
        const li = document.createElement("li");
        li.className = "picker-row";
        const handleEl = document.createElement("span");
        handleEl.className = "picker-row-handle";
        handleEl.textContent = "@" + c.handle;
        const badge = document.createElement("span");
        badge.className = "picker-row-badge picker-via-" + c.via;
        badge.textContent = _viaLabel(c.via);
        li.appendChild(handleEl);
        li.appendChild(badge);
        li.addEventListener("click", () => addHandle(c.handle, c.via));
        dropdown.appendChild(li);
      }
    }

    input.addEventListener("input", renderDropdown);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const q = input.value.trim().replace(/^@/, "");
        if (HANDLE_RE.test(q)) {
          addHandle(q, "custom");
        }
      }
    });

    // Initial render
    renderChips();
    renderDropdown();

    return {
      getValues: () => selected.map((s) => s.handle),
      clear: () => {
        selected.length = 0;
        renderChips();
        renderDropdown();
      },
      // W2.5: bulk-add — used by the "Copy from past trip" header.
      // Each entry is `{handle, via}`. Skips duplicates already in
      // `selected` (preserves the prior selection order).
      addValues: (entries) => {
        for (const e of entries || []) {
          if (!e || !e.handle) continue;
          if (isAlreadySelected(e.handle)) continue;
          selected.push({ handle: e.handle, via: e.via || "custom" });
        }
        renderChips();
        renderDropdown();
      },
    };
  }

  function _viaLabel(via) {
    if (via === "buddy") return "co-traveler";
    if (via === "chat") return "in your chats";
    if (via === "grant") return "place-granted";
    return "added";
  }

  const travelerPicker = createPeoplePicker(
    "traveler-picker",
    PEOPLE_CANDIDATES,
    { placeholder: "Search names or type @handle…" }
  );
  const notifyPicker = createPeoplePicker(
    "notify-picker",
    PEOPLE_CANDIDATES,
    { placeholder: "Search or type @handle…" }
  );
  const approverPicker = createPeoplePicker(
    "approver-picker",
    PEOPLE_CANDIDATES,
    { placeholder: "Search or type @handle…" }
  );
  // W2.5: ride pickers, one per side. Only shown when mode=request
  // is selected via the radio. Same reusable picker as the roster
  // sections — same candidate set + outsider fallback.
  const rideToPicker = createPeoplePicker(
    "ride-to-picker",
    PEOPLE_CANDIDATES,
    { placeholder: "Who's driving you to the airport?" }
  );
  const rideFromPicker = createPeoplePicker(
    "ride-from-picker",
    PEOPLE_CANDIDATES,
    { placeholder: "Who's picking you up?" }
  );
  // Show/hide each ride picker based on its radio. Triggered on
  // change; initial state is hidden (default radio = tbd).
  function wireRideRadios(side) {
    const wrap = document.getElementById("ride-" + side + "-picker-wrap");
    document
      .querySelectorAll('input[name="ride-' + side + '-mode"]')
      .forEach((r) =>
        r.addEventListener("change", () => {
          if (r.checked && r.value === "request") {
            wrap.classList.remove("hidden");
          } else if (r.checked) {
            wrap.classList.add("hidden");
          }
        })
      );
  }
  wireRideRadios("to");
  wireRideRadios("from");

  // ----- W2.5 past-trips header (Copy from a past trip) -----
  // Render up to 5 rows. Each row has a "Copy" button that fills in
  // every form field we can recover from the past trip. Dates are
  // intentionally NOT copied — the whole point of a new trip is new
  // dates. Same for flight number, ride choices.
  function renderPastTrips() {
    const section = document.getElementById("past-trips-section");
    const listEl = document.getElementById("past-trips-list");
    if (!PAST_TRIPS.length) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    listEl.innerHTML = "";
    for (const t of PAST_TRIPS) {
      const row = document.createElement("div");
      row.className = "past-trip-row";
      const summary = document.createElement("div");
      summary.className = "past-trip-summary";
      const title = document.createElement("div");
      title.className = "past-trip-title";
      title.textContent = t.name || "(unnamed)";
      const route = document.createElement("div");
      route.className = "past-trip-route";
      const r = [];
      if (t.origin) r.push("✈️ " + t.origin);
      if (t.dest) r.push("✈️ " + t.dest);
      const peopleCount =
        (t.trav || []).length + (t.appr || []).length + (t.notif || []).length;
      if (peopleCount > 0) r.push(peopleCount + " people");
      route.textContent = r.join(" · ") || "(no route)";
      summary.appendChild(title);
      summary.appendChild(route);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-ghost btn-copy";
      btn.textContent = "Copy →";
      btn.addEventListener("click", () => applyPastTrip(t));
      row.appendChild(summary);
      row.appendChild(btn);
      listEl.appendChild(row);
    }
  }

  /**
   * Apply a past-trip prefill into the wizard form.
   *
   * Sets:
   *   - trip name (prefixed with "Re: ")
   *   - origin/destination by IATA (looks up the full record in
   *     the loaded airports.json so the selection state carries
   *     city/country/region for the renderer)
   *   - traveler / notify / approver pickers (each picker's clear()
   *     before re-adding so successive "Copy" taps don't double up)
   *   - announce-mode + min-approvals radios
   *
   * Does NOT touch dates, flight-info, or ride radios — those are
   * trip-specific and shouldn't carry over.
   */
  function applyPastTrip(t) {
    // 1. Trip name (prefixed so the user knows it's a copy)
    if (t.name) {
      const el = document.getElementById("trip-name");
      el.value = "Re: " + t.name;
      lastAutoFill = el.value;
    }
    // 2. Origin / destination — resolve IATA → full airport record
    if (t.origin && airports.length) {
      const a = airports.find((x) => x.iata === t.origin);
      if (a) {
        selected.origin = a;
        document.getElementById("origin-q").value = "";
        renderPicker("origin");
      }
    }
    if (t.dest && airports.length) {
      const a = airports.find((x) => x.iata === t.dest);
      if (a) {
        selected.destination = a;
        document.getElementById("dest-q").value = "";
        renderPicker("dest");
      }
    }
    // 3. People pickers — clear then bulk-add so successive copies
    //    don't accumulate. `addValues` was added to the picker
    //    factory for exactly this case.
    travelerPicker.clear();
    notifyPicker.clear();
    approverPicker.clear();
    travelerPicker.addValues((t.trav || []).map((h) => ({ handle: h, via: "custom" })));
    notifyPicker.addValues((t.notif || []).map((h) => ({ handle: h, via: "custom" })));
    approverPicker.addValues((t.appr || []).map((h) => ({ handle: h, via: "custom" })));
    // 4. Pin mode + min approvals
    if (t.mode) {
      const radio = document.querySelector(
        'input[name="announce-mode"][value="' + t.mode + '"]'
      );
      if (radio) radio.checked = true;
    }
    if (t.min !== undefined && t.min !== null) {
      const v = t.min === -1 ? "all" : String(t.min);
      const radio = document.querySelector(
        'input[name="min-approvals"][value="' + v + '"]'
      );
      if (radio) radio.checked = true;
    }
    refreshSubmitGate();
    // Scroll up so the user sees the prefill landed.
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  renderPastTrips();

  // ----- submit -----

  submitBtn.addEventListener("click", () => {
    if (submitBtn.disabled) return;
    // W5: resolve the chosen target chat. Picker shown → use its
    // value; "DM only" → null. Picker hidden → fall back to the
    // bot-supplied TARGET_CHAT_ID (legacy /newtrip-from-group path)
    // or null (DM trip).
    let targetChatId = TARGET_CHAT_ID ? Number(TARGET_CHAT_ID) : null;
    if (CHAT_CANDIDATES.length) {
      const picked = pickedRadio("target-chat", "0");
      const n = Number(picked);
      targetChatId = n === 0 ? null : n;
    }
    const payload = {
      type: "m4-wizard",
      ts: Date.now(),
      trip: {
        name: (document.getElementById("trip-name").value || "").trim() ||
              (selected.origin.iata + " → " + selected.destination.iata),
        target_chat_id: targetChatId,
        origin: selected.origin,
        destination: selected.destination,
        start_date: dateStart.value,
        end_date: dateEnd.value || null,
        // W3: roster fields now come from the multi-select pickers.
        // Each picker maintains its own selected set so the same
        // @handle can appear in multiple lists (e.g. a traveler
        // who's also an approver) without one removing the other.
        traveler_handles: travelerPicker.getValues(),
        notify_handles: notifyPicker.getValues(),
        approver_handles: approverPicker.getValues(),
        min_approvals: pickedRadio("min-approvals", "0"),
        announce_mode: pickedRadio("announce-mode", "pinned"),
        // W2.5: flight info + ride asks inline.
        flight_no: (document.getElementById("flight-no").value || "").trim() || null,
        dep_time: document.getElementById("dep-time").value || null,
        arr_time: document.getElementById("arr-time").value || null,
        ride_to: collectRide("to"),
        ride_from: collectRide("from"),
      },
    };
    if (tg && typeof tg.sendData === "function") {
      // `sendData` ONLY works when the Mini App was launched from a
      // reply-keyboard button — Telegram closes the app on success. If
      // it was opened via the menu button or an inline/group button,
      // sendData silently no-ops and the app stays open. So: optimistic
      // "Submitting…", and if we're still alive a beat later, tell the
      // user the one launch that works today (DM /tailtrip). The real
      // fix is a write API endpoint (works from any launch) — tracked.
      submitBtn.disabled = true;
      submitHint.textContent = "Submitting…";
      try {
        tg.sendData(JSON.stringify(payload));
      } catch (e) {
        submitBtn.disabled = false;
        submitHint.textContent =
          "Couldn't submit (" + ((e && e.message) || e) + ").";
        return;
      }
      setTimeout(() => {
        // Still here → the launch context can't sendData.
        submitBtn.disabled = false;
        submitHint.textContent =
          "Couldn't submit from this launch. Open the bot in a DM and " +
          "send /tailtrip there, then create the trip — submitting only " +
          "works from the DM launch for now.";
      }, 2500);
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

  // W2.5: gather the ride selection for one side into the payload shape
  // the bot expects ({mode, asked: [handles]}). The picker's getValues()
  // is only consulted in "request" mode; otherwise asked is empty.
  function collectRide(side) {
    const mode = pickedRadio("ride-" + side + "-mode", "tbd");
    const picker = side === "to" ? rideToPicker : rideFromPicker;
    return {
      mode: mode,
      asked: mode === "request" ? picker.getValues() : [],
    };
  }

  // ----- boot -----
  refreshSubmitGate();
})();
