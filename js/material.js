/* ============================================================
   Studypath: Material ingestion
   Handles: file validation, PDF/DOCX/TXT extraction, pasted text,
   text normalization, and a small state machine describing the
   current study material. Kept completely separate from quiz
   generation (js/generator.js) so file handling never has to know
   anything about quizzes.
   ============================================================ */
(function (global) {
  'use strict';

  if (global.pdfjsLib && global.pdfjsLib.GlobalWorkerOptions) {
    global.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

  var MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB: generous for text-based study docs
  var MIN_CONTENT_CHARS = 120; // below this, material is considered "empty" for quiz purposes

  var ALLOWED = {
    '.pdf': { mime: ['application/pdf'], type: 'pdf' },
    '.docx': {
      mime: [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ],
      type: 'docx'
    },
    '.txt': { mime: ['text/plain'], type: 'txt' }
  };

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      );
    });
  }

  function extOf(name) {
    var m = /\.[a-z0-9]+$/i.exec(name || '');
    return m ? m[0].toLowerCase() : '';
  }

  function validateFile(file) {
    if (!file) return { ok: false, error: 'No file was selected.' };
    if (file.size === 0) {
      return { ok: false, error: 'That file is empty (0 bytes). Choose a different file.' };
    }
    if (file.size > MAX_FILE_SIZE) {
      return {
        ok: false,
        error: 'That file is larger than 15MB. Please upload a smaller document.'
      };
    }
    var ext = extOf(file.name);
    var rule = ALLOWED[ext];
    if (!rule) {
      return {
        ok: false,
        error: 'Unsupported file type. Please upload a PDF, DOCX, or TXT file.'
      };
    }
    // MIME sniffing is best-effort: some browsers/OSes report an empty or
    // generic MIME type for legitimate files, so we only hard-reject when
    // the browser reports a MIME type that clearly belongs to another kind
    // of file, not when it's blank/unknown.
    if (file.type && rule.mime.indexOf(file.type) === -1 && file.type !== '') {
      var knownOther = Object.keys(ALLOWED).some(function (k) {
        return ALLOWED[k].mime.indexOf(file.type) !== -1 && k !== ext;
      });
      if (knownOther) {
        return {
          ok: false,
          error: 'This file\u2019s contents don\u2019t match its extension (' + ext + '). Please re-export or choose another file.'
        };
      }
    }
    return { ok: true, type: rule.type };
  }

  /* ---------------- Text normalization ---------------- */
  /* ---------------- Text quality ("does this look like real content?") ----------------
     A lightweight, non-blocking heuristic: not true language understanding.
     It flags likely keyboard-mashing, symbol spam, or heavily repetitive text
     so the user can be warned before generating a quiz from it, without hard
     -blocking legitimate content the heuristic doesn't recognize (technical
     jargon, non-English text, etc). */
  var COMMON_WORDS = {
    the: 1, and: 1, is: 1, of: 1, to: 1, in: 1, a: 1, that: 1, it: 1, for: 1,
    on: 1, with: 1, as: 1, was: 1, are: 1, this: 1, be: 1, by: 1, an: 1, or: 1,
    at: 1, from: 1, have: 1, has: 1, not: 1, but: 1, which: 1, their: 1,
    they: 1, you: 1, your: 1, we: 1, our: 1, can: 1, will: 1, if: 1, then: 1,
    these: 1, those: 1, into: 1, about: 1, also: 1, more: 1, such: 1, one: 1,
    two: 1, other: 1, its: 1, all: 1, when: 1, may: 1, each: 1, most: 1
  };

  function assessTextQuality(text) {
    var words = String(text || '').match(/[A-Za-z']{1,30}/g) || [];
    var total = words.length;
    if (total < 10) {
      return { score: 0, looksLikeRealText: false, reasons: ['not enough recognizable words'] };
    }

    var lower = words.map(function (w) { return w.toLowerCase(); });
    var commonHits = lower.filter(function (w) { return COMMON_WORDS[w]; }).length;
    var commonRatio = commonHits / total;

    var vowelRe = /[aeiou]/i;
    var noVowelLong = words.filter(function (w) { return w.length >= 4 && !vowelRe.test(w); }).length;
    var noVowelRatio = noVowelLong / total;

    var clusterRe = /[^aeiou\s]{5,}/i;
    var clusterHits = words.filter(function (w) { return clusterRe.test(w); }).length;
    var clusterRatio = clusterHits / total;

    var uniqueRatio = Object.keys(lower.reduce(function (s, w) { s[w] = 1; return s; }, {})).length / total;

    var repeatedCharRe = /(.)\1{4,}/;
    var repeatedHits = words.filter(function (w) { return repeatedCharRe.test(w); }).length;
    var repeatedRatio = repeatedHits / total;

    var avgLen = words.reduce(function (s, w) { return s + w.length; }, 0) / total;

    var score = 100;
    var reasons = [];
    if (commonRatio < 0.02) { score -= 35; reasons.push('very few common words like \u201cthe,\u201d \u201cand,\u201d or \u201cis\u201d'); }
    if (noVowelRatio > 0.25) { score -= 25; reasons.push('many words with no vowels'); }
    if (clusterRatio > 0.15) { score -= 20; reasons.push('unusual consonant clusters'); }
    if (uniqueRatio < 0.25) { score -= 15; reasons.push('very repetitive wording'); }
    if (repeatedRatio > 0.05) { score -= 15; reasons.push('repeated-character spam'); }
    if (avgLen < 2.2 || avgLen > 11) { score -= 10; reasons.push('unusual average word length'); }

    score = Math.max(0, Math.min(100, score));
    return { score: score, looksLikeRealText: score >= 55, reasons: reasons };
  }

  function normalizeText(raw) {
    if (!raw) return '';
    var text = String(raw);

    // Normalize line endings
    text = text.replace(/\r\n?/g, '\n');
    // Strip control characters (except newline/tab) that sometimes leak
    // out of PDF/DOCX extraction
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    // Collapse the kind of hard line-wraps PDF extraction produces inside a
    // paragraph (a lowercase letter followed by a line break followed by a
    // lowercase letter is almost always mid-sentence wrapping, not a real
    // paragraph break)
    text = text.replace(/([a-z,;:])\n(?=[a-z])/g, '$1 ');
    // Collapse 3+ blank lines down to a single paragraph break
    text = text.replace(/\n{3,}/g, '\n\n');
    // Collapse runs of spaces/tabs
    text = text.replace(/[ \t]{2,}/g, ' ');
    // Trim trailing whitespace on each line
    text = text
      .split('\n')
      .map(function (l) {
        return l.replace(/[ \t]+$/g, '');
      })
      .join('\n');

    return text.trim();
  }

  /* ---------------- Extraction back-ends ---------------- */
  function extractTxt(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ''));
      };
      reader.onerror = function () {
        reject(new Error('Could not read that text file.'));
      };
      reader.readAsText(file);
    });
  }

  function extractPdf(file) {
    if (!global.pdfjsLib) {
      return Promise.reject(
        new Error('PDF support did not load. Check your connection and try again.')
      );
    }
    return file.arrayBuffer().then(function (buf) {
      return global.pdfjsLib
        .getDocument({ data: buf })
        .promise.then(function (pdf) {
          if (!pdf.numPages) {
            throw new Error('This PDF has no pages.');
          }
          var pagePromises = [];
          for (var i = 1; i <= pdf.numPages; i++) {
            pagePromises.push(
              pdf.getPage(i).then(function (page) {
                return page.getTextContent().then(function (content) {
                  var strings = content.items.map(function (it) {
                    return it.str;
                  });
                  return strings.join(' ');
                });
              })
            );
          }
          return Promise.all(pagePromises).then(function (pages) {
            return pages.join('\n\n');
          });
        })
        .catch(function (err) {
          // pdf.js throws its own error types for corrupted/password-protected files
          var msg =
            err && err.name === 'PasswordException'
              ? 'This PDF is password-protected and can\u2019t be read.'
              : 'This PDF appears to be corrupted or unreadable.';
          throw new Error(msg);
        });
    });
  }

  function extractDocx(file) {
    if (!global.mammoth) {
      return Promise.reject(
        new Error('DOCX support did not load. Check your connection and try again.')
      );
    }
    return file.arrayBuffer().then(function (buf) {
      return global.mammoth
        .extractRawText({ arrayBuffer: buf })
        .then(function (result) {
          return result.value || '';
        })
        .catch(function () {
          throw new Error('This DOCX file appears to be malformed or corrupted.');
        });
    });
  }

  /* ---------------- Material state ---------------- */
  // status: empty | selected | processing | ready | invalid | extraction_failed | empty_content | error
  var STORAGE_KEY = 'studypath:material';

  function emptyMaterial() {
    return {
      sourceType: null,
      fileName: '',
      fileSize: 0,
      mimeType: '',
      extractedText: '',
      characterCount: 0,
      status: 'empty',
      error: '',
      quality: null
    };
  }

  var material = load();

  function load() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : emptyMaterial();
    } catch (e) {
      return emptyMaterial();
    }
  }

  function persist() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(material));
    } catch (e) {
      /* storage full/unavailable: material still works for this session */
    }
  }

  function set(partial) {
    material = Object.assign({}, material, partial);
    persist();
    return material;
  }

  function reset() {
    material = emptyMaterial();
    persist();
    return material;
  }

  function fromFile(file) {
    var check = validateFile(file);
    if (!check.ok) {
      set({
        sourceType: null,
        fileName: file ? file.name : '',
        fileSize: file ? file.size : 0,
        mimeType: file ? file.type : '',
        extractedText: '',
        characterCount: 0,
        status: 'invalid',
        error: check.error
      });
      return Promise.resolve(material);
    }

    set({
      sourceType: check.type,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || '',
      extractedText: '',
      characterCount: 0,
      status: 'processing',
      error: ''
    });

    var extractor =
      check.type === 'pdf' ? extractPdf : check.type === 'docx' ? extractDocx : extractTxt;

    return extractor(file)
      .then(function (raw) {
        var normalized = normalizeText(raw);
        if (normalized.length < MIN_CONTENT_CHARS) {
          var reason =
            check.type === 'pdf'
              ? 'No readable text could be found in this PDF. If it\u2019s a scanned or image-only document, Studypath can\u2019t extract text from images yet: try a text-based PDF, or paste the content directly.'
              : 'This file didn\u2019t contain enough readable text to build a quiz from (found ' +
                normalized.length +
                ' characters). Try a different file or paste text directly.';
          set({
            extractedText: normalized,
            characterCount: normalized.length,
            status: normalized.length === 0 ? 'extraction_failed' : 'empty_content',
            error: reason
          });
          return material;
        }
        set({
          extractedText: normalized,
          characterCount: normalized.length,
          status: 'ready',
          error: '',
          quality: assessTextQuality(normalized)
        });
        return material;
      })
      .catch(function (err) {
        set({
          extractedText: '',
          characterCount: 0,
          status: 'extraction_failed',
          error: (err && err.message) || 'Could not extract text from that file.'
        });
        return material;
      });
  }

  function fromPaste(text) {
    var normalized = normalizeText(text || '');
    if (normalized.length < MIN_CONTENT_CHARS) {
      set({
        sourceType: 'paste',
        fileName: '',
        fileSize: 0,
        mimeType: 'text/plain',
        extractedText: normalized,
        characterCount: normalized.length,
        status: 'empty_content',
        error:
          'Paste a bit more, at least ' +
          MIN_CONTENT_CHARS +
          ' characters of real content works best (' +
          normalized.length +
          ' so far).'
      });
      return material;
    }
    set({
      sourceType: 'paste',
      fileName: '',
      fileSize: 0,
      mimeType: 'text/plain',
      extractedText: normalized,
      characterCount: normalized.length,
      status: 'ready',
      error: '',
      quality: assessTextQuality(normalized)
    });
    return material;
  }

  function get() {
    return material;
  }

  function isReady() {
    return material.status === 'ready' && material.characterCount >= MIN_CONTENT_CHARS;
  }

  global.Material = {
    MAX_FILE_SIZE: MAX_FILE_SIZE,
    MIN_CONTENT_CHARS: MIN_CONTENT_CHARS,
    escapeHtml: escapeHtml,
    normalizeText: normalizeText,
    validateFile: validateFile,
    assessTextQuality: assessTextQuality,
    fromFile: fromFile,
    fromPaste: fromPaste,
    reset: reset,
    get: get,
    isReady: isReady
  };
})(window);
