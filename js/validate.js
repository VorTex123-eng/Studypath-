/* ============================================================
   Studypath: Quiz validation
   A generated quiz (mock today, backend-generated tomorrow) must
   pass this before it's allowed into the quiz engine. Keeping this
   separate from generation means a future real-AI provider gets
   the exact same safety net for free.
   ============================================================ */
(function (global) {
  'use strict';

  var VALID_TYPES = ['mcq', 'true_false', 'short_answer'];

  function validateQuestion(q, index) {
    var errs = [];
    var where = 'Question ' + (index + 1);
    if (!q || typeof q !== 'object') return [where + ' is missing.'];
    if (!q.id) errs.push(where + ' has no id.');
    if (VALID_TYPES.indexOf(q.type) === -1) errs.push(where + ' has an invalid type: ' + q.type);
    if (!q.text || !String(q.text).trim()) errs.push(where + ' has no question text.');
    if (!q.topic) errs.push(where + ' has no topic.');

    if (q.type === 'mcq') {
      if (!Array.isArray(q.options) || q.options.length < 2) {
        errs.push(where + ' (multiple choice) needs at least two options.');
      } else {
        var ids = q.options.map(function (o) {
          return o.id;
        });
        if (new Set(ids).size !== ids.length) errs.push(where + ' has duplicate option ids.');
        if (!q.correctOptionId || ids.indexOf(q.correctOptionId) === -1) {
          errs.push(where + ' has no valid correctOptionId.');
        }
      }
    } else if (q.type === 'true_false') {
      if (typeof q.correctAnswer !== 'boolean') {
        errs.push(where + ' (true/false) needs a boolean correctAnswer.');
      }
    } else if (q.type === 'short_answer') {
      if (!Array.isArray(q.acceptableAnswers) || !q.acceptableAnswers.length) {
        errs.push(where + ' (short answer) needs at least one acceptable answer.');
      }
    }
    return errs;
  }

  function validateQuiz(quiz) {
    var errs = [];
    if (!quiz || typeof quiz !== 'object') return { ok: false, errors: ['No quiz was generated.'] };
    if (!quiz.id) errs.push('Quiz has no id.');
    if (!Array.isArray(quiz.questions) || !quiz.questions.length) {
      errs.push('Quiz has no questions.');
    } else {
      var seen = {};
      quiz.questions.forEach(function (q, i) {
        if (q && q.id) {
          if (seen[q.id]) errs.push('Duplicate question id: ' + q.id);
          seen[q.id] = true;
        }
        errs.push.apply(errs, validateQuestion(q, i));
      });
    }
    return { ok: errs.length === 0, errors: errs };
  }

  function validateFlashcards(deck) {
    var errs = [];
    if (!deck || typeof deck !== 'object') return { ok: false, errors: ['No flashcard deck was generated.'] };
    if (!Array.isArray(deck.cards) || !deck.cards.length) {
      errs.push('Deck has no cards.');
    } else {
      var seen = {};
      deck.cards.forEach(function (c, i) {
        var where = 'Card ' + (i + 1);
        if (!c || typeof c !== 'object') { errs.push(where + ' is missing.'); return; }
        if (!c.id) errs.push(where + ' has no id.');
        if (c.id && seen[c.id]) errs.push('Duplicate card id: ' + c.id);
        if (c.id) seen[c.id] = true;
        if (!c.front || !String(c.front).trim()) errs.push(where + ' has no front side.');
        if (!c.back || !String(c.back).trim()) errs.push(where + ' has no back side.');
      });
    }
    return { ok: errs.length === 0, errors: errs };
  }

  global.QuizValidate = { validateQuiz: validateQuiz, validateFlashcards: validateFlashcards };
})(typeof window !== 'undefined' ? window : global);
