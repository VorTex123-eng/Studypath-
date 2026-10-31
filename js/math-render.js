/* Studypath - safe math rendering wrapper around KaTeX.

   Mirrors js/material.js's pattern for pdf.js/mammoth: the actual
   library loads from a CDN (see quiz.html/review.html's <head>), and
   this file wraps it so the rest of the app never has to know whether
   KaTeX loaded successfully, or handle a malformed expression itself.

   Delimiter strategy (Part 9 of the spec this implements):
   - Inline math:  $...$   and  \(...\)
   - Display math: $$...$$ and  \[...\]
   Single-dollar inline math is NOT KaTeX's auto-render default,
   specifically because of the currency-collision risk the spec calls
   out ("$12" could be mistaken for math). It's enabled here anyway
   because the spec's own example output uses single-dollar inline math,
   and because the mitigation is applied at the SOURCE instead: the AI
   generation prompt (see convex/quiz.ts) explicitly tells the model to
   never use a bare dollar sign for currency and to spell out amounts in
   words instead. That is the right place to prevent the collision,
   since Studypath controls what the model outputs - unlike a page
   rendering arbitrary third-party text, where disabling single-dollar
   entirely would be the safer default.
*/
(function (global) {
  'use strict';

  var DELIMITERS = [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '$', right: '$', display: false },
    { left: '\\(', right: '\\)', display: false }
  ];

  // Renders any $...$/$$...$$ math inside `container` in place. Safe to
  // call on any element, including ones with no math in them at all
  // (auto-render just finds nothing to do). Never throws - if KaTeX
  // didn't load (e.g. the CDN was unreachable, same failure mode
  // material.js already handles for pdf.js/mammoth), or a specific
  // expression is malformed, this fails quietly and leaves the original
  // text visible rather than breaking the page.
  function renderMath(container) {
    if (!container) return;
    if (typeof global.renderMathInElement !== 'function') {
      // KaTeX's auto-render script didn't load. Leave the raw
      // $...$ text as-is (still readable, just unstyled) rather than
      // showing nothing or throwing.
      return;
    }
    try {
      global.renderMathInElement(container, {
        delimiters: DELIMITERS,
        throwOnError: false, // render a visibly-flagged fallback for bad LaTeX instead of throwing
        errorColor: '#b3261e',
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
      });
    } catch (e) {
      // renderMathInElement itself is defensive, but a container with
      // unusual content could still throw at the DOM-walk level rather
      // than per-expression. Either way: never let a math rendering
      // failure take down the quiz page underneath it.
      console.error('[math-render] renderMathInElement failed:', e && e.message);
    }
  }

  global.MathRender = { render: renderMath };
})(window);
