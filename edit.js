/* TailTrip Mini App — M7 Sequenced Editor.
 *
 * Renders the trip's leg chain from a base64-encoded snapshot in the
 * URL `?snapshot=…` param (same codec as board.js — keep mirrored
 * with bot/board_snapshot.py::decode_url_param).
 *
 * Per-row Remove → Telegram.WebApp.sendData({type: "edit-remove",
 * trip_id, leg_id}) → bot deletes + sends a fresh button.
 * Refresh round-trip uses {type: "edit-refresh"} same way.
 *
 * Add / per-leg edit are intentionally NOT in this Mini App view —
 * those live in the chat-side travel menu (per design: "Add and edit
 * individual legs redirect to existing chat menus for this push;
 * reorder via dep_at swap deferred").
 */

(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  // ----- decode snapshot (mirror of board.js) -----

  function decode(param) {
    if (!param) return null;
    const padded = param + "=".repeat((4 - (param.length % 4)) % 4);
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
  const chainEl = document.getElementById("chain");
  const emptyEl = document.getElementById("empty");
  const errorEl = document.getElementById("error");

  if (!snapshot) {
    errorEl.classList.remove("hidden");
    return;
  }

  // ----- header -----

  tripNameEl.textContent = snapshot.trip.name || "(unnamed trip)";
  const legCount = snapshot.legs.length;
  tripMetaEl.textContent =
    snapshot.trip.status +
    " · " +
    (legCount === 1 ? "1 leg" : legCount + " legs");

  // ----- chain rendering -----

  if (snapshot.legs.length === 0) {
    emptyEl.classList.remove("hidden");
  } else {
    renderChain(snapshot);
  }

  // ----- refresh / close -----

  document.getElementById("refresh").addEventListener("click", () => {
    if (tg) {
      tg.sendData(
        JSON.stringify({
          type: "edit-refresh",
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

  /**
   * Build a list of Place rows interleaved with the Travel events
   * that connect them. We walk the legs in dep_at order and emit:
   *
   *   place(from_place_id)
   *     travel(leg #1)
   *   place(to_place_id == from of next leg)
   *     travel(leg #2)
   *   place(to_place_id of leg #2)
   *
   * Where a leg's from/to place_id is null (TBD), we emit a "?" row.
   * Where two adjacent legs don't share a place (e.g. one leg lands at
   * SEA and the next starts at PAE with no connecting drive), we emit
   * BOTH endpoints so the chain stays honest.
   */
  function renderChain(snap) {
    const placeById = new Map();
    for (const p of snap.places) placeById.set(p.id, p);

    let placeNum = 1;
    let prevPlaceId = null;

    for (let i = 0; i < snap.legs.length; i++) {
      const leg = snap.legs[i];

      // Emit a Place row for the leg's origin if it differs from the
      // previous leg's destination (or if this is the first leg).
      if (leg.from_place !== prevPlaceId) {
        const p = leg.from_place ? placeById.get(leg.from_place) : null;
        chainEl.appendChild(renderPlace(placeNum++, p, leg.from_iata));
      }

      // Emit the Travel row
      chainEl.appendChild(renderTravel(leg, snap.trip.id));

      // The next iteration's prev = this leg's destination
      prevPlaceId = leg.to_place;

      // If this is the LAST leg, emit its destination place too.
      if (i === snap.legs.length - 1) {
        const p = leg.to_place ? placeById.get(leg.to_place) : null;
        chainEl.appendChild(renderPlace(placeNum++, p, leg.to_iata));
      }
    }
  }

  function renderPlace(num, p, fallbackIata) {
    const row = el("div", "place-row");

    const numEl = el("div", "place-num");
    numEl.textContent = "[" + num + "]";

    const body = el("div", "place-body");
    const nameEl = el("div", "place-name");
    if (p) {
      const iconEl = el("span", "icon");
      iconEl.textContent = p.icon || "📍";
      nameEl.appendChild(iconEl);
      nameEl.appendChild(document.createTextNode(p.name));
    } else if (fallbackIata) {
      const iconEl = el("span", "icon");
      iconEl.textContent = "✈️";
      nameEl.appendChild(iconEl);
      nameEl.appendChild(document.createTextNode(fallbackIata));
    } else {
      nameEl.textContent = "? (TBD)";
    }
    body.appendChild(nameEl);

    if (p && p.where) {
      const whereEl = el("div", "place-where");
      whereEl.textContent = p.where;
      body.appendChild(whereEl);
    }

    row.appendChild(numEl);
    row.appendChild(body);
    return row;
  }

  function renderTravel(leg, tripId) {
    const row = el("div", "travel-row");
    if (leg.is_request) row.classList.add("is-request");

    const iconEl = el("div", "travel-icon");
    iconEl.textContent = modeGlyph(leg.mode);

    const body = el("div", "travel-body");

    const summary = el("div", "travel-summary");
    if (leg.from_iata) {
      const fromI = el("span", "iata");
      fromI.textContent = leg.from_iata;
      summary.appendChild(fromI);
    }
    const arrow = document.createElement("span");
    arrow.textContent = "→";
    summary.appendChild(arrow);
    if (leg.to_iata) {
      const toI = el("span", "iata");
      toI.textContent = leg.to_iata;
      summary.appendChild(toI);
    } else if (!leg.from_iata) {
      // Non-flight (drive/walk/etc) without IATA — show the mode label.
      const label = document.createElement("span");
      label.textContent = modeLabel(leg.mode);
      summary.appendChild(label);
    }
    if (leg.flight_no) {
      const fn = el("span", "flight-no");
      fn.textContent = leg.flight_no;
      summary.appendChild(fn);
    }
    body.appendChild(summary);

    const meta = el("div", "travel-meta");
    const metaBits = [];
    if (leg.dep_at) metaBits.push(formatDate(leg.dep_at));
    if (leg.is_request) {
      const reqTag = el("span", "open-request-tag");
      reqTag.textContent = "🆘 ride request";
      meta.appendChild(reqTag);
      if (metaBits.length) meta.appendChild(document.createTextNode(" · "));
    }
    if (leg.operator) metaBits.push("op: " + leg.operator);
    if (leg.passenger_count) {
      metaBits.push(
        leg.passenger_count + " pax" +
        (leg.capacity_seats ? "/" + leg.capacity_seats : "")
      );
    }
    if (metaBits.length) {
      meta.appendChild(document.createTextNode(metaBits.join(" · ")));
    }
    body.appendChild(meta);

    const removeBtn = document.createElement("button");
    removeBtn.className = "travel-remove";
    removeBtn.textContent = "✕ Remove";
    removeBtn.addEventListener("click", () => onRemove(leg, tripId, row));

    row.appendChild(iconEl);
    row.appendChild(body);
    row.appendChild(removeBtn);
    return row;
  }

  function onRemove(leg, tripId, rowEl) {
    // Visual feedback before sendData closes the app
    const banner = el("div", "removing-banner");
    banner.textContent =
      "🗑 Removing leg " + (leg.from_iata || "?") + " → " +
      (leg.to_iata || "?") + "…";
    rowEl.replaceWith(banner);

    const payload = {
      type: "edit-remove",
      trip_id: tripId,
      leg_id: leg.id,
    };
    if (tg) {
      tg.sendData(JSON.stringify(payload));
    } else {
      alert("Not in Telegram; payload:\n" + JSON.stringify(payload, null, 2));
    }
  }

  // ===== glyph helpers (mirror board.js — keep in sync) =====

  function modeGlyph(mode) {
    switch (mode) {
      case "flight": return "✈️";
      case "drive":  return "🚗";
      case "train":  return "🚆";
      case "boat":   return "⛴";
      case "walk":   return "🚶";
      default:       return "⋯";
    }
  }

  function modeLabel(mode) {
    switch (mode) {
      case "flight": return "flight";
      case "drive":  return "drive";
      case "train":  return "train";
      case "boat":   return "boat";
      case "walk":   return "walk";
      default:       return "other";
    }
  }

  function formatDate(iso) {
    const d = new Date(iso);
    const month = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ][d.getUTCMonth()];
    const day = d.getUTCDate();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return month + " " + day + " " + hh + ":" + mm + " UTC";
  }

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
})();
