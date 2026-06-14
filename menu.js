/* TailTrip Mini App — main menu (#125).
 *
 * The "do everything from here" home, opened by /openapp. Reads:
 *   ?api=<base>   — the read-only API base URL (#124). Without it, the
 *                   data cards degrade to a "not connected" hint.
 *   ?chats=, ?people=, ?past=, ?target=, ?target_name=
 *                 — wizard pass-through params, forwarded to index.html
 *                   when the user taps "Plan a trip".
 *
 * Auth: forwards Telegram.WebApp.initData in the X-Telegram-Init-Data
 * header on every API call (the bot verifies its HMAC; see web/auth.py).
 *
 * Vanilla JS to match the rest of webapp/ — no build step, no framework.
 */

(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  const params = new URLSearchParams(window.location.search);
  const API = (params.get("api") || "").replace(/\/+$/, "");
  const initData = (tg && tg.initData) || "";

  // ----- helpers -----

  function el(id) {
    return document.getElementById(id);
  }

  async function apiGet(path) {
    // Returns parsed JSON, or throws. Caller handles the offline state.
    if (!API) throw new Error("no-api");
    const res = await fetch(API + path, {
      headers: { "X-Telegram-Init-Data": initData },
    });
    if (!res.ok) throw new Error("http-" + res.status);
    return res.json();
  }

  function row({ glyph, title, sub, onClick }) {
    const b = document.createElement("button");
    b.className = "row";
    b.innerHTML =
      '<span class="row-glyph"></span>' +
      '<span class="row-body"><span class="row-title"></span>' +
      '<span class="row-sub"></span></span>' +
      '<span class="row-chev">›</span>';
    b.querySelector(".row-glyph").textContent = glyph || "•";
    b.querySelector(".row-title").textContent = title || "";
    const subEl = b.querySelector(".row-sub");
    if (sub) subEl.textContent = sub;
    else subEl.remove();
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  const STATUS_GLYPH = {
    requested: "⚪",
    negotiating: "🟠",
    agreed: "🟢",
    booked: "🎫",
    travelling: "✈️",
    arrived: "🛬",
    closed: "▫️",
    cancelled: "❌",
  };

  function tripSub(t) {
    const bits = [];
    if (t.status) bits.push(t.status);
    if (t.hosts) bits.push("hosts " + t.hosts.have + "/" + t.hosts.need);
    if (t.pax) bits.push("pax " + t.pax.have + "/" + t.pax.need);
    return bits.join(" · ");
  }

  // ----- navigation -----

  function openWizard() {
    // Forward the wizard pass-through params to index.html.
    const fwd = new URLSearchParams();
    ["chats", "people", "past", "target", "target_name"].forEach((k) => {
      const v = params.get(k);
      if (v) fwd.set(k, v);
    });
    const qs = fwd.toString();
    window.location.href = "index.html" + (qs ? "?" + qs : "");
  }

  function openBoard(tripId) {
    const fwd = new URLSearchParams();
    fwd.set("trip_id", tripId);
    if (API) fwd.set("api", API);
    window.location.href = "board.html?" + fwd.toString();
  }

  el("new-trip").addEventListener("click", openWizard);
  el("copy-trip").addEventListener("click", openWizard);
  el("settings-btn").addEventListener("click", function () {
    // Settings panel is a later card; for now nudge to the wizard/chat.
    if (tg) tg.showAlert("Settings are coming to the app — use /settings in chat for now.");
  });

  // ----- offline (no API) state -----

  function goOffline() {
    el("offline-note").classList.remove("hidden");
    el("trips-card").classList.add("hidden");
    el("inbox-card").classList.add("hidden");
    el("search-card").classList.add("hidden");
  }

  // ----- render: menu (trips) -----

  function renderTrips(data) {
    const who = el("who");
    if (data.user && data.user.username) who.textContent = "@" + data.user.username;

    const list = el("trips-list");
    list.innerHTML = "";
    const trips = data.trips || [];
    if (!trips.length) {
      el("trips-empty").classList.remove("hidden");
      return;
    }
    el("trips-empty").classList.add("hidden");
    trips.forEach((t) => {
      list.appendChild(
        row({
          glyph: STATUS_GLYPH[t.status] || "•",
          title: t.name || "(unnamed trip)",
          sub: tripSub(t),
          onClick: () => openBoard(t.trip_id),
        })
      );
    });
  }

  // ----- render: inbox -----

  function renderInbox(data) {
    const items = data.items || [];
    const badge = el("inbox-count");
    const list = el("inbox-list");
    list.innerHTML = "";
    if (!items.length) {
      el("inbox-empty").classList.remove("hidden");
      badge.classList.add("hidden");
      return;
    }
    el("inbox-empty").classList.add("hidden");
    badge.textContent = String(items.length);
    badge.classList.remove("hidden");
    const glyphFor = { approval: "🟡", ride_confirm: "🚗" };
    items.forEach((it) => {
      list.appendChild(
        row({
          glyph: glyphFor[it.kind] || "🔔",
          title: it.trip_name || "(trip)",
          sub: it.detail || "",
          onClick: () => openBoard(it.trip_id),
        })
      );
    });
  }

  // ----- render: search -----

  let searchTimer = null;
  el("search-input").addEventListener("input", function (e) {
    const q = e.target.value.trim();
    clearTimeout(searchTimer);
    if (!q) {
      el("search-results").innerHTML = "";
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 250);
  });

  async function runSearch(q) {
    const out = el("search-results");
    try {
      const data = await apiGet("/api/search?q=" + encodeURIComponent(q));
      out.innerHTML = "";
      (data.trips || []).forEach((t) => {
        out.appendChild(
          row({
            glyph: STATUS_GLYPH[t.status] || "🧭",
            title: t.name || "(unnamed)",
            sub: t.status,
            onClick: () => openBoard(t.trip_id),
          })
        );
      });
      (data.places || []).forEach((p) => {
        out.appendChild(
          row({
            glyph: p.icon || "📍",
            title: p.name,
            sub: p.city || "place",
            onClick: () => openBoard(p.trip_id),
          })
        );
      });
      if (!out.children.length) {
        out.appendChild(row({ glyph: "🔍", title: "No matches for “" + q + "”" }));
      }
    } catch (err) {
      out.innerHTML = "";
      out.appendChild(row({ glyph: "⚠️", title: "Search unavailable" }));
    }
  }

  // ----- boot -----

  async function boot() {
    if (!API) {
      goOffline();
      return;
    }
    try {
      const [menu, inbox] = await Promise.all([
        apiGet("/api/menu"),
        apiGet("/api/inbox").catch(() => ({ items: [] })),
      ]);
      renderTrips(menu);
      renderInbox(inbox);
    } catch (err) {
      // API configured but unreachable / unauthorized → offline hint.
      goOffline();
    }
  }

  boot();
})();
