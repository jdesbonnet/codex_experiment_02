// Timeline Widget (v2) — a fresh, dependency-free implementation.
// Renders a zoomable, pannable, track-based timeline with event clustering,
// adaptive time ticks, optional broken-axis splits, and optional range selection.

const DEFAULTS = {
  orientation: "horizontal",
  minZoom: 0.5,
  maxZoom: 6,
  zoom: 1,
  clusterRadiusPx: 24,
  tickLabelFormatter: null,
  tickMinSpacingPx: 90,
  enableAutoSplits: false,
  manualSplits: [],
  splitThresholdMs: 1000 * 60 * 60 * 24 * 30,
  tracks: [],
  defaultIcon: "●",
  rangeSelection: false,
  onEventRender: null,
};

const SPLIT_GAP_PX = 36;
const DAY_MS = 86400000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Candidate tick steps from finest to coarsest. approxMs is used only to pick a
// granularity; calendar units are then iterated with real date math.
const TICK_STEPS = buildTickSteps();

function buildTickSteps() {
  const out = [];
  const push = (unit, step, approx) => out.push({ unit, step, approxMs: approx * step });
  [1, 2, 5, 10, 20, 50, 100, 200, 500].forEach((s) => push("ms", s, 1));
  [1, 2, 5, 10, 15, 30].forEach((s) => push("sec", s, 1000));
  [1, 2, 5, 10, 15, 30].forEach((s) => push("min", s, 60000));
  [1, 2, 3, 6, 12].forEach((s) => push("hour", s, 3600000));
  [1, 2].forEach((s) => push("day", s, DAY_MS));
  push("week", 1, DAY_MS * 7);
  [1, 3, 6].forEach((s) => push("month", s, DAY_MS * 30.44));
  [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000].forEach((s) => push("year", s, DAY_MS * 365.25));
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class TimelineWidget {
  constructor(container, options = {}) {
    if (!container) throw new Error("TimelineWidget requires a container element");
    this.container = container;
    this.opts = { ...DEFAULTS, ...options };
    this.horizontal = this.opts.orientation !== "vertical";

    this.tracks = (this.opts.tracks && this.opts.tracks.length)
      ? this.opts.tracks.map((t) => ({ id: t.id, label: t.label ?? t.id }))
      : [{ id: "default", label: "" }];

    this.events = [];
    this.zoom = clamp(this.opts.zoom, this.opts.minZoom, this.opts.maxZoom);
    this.centerTime = null;
    this.selection = null; // { start, end }
    this._scroll = 0;
    this._layout = null;
    this._listeners = new Map();

    this._buildDom();
    this._bindEvents();

    this._resizeObserver = new ResizeObserver(() => this.render());
    this._resizeObserver.observe(this.root);

    this.render();
  }

  // ---- public API --------------------------------------------------------

  setEvents(events) {
    this.events = (events || []).map(normalizeEvent);
    this.centerTime = null;
    this.render();
    return this;
  }

  addEvents(events) {
    this.events.push(...(events || []).map(normalizeEvent));
    this.render();
    return this;
  }

  removeEvents(ids) {
    const set = new Set(ids || []);
    this.events = this.events.filter((e) => !set.has(e.id));
    this.render();
    return this;
  }

  setZoom(zoom, anchor) {
    const z = clamp(zoom, this.opts.minZoom, this.opts.maxZoom);
    if (anchor) {
      const lay = this._computeLayout(z);
      let scroll = lay.timeToContentPx(anchor.time) - anchor.px;
      scroll = clampScroll(scroll, lay);
      this.centerTime = lay.contentPxToTime(scroll + lay.available / 2);
    }
    if (z === this.zoom && !anchor) return this;
    this.zoom = z;
    this.render();
    this._emit("zoom", z);
    return this;
  }

  setCenterTime(time) {
    this.centerTime = time;
    this.render();
    this._emit("move", time);
    return this;
  }

  on(name, handler) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(handler);
    return this;
  }

  off(name, handler) {
    this._listeners.get(name)?.delete(handler);
    return this;
  }

  destroy() {
    this._resizeObserver.disconnect();
    this.root.replaceChildren();
    this.root.className = "";
    this._listeners.clear();
  }

  // ---- dom scaffold ------------------------------------------------------

  _buildDom() {
    const root = document.createElement("div");
    root.className = `tlw tlw--${this.horizontal ? "horizontal" : "vertical"}`;

    const axis = document.createElement("div");
    axis.className = "tlw__axis";
    const axisLabel = document.createElement("div");
    axisLabel.className = "tlw__axis-label";
    const scale = document.createElement("div");
    scale.className = "tlw__scale";
    axis.append(axisLabel, scale);

    const tracks = document.createElement("div");
    tracks.className = "tlw__tracks";

    const selection = document.createElement("div");
    selection.className = "tlw__selection";
    selection.hidden = true;
    tracks.appendChild(selection);

    const laneEls = new Map();
    for (const track of this.tracks) {
      const row = document.createElement("div");
      row.className = "tlw__track";
      const label = document.createElement("div");
      label.className = "tlw__label";
      label.textContent = track.label || "";
      const lane = document.createElement("div");
      lane.className = "tlw__lane";
      lane.dataset.track = track.id;
      row.append(label, lane);
      tracks.appendChild(row);
      laneEls.set(track.id, lane);
    }

    const empty = document.createElement("div");
    empty.className = "tlw__empty";
    empty.textContent = "No events";
    empty.hidden = true;
    tracks.appendChild(empty);

    root.append(axis, tracks);
    this.container.appendChild(root);

    this.root = root;
    this.scaleEl = scale;
    this.tracksEl = tracks;
    this.selectionEl = selection;
    this.laneEls = laneEls;
    this.emptyEl = empty;
    this.axisLabelEl = axisLabel;
  }

  _refLane() {
    return this.laneEls.values().next().value;
  }

  _bindEvents() {
    // Pan by dragging across the lanes.
    this.tracksEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".tlw__marker")) return;
      if (!this._layout) return;
      this.tracksEl.setPointerCapture(e.pointerId);
      const startCoord = this._coord(e);
      const startScroll = this._scroll;
      const onMove = (ev) => {
        const delta = this._coord(ev) - startCoord;
        let scroll = clampScroll(startScroll - delta, this._layout);
        this.centerTime = this._layout.contentPxToTime(scroll + this._layout.available / 2);
        this.render();
        this._emit("move", this.centerTime);
      };
      const onUp = (ev) => {
        this.tracksEl.releasePointerCapture(e.pointerId);
        this.tracksEl.removeEventListener("pointermove", onMove);
        this.tracksEl.removeEventListener("pointerup", onUp);
        ev.target.closest(".tlw__lane")?.classList.remove("is-grabbing");
      };
      e.target.closest(".tlw__lane")?.classList.add("is-grabbing");
      this.tracksEl.addEventListener("pointermove", onMove);
      this.tracksEl.addEventListener("pointerup", onUp);
    });

    // Zoom toward the cursor with the wheel.
    this.root.addEventListener("wheel", (e) => {
      if (!this._layout) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const px = this._coord(e);
      const time = this._layout.contentPxToTime(this._scroll + px);
      this.setZoom(this.zoom * factor, { px, time });
    }, { passive: false });

    // Range selection by dragging on the time axis.
    this.scaleEl.addEventListener("pointerdown", (e) => {
      if (!this.opts.rangeSelection || !this._layout) return;
      this.scaleEl.setPointerCapture(e.pointerId);
      const startPx = this._coord(e, this.scaleEl);
      const startTime = this._layout.contentPxToTime(this._scroll + startPx);
      let moved = false;
      const onMove = (ev) => {
        moved = true;
        const px = this._coord(ev, this.scaleEl);
        const t = this._layout.contentPxToTime(this._scroll + px);
        this.selection = { start: Math.min(startTime, t), end: Math.max(startTime, t) };
        this._renderSelection();
      };
      const onUp = () => {
        this.scaleEl.releasePointerCapture(e.pointerId);
        this.scaleEl.removeEventListener("pointermove", onMove);
        this.scaleEl.removeEventListener("pointerup", onUp);
        if (!moved) { this.selection = null; this._renderSelection(); }
      };
      this.scaleEl.addEventListener("pointermove", onMove);
      this.scaleEl.addEventListener("pointerup", onUp);
    });
  }

  // Main-axis coordinate of a pointer event, relative to a reference element.
  _coord(e, ref) {
    const el = ref || this._refLane();
    const rect = el.getBoundingClientRect();
    return this.horizontal ? e.clientX - rect.left : e.clientY - rect.top;
  }

  _available() {
    const lane = this._refLane();
    const rect = lane.getBoundingClientRect();
    return this.horizontal ? rect.width : rect.height;
  }

  // ---- layout ------------------------------------------------------------

  _extent() {
    let min = Infinity;
    let max = -Infinity;
    for (const e of this.events) {
      min = Math.min(min, e.start);
      max = Math.max(max, e.end);
    }
    if (!isFinite(min)) return null;
    if (min === max) { min -= DAY_MS; max += DAY_MS; }
    const pad = (max - min) * 0.04;
    return [min - pad, max + pad];
  }

  _segments(extent) {
    let segs = [{ start: extent[0], end: extent[1] }];

    if (this.opts.enableAutoSplits && this.events.length) {
      const intervals = this.events
        .map((e) => [e.start, e.end])
        .sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const [s, en] of intervals) {
        const last = merged[merged.length - 1];
        if (last && s - last[1] <= this.opts.splitThresholdMs) {
          last[1] = Math.max(last[1], en);
        } else {
          merged.push([s, en]);
        }
      }
      const pad = Math.min((extent[1] - extent[0]) * 0.02, this.opts.splitThresholdMs / 4);
      segs = merged.map(([s, en], i) => ({
        start: i === 0 ? extent[0] : s - pad,
        end: i === merged.length - 1 ? extent[1] : en + pad,
      }));
    }

    for (const raw of [...this.opts.manualSplits].sort((a, b) => a - b)) {
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (raw > seg.start && raw < seg.end) {
          segs.splice(i, 1, { start: seg.start, end: raw }, { start: raw, end: seg.end });
          break;
        }
      }
    }
    return segs;
  }

  _computeLayout(zoom) {
    const available = this._available();
    const extent = this._extent();
    if (!extent || available <= 0) return null;

    const segments = this._segments(extent);
    const totalMs = segments.reduce((sum, s) => sum + (s.end - s.start), 0) || 1;
    const gapTotal = (segments.length - 1) * SPLIT_GAP_PX;
    const basePxPerMs = Math.max(0, available - gapTotal) / totalMs;
    const scale = basePxPerMs * zoom;

    let cursor = 0;
    for (const seg of segments) {
      seg.pxStart = cursor;
      seg.pxEnd = cursor + (seg.end - seg.start) * scale;
      cursor = seg.pxEnd + SPLIT_GAP_PX;
    }
    const contentLength = cursor - (segments.length ? SPLIT_GAP_PX : 0);

    return {
      segments,
      scale,
      available,
      contentLength,
      timeToContentPx(t) {
        for (const seg of segments) {
          if (t < seg.start) return seg.pxStart;
          if (t <= seg.end) return seg.pxStart + (t - seg.start) * scale;
        }
        return segments[segments.length - 1].pxEnd;
      },
      contentPxToTime(px) {
        const p = clamp(px, 0, contentLength);
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          if (p <= seg.pxEnd) {
            const t = seg.start + Math.max(0, p - seg.pxStart) / scale;
            return clamp(t, seg.start, seg.end);
          }
          const next = segments[i + 1];
          if (next && p < next.pxStart) {
            return p - seg.pxEnd < next.pxStart - p ? seg.end : next.start;
          }
        }
        return segments[segments.length - 1].end;
      },
    };
  }

  // ---- rendering ---------------------------------------------------------

  render() {
    const hasEvents = this.events.length > 0;
    this.emptyEl.hidden = hasEvents;
    for (const lane of this.laneEls.values()) lane.replaceChildren();
    this.scaleEl.replaceChildren();

    if (!hasEvents) { this._layout = null; return; }

    const layout = this._computeLayout(this.zoom);
    this._layout = layout;
    if (!layout) return;

    if (this.centerTime == null) {
      this.centerTime = layout.contentPxToTime(layout.contentLength / 2);
    }
    const centerPx = layout.timeToContentPx(this.centerTime);
    this._scroll = clampScroll(centerPx - layout.available / 2, layout);

    this._renderTicks(layout);
    this._renderSplits(layout);
    this._renderMarkers(layout);
    this._renderSelection();
  }

  _viewPx(layout, contentPx) {
    return contentPx - this._scroll;
  }

  _renderTicks(layout) {
    const step = pickTickStep(layout.scale, this.opts.tickMinSpacingPx);
    const frag = document.createDocumentFragment();
    for (const seg of layout.segments) {
      let t = floorAlign(seg.start, step.unit, step.step);
      if (t < seg.start) t = increment(t, step.unit, step.step);
      let guard = 0;
      while (t <= seg.end && guard++ < 2000) {
        const view = this._viewPx(layout, layout.timeToContentPx(t));
        if (view >= -1 && view <= layout.available + 1) {
          const tick = document.createElement("div");
          tick.className = "tlw__tick";
          this._place(tick, view);
          const label = document.createElement("span");
          label.className = "tlw__tick-label";
          label.textContent = this.opts.tickLabelFormatter
            ? this.opts.tickLabelFormatter(t, { unit: step.unit, step: step.step, approxMs: step.approxMs })
            : defaultLabel(t, step.unit);
          tick.appendChild(label);
          frag.appendChild(tick);
        }
        t = increment(t, step.unit, step.step);
      }
    }
    this.scaleEl.appendChild(frag);
  }

  _renderSplits(layout) {
    for (let i = 0; i < layout.segments.length - 1; i++) {
      const seg = layout.segments[i];
      const view = this._viewPx(layout, seg.pxEnd + SPLIT_GAP_PX / 2);
      if (view < 0 || view > layout.available) continue;
      const brk = document.createElement("div");
      brk.className = "tlw__break";
      this._place(brk, view);
      this.scaleEl.appendChild(brk);
    }
  }

  _renderMarkers(layout) {
    for (const track of this.tracks) {
      const lane = this.laneEls.get(track.id);
      const frag = document.createDocumentFragment();
      const inTrack = this.events.filter((e) => e.trackId === track.id);

      // Range events render as bars.
      for (const e of inTrack.filter((e) => e.type === "range")) {
        const a = this._viewPx(layout, layout.timeToContentPx(e.start));
        const b = this._viewPx(layout, layout.timeToContentPx(e.end));
        if (b < 0 || a > layout.available) continue;
        const bar = document.createElement("button");
        bar.type = "button";
        bar.className = "tlw__marker tlw__range";
        bar.title = e.title || "";
        const lo = Math.min(a, b);
        const len = Math.max(2, Math.abs(b - a));
        if (this.horizontal) { bar.style.left = `${lo}px`; bar.style.width = `${len}px`; }
        else { bar.style.top = `${lo}px`; bar.style.height = `${len}px`; }
        bar.addEventListener("click", (ev) => { ev.stopPropagation(); this._emit("select", e.raw); });
        this._afterRender(bar, { items: [e.raw], count: 1, time: e.start, px: lo });
        frag.appendChild(bar);
      }

      // Point events cluster by pixel proximity.
      const points = inTrack
        .filter((e) => e.type === "point")
        .map((e) => ({ e, px: this._viewPx(layout, layout.timeToContentPx(e.start)) }))
        .sort((p, q) => p.px - q.px);

      const clusters = [];
      for (const p of points) {
        const last = clusters[clusters.length - 1];
        if (last && p.px - last.px <= this.opts.clusterRadiusPx) {
          last.items.push(p.e);
          last.sum += p.px;
          last.px = last.sum / last.items.length;
        } else {
          clusters.push({ items: [p.e], sum: p.px, px: p.px });
        }
      }

      for (const c of clusters) {
        if (c.px < -this.opts.clusterRadiusPx || c.px > layout.available + this.opts.clusterRadiusPx) continue;
        const marker = document.createElement("button");
        marker.type = "button";
        const single = c.items.length === 1;
        marker.className = `tlw__marker${single ? "" : " tlw__cluster"}`;
        marker.title = single ? (c.items[0].title || "") : `${c.items.length} events`;
        marker.textContent = single ? (c.items[0].icon || this.opts.defaultIcon) : String(c.items.length);
        this._place(marker, c.px, true);
        marker.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (single) {
            this._emit("select", c.items[0].raw);
          } else {
            this.setZoom(this.zoom * 1.8, { px: c.px, time: this._layout.contentPxToTime(this._scroll + c.px) });
          }
        });
        const cluster = { items: c.items.map((i) => i.raw), count: c.items.length, time: c.items[0].start, px: c.px };
        this._afterRender(marker, cluster);
        frag.appendChild(marker);
      }

      lane.appendChild(frag);
    }
  }

  _renderSelection() {
    const layout = this._layout;
    if (!this.opts.rangeSelection || !this.selection || !layout) {
      this.selectionEl.hidden = true;
      return;
    }
    const a = this._viewPx(layout, layout.timeToContentPx(this.selection.start));
    const b = this._viewPx(layout, layout.timeToContentPx(this.selection.end));
    const lo = Math.min(a, b);
    const len = Math.max(1, Math.abs(b - a));
    this.selectionEl.hidden = false;
    if (this.horizontal) {
      this.selectionEl.style.transform = `translateX(${lo}px)`;
      this.selectionEl.style.width = `${len}px`;
    } else {
      this.selectionEl.style.transform = `translateY(${lo}px)`;
      this.selectionEl.style.height = `${len}px`;
    }
  }

  // Position an element along the main axis; `center` translates it to center on the point.
  _place(el, px, center = false) {
    if (this.horizontal) {
      el.style.left = `${px}px`;
      if (center) el.style.transform = "translate(-50%, -50%)";
    } else {
      el.style.top = `${px}px`;
      if (center) el.style.transform = "translate(-50%, -50%)";
    }
  }

  _afterRender(el, cluster) {
    if (typeof this.opts.onEventRender === "function") {
      this.opts.onEventRender(el, cluster);
    }
  }

  _emit(name, payload) {
    this._listeners.get(name)?.forEach((fn) => fn(payload));
  }
}

