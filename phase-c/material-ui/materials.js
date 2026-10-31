/* Phase C prototype app script.
   Drives the real Phase C core (window.PhaseC, loaded by the bootstrap in
   materials.html) against an in-memory repo seeded with clearly-labeled
   DEMO data. Not connected to any account or backend. */
(function () {
  'use strict';

  var MaterialService = window.PhaseC['material-service'].MaterialService;
  var MemoryMaterialRepository = window.PhaseC['material-repo-memory'].MemoryMaterialRepository;
  var makeSessionStore = window.PhaseC['material-repo-memory'].makeSessionStore;
  var validateMaterialInput = window.PhaseC['material-validation'].validateMaterialInput;
  var LIMITS = window.PhaseC['material-types'].LIMITS;
  var forSavedMaterial = window.PhaseC['create-quiz-adapter'].forSavedMaterial;
  var toGenerationArgs = window.PhaseC['create-quiz-adapter'].toGenerationArgs;

  // -- demo identity: one signed-in demo user, session store ---------------
  var DEMO_TOKEN = 'demo_session_token';
  var users = { u_demo: { _id: 'u_demo', email: 'demo@example.com', name: 'Demo User' } };
  var sessions = makeSessionStore();
  sessions.add(DEMO_TOKEN, 'u_demo', 24 * 3600 * 1000, Date.now());

  var repo = new MemoryMaterialRepository();
  var service = new MaterialService({
    repo: repo,
    findSession: function (t) { return sessions.findSession(t); },
    getUser: function (id) { return users[id] || null; },
    attemptLinkage: {
      unlinkMaterial: function () { return Promise.resolve(0); }, // no attempts in demo
    },
    now: Date.now,
  });

  // -- clearly-labeled demo data -------------------------------------------
  var DEMO_TEXT =
    'DEMO DATA — not your content. In the real flow this text would be the ' +
    'normalized extraction of a document you uploaded or text you pasted.\n\n' +
    'Photosynthesis is the process by which green plants convert sunlight, water ' +
    'and carbon dioxide into glucose and oxygen. Chlorophyll absorbs light energy, ' +
    'which powers the splitting of water molecules and the fixation of carbon. ' +
    'The light-dependent reactions take place in the thylakoid membranes, while the ' +
    'Calvin cycle runs in the stroma, producing the sugars the plant needs to grow.';

  function seedDemo() {
    var seeds = [
      { title: 'Biology — Photosynthesis', subject: 'Biology', kind: 'pdf', n: 3 },
      { title: 'Chemistry — Periodic Table', subject: 'Chemistry', kind: 'paste', n: 1 },
      { title: 'History — Cold War Notes', subject: 'History', kind: 'docx', n: 1 },
    ];
    var chain = Promise.resolve();
    seeds.forEach(function (s) {
      chain = chain.then(function () {
        return service.createMaterial(DEMO_TOKEN, {
          title: s.title,
          subject: s.subject,
          kind: s.kind,
          extractedText: DEMO_TEXT + '\n\n(Seed copy ' + s.n + ' of the demo corpus.)',
        });
      });
    });
    return chain;
  }

  // -- tiny view helpers ----------------------------------------------------
  function $(id) { return document.getElementById(id); }
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }
  function show(view) {
    ['libraryView', 'detailView', 'createView'].forEach(function (v) {
      $(v).classList.toggle('hidden', v !== view);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fmtDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // -- library ---------------------------------------------------------------
  function renderLibrary() {
    service.listMaterials(DEMO_TOKEN).then(function (res) {
      if (!res.ok) { toast(res.error.message); return; }
      var mats = res.data.materials;
      $('libCount').textContent = mats.length === 1 ? '1 material' : mats.length + ' materials';
      $('libQuota').textContent = mats.length + ' / ' + LIMITS.MAX_MATERIALS_PER_USER + ' used';
      $('emptyState').classList.toggle('hidden', mats.length > 0);
      var grid = $('materialGrid');
      grid.innerHTML = '';
      mats.forEach(function (m) {
        var card = document.createElement('article');
        card.className = 'card';
        card.innerHTML =
          '<div class="card-top"><span class="kind-badge">' + esc(m.kind) + '</span></div>' +
          '<h3>' + esc(m.title) + '</h3>' +
          (m.subject ? '<p class="card-subject">' + esc(m.subject) + '</p>' : '') +
          '<div class="card-foot"><span class="muted mono">' +
          m.charCount.toLocaleString() + ' chars · ' + fmtDate(m.updatedAt) +
          '</span><button class="open" data-id="' + esc(m.id) + '">Open →</button></div>';
        grid.appendChild(card);
      });
      grid.querySelectorAll('.open').forEach(function (b) {
        b.addEventListener('click', function () { renderDetail(b.getAttribute('data-id')); });
      });
      show('libraryView');
    });
  }

  // -- detail -----------------------------------------------------------------
  var currentId = null;
  function renderDetail(id) {
    service.getMaterial(DEMO_TOKEN, id).then(function (res) {
      if (!res.ok) { toast(res.error.message); return; }
      var m = res.data.material;
      currentId = m.id;
      $('detailKind').textContent = m.kind.toUpperCase() + (m.subject ? ' · ' + m.subject : '');
      $('detailTitle').textContent = m.title;
      $('detailMeta').textContent =
        m.charCount.toLocaleString() + ' characters · saved ' + fmtDate(m.createdAt);
      var preview = m.extractedText.length > 900
        ? m.extractedText.slice(0, 900) + '…'
        : m.extractedText;
      $('detailPreview').textContent = preview;
      $('adapterPanel').classList.add('hidden');
      show('detailView');
    });
  }

  // -- create ------------------------------------------------------------------
  function wireCreate() {
    var form = $('createForm');
    $('fText').addEventListener('input', function () {
      $('charCount').textContent = $('fText').value.length.toLocaleString() + ' chars';
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = {
        title: $('fTitle').value,
        subject: $('fSubject').value,
        kind: 'paste',
        extractedText: $('fText').value,
      };
      var v = validateMaterialInput(input); // instant client feedback
      if (!v.ok) {
        var err = $('formError');
        err.textContent = v.error.message;
        err.classList.remove('hidden');
        return;
      }
      $('formError').classList.add('hidden');
      service.createMaterial(DEMO_TOKEN, input).then(function (res) {
        if (!res.ok) { toast(res.error.message); return; }
        form.reset();
        $('charCount').textContent = '';
        toast('Material saved');
        renderDetail(res.data.material.id);
      });
    });
  }

  // -- wiring -------------------------------------------------------------------
  function wire() {
    $('newMaterialBtn').addEventListener('click', function () { show('createView'); });
    $('emptyCta').addEventListener('click', function () { show('createView'); });
    $('backBtn').addEventListener('click', renderLibrary);
    $('createBackBtn').addEventListener('click', renderLibrary);
    $('themeToggle').addEventListener('click', function () {
      var root = document.documentElement;
      var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', JSON.stringify(next)); } catch (e) {}
    });

    $('renameBtn').addEventListener('click', function () {
      var name = prompt('Rename material:', $('detailTitle').textContent);
      if (name === null) return;
      service.renameMaterial(DEMO_TOKEN, currentId, name).then(function (res) {
        if (!res.ok) { toast(res.error.message); return; }
        toast('Renamed');
        renderDetail(currentId);
      });
    });

    $('deleteBtn').addEventListener('click', function () {
      if (!confirm('Delete "' + $('detailTitle').textContent + '"? This cannot be undone.')) return;
      service.deleteMaterial(DEMO_TOKEN, currentId).then(function (res) {
        if (!res.ok) { toast(res.error.message); return; }
        toast('Material deleted');
        renderLibrary();
      });
    });

    $('useForQuizBtn').addEventListener('click', function () {
      // The real Create Quiz flow would navigate to the create view with
      // this adapter input; the prototype shows the adapter output instead.
      var args = toGenerationArgs(forSavedMaterial(currentId, $('detailTitle').textContent));
      $('adapterOutput').textContent = JSON.stringify(args, null, 2);
      $('adapterPanel').classList.remove('hidden');
      toast('Adapter input ready (see below)');
    });

    wireCreate();
  }

  seedDemo().then(function () { wire(); renderLibrary(); });
})();
