/*
 * Proposal front matter — the introduction pages that print ahead of the itemized
 * proposal, and the builder controls that feed them.
 *
 * This file is the registry, not the content. Each product line ships its own file
 * (intro-adventure.js, intro-soar.js, …) that registers a template:
 *
 *     SSGFrontMatter.register({
 *       id: 'ADVENTURE',
 *       label: 'Summit Adventure Series',
 *       matches: function (doc) { … },     // recognise the product on a proposal
 *       slots: [{ id, label, house }],     // the photo areas, in page order
 *       pages: [function (v, art) { … }],  // one function per printed sheet
 *     });
 *
 * app.js only ever talks to this file, so adding Soar, Flex or Basic later is one
 * new script tag and one new file — no change to the proposal engine.
 *
 * Every page is authored at 816 × 1056 px — exactly 8.5in × 11in at 96 dpi — and
 * prints edge to edge, so the print sheet IS the page. The @page rule that makes
 * that true lives in app.js (screen print styles) and in the standalone document
 * the server renderer receives; both use a zero page margin and give the itemized
 * proposal its own half inch as padding instead.
 *
 * Pages are inline-styled and self-contained, because the same markup is printed by
 * the browser, rendered to PDF by headless Chromium and inlined into the DocuSeal
 * packet, and only inline styles survive all three.
 *
 * PHOTOS
 * ------
 * Photography belongs to the template, not to the proposal: the same pictures go on
 * every Adventure proposal. They are managed once under Admin -> Proposal
 * introductions (intro-admin.js), stored server-side, and loaded here into one cache
 * at sign-in. A rep cannot change them from a proposal, and nothing image-sized is
 * written into a proposal version.
 *
 * Order of preference per slot: the photograph uploaded in Admin, then the house file
 * named by the slot (a JPEG deployed in /public/proposal/). A slot with neither prints
 * as white space — an empty grey box never reaches a customer.
 */
