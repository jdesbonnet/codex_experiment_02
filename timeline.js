const DEFAULTS = {
  orientation: "horizontal",
  minZoom: 0.5,
  maxZoom: 6,
  zoom: 1,
  clusterRadiusPx: 24,
  enableAutoSplits: false,
  manualSplits: [],
  splitThresholdMs: 1000 * 60 * 60 * 24 * 30,
  tracks: [],
  defaultIcon: "●",
  rangeSelection: false,
  onEventRender: null
};

export class TimelineWidget {
  constructor(container, options = {}) {
    if (!container) {
      throw new Error("TimelineWidget requires a container element.");
    }

    this.container = container;
    this.options = { ...DEFAULTS, ...options };
    this.events = [];
    this.tracks = this.options.tracks;
    this.listeners = new Map();
    this.zoom = this.options.zoom;
    this.currentCenter = null;
    this.rangeSelection = {
      start: null,
      end: null
    };

    this.handleZoomIn = this.handleZoomIn.bind(this);
    this.handleZoomOut = this.handleZoomOut.bind(this);
    this.handleSliderInput = this.handleSliderInput.bind(this);
    this.handleWheel = this.handleWheel.bind(this);

    this.render();
  }

  on(eventName, handler) {
    const handlers = this.listeners.get(eventName) ?? new Set();
    handlers.add(handler);
    this.listeners.set(eventName, handlers);
  }

  off(eventName, handler) {
    const handlers = this.listeners.get(eventName);
    if (!handlers) {
      return;
    }
    handlers.delete(handler);
  }

  emit(eventName, payload) {
    const handlers = this.listeners.get(eventName);
    if (!handlers) {
      return;
    }
    handlers.forEach((handler) => handler(payload));
  }

  setEvents(events) {
    this.events = [...events];
    this.syncRange();
    this.renderTimeline();
  }

  addEvents(events) {
    this.events = [...this.events, ...events];
    this.syncRange();
    this.renderTimeline();
  }

  removeEvents(ids) {
    const idSet = new Set(ids);
    this.events = this.events.filter((event) => !idSet.has(event.id));
    this.syncRange();
    this.renderTimeline();
  }

  setZoom(zoom) {
    const clampedZoom = Math.max(this.options.minZoom, Math.min(this.options.maxZoom, zoom));
    if (clampedZoom === this.zoom) {
      return;
    }
    this.zoom = clampedZoom;
    this.updateSlider();
    this.renderTimeline();
    this.emit("zoom", this.zoom);
  }

  setCenterTime(time) {
    this.currentCenter = time;
    this.updateSlider();
    this.renderTimeline();
    this.emit("move", time);
  }

  destroy() {
    this.container.innerHTML = "";
    this.listeners.clear();
  }

  render() {
    this.container.innerHTML = "";
    this.root = document.createElement("div");
    this.root.className = `timeline-widget ${this.options.orientation}`;

    this.controls = document.createElement("div");
    this.controls.className = "timeline-controls";

    this.zoomOutButton = document.createElement("button");
    this.zoomOutButton.type = "button";
    this.zoomOutButton.textContent = "-";
    this.zoomOutButton.addEventListener("click", this.handleZoomOut);

    this.zoomInButton = document.createElement("button");
    this.zoomInButton.type = "button";
    this.zoomInButton.textContent = "+";
    this.zoomInButton.addEventListener("click", this.handleZoomIn);

    this.slider = document.createElement("input");
    this.slider.type = "range";
    this.slider.min = "0";
    this.slider.max = "1000";
    this.slider.value = "500";
    this.slider.addEventListener("input", this.handleSliderInput);

    this.controls.append(this.zoomOutButton, this.zoomInButton, this.slider);

    this.viewport = document.createElement("div");
    this.viewport.className = "timeline-viewport";
    this.viewport.addEventListener("wheel", this.handleWheel, { passive: false });

    this.root.append(this.controls, this.viewport);
    this.container.append(this.root);

    this.syncRange();
    this.renderTimeline();
  }

  syncRange() {
    if (!this.events.length) {
      const now = Date.now();
      this.minTime = now - 1000 * 60 * 60 * 24 * 7;
      this.maxTime = now + 1000 * 60 * 60 * 24 * 7;
      this.currentCenter = now;
      return;
    }

    const times = this.events.flatMap((event) =>
      event.start != null ? [event.start, event.end ?? event.start] : [event.time]
    );
    this.minTime = Math.min(...times);
    this.maxTime = Math.max(...times);

    if (this.currentCenter == null) {
      this.currentCenter = (this.minTime + this.maxTime) / 2;
    }
  }