// ---- helpers -------------------------------------------------------------

function normalizeEvent(raw) {
  const isPoint = raw.time != null;
  const start = isPoint ? raw.time : raw.start;
  const end = isPoint ? raw.time : (raw.end ?? raw.start);
  return {
    id: raw.id,
    type: isPoint ? "point" : "range",
    start,
    end,
    title: raw.title,
    icon: raw.icon,
    trackId: raw.trackId ?? "default",
    raw,
  };
}

function clampScroll(scroll, layout) {
  if (!layout) return 0;
  if (layout.contentLength <= layout.available) {
    return (layout.contentLength - layout.available) / 2;
  }
  return clamp(scroll, 0, layout.contentLength - layout.available);
}

function pickTickStep(scale, minSpacing) {
  for (const s of TICK_STEPS) {
    if (s.approxMs * scale >= minSpacing) return s;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

function floorAlign(t, unit, step) {
  const d = new Date(t);
  switch (unit) {
    case "ms": return Math.floor(t / step) * step;
    case "sec": d.setMilliseconds(0); d.setSeconds(Math.floor(d.getSeconds() / step) * step); return d.getTime();
    case "min": d.setMilliseconds(0); d.setSeconds(0); d.setMinutes(Math.floor(d.getMinutes() / step) * step); return d.getTime();
    case "hour": d.setMilliseconds(0); d.setSeconds(0); d.setMinutes(0); d.setHours(Math.floor(d.getHours() / step) * step); return d.getTime();
    case "day": d.setHours(0, 0, 0, 0); return d.getTime();
    case "week": d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); return d.getTime();
    case "month": d.setHours(0, 0, 0, 0); d.setDate(1); d.setMonth(Math.floor(d.getMonth() / step) * step); return d.getTime();
    case "year": d.setHours(0, 0, 0, 0); d.setMonth(0); d.setDate(1); d.setFullYear(Math.floor(d.getFullYear() / step) * step); return d.getTime();
    default: return t;
  }
}

function increment(t, unit, step) {
  const d = new Date(t);
  switch (unit) {
    case "ms": return t + step;
    case "sec": return t + step * 1000;
    case "min": return t + step * 60000;
    case "hour": return t + step * 3600000;
    case "day": d.setDate(d.getDate() + step); return d.getTime();
    case "week": d.setDate(d.getDate() + 7 * step); return d.getTime();
    case "month": d.setMonth(d.getMonth() + step); return d.getTime();
    case "year": d.setFullYear(d.getFullYear() + step); return d.getTime();
    default: return t + step;
  }
}

function defaultLabel(t, unit) {
  const d = new Date(t);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  switch (unit) {
    case "ms": return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    case "sec": return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    case "min":
    case "hour": return `${p(d.getHours())}:${p(d.getMinutes())}`;
    case "day":
    case "week": return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
    case "month": return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    case "year": return String(d.getFullYear());
    default: return new Date(t).toISOString();
  }
}
