/**
 * Idle "human" activity performed between products.
 *
 * This module reads nothing and extracts nothing — it exists purely so the gap
 * between one product and the next carries the small, irregular mouse and
 * scroll traffic a real browsing session produces, instead of a page that sits
 * perfectly still and then navigates.
 *
 * Two rules hold everywhere in here:
 *
 *   1. **Never change page state.** Movement, wheel and hover only. Nothing
 *      clicks, focuses, types or navigates, so no scrape can be affected by it.
 *   2. **Never fail a scrape.** Every call is best-effort; the whole routine is
 *      wrapped so a closed page or a detached element is swallowed silently.
 *
 * It runs after a product's result has already been computed, so by
 * construction it cannot alter any extracted data.
 */

import type { Page } from 'playwright';
import { delay } from './utils';

/* ------------------------------------------------------------------ tuning */

/** Total wall-clock budget for one visit, in ms. Requirement: ~500–3000ms. */
const MIN_TOTAL_MS = 500;
const MAX_TOTAL_MS = 3000;

/** Fallback viewport when Playwright reports none (headless without a size). */
const FALLBACK_VIEWPORT = { width: 1440, height: 900 };

/**
 * Elements that are safe to drift the pointer over: text and media only.
 * Deliberately excludes `a`, `button`, `input` and anything clickable — we
 * hover by moving the raw mouse, so nothing here can ever be activated.
 */
const HOVER_TARGETS = 'img, h1, h2, h3, p, span, li, td';

/* ------------------------------------------------------------------ helpers */

/** Random integer in [min, max]. */
function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Random float in [min, max). */
function randomFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** True with probability `p` (0..1). */
function chance(p: number): boolean {
  return Math.random() < p;
}

/** Fisher–Yates, so the action order differs every visit. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Ease-in-out curve. Applied to the progress along a mouse path so the pointer
 * accelerates away from its start and decelerates into its target, rather than
 * covering equal distance per step the way a scripted move does.
 */
function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/* -------------------------------------------------------------------- state */

/**
 * Last known pointer position per page, so consecutive gestures continue from
 * where the previous one left the cursor instead of teleporting from a fixed
 * origin.
 *
 * Keyed by page rather than module-scoped because a worker pool has several
 * pages alive at once. One shared position would have each worker starting its
 * moves from wherever another worker's cursor happened to stop — producing
 * exactly the teleporting, discontinuous path this module exists to avoid.
 * A WeakMap so a closed page's entry goes away with the page.
 */
const pointers = new WeakMap<Page, { x: number; y: number }>();

function pointerFor(page: Page): { x: number; y: number } {
  return pointers.get(page) ?? { x: FALLBACK_VIEWPORT.width / 2, y: FALLBACK_VIEWPORT.height / 2 };
}

/* ------------------------------------------------------------------ actions */

/**
 * Glide the pointer to (x, y) along a curved, eased path.
 *
 * The path is a quadratic Bézier whose control point is nudged off the straight
 * line, so the trajectory bows the way a hand-driven cursor does. Step count
 * scales with distance, and each step gets its own short, varying pause.
 */
async function moveMouseTo(page: Page, x: number, y: number, signal?: AbortSignal): Promise<void> {
  const from = pointerFor(page);
  const distance = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(8, Math.min(28, Math.round(distance / 22) + randomInt(3, 8)));

  // Control point: the midpoint pushed perpendicular to the travel direction by
  // a fraction of the distance, sign chosen at random so bows go either way.
  const bow = randomFloat(0.08, 0.22) * distance * (chance(0.5) ? 1 : -1);
  const midX = (from.x + x) / 2;
  const midY = (from.y + y) / 2;
  const angle = Math.atan2(y - from.y, x - from.x);
  const controlX = midX + Math.cos(angle + Math.PI / 2) * bow;
  const controlY = midY + Math.sin(angle + Math.PI / 2) * bow;

  for (let step = 1; step <= steps; step++) {
    if (signal?.aborted) return;

    const t = ease(step / steps);
    const inv = 1 - t;
    const px = inv * inv * from.x + 2 * inv * t * controlX + t * t * x;
    const py = inv * inv * from.y + 2 * inv * t * controlY + t * t * y;

    await page.mouse.move(px, py);
    // Varying per-step dwell — a constant one is as robotic as a straight line.
    await delay(randomInt(4, 18), signal);
  }

  pointers.set(page, { x, y });
}

/** Drift to a random point inside the safe middle band of the viewport. */
async function moveToRandomSpot(page: Page, signal?: AbortSignal): Promise<void> {
  const { width, height } = page.viewportSize() ?? FALLBACK_VIEWPORT;
  // Inset from the edges: the extremes are where browser chrome and sticky
  // headers live, and a cursor that keeps landing in corners looks synthetic.
  const x = randomInt(Math.round(width * 0.1), Math.round(width * 0.9));
  const y = randomInt(Math.round(height * 0.15), Math.round(height * 0.85));
  await moveMouseTo(page, x, y, signal);
}

