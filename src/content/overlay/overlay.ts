// SPDX-License-Identifier: GPL-3.0-or-later
// In-page selection overlay: hover-pick an element (primary) or drag a
// rectangle (secondary), walk the ancestor chain with ArrowUp/ArrowDown, then
// act on the selection from a small toolbar. Behaviour follows Firefox
// Screenshots (40 px drag threshold, Escape cancels, H1–H6 skipped).
import { placeToolbar } from "../../shared/place.ts";
import type { DocRect } from "../../shared/types.ts";
import { clampedRect, docRectOf, parentOf, pickAt, visibleViewport } from "./pick.ts";
import { adoptStyles, createHtml, OVERLAY_CSS, setImportant, styleHost } from "./styles.ts";
import { createToolbar, type ToolbarButton } from "./toolbar.ts";

export interface Selection {
  mode: "element" | "drag";
  /** Document CSS px, clamped to scrollWidth × scrollHeight. */
  rect: DocRect;
  element?: Element;
}

export type ToolbarAction = "save" | "copy-text" | "copy-link";

export interface OverlayHandle {
  readonly host: HTMLElement;
  /** Takes the overlay out of the rendering (before capture). */
  hide(): void;
  /** Undoes hide() (error path: the overlay is restored, not removed). */
  show(): void;
  /** Disables the toolbar while an action runs. */
  setBusy(busy: boolean): void;
  /** Removes the host and every listener. Idempotent. */
  destroy(): void;
}

/** Diagonal pointer travel (CSS px) after which a press becomes a drag. */
export const DRAG_THRESHOLD = 40;

type State = "hover" | "pressed" | "dragging" | "selected";

const HINT_TEXT = "Click an element or drag an area · ↑ ↓ parent/child · Esc cancels";

// Swallowed so the page never reacts while the overlay is up. Pointer events
// are only stopped, not default-prevented: preventDefault on pointerdown would
// suppress the compatibility mouse events the state machine runs on.
const MOUSE_EVENTS = ["mousedown", "mousemove", "mouseup", "click", "dblclick", "auxclick", "contextmenu"];
const STOP_ONLY_EVENTS = ["pointerdown", "pointermove", "pointerup", "keyup", "keypress"];
const PREVENT_EVENTS = ["selectstart", "dragstart"];

