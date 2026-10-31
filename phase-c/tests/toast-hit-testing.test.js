/* Toast hit-testing regression tests (2026-10-08).
 *
 * Production bug, found by an external tester: on the Create Quiz page the
 * "Generate quiz" button was visually present but not reliably clickable.
 * Hovering the button area showed the text-selection cursor instead of the
 * pointer cursor, and clicks never reached the button.
 *
 * Root cause: the global `.toast` element is `position:fixed` at the
 * bottom-right of the viewport with `opacity:0` when idle, but it had no
 * `pointer-events:none`. `toast()` in js/app.js only removes the `.show`
 * class on timeout, so the message text stays in the DOM forever. The
 * invisible, text-filled toast therefore kept intercepting pointer events
 * over its bottom-right rect, swallowing hovers/clicks meant for content
 * scrolled beneath it (e.g. the right-aligned Generate Quiz button). The
 * leftover text is also why the cursor rendered as an I-beam.
 * It looked zoom-related because zoom changes move the button in and out
 * of the toast's fixed rect; the defect itself was not zoom-specific.
 *
 * Fix: `.toast{...;pointer-events:none}` + `.toast.show{...;pointer-events:auto}`.
 *
 * Browser-level zoom cannot be automated in this node:test setup. The fix
 * was verified with a Playwright matrix (Chromium, create.html, toast left
 * in its real post-timeout end state, #generateBtn scrolled to the viewport
 * bottom, document.elementFromPoint at the button's visual center):
 *   zoom 75/80/90/100/110/125/150% (viewport scaled as window/zoom):
 *     BEFORE fix -> div.toast hit at 90/100/110/125/150%
 *     AFTER fix  -> button#generateBtn hit at all 7 levels, cursor pointer
 *   real mouse.click at 75% reaches the button: yes
 *   keyboard: button tabbable, focusable, Enter activates: yes
 *   viewports 1024x768 / 1366x864 / 1440x900 / 1920x1080: button hit
 *   mobile 390x844 scrolled to document bottom: button hit, 44px clearance
 *     above the fixed bottom-nav (the 82px main padding-bottom holds)
 *   visible toast keeps pointer-events:auto (message still selectable)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

function ruleBody(selector) {
  // Finds the first top-level rule for the exact selector and returns its body.
  const idx = css.indexOf(selector + '{');
  assert.ok(idx !== -1, `expected CSS rule for ${selector}`);
  const end = css.indexOf('}', idx);
  return css.slice(idx + selector.length + 1, end);
}

test('hidden .toast never intercepts pointer events', () => {
  const body = ruleBody('.toast');
  assert.ok(/position\s*:\s*fixed/.test(body), '.toast stays fixed bottom-right');
  assert.ok(/opacity\s*:\s*0/.test(body), '.toast is still invisible when idle (no visual change)');
  assert.ok(
    /pointer-events\s*:\s*none/.test(body),
    '.toast must have pointer-events:none so the idle (invisible) toast cannot swallow clicks'
  );
});

test('visible .toast keeps pointer events (today\u2019s behavior preserved)', () => {
  const body = ruleBody('.toast.show');
  assert.ok(/opacity\s*:\s*1/.test(body), '.toast.show still fades in');
  assert.ok(
    /pointer-events\s*:\s*auto/.test(body),
    '.toast.show keeps pointer-events:auto so a visible message remains selectable/hoverable'
  );
});

test('toast() leaves message text in the DOM after hiding (why the CSS guard matters)', () => {
  // The timeout only removes .show; textContent is never cleared. This test
  // documents the behavior the pointer-events fix defends against: an
  // invisible toast that still contains text (and therefore still shows an
  // I-beam cursor and eats clicks if it ever intercepts again).
  const m = appJs.match(/function toast\(m, duration\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'toast() found in js/app.js');
  assert.ok(/classList\.remove\('show'\)/.test(m[1]), 'timeout removes .show');
  assert.ok(!/textContent\s*=\s*['"]{2}/.test(m[1]), 'timeout does not clear the message text');
});

test('other fixed overlays already neutralize pointer events when hidden', () => {
  // #introOverlay and #pageLoader hide via .hide, which must keep
  // pointer-events:none + visibility:hidden so they cannot trap clicks.
  for (const sel of ['#introOverlay.hide', '#pageLoader.hide']) {
    const body = ruleBody(sel);
    assert.ok(/pointer-events\s*:\s*none/.test(body), `${sel} keeps pointer-events:none`);
    assert.ok(/visibility\s*:\s*hidden/.test(body), `${sel} keeps visibility:hidden`);
  }
});