/**
 * Hover a randomly chosen text or media element.
 *
 * Uses raw mouse movement to the element's box rather than `locator.hover()`:
 * that keeps Playwright's actionability checks and auto-scroll-into-view out of
 * it, so this can never move the page or wait on an element that isn't there.
 */
async function hoverRandomElement(page: Page, signal?: AbortSignal): Promise<void> {
  const { width, height } = page.viewportSize() ?? FALLBACK_VIEWPORT;
  const candidates = await page.locator(HOVER_TARGETS).all();
  if (candidates.length === 0) return;

  // Sample a handful rather than measuring every node on a Flipkart page.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal?.aborted) return;

    const box = await candidates[randomInt(0, candidates.length - 1)].boundingBox().catch(() => null);
    if (!box || box.width < 12 || box.height < 12) continue;

    // Only if it is actually on screen — hovering a point below the fold would
    // just park the cursor somewhere the user cannot see.
    const x = box.x + randomFloat(0.25, 0.75) * box.width;
    const y = box.y + randomFloat(0.25, 0.75) * box.height;
    if (x < 0 || y < 0 || x > width || y > height) continue;

    await moveMouseTo(page, x, y, signal);
    await delay(randomInt(120, 500), signal); // dwell, as if reading it
    return;
  }
}

/**
 * A short scroll in small wheel increments, usually down, sometimes partly
 * back up. Never a jump to the bottom — that is a signature, not a scroll.
 */
async function smallScroll(page: Page, signal?: AbortSignal): Promise<void> {
  const ticks = randomInt(2, 5);
  const direction = chance(0.75) ? 1 : -1;

  for (let tick = 0; tick < ticks; tick++) {
    if (signal?.aborted) return;
    await page.mouse.wheel(0, direction * randomInt(40, 160));
    await delay(randomInt(60, 220), signal);
  }

  // Often drift back the other way, the way someone overshoots and corrects.
  if (chance(0.45)) {
    await delay(randomInt(150, 450), signal);
    for (let tick = 0; tick < randomInt(1, 3); tick++) {
      if (signal?.aborted) return;
      await page.mouse.wheel(0, -direction * randomInt(30, 110));
      await delay(randomInt(60, 180), signal);
    }
  }
}

/**
 * Slide the pointer off the bottom or side of the viewport and back in —
 * the reflex of reaching for a taskbar or another window mid-browse.
 */
async function driftOffscreenAndBack(page: Page, signal?: AbortSignal): Promise<void> {
  const { width, height } = page.viewportSize() ?? FALLBACK_VIEWPORT;
  const exit = chance(0.5)
    ? { x: randomInt(0, width), y: height + randomInt(20, 90) } // below
    : { x: width + randomInt(20, 90), y: randomInt(0, height) }; // right

  await moveMouseTo(page, exit.x, exit.y, signal);
  await delay(randomInt(150, 600), signal);
  await moveToRandomSpot(page, signal);
}

/** Do nothing at all for a moment — attention elsewhere. */
async function idle(signal?: AbortSignal): Promise<void> {
  await delay(randomInt(150, 700), signal);
}

/* -------------------------------------------------------------------- entry */

export interface HumanBehaviorOptions {
  /** Set false to skip entirely. */
  enabled?: boolean;
  /** Cancels mid-routine, so a Stop is not held up by idle activity. */
  signal?: AbortSignal;
}

/**
 * Perform one short, randomized burst of idle browsing activity on `page`.
 *
 * Called between products. Picks a different subset of actions in a different
 * order every time — sometimes only a mouse drift, sometimes a scroll and a
 * hover, sometimes just a pause — and returns once its randomly chosen budget
 * of roughly 500–3000ms is spent.
 *
 * Never throws.
 */
export async function humanBehavior(page: Page, options: HumanBehaviorOptions = {}): Promise<void> {
  if (options.enabled === false) return;
  const { signal } = options;
  if (signal?.aborted || page.isClosed()) return;

  const budgetMs = randomInt(MIN_TOTAL_MS, MAX_TOTAL_MS);
  const startedAt = Date.now();

  try {
    // Weighted pool: cheap, common gestures appear more than once so they are
    // drawn more often, without any action becoming guaranteed.
    const pool: Array<(p: Page, s?: AbortSignal) => Promise<void>> = [
      moveToRandomSpot,
      moveToRandomSpot,
      smallScroll,
      smallScroll,
      hoverRandomElement,
      (_p, s) => idle(s),
      driftOffscreenAndBack,
    ];

    // 1–3 actions, shuffled: the sequence itself varies, not just the timings.
    const plan = shuffle(pool).slice(0, randomInt(1, 3));

    for (const action of plan) {
      if (signal?.aborted || page.isClosed()) return;
      if (Date.now() - startedAt >= budgetMs) break;
      await action(page, signal);
      await delay(randomInt(80, 350), signal); // beat between gestures
    }

    // Spend whatever is left of the budget standing still, so total dwell lands
    // in the intended window even when the plan finished quickly.
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining > 0) await delay(remaining, signal);
  } catch {
    // Page closed, navigated, or an element vanished mid-move. This routine is
    // decorative — its failure must never touch a result.
  }
}