export function startOverlay(opts: {
  onAction(action: ToolbarAction, selection: Selection): void | Promise<void>;
  onCancel(): void;
  /** Why this selection cannot be saved right now, or null; asked again after every scroll and resize. */
  saveBlocked?(selection: Selection): string | null;
}): OverlayHandle {
  const host = createHtml("snapii-overlay");
  styleHost(host, { inset: "0" });
  const root = host.attachShadow({ mode: "closed" });
  adoptStyles(root, OVERLAY_CSS);

  const glass = createHtml("div");
  glass.className = "glass";
  const box = createHtml("div");
  box.className = "box";
  box.hidden = true;
  const hint = createHtml("div");
  hint.className = "hint";
  hint.textContent = HINT_TEXT;
  const toolbar = createToolbar();
  root.append(glass, box, hint, toolbar.el);

  let state: State = "hover";
  let busy = false;
  let destroyed = false;
  /** Element currently highlighted in hover state. */
  let hovered: Element | null = null;
  /** Raw pick under the pointer; hovered only follows it when it changes, so an ArrowUp walk survives jitter. */
  let lastPick: Element | null = null;
  /** ArrowUp history for ArrowDown. */
  let history: Element[] = [];
  let selection: Selection | null = null;
  let pointer = { x: -1, y: -1 };
  let press = { x: 0, y: 0 };
  let toolbarPress: ToolbarButton | null = null;
  let frame = 0;
  /** The reason Save is unavailable for the current selection. */
  let blocked: string | null = null;

  const page = (): { x: number; y: number } => ({ x: pointer.x + scrollX, y: pointer.y + scrollY });

  function drawBox(r: DocRect | null, drag = false): void {
    box.hidden = !r;
    if (!r) return;
    box.classList.toggle("drag", drag);
    setImportant(box, {
      left: `${r.x - scrollX}px`,
      top: `${r.y - scrollY}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function placeTb(): void {
    if (!selection) return;
    // Fractional size: offsetWidth would round and misalign the right edge.
    const tb = toolbar.el.getBoundingClientRect();
    const { x, y } = placeToolbar(selection.rect, { width: tb.width, height: tb.height }, visibleViewport());
    setImportant(toolbar.el, { left: `${x - scrollX}px`, top: `${y - scrollY}px` });
  }

  function dragRect(): DocRect {
    const p = page();
    return clampedRect(press.x, press.y, p.x, p.y);
  }

  function render(): void {
    blocked = state === "selected" && selection ? (opts.saveBlocked?.(selection) ?? null) : null;
    toolbar.setSaveBlocked(blocked);
    hint.textContent = blocked ?? HINT_TEXT;
    hint.classList.toggle("notice", blocked !== null);
    hint.hidden = blocked === null && (state === "selected" || state === "dragging");
    toolbar.el.hidden = state !== "selected";
    if (state === "selected" && selection) {
      drawBox(selection.rect, selection.mode === "drag");
      placeTb();
    } else if (state === "dragging") {
      drawBox(dragRect(), true);
    } else {
      drawBox(hovered ? docRectOf(hovered) : null);
    }
  }

  function updateHover(): void {
    frame = 0;
    if (state !== "hover" || pointer.x < 0) return;
    const pick = pickAt(pointer.x, pointer.y, host);
    if (pick !== lastPick) {
      lastPick = pick;
      hovered = pick;
      history = [];
    }
    render();
  }

  function scheduleHover(): void {
    if (!frame) frame = requestAnimationFrame(updateHover);
  }

  /** Runs a pending hover update now, so a press acts on what is under the pointer. */
  function flushHover(): void {
    if (frame) {
      cancelAnimationFrame(frame);
      updateHover();
    }
  }

  function select(next: Selection): void {
    selection = next;
    state = "selected";
    render();
  }

  function selectElement(el: Element): void {
    select({ mode: "element", rect: docRectOf(el), element: el });
  }

  function backToHover(): void {
    selection = null;
    state = "hover";
    render();
  }

  function setBusy(next: boolean): void {
    busy = next;
    toolbar.setBusy(next);
  }

  function runAction(action: ToolbarAction): void {
    if (busy || !selection) return;
    if (action === "save" && blocked !== null) return;
    const result = opts.onAction(action, { ...selection }) as PromiseLike<void> | undefined;
    if (result && typeof result.then === "function") {
      // Guards against a second click while the first action is in flight.
      setBusy(true);
      Promise.resolve(result)
        .catch((err: unknown) => console.error("snapii: action failed", err))
        .finally(() => {
          if (!destroyed) setBusy(false);
        });
    }
  }

  /**
   * The overlay is gone before Escape's keyup arrives; without this the page
   * would still see that keyup (e.g. a modal closing on Escape).
   */
  function swallowEscapeKeyup(): void {
    const off = (): void => window.removeEventListener("keyup", onKeyup, true);
    const onKeyup = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      off();
    };
    window.addEventListener("keyup", onKeyup, true);
    // A keyup lost to a focus change must not eat a later Escape of the page.
    setTimeout(off, 1000);
  }

  function cancel(): void {
    destroy();
    opts.onCancel();
  }

  function onButton(button: ToolbarButton): void {
    if (busy) return;
    if (button === "cancel") cancel();
    else runAction(button);
  }

  /** Steps the hover highlight or the element selection one ancestor up (or back down). */
  function walk(up: boolean): void {
    const current = state === "selected" ? selection?.element : state === "hover" ? hovered : undefined;
    if (!current) return;
    let next: Element | null | undefined;
    if (up) {
      next = parentOf(current);
      if (next) history.push(current);
    } else {
      next = history.pop();
    }
    if (!next) return;
    if (state === "selected") selectElement(next);
    else {
      hovered = next;
      render();
    }
  }

  function swallow(e: Event): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onMouse(e: Event): void {
    swallow(e);
    // Content-script listeners also get events the page dispatches itself;
    // acting on those would let the page pick a region and save it.
    if (!e.isTrusted) return;
    const m = e as MouseEvent;
    pointer = { x: m.clientX, y: m.clientY };
    switch (e.type) {
      case "mousemove":
        if (state === "hover") scheduleHover();
        else if (state === "pressed") {
          const p = page();
          if (Math.hypot(p.x - press.x, p.y - press.y) > DRAG_THRESHOLD) {
            state = "dragging";
            render();
          }
        } else if (state === "dragging") render();
        break;
      case "mousedown": {
        if (m.button !== 0) return;
        toolbarPress = toolbar.buttonAt(m.clientX, m.clientY);
        if (toolbarPress || busy) return;
        if (state === "selected") {
          // A press outside the toolbar starts over, like Screenshots.
          selection = null;
          state = "hover";
          // updateHover keeps hovered when the pick is null both before and
          // after, and the mouseup would select the old element again.
          lastPick = null;
          hovered = null;
          updateHover();
        } else flushHover();
        if (state !== "hover") return;
        press = page();
        state = "pressed";
        break;
      }
      case "mouseup":
        if (m.button !== 0) return;
        if (toolbarPress) return;
        if (state === "pressed") {
          if (hovered) selectElement(hovered);
          else backToHover();
        } else if (state === "dragging") {
          const r = dragRect();
          if (r.width > 0 && r.height > 0) select({ mode: "drag", rect: r });
          else backToHover();
        }
        break;
      case "click": {
        // Only a press that started on the same button counts as a click, so
        // the mouseup that selects an element never hits a fresh toolbar.
        const button = toolbar.buttonAt(m.clientX, m.clientY);
        const pressed = toolbarPress;
        toolbarPress = null;
        if (button && button === pressed) onButton(button);
        break;
      }
    }
  }

  function onKey(e: KeyboardEvent): void {
    // Stop every key from reaching page shortcuts, but keep the browser's
    // own default (scrolling, browser shortcuts) for keys we do not handle.
    e.stopImmediatePropagation();
    // Page-dispatched keys (a forged Enter) are swallowed but never acted on.
    if (!e.isTrusted || e.isComposing) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        if (busy) break;
        swallowEscapeKeyup();
        cancel();
        break;
      case "Enter":
        e.preventDefault();
        if (busy) break;
        if (state === "selected") runAction("save");
        else if (state === "hover") {
          flushHover();
          if (hovered) selectElement(hovered);
        }
        break;
      case "ArrowUp":
      case "ArrowDown":
        e.preventDefault();
        if (!busy) walk(e.key === "ArrowUp");
        break;
    }
  }

  function onStop(e: Event): void {
    e.stopImmediatePropagation();
  }

  function onScroll(): void {
    // Content under a still pointer changes; a drag grows with the scroll
    // because its end point is pointer + scroll offset.
    if (state === "hover") scheduleHover();
    else render();
  }

  const listeners: [EventTarget, string, EventListener, AddEventListenerOptions][] = [
    ...MOUSE_EVENTS.map((t): [EventTarget, string, EventListener, AddEventListenerOptions] => [
      window,
      t,
      onMouse,
      { capture: true },
    ]),
    ...STOP_ONLY_EVENTS.map((t): [EventTarget, string, EventListener, AddEventListenerOptions] => [
      window,
      t,
      onStop,
      { capture: true },
    ]),
    ...PREVENT_EVENTS.map((t): [EventTarget, string, EventListener, AddEventListenerOptions] => [
      window,
      t,
      swallow,
      { capture: true },
    ]),
    [window, "keydown", onKey as EventListener, { capture: true }],
    [window, "scroll", onScroll, { capture: true, passive: true }],
    [window, "resize", onScroll, { passive: true }],
  ];
  for (const [t, type, fn, o] of listeners) t.addEventListener(type, fn, o);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (frame) cancelAnimationFrame(frame);
    for (const [t, type, fn, o] of listeners) t.removeEventListener(type, fn, o);
    host.remove();
  }

  document.documentElement.append(host);
  render();

  return {
    host,
    hide: () => setImportant(host, { display: "none" }),
    show: () => setImportant(host, { display: "block" }),
    setBusy,
    destroy,
  };
}