  getViewWindow() {
    const fullRange = this.maxTime - this.minTime;
    const viewRange = fullRange / this.zoom;
    const center = this.currentCenter ?? (this.minTime + this.maxTime) / 2;
    return {
      start: center - viewRange / 2,
      end: center + viewRange / 2,
      range: viewRange
    };
  }

  updateSlider() {
    const total = this.maxTime - this.minTime;
    if (!Number.isFinite(total) || total === 0) {
      return;
    }
    const value = ((this.currentCenter - this.minTime) / total) * 1000;
    this.slider.value = String(Math.min(1000, Math.max(0, value)));
  }

  handleZoomIn() {
    this.setZoom(this.zoom + 0.5);
  }

  handleZoomOut() {
    this.setZoom(this.zoom - 0.5);
  }

  handleSliderInput(event) {
    const value = Number(event.target.value) / 1000;
    const center = this.minTime + value * (this.maxTime - this.minTime);
    this.setCenterTime(center);
  }

  handleWheel(event) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const delta = event.deltaY > 0 ? -0.2 : 0.2;
      this.setZoom(this.zoom + delta);
      return;
    }

    const delta = event.deltaY;
    const range = this.maxTime - this.minTime;
    const shift = (delta / 500) * range;
    this.setCenterTime(this.currentCenter + shift);
  }

  renderTimeline() {
    this.viewport.innerHTML = "";
    const { start, end, range } = this.getViewWindow();
    const size = this.options.orientation === "horizontal" ? this.viewport.clientWidth : this.viewport.clientHeight;
    const pixelsPerMs = size / range;

    const tracks = this.tracks.length ? this.tracks : [{ id: "default", label: "" }];

    tracks.forEach((track) => {
      const trackEl = document.createElement("div");
      trackEl.className = "timeline-track";

      if (track.label) {
        const label = document.createElement("div");
        label.className = "timeline-track-label";
        label.textContent = track.label;
        trackEl.append(label);
      }

      const segments = this.buildLineSegments(start, end);
      segments.forEach((segment) => {
        const line = document.createElement("div");
        line.className = "timeline-line-segment";
        if (this.options.orientation === "horizontal") {
          line.style.left = `${segment.start * 100}%`;
          line.style.width = `${(segment.end - segment.start) * 100}%`;
        } else {
          line.style.top = `${segment.start * 100}%`;
          line.style.height = `${(segment.end - segment.start) * 100}%`;
        }
        trackEl.append(line);
      });

      const trackEvents = this.events.filter((event) => (event.trackId ?? "default") === track.id);
      const { clusters, intervals } = this.buildClusters(trackEvents, pixelsPerMs, start, end);

      intervals.forEach((interval) => {
        const intervalEl = document.createElement("div");
        intervalEl.className = "timeline-interval";
        if (this.options.orientation === "horizontal") {
          intervalEl.style.left = `${interval.start}px`;
          intervalEl.style.width = `${interval.end - interval.start}px`;
        } else {
          intervalEl.style.top = `${interval.start}px`;
          intervalEl.style.height = `${interval.end - interval.start}px`;
        }
        trackEl.append(intervalEl);
      });

      clusters.forEach((cluster) => {
        const marker = document.createElement("div");
        marker.className = cluster.count > 1 ? "timeline-cluster" : "timeline-marker";
        marker.dataset.count = String(cluster.count);
        marker.dataset.type = cluster.type;
        if (cluster.count > 1) {
          marker.textContent = String(cluster.count);
        } else {
          marker.textContent = cluster.icon;
        }
        if (this.options.orientation === "horizontal") {
          marker.style.left = `${cluster.position}px`;
        } else {
          marker.style.top = `${cluster.position}px`;
        }

        marker.addEventListener("click", () => {
          if (cluster.count > 1) {
            this.setZoom(this.zoom + 0.5);
            this.setCenterTime(cluster.centerTime);
            return;
          }
          this.emit("select", cluster.events[0]);
        });

        if (typeof this.options.onEventRender === "function") {
          this.options.onEventRender(marker, cluster);
        }

        trackEl.append(marker);
      });

      this.viewport.append(trackEl);
    });

    if (this.options.rangeSelection) {
      this.renderRangeSelection(start, end, pixelsPerMs);
    }
  }

  buildLineSegments(start, end) {
    const splits = new Set(this.options.manualSplits || []);
    if (this.options.enableAutoSplits) {
      const sorted = [...this.events]
        .map((event) => (event.start ?? event.time))
        .sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i] - sorted[i - 1] > this.options.splitThresholdMs) {
          splits.add(sorted[i - 1] + (sorted[i] - sorted[i - 1]) / 2);
        }
      }
    }

    const splitTimes = [...splits]
      .filter((time) => time > start && time < end)
      .sort((a, b) => a - b);

    const segments = [];
    let segmentStart = start;
    splitTimes.forEach((split) => {
      segments.push({ start: (segmentStart - start) / (end - start), end: (split - start) / (end - start) });
      segmentStart = split;
    });
    segments.push({ start: (segmentStart - start) / (end - start), end: 1 });

    return segments;
  }

  buildClusters(events, pixelsPerMs, start, end) {
    const filtered = events
      .map((event) => ({
        ...event,
        startTime: event.start ?? event.time,
        endTime: event.end ?? event.time
      }))
      .filter((event) => event.endTime >= start && event.startTime <= end)
      .sort((a, b) => a.startTime - b.startTime);

    const clusters = [];
    const intervals = [];
    let currentCluster = null;

    filtered.forEach((event) => {
      const position = (event.startTime - start) * pixelsPerMs;
      if (!currentCluster) {
        currentCluster = { events: [event], positions: [position] };
        return;
      }

      const lastPosition = currentCluster.positions[currentCluster.positions.length - 1];
      if (Math.abs(position - lastPosition) <= this.options.clusterRadiusPx) {
        currentCluster.events.push(event);
        currentCluster.positions.push(position);
      } else {
        clusters.push(this.finalizeCluster(currentCluster, pixelsPerMs, start));
        currentCluster = { events: [event], positions: [position] };
      }
    });

    if (currentCluster) {
      clusters.push(this.finalizeCluster(currentCluster, pixelsPerMs, start));
    }

    clusters.forEach((cluster) => {
      if (cluster.type === "range") {
        intervals.push({
          start: cluster.rangeStart,
          end: cluster.rangeEnd
        });
      }
    });

    return { clusters, intervals };
  }

  finalizeCluster(cluster, pixelsPerMs, start) {
    const events = cluster.events;
    const count = events.length;
    const centerTime = events.reduce((sum, event) => sum + event.startTime, 0) / count;
    const position = (centerTime - start) * pixelsPerMs;
    const hasRange = events.some((event) => event.startTime !== event.endTime);
    let rangeStart = null;
    let rangeEnd = null;

    if (hasRange) {
      rangeStart = (Math.min(...events.map((event) => event.startTime)) - start) * pixelsPerMs;
      rangeEnd = (Math.max(...events.map((event) => event.endTime)) - start) * pixelsPerMs;
    }

    return {
      count,
      centerTime,
      position,
      events,
      type: hasRange ? "range" : "point",
      rangeStart,
      rangeEnd,
      icon: events[0].icon ?? this.options.defaultIcon
    };
  }

  renderRangeSelection(start, end, pixelsPerMs) {
    const rangeLayer = document.createElement("div");
    rangeLayer.className = "timeline-range-selection";

    if (this.rangeSelection.start == null || this.rangeSelection.end == null) {
      this.rangeSelection.start = start + (end - start) * 0.25;
      this.rangeSelection.end = start + (end - start) * 0.6;
    }

    const bar = document.createElement("div");
    bar.className = "timeline-range-bar";

    const startHandle = document.createElement("div");
    startHandle.className = "timeline-range-handle";
    const endHandle = document.createElement("div");
    endHandle.className = "timeline-range-handle";

    const updateRange = () => {
      const startPos = (this.rangeSelection.start - start) * pixelsPerMs;
      const endPos = (this.rangeSelection.end - start) * pixelsPerMs;
      const minPos = Math.min(startPos, endPos);
      const maxPos = Math.max(startPos, endPos);
      if (this.options.orientation === "horizontal") {
        bar.style.left = `${minPos}px`;
        bar.style.width = `${maxPos - minPos}px`;
        startHandle.style.left = `${startPos}px`;
        endHandle.style.left = `${endPos}px`;
      } else {
        bar.style.top = `${minPos}px`;
        bar.style.height = `${maxPos - minPos}px`;
        startHandle.style.top = `${startPos}px`;
        endHandle.style.top = `${endPos}px`;
      }
    };

    const attachDrag = (handle, key) => {
      const onMove = (event) => {
        const rect = this.viewport.getBoundingClientRect();
        const position =
          this.options.orientation === "horizontal"
            ? event.clientX - rect.left
            : event.clientY - rect.top;
        const time = start + position / pixelsPerMs;
        this.rangeSelection[key] = Math.max(start, Math.min(end, time));
        updateRange();
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      handle.addEventListener("mousedown", () => {
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    };

    attachDrag(startHandle, "start");
    attachDrag(endHandle, "end");

    updateRange();
    rangeLayer.append(bar, startHandle, endHandle);
    this.viewport.append(rangeLayer);
  }
}