(function () {
  'use strict';

  var TEMPLATES = [];
  /** Host helpers borrowed from app.js — see init(). */
  var H = null;
  /**
   * What to generate: the introduction, the itemized proposal, or both.
   *
   * Deliberately NOT stored on the proposal. Pulling the introduction is something a
   * rep does at a moment — to send the story ahead of pricing, to reprint the pages
   * for a meeting — and it has nothing to do with the state of the record. Keeping it
   * out of meta means it works on a sent, signed or read-only version, needs no save,
   * and never marks a proposal dirty.
   */
  var SCOPE_KEY = 'ssgIntroScope';
  var SCOPES = [
    { id: 'BOTH', label: 'Introduction + proposal' },
    { id: 'INTRO', label: 'Introduction only' },
    { id: 'PROPOSAL', label: 'Proposal only' },
  ];

  /** Slot id -> data URL, as managed in Admin. Loaded once per session. */
  var ART = {};
  var artLoaded = false;
  /**
   * Longest edge of an uploaded photo, and JPEG quality.
   *
   * The default suits a wide band. A slot can raise it — see slot.maxEdge — and the
   * tall page-4 column has to: it prints 236 x 1056 px, which is 2112 px of vertical
   * detail at print resolution, so a 1400 px cap resamples the picture upwards and it
   * arrives on the page soft.
   */
  var MAX_EDGE = 1400,
    JPEG_QUALITY = 0.78;

  function scope() {
    var v = '';
    try {
      v = localStorage.getItem(SCOPE_KEY) || '';
    } catch (e) {
      v = '';
    }
    return v === 'INTRO' || v === 'PROPOSAL' ? v : 'BOTH';
  }

  function setScope(v) {
    try {
      localStorage.setItem(SCOPE_KEY, v);
    } catch (e) {
      /* private browsing */
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  /** August 17, 2026 — the letter's dateline. */
  function fmtDate(iso) {
    if (!iso) return '';
    var p = String(iso).slice(0, 10).split('-');
    if (p.length !== 3) return String(iso);
    var months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    var mi = Number(p[1]) - 1;
    if (!months[mi]) return String(iso);
    return months[mi] + ' ' + Number(p[2]) + ', ' + p[0];
  }

  /** Aug 17, 2026 — the cover's tighter form. */
  function fmtShort(iso) {
    var full = fmtDate(iso);
    if (!full) return '';
    var i = full.indexOf(' ');
    var month = full.slice(0, i);
    return (month.length > 4 ? month.slice(0, 3) : month) + full.slice(i);
  }

  /**
   * The model code, read off the itemized frame heading the builder writes
   * ("SQ-2MBL2TZ — Itemized"). Same derivation as the save-as-PDF file name, so an
   * edited heading is respected and a proposal with no frame prints no model line.
   */
  function modelCode(doc) {
    var model = '';
    ((doc && doc.lines) || []).forEach(function (l) {
      if ((l.lineType || '') !== 'GROUP' || model) return;
      if (/itemized/i.test(l.name || '')) {
        model = String(l.name)
          .replace(/\s*[-\u2013\u2014]\s*itemized.*$/i, '')
          .trim();
      }
    });
    return model;
  }

  /**
   * First name of the proposal contact — what an executive letter opens with. With
   * no contact on the proposal the letter still has to read as a letter, so it falls
   * back to a neutral salutation rather than printing "Dear ,".
   */
  function firstName(doc) {
    var name = String((doc && doc.meta && doc.meta.contactName) || '').trim();
    if (!name) return 'Colleague';
    return name.split(/\s+/)[0];
  }

  /** Register a product's introduction. Called by each intro-*.js at load. */
  function register(template) {
    if (!template || !template.id) return;
    TEMPLATES = TEMPLATES.filter(function (t) {
      return t.id !== template.id;
    });
    TEMPLATES.push({
      id: template.id,
      label: template.label || template.id,
      matches:
        typeof template.matches === 'function'
          ? template.matches
          : function () {
              return false;
            },
      slots: template.slots || [],
      pages: template.pages || [],
    });
  }

  function byId(id) {
    for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].id === id) return TEMPLATES[i];
    return null;
  }

  /** The product this proposal is recognised as, before any manual override. */
  function detect(doc) {
    for (var i = 0; i < TEMPLATES.length; i++) {
      try {
        if (TEMPLATES[i].matches(doc || {})) return TEMPLATES[i];
      } catch (e) {
        /* a bad matcher must not break the builder */
      }
    }
    return null;
  }

  /**
   * The template a document will actually print with: the rep's choice if they made
   * one, otherwise whatever the proposal looks like. 'NONE' means they deliberately
   * turned the introduction off.
   */
  function templateFor(doc) {
    var chosen = doc && doc.meta && doc.meta.introTemplate;
    if (chosen === 'NONE') return null;
    if (chosen) return byId(chosen) || detect(doc);
    return detect(doc);
  }

  /** True when this proposal has an introduction to print. */
  function applies(doc) {
    return !!templateFor(doc);
  }

  /**
   * The photographs a template will print with: whatever Admin has uploaded, then
   * the house file named by the slot.
   */
  function artOf(doc) {
    var t = templateFor(doc);
    var out = {};
    ((t && t.slots) || []).forEach(function (s) {
      out[s.id] = ART[s.id] || s.house || '';
    });
    return out;
  }

  /**
   * Load the managed photographs. Called once at sign-in by app.js, and again by the
   * admin screen after an upload. Synchronous readers (introHtml) use whatever is
   * cached, so a failed load degrades to the house files rather than to nothing.
   */
  function loadArt(force) {
    if (artLoaded && !force) return Promise.resolve(ART);
    if (!H || !H.authed) {
      artLoaded = true;
      return Promise.resolve(ART);
    }
    return H.authed('/intro-templates/art')
      .then(function (r) {
        return r.ok ? r.json() : { art: {} };
      })
      .then(function (d) {
        ART = (d && d.art) || {};
        artLoaded = true;
        return ART;
      })
      .catch(function () {
        artLoaded = true;
        return ART;
      });
  }

  /**
   * Downscale a picked file to a data URL. Used by the admin screen.
   *
   * `opts.maxEdge` and `opts.quality` come from the slot, so a page that prints a
   * photograph large is not held to the same ceiling as a page that prints it small.
   * Never upscales: a small original is stored as it is rather than being stretched.
   */
  function prepareImage(file, done, opts) {
    opts = opts || {};
    var maxEdge = Number(opts.maxEdge) > 0 ? Number(opts.maxEdge) : MAX_EDGE;
    var quality = Number(opts.quality) > 0 ? Number(opts.quality) : JPEG_QUALITY;
    var reader = new FileReader();
    reader.onload = function () {
      var im = new Image();
      im.onload = function () {
        var scale = Math.min(1, maxEdge / Math.max(im.width, im.height));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(im.width * scale));
        c.height = Math.max(1, Math.round(im.height * scale));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        done(c.toDataURL('image/jpeg', quality));
      };
      im.onerror = function () {
        done(null);
      };
      im.src = String(reader.result);
    };
    reader.onerror = function () {
      done(null);
    };
    reader.readAsDataURL(file);
  }

  /**
   * A photo area: the photograph, or nothing at all. A house photo that has not been
   * added to the deployment yet removes itself on error, so a missing file leaves
   * clean white space instead of a broken-image icon in front of a customer.
   */
  function img(art, id) {
    var src = art && art[id];
    if (!src) return '';
    return (
      '<img src="' +
      esc(src) +
      '" alt="" onerror="this.style.display=\'none\'" ' +
      'style="width:100%;height:100%;object-fit:cover;display:block;">'
    );
  }

  /** Everything the pages merge from the proposal record. */
  function values(doc, opts) {
    var m = (doc && doc.meta) || {};
    var u = (opts && opts.user) || {};
    var rev = (Number(doc.version) || 1) > 1 ? ' \u00b7 Revision ' + (Number(doc.version) - 1) : '';
    var issued = [];
    if (m.proposalDate) issued.push('Issued ' + fmtShort(m.proposalDate));
    if (m.expiration) issued.push('valid through ' + fmtShort(m.expiration));
    return {
      org: esc(doc.orgName || ''),
      firstName: esc(firstName(doc)),
      model: esc(modelCode(doc)),
      number: esc(doc.number || ''),
      numberRev: esc(doc.number || '') + rev,
      issuedLine: esc(issued.join(' \u00b7 ')),
      letterDate: esc(fmtDate(m.proposalDate)),
      repName: esc([u.name || u.email || '', u.title].filter(Boolean).join(', ')),
      repContact: esc([u.phone, u.email].filter(Boolean).join(' \u00b7 ')),
    };
  }

  /** The introduction for this proposal, merged and ready to print. */
  function introHtml(doc, opts) {
    doc = doc || {};
    var t = templateFor(doc);
    if (!t) return '';
    var v = values(doc, opts || {});
    var art = artOf(doc);
    return (
      '<div class="ssg-front-matter" data-intro="' +
      esc(t.id) +
      '">' +
      t.pages
        .map(function (fn) {
          return fn(v, art, { img: img, esc: esc });
        })
        .join('') +
      '</div>'
    );
  }

  /* ------------------------------------------------------------------ builder */

  /**
   * The builder card: which introduction this proposal uses.
   *
   * Only the template lives here, because only the template is a property of the
   * proposal. Photography belongs to the product line and is managed under Admin;
   * what to generate is chosen at the moment of generating — see scopeToggleHtml().
   */
  function panelHtml(doc) {
    var meta = (doc && doc.meta) || {};
    var detected = detect(doc);
    var active = templateFor(doc);
    if (!detected && !active && !meta.introTemplate) return '';

    var chosen = meta.introTemplate || '';

    var options = [
      '<option value=""' +
        (chosen ? '' : ' selected') +
        '>' +
        (detected ? 'Auto \u2014 ' + esc(detected.label) : 'Auto \u2014 none detected') +
        '</option>',
    ];
    TEMPLATES.forEach(function (t) {
      options.push(
        '<option value="' +
          esc(t.id) +
          '"' +
          (chosen === t.id ? ' selected' : '') +
          '>' +
          esc(t.label) +
          '</option>',
      );
    });
    options.push(
      '<option value="NONE"' +
        (chosen === 'NONE' ? ' selected' : '') +
        '>No introduction pages</option>',
    );

    return (
      '<div class="card" style="margin-bottom:16px;">' +
      '<div class="section-title" style="margin:0 0 4px;">Proposal introduction</div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:12px;">Introduction pages print ahead of the itemized proposal, each on its own 8.5&Prime; &times; 11&Prime; sheet. Their wording and photography are set under Admin &rarr; Proposal introductions.</div>' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<label style="font-size:12.5px;color:#20241f;">Template</label>' +
      '<select id="fmTemplate" style="padding:7px 10px;font-size:12.5px;border:1px solid #dfe3ec;border-radius:7px;background:#fff;min-width:250px;">' +
      options.join('') +
      '</select>' +
      (active
        ? '<span class="muted" style="font-size:11.5px;">' + active.pages.length + ' pages</span>'
        : '<span class="muted" style="font-size:11.5px;">No introduction pages will be included.</span>') +
      '</div>' +
      '<div class="muted" style="font-size:11.5px;margin-top:10px;">Choose whether to generate the introduction, the proposal, or both when you preview or save the PDF.</div>' +
      '</div>'
    );
  }

  /**
   * Wire the builder card. `meta` is the builder's meta object, mutated in place;
   * `onChange` marks the builder dirty and re-renders it.
   */
  function bindPanel(root, meta, onChange) {
    if (!root || !meta) return;
    var sel = root.querySelector('#fmTemplate');
    if (sel)
      sel.addEventListener('change', function () {
        meta.introTemplate = sel.value;
        onChange();
      });
  }

  /**
   * The what-to-generate switch shown in the preview toolbar.
   *
   * It lives with the preview rather than with the proposal so it is reachable on any
   * version at any time — draft, sent, signed, read-only — without touching the record.
   */
  function scopeToggleHtml(doc) {
    if (!applies(doc)) return '';
    var cur = scope();
    return (
      '<div id="fmScopeBar" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
      '<span style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Generate</span>' +
      '<div style="display:flex;border:1px solid #dfe3ec;border-radius:8px;overflow:hidden;background:#fff;">' +
      SCOPES.map(function (s, i) {
        var on = cur === s.id;
        return (
          '<button type="button" data-fm-scope="' +
          s.id +
          '" style="border:0;' +
          (i ? 'border-left:1px solid #dfe3ec;' : '') +
          'padding:9px 14px;font-family:inherit;font-size:12.5px;cursor:pointer;' +
          'background:' +
          (on ? '#3d4a55' : '#fff') +
          ';color:' +
          (on ? '#fff' : '#3d4a55') +
          ';' +
          'font-weight:' +
          (on ? '600' : '400') +
          ';">' +
          esc(s.label) +
          '</button>'
        );
      }).join('') +
      '</div></div>'
    );
  }

  /** Wire that switch. `onChange` re-renders whatever is on screen. */
  function bindScopeToggle(root, onChange) {
    if (!root) return;
    root.querySelectorAll('[data-fm-scope]').forEach(function (b) {
      b.addEventListener('click', function () {
        setScope(b.getAttribute('data-fm-scope'));
        onChange();
      });
    });
  }

  window.SSGFrontMatter = {
    /**
     * Borrow the shell's helpers, as FreightTrueUp does: everything this module needs
     * from app.js, named rather than reached for.
     */
    init: function (helpers) {
      H = helpers;
    },
    loadArt: loadArt,
    prepareImage: prepareImage,
    art: function () {
      return ART;
    },
    scope: scope,
    setScope: setScope,
    scopeToggleHtml: scopeToggleHtml,
    bindScopeToggle: bindScopeToggle,
    register: register,
    templates: function () {
      return TEMPLATES.slice();
    },
    detect: detect,
    templateFor: templateFor,
    applies: applies,
    introHtml: introHtml,
    panelHtml: panelHtml,
    bindPanel: bindPanel,
    modelCode: modelCode,
    helpers: { esc: esc, img: img, fmtDate: fmtDate, fmtShort: fmtShort, firstName: firstName },
  };
})();
