# Timeline Widget Documentation

## Overview
The Timeline Widget renders a zoomable, track-based timeline with clustered events, optional range selection, and configurable tick labels. It is designed to run in the browser with no build step required.

## Quick start
1. Include the styles and module script.
2. Create a container element.
3. Instantiate `TimelineWidget` with options.
4. Provide events via `setEvents` or `addEvents`.

```html
<link rel="stylesheet" href="timeline.css" />
<div id="timeline"></div>
<script type="module">
  import { TimelineWidget } from "./timeline.js";

  const timeline = new TimelineWidget(document.getElementById("timeline"), {
    orientation: "horizontal",
    tracks: [
      { id: "design", label: "Design" },
      { id: "build", label: "Build" }
    ],
    rangeSelection: true,
    defaultIcon: "●"
  });

  timeline.setEvents([
    {
      id: "evt-1",
      title: "Kickoff",
      time: Date.now(),
      trackId: "design"
    },
    {
      id: "evt-2",
      title: "Milestone",
      start: Date.now() + 86400000,
      end: Date.now() + 86400000 * 5,
      trackId: "build",
      icon: "◆"
    }
  ]);
</script>
```

## Options
Pass an options object to `new TimelineWidget(container, options)` to configure behavior.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `orientation` | `"horizontal" \| "vertical"` | `"horizontal"` | Layout direction for tracks and ticks. |
| `minZoom` | `number` | `0.5` | Minimum zoom level. |
| `maxZoom` | `number` | `6` | Maximum zoom level. |
| `zoom` | `number` | `1` | Initial zoom level. |
| `clusterRadiusPx` | `number` | `24` | Pixel radius for clustering nearby events. |
| `tickLabelFormatter` | `(time: number, interval: object) => string` | `null` | Custom label formatter for ticks. |
| `tickMinSpacingPx` | `number` | `90` | Minimum spacing between tick marks. |
| `enableAutoSplits` | `boolean` | `false` | Auto-create timeline segments when gaps exceed `splitThresholdMs`. |
| `manualSplits` | `number[]` | `[]` | Manual split positions as epoch milliseconds. |
| `splitThresholdMs` | `number` | `1000 * 60 * 60 * 24 * 30` | Gap size required for auto splits. |
| `tracks` | `{ id: string, label?: string }[]` | `[]` | Track definitions. Uses a single default track when empty. |
| `defaultIcon` | `string` | `"●"` | Icon used for point events without a custom icon. |
| `rangeSelection` | `boolean` | `false` | Show a draggable range-selection overlay. |
| `onEventRender` | `(marker: HTMLElement, cluster: object) => void` | `null` | Hook to customize marker elements after rendering. |

## Event data
Provide events as objects with required IDs and time fields. Use `time` for point events or `start` + `end` for ranges.

```js
{
  id: "evt-1",
  title: "Design review",
  time: Date.now(),
  trackId: "design",
  icon: "◆"
}

{
  id: "evt-2",
  title: "Build sprint",
  start: Date.now(),
  end: Date.now() + 86400000 * 3,
  trackId: "build"
}
```

| Field | Required | Description |
| --- | --- | --- |
| `id` | ✅ | Unique identifier used for updates/removals. |
| `title` | Optional | Label for your own use (not rendered by default). |
| `time` | ✅ for point events | Epoch milliseconds for a single marker. |
| `start` | ✅ for range events | Epoch milliseconds for the range start. |
| `end` | Optional | Epoch milliseconds for range end (falls back to `start`). |
| `trackId` | Optional | Track ID (defaults to `"default"`). |
| `icon` | Optional | Marker icon for point events. |

## Methods
| Method | Description |
| --- | --- |
| `setEvents(events)` | Replace all events. |
| `addEvents(events)` | Append events. |
| `removeEvents(ids)` | Remove events by ID. |
| `setZoom(zoom)` | Set zoom level (clamped to min/max). |
| `setCenterTime(time)` | Center the viewport on a time. |
| `destroy()` | Remove the widget from the container. |

## Events
Subscribe to widget events with `timeline.on(name, handler)` and remove handlers with `timeline.off(name, handler)`.

| Event | Payload | When it fires |
| --- | --- | --- |
| `select` | Event object | Click on a single marker (not a cluster). |
| `zoom` | `number` | Zoom level changes. |
| `move` | `number` | Center time changes. |

## Styling notes
The widget ships with default styles in `timeline.css`. You can override them by adding new selectors after the stylesheet or by extending `onEventRender` to attach custom classes.
