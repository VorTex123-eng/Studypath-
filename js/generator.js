/* ============================================================
   Studypath: Quiz generation
   ------------------------------------------------------------
   QuizGenerationProvider is the abstraction the rest of the app
   talks to. As of M11H, real uploaded/pasted material is sent to
   BackendQuizGenerationProvider - real Gemini generation, via
   Convex's quiz:generateQuiz action, with server-side validation,
   rate limiting, and retry already handled there (see
   convex/quiz.ts). Built-in sample topics are a separate thing entirely -
   curated demo content, not a stand-in for real generation - and
   keep using the sample bank exactly as before.
   ============================================================ */
(function (global) {
  'use strict';

  var STOPWORDS = (
    'the a an of and or but if then else for to in on at by with without ' +
    'is are was were be been being this that these those it its as from ' +
    'into over under about above below between among not no nor so than ' +
    'too very can could will would shall should may might must do does did ' +
    'you your yours he she they them his her their our we us i my me also ' +
    'which who whom whose what when where why how all any some such only ' +
    'own same just because while during before after up down out off again'
  ).split(/\s+/);
  var STOPSET = STOPWORDS.reduce(function (s, w) {
    s[w] = true;
    return s;
  }, {});

  function splitSentences(text) {
    var raw = String(text || '')
      .replace(/\n+/g, ' ')
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u201c])/);
    return raw
      .map(function (s) {
        return s.trim();
      })
      .filter(function (s) {
        return s.length >= 30 && s.length <= 280 && /[a-zA-Z]{3,}/.test(s);
      });
  }

  function words(sentence) {
    return sentence.match(/[A-Za-z][A-Za-z'-]{2,}/g) || [];
  }

  // Picks the most "informative" word in a sentence to turn into a blank:
  // prefer capitalized (non-sentence-initial) terms or the longest
  // non-stopword. Returns null if nothing usable is found.
  function pickKeyTerm(sentence) {
    var w = words(sentence);
    if (!w.length) return null;
    var candidates = w.filter(function (word, idx) {
      var lower = word.toLowerCase();
      if (STOPSET[lower]) return false;
      if (word.length < 4) return false;
      return true;
    });
    if (!candidates.length) return null;
    // Prefer capitalized mid-sentence words (likely proper nouns/terms)
    var capitalized = candidates.filter(function (word, idx) {
      return /^[A-Z]/.test(word) && sentence.indexOf(word) > 0;
    });
    var pool = capitalized.length ? capitalized : candidates;
    // Prefer the longest candidate: tends to be the key technical term
    pool = pool.slice().sort(function (a, b) {
      return b.length - a.length;
    });
    return pool[0];
  }

  function makeBlank(sentence, term) {
    var re = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    return sentence.replace(re, '_____');
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function uid(prefix, i) {
    return prefix + '_' + (i + 1) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------- Question builders ---------------- */
  function buildMCQ(id, sentence, term, distractorPool, topic, difficulty) {
    var blanked = makeBlank(sentence, term);
    var seenLower = {};
    seenLower[term.toLowerCase()] = true;
    var uniquePool = distractorPool.filter(function (d) {
      var low = d.toLowerCase();
      if (seenLower[low]) return false;
      seenLower[low] = true;
      return true;
    });
    var others = shuffle(uniquePool).slice(0, 3);
    while (others.length < 3) {
      others.push(term + ['ism', 'tion', 'ology'][others.length % 3]);
    }
    var options = shuffle([term].concat(others));
    var correctOptionId = null;
    var optionObjs = options.map(function (text, i) {
      var oid = 'o' + i;
      if (text === term) correctOptionId = oid;
      return { id: oid, text: text };
    });
    return {
      id: id,
      type: 'mcq',
      text:
        difficulty === 'easy'
          ? 'Fill in the blank based on the material: "' + blanked + '"'
          : 'Complete the statement: "' + blanked + '"',
      topic: topic,
      explanation: 'From the source material: "' + sentence + '"',
      options: optionObjs,
      correctOptionId: correctOptionId
    };
  }

  function buildTrueFalse(id, sentence, distractorPool, topic, makeFalse) {
    var term = pickKeyTerm(sentence);
    var statement = sentence;
    var isTrue = true;
    if (makeFalse && term) {
      var swap = shuffle(
        distractorPool.filter(function (d) {
          return d.toLowerCase() !== term.toLowerCase();
        })
      )[0];
      if (swap) {
        statement = makeBlank(sentence, term).replace('_____', swap);
        isTrue = false;
      }
    }
    return {
      id: id,
      type: 'true_false',
      text: 'True or False: "' + statement + '"',
      topic: topic,
      explanation: 'Per the source material: "' + sentence + '"',
      correctAnswer: isTrue
    };
  }

  function buildShortAnswer(id, sentence, term, topic) {
    var blanked = makeBlank(sentence, term);
    return {
      id: id,
      type: 'short_answer',
      text: 'Fill in the missing word: "' + blanked + '"',
      topic: topic,
      explanation: 'From the source material: "' + sentence + '"',
      acceptableAnswers: [term]
    };
  }

  function topicLabelFor(index, total, topicHints) {
    if (topicHints && topicHints.length) {
      return topicHints[index % topicHints.length];
    }
    var section = Math.floor((index / Math.max(1, total)) * 4) + 1;
    return 'Section ' + Math.min(section, 4);
  }

  /* ---------------- Mock provider ---------------- */
  function generateFromMaterial(config) {
    var text = (config.material && config.material.text) || '';
    var label = (config.material && config.material.label) || 'Study material';
    var count = Math.max(1, Math.min(100, config.questionCount || 10));
    var types = normalizeTypes(config.questionTypes);
    var difficulty = config.difficulty || 'medium';
    var topics = (config.topics || []).filter(Boolean);

    var sentences = splitSentences(text);
    if (!sentences.length) {
      // Extremely short/unusual material: fall back to treating the whole
      // text as one sentence so generation still produces *something*
      // grounded in what the user supplied, rather than failing outright.
      sentences = [text.trim()].filter(Boolean);
    }

    // If the user gave topic-focus keywords, prioritize sentences that
    // mention them, but don't discard the rest (we may need them to reach
    // the requested question count).
    if (topics.length) {
      var lowerTopics = topics.map(function (t) {
        return t.toLowerCase();
      });
      sentences = sentences.slice().sort(function (a, b) {
        var score = function (s) {
          var low = s.toLowerCase();
          return lowerTopics.reduce(function (n, t) {
            return n + (low.indexOf(t) !== -1 ? 1 : 0);
          }, 0);
        };
        return score(b) - score(a);
      });
    }

    // Easy quizzes favor shorter, plainer sentences; hard/expert favor
    // longer, denser ones. This is a light re-sort, not a hard filter, so
    // small material still yields enough questions.
    if (difficulty === 'easy') {
      sentences = sentences.slice().sort(function (a, b) {
        return a.length - b.length;
      });
    } else if (difficulty === 'hard' || difficulty === 'expert') {
      sentences = sentences.slice().sort(function (a, b) {
        return b.length - a.length;
      });
    }

    var termPool = [];
    var seenTerms = {};
    sentences.forEach(function (s) {
      var t = pickKeyTerm(s);
      if (t && !seenTerms[t.toLowerCase()]) {
        seenTerms[t.toLowerCase()] = true;
        termPool.push(t);
      }
    });

    var questions = [];
    for (var i = 0; i < count; i++) {
      var sentence = sentences[i % sentences.length];
      var term = pickKeyTerm(sentence);
      var topic = topicLabelFor(i, count, topics);
      var type = types[i % types.length];

      if (!term && type !== 'true_false') {
        type = 'true_false'; // sentence has no good blank candidate: TF still works
      }

      var q;
      if (type === 'mcq') {
        q = buildMCQ(uid('q', i), sentence, term, termPool, topic, difficulty);
      } else if (type === 'short_answer') {
        q = buildShortAnswer(uid('q', i), sentence, term, topic);
      } else {
        q = buildTrueFalse(uid('q', i), sentence, termPool, topic, i % 2 === 1);
      }
      questions.push(q);
    }

    return {
      id: 'quiz_' + Date.now(),
      title: label + ': ' + labelForDifficulty(difficulty) + ' quiz',
      subject: (config.subject || '').trim() || label,
      difficulty: difficulty,
      mode: config.mode || 'study',
      timeLimitMinutes: config.timeLimitMinutes || null,
      questionCount: questions.length,
      sourceMaterial: label,
      instructions: config.instructions || '',
      questions: questions
    };
  }

  function labelForDifficulty(d) {
    return { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' }[d] || 'Medium';
  }

  function normalizeTypes(requested) {
    var valid = ['mcq', 'true_false', 'short_answer'];
    if (!requested || !requested.length || requested.indexOf('mixed') !== -1) {
      return valid;
    }
    var filtered = requested.filter(function (t) {
      return valid.indexOf(t) !== -1;
    });
    return filtered.length ? filtered : valid;
  }

  /* ---------------- Legacy sample-topic path ----------------
     Preserves the original built-in subject quiz option (biology/history/
     math) for users who just want a quick sample quiz with no material of
     their own, using the same output schema as the material-based path. */
  var SampleBank = {
    biology: [
      ['What is the primary function of mitochondria?', ['Store genetic information', 'Produce cellular energy', 'Break down proteins', 'Transport oxygen'], 1, 'Mitochondria convert energy from nutrients into ATP, the usable energy currency of cells.'],
      ['Which molecule carries hereditary information?', ['RNA', 'Protein', 'DNA', 'Glucose'], 2, 'DNA carries the genetic instructions used in growth, function, and reproduction.'],
      ['In a food web, plants are called\u2026', ['Consumers', 'Decomposers', 'Producers', 'Predators'], 2, 'Plants make their own food through photosynthesis, making them producers.'],
      ['What process do cells use to divide for growth?', ['Mitosis', 'Diffusion', 'Osmosis', 'Respiration'], 0, 'Mitosis produces two genetically identical cells for growth and repair.']
    ],
    history: [
      ['The Magna Carta was signed in which year?', ['1066', '1215', '1492', '1776'], 1, 'King John sealed the Magna Carta in 1215.'],
      ['Which civilization built Machu Picchu?', ['Roman', 'Maya', 'Inca', 'Egyptian'], 2, 'Machu Picchu was constructed by the Inca Empire.'],
      ['The Renaissance began in\u2026', ['Italy', 'Japan', 'Brazil', 'Norway'], 0, 'The Renaissance began in Italian city-states in the 14th century.']
    ],
    math: [
      ['Solve: 3x + 5 = 20', ['3', '5', '7', '15'], 1, 'Subtract 5 to get 3x = 15, then divide by 3.'],
      ['What is 15% of 200?', ['15', '20', '30', '45'], 2, '0.15 multiplied by 200 equals 30.'],
      ['A triangle has angles 40\u00b0 and 60\u00b0. The third is\u2026', ['70\u00b0', '80\u00b0', '90\u00b0', '100\u00b0'], 1, 'Triangle angles add to 180\u00b0, so 180 - 100 = 80\u00b0.']
    ]
  };

  function sampleBankSize(subject) {
    return (SampleBank[subject] || SampleBank.biology).length;
  }

  function generateFromSample(config) {
    var subject = config.sampleSubject || 'biology';
    var bank = SampleBank[subject] || SampleBank.biology;
    var count = Math.max(1, Math.min(bank.length, config.questionCount || bank.length));
    var questions = bank.slice(0, count).map(function (row, i) {
      var optionObjs = row[1].map(function (text, oi) {
        return { id: 'o' + oi, text: text };
      });
      return {
        id: uid('q', i),
        type: 'mcq',
        text: row[0],
        topic: subject,
        explanation: row[3],
        options: optionObjs,
        correctOptionId: 'o' + row[2]
      };
    });
    return {
      id: 'quiz_' + Date.now(),
      title: subject.charAt(0).toUpperCase() + subject.slice(1) + ' sample quiz',
      subject: subject,
      difficulty: config.difficulty || 'medium',
      mode: config.mode || 'study',
      timeLimitMinutes: config.timeLimitMinutes || null,
      questionCount: questions.length,
      sourceMaterial: 'Built-in sample: ' + subject,
      instructions: config.instructions || '',
      questions: questions
    };
  }

  // M11D: the real backend provider. Calls the Convex `quiz:generateQuiz`
  // action, which calls Gemini server-side and validates the result before
  // it ever gets here. Same generateQuiz(config) -> Promise<Quiz> contract
  // as before - the quiz engine can't tell them apart.
  var BackendQuizGenerationProvider = {
    generateQuiz: function (config) {
      if (typeof Convex === 'undefined') {
        return Promise.reject(new Error('Convex client is not loaded on this page.'));
      }
      return Convex.action('quiz:generateQuiz', {
        material: config.material || { text: '', label: config.sampleSubject || 'Sample' },
        difficulty: config.difficulty,
        questionCount: config.questionCount,
        questionTypes: config.questionTypes || [],
        mode: config.mode,
        timeLimitMinutes: config.timeLimitMinutes === undefined ? null : config.timeLimitMinutes,
        topics: config.topics || [],
        instructions: config.instructions || '',
        // Phase C: when the quiz comes from a saved library material, send
        // only the id - the action resolves the text server-side from the
        // caller's own row and ignores any inline text.
        materialId: config.materialId || undefined,
        // Subject/topic contamination fix: the quiz config's subject is the
        // application-owned quiz context; the server falls back to the
        // material label when it is absent.
        subject: config.subject || undefined,
        // M11H - identity for server-side rate limiting. Both helpers are
        // always loaded ahead of this file (see script order on every
        // page) - anonymousId always exists, sessionToken only when
        // actually signed in.
        sessionToken: (typeof Auth !== 'undefined' && Auth.getToken()) || undefined,
        anonymousId: typeof getAnonId === 'function' ? getAnonId() : ''
      }).then(function (res) {
        if (!res.ok) {
          var err = new Error(res.error.message);
          err.code = res.error.code;
          throw err;
        }
        return res.data;
      });
    },
    // A2: targeted practice. Same contract shape as generateQuiz (config
    // in, quiz object out) so the engine can't tell them apart; the
    // returned quiz carries materialId + practiceSource:"targeted_ai".
    generateTargetedPractice: function (config) {
      if (typeof Convex === 'undefined') {
        return Promise.reject(new Error('Convex client is not loaded on this page.'));
      }
      return Convex.action('quiz:generateTargetedPractice', {
        subjectKey: config.subjectKey,
        topicKey: config.topicKey,
        questionCount: config.questionCount,
        difficulty: config.difficulty,
        questionTypes: config.questionTypes || [],
        sessionToken: (typeof Auth !== 'undefined' && Auth.getToken()) || undefined,
        anonymousId: typeof getAnonId === 'function' ? getAnonId() : ''
      }).then(function (res) {
        if (!res.ok) {
          var err = new Error(res.error.message);
          err.code = res.error.code;
          throw err;
        }
        return res.data;
      });
    }
  };
  /* ---------------- Flashcards ----------------
     Reuses the same sentence/key-term extraction as quiz generation, just
     shaped as front/back cards instead of scored questions. No timer, no
     options, no correctness tracking - purely a study aid. */
  function generateFlashcardsFromMaterial(config) {
    var text = (config.material && config.material.text) || '';
    var label = (config.material && config.material.label) || 'Study material';
    var count = Math.max(1, Math.min(100, config.questionCount || 10));
    var topics = (config.topics || []).filter(Boolean);

    var sentences = splitSentences(text);
    if (!sentences.length) sentences = [text.trim()].filter(Boolean);

    if (topics.length) {
      var lowerTopics = topics.map(function (t) { return t.toLowerCase(); });
      sentences = sentences.slice().sort(function (a, b) {
        var score = function (s) {
          var low = s.toLowerCase();
          return lowerTopics.reduce(function (n, t) { return n + (low.indexOf(t) !== -1 ? 1 : 0); }, 0);
        };
        return score(b) - score(a);
      });
    }

    var cards = [];
    for (var i = 0; i < count; i++) {
      var sentence = sentences[i % sentences.length];
      var term = pickKeyTerm(sentence);
      var topic = topicLabelFor(i, count, topics);
      if (term) {
        cards.push({
          id: uid('card', i),
          front: makeBlank(sentence, term).replace('_____', 'ـ ? ـ'),
          back: term,
          topic: topic,
          explanation: sentence
        });
      } else {
        cards.push({
          id: uid('card', i),
          front: 'What does this cover?',
          back: sentence,
          topic: topic,
          explanation: ''
        });
      }
    }

    return {
      id: 'flash_' + Date.now(),
      title: label + ': flashcards',
      subject: (config.subject || '').trim() || label,
      mode: 'flashcards',
      cardCount: cards.length,
      sourceMaterial: label,
      cards: cards
    };
  }

  function generateFlashcardsFromSample(config) {
    var subject = config.sampleSubject || 'biology';
    var bank = SampleBank[subject] || SampleBank.biology;
    var count = Math.max(1, Math.min(bank.length, config.questionCount || bank.length));
    var cards = bank.slice(0, count).map(function (row, i) {
      return { id: uid('card', i), front: row[0], back: row[1][row[2]], topic: subject, explanation: row[3] };
    });
    return {
      id: 'flash_' + Date.now(),
      title: subject.charAt(0).toUpperCase() + subject.slice(1) + ': flashcards',
      subject: subject,
      mode: 'flashcards',
      cardCount: cards.length,
      sourceMaterial: 'Built-in sample: ' + subject,
      cards: cards
    };
  }

  // The active provider used by every normal call to QuizGen.generateQuiz.
  // M11H: real material now goes to the real backend (Gemini) by default -
  // this IS the "replace the mock with the real LLM in the live flow"
  // change. Built-in sample topics are unaffected (see header comment) -
  // they were never mock-LLM output to begin with, so there's nothing to
  // replace there. No silent fallback to the heuristic mock on a backend
  // failure: draft.generateError (js/app.js) already surfaces a real
  // failure honestly, exactly like any other backend error - quietly
  // handing someone lower-quality heuristic content instead, with no
  // indication anything went wrong, would be worse than a clear error.
  var LiveQuizGenerationProvider = {
    generateQuiz: function (config) {
      if (config.sampleSubject && !(config.material && config.material.text)) {
        return Promise.resolve(generateFromSample(config));
      }
      return BackendQuizGenerationProvider.generateQuiz(config);
    }
  };
  var activeProvider = LiveQuizGenerationProvider;

  global.QuizGen = {
    generateQuiz: function (config) {
      return activeProvider.generateQuiz(config);
    },
    // A2: always the real backend (targeted practice is meaningless as a
    // heuristic mock - it must be grounded in the user's saved material).
    generateTargetedPractice: function (config) {
      return BackendQuizGenerationProvider.generateTargetedPractice(config);
    },
    generateFlashcards: function (config) {
      if (config.sampleSubject && !(config.material && config.material.text)) {
        return Promise.resolve(generateFlashcardsFromSample(config));
      }
      return Promise.resolve(generateFlashcardsFromMaterial(config));
    },
    sampleBankSize: sampleBankSize,
    _internals: { splitSentences: splitSentences, pickKeyTerm: pickKeyTerm } // exposed for tests
  };
})(typeof window !== 'undefined' ? window : global);
