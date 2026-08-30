/**
 * The legal document editor: Administration -> Proposal content.
 *
 * Two documents, the release and the standard terms, edited as titled blocks rather than
 * as one text area. They are already structured that way — the release is Roman-numeral
 * articles, the terms are twelve numbered clauses — and editing them block by block keeps
 * the printed page-break rules working. A single rich-text box would let pasted
 * formatting break the 9pt Aptos the whole document is set in.
 *
 * DRAFT AND PUBLISHED ARE SEPARATE. Save changes nothing about what prints; Publish does.
 * A legal document under revision is the one place where "save" must not mean "live".
 *
 * Preview renders through the real proposal renderer (SSGContractPages.withContent), not
 * a facsimile, so what you approve is what prints.
 *
 * Registers on window.SSGLegalAdmin. Needs authed and esc from the shell.
 */
(function () {
  'use strict';

  var H = null;
  var STATE = [];
  var open = {};
  var previewing = {};

  var IN =
    'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d8dcd2;border-radius:6px;' +
    'font-family:inherit;font-size:13px;color:#20241f;background:#fff;';
  var TA = IN + 'line-height:1.55;resize:vertical;';
  var BTN =
    'border:1px solid #d8dcd2;background:#fff;border-radius:6px;padding:7px 13px;font-family:inherit;' +
    'font-size:12.5px;cursor:pointer;color:#3d4a55;';
  var PRIMARY =
    'border:1px solid #203060;background:#203060;color:#fff;border-radius:6px;padding:7px 15px;' +
    'font-family:inherit;font-size:12.5px;cursor:pointer;font-weight:600;';

  function esc(s) {
    return H && H.esc ? H.esc(s) : String(s == null ? '' : s);
  }

  /** The copy being edited: the draft if there is one, otherwise the published text. */
  function working(doc) {
    return doc.draft || doc.published;
  }

  function label(key) {
    return key === 'RELEASE' ? 'General release of liability' : 'Standard terms & conditions';
  }

  /* ------------------------------------------------------------------ rendering */

  function blockEditor(key, kind, i, block, total) {
    var isArticle = kind === 'ARTICLES';
    var titleId = 'lg_' + key + '_t_' + i;
    var bodyId = 'lg_' + key + '_b_' + i;
    var numeral = isArticle ? block.numeral : String(i + 1);

    var subs = '';
    if (isArticle && (block.subs || []).length) {
      subs =
        '<div style="margin-top:9px;padding-left:12px;border-left:2px solid #eceee8;">' +
        '<div class="muted" style="font-size:11px;margin-bottom:5px;">' +
        'Sub-paragraphs. <b>**bold**</b> and merge fields like <b>{{customer}}</b> work here.' +
        '</div>' +
        block.subs
          .map(function (s, j) {
            return (
              '<div style="display:flex;gap:7px;margin-top:6px;">' +
              '<input value="' +
              esc(s.numeral) +
              '" id="lg_' +
              key +
              '_sn_' +
              i +
              '_' +
              j +
              '" style="' +
              IN +
              'width:52px;flex:none;text-align:center;">' +
              '<textarea id="lg_' +
              key +
              '_sb_' +
              i +
              '_' +
              j +
              '" rows="3" style="' +
              TA +
              '">' +
              esc(s.text) +
              '</textarea>' +
              '</div>'
            );
          })
          .join('') +
        '</div>';
    }

    return (
      '<div data-lgblock="' +
      i +
      '" style="border:1px solid #e6e9e1;border-radius:8px;padding:12px 13px;margin-top:9px;background:#fcfdfb;">' +
      '<div style="display:flex;gap:9px;align-items:center;">' +
      (isArticle
        ? '<input value="' +
          esc(numeral) +
          '" id="lg_' +
          key +
          '_n_' +
          i +
          '" style="' +
          IN +
          'width:56px;flex:none;text-align:center;font-weight:600;">'
        : '<div style="flex:none;width:26px;text-align:center;font-weight:700;color:#8a8f85;">' +
          numeral +
          '.</div>') +
      '<input value="' +
      esc(block.title) +
      '" id="' +
      titleId +
      '" style="' +
      IN +
      'font-weight:600;">' +
      '<div style="display:flex;gap:3px;flex:none;">' +
      btn('&#9650;', 'lgup', key, i, i === 0) +
      btn('&#9660;', 'lgdown', key, i, i === total - 1) +
      btn('&#10005;', 'lgdel', key, i, total <= 1) +
      '</div>' +
      '</div>' +
      '<textarea id="' +
      bodyId +
      '" rows="' +
      Math.min(16, Math.max(4, Math.ceil(bodyText(kind, block).length / 95))) +
      '" style="' +
      TA +
      'margin-top:8px;">' +
      esc(bodyText(kind, block)) +
      '</textarea>' +
      '<div class="muted" style="font-size:11px;margin-top:4px;">' +
      'Leave a blank line between paragraphs.' +
      '</div>' +
      subs +
      '</div>'
    );
  }

  function btn(glyph, act, key, i, disabled) {
    return (
      '<button data-' +
      act +
      '="' +
      i +
      '" data-lgkey="' +
      key +
      '"' +
      (disabled ? ' disabled' : '') +
      ' style="' +
      BTN +
      'padding:6px 9px;line-height:1;' +
      (disabled ? 'opacity:.32;cursor:default;' : '') +
      '">' +
      glyph +
      '</button>'
    );
  }

  /** Articles carry paragraphs[]; sections carry one body string. Same textarea. */
  function bodyText(kind, block) {
    return kind === 'ARTICLES' ? (block.paragraphs || []).join('\n\n') : block.body || '';
  }

  function docCard(doc) {
    var w = working(doc);
    var blocks = w.kind === 'ARTICLES' ? w.articles || [] : w.sections || [];
    var isOpen = !!open[doc.key];
    var hasDraft = !!doc.draft;

    var head =
      '<div style="display:flex;align-items:baseline;gap:10px;">' +
      '<div class="section-title" style="margin:0;">' +
      esc(label(doc.key)) +
      '</div>' +
      (hasDraft
        ? '<span style="font-size:11px;font-weight:600;color:#8a6d1f;background:#fdf6e6;' +
          'border:1px solid #ecd9a6;border-radius:99px;padding:2px 9px;">Unpublished draft</span>'
        : '') +
      '<div style="flex:1;"></div>' +
      '<button data-lgtoggle="' +
      doc.key +
      '" style="' +
      BTN +
      '">' +
      (isOpen ? 'Close' : 'Edit') +
      '</button>' +
      '</div>';

    var meta =
      '<div class="muted" style="font-size:11.5px;margin-top:3px;line-height:1.6;">' +
      'Prints as &ldquo;' +
      esc(w.title) +
      '&rdquo;. ' +
      (doc.publishedVersion
        ? 'Published revision ' + doc.publishedVersion + '.'
        : 'Never edited &mdash; printing the wording this release shipped with.') +
      (hasDraft ? ' <b>The draft below is not printing yet.</b>' : '') +
      '</div>';

    if (!isOpen) return '<div class="card" style="margin-top:14px;">' + head + meta + '</div>';

    return (
      '<div class="card" style="margin-top:14px;">' +
      head +
      meta +
      '<div style="margin-top:14px;">' +
      '<label style="display:block;font-size:12px;color:#5c6157;margin-bottom:4px;">' +
      'Printed document title</label>' +
      '<input id="lg_' +
      doc.key +
      '_title" value="' +
      esc(w.title) +
      '" style="' +
      IN +
      'font-weight:600;">' +
      // The trap worth naming: the release's own first sentence says "This General
      // Release of Liability...". Renaming the heading does not rewrite the prose.
      '<div class="muted" style="font-size:11px;margin-top:4px;">' +
      'Renaming the heading does not change the document&rsquo;s own text. If a clause ' +
      'names the document, edit that clause too.' +
      '</div>' +
      '</div>' +
      '<div style="margin-top:16px;">' +
      blocks
        .map(function (b, i) {
          return blockEditor(doc.key, w.kind, i, b, blocks.length);
        })
        .join('') +
      '</div>' +
      (w.kind === 'ARTICLES' && w.closing !== undefined
        ? '<div style="margin-top:14px;">' +
          '<label style="display:block;font-size:12px;color:#5c6157;margin-bottom:4px;">' +
          'Closing line, above the signature blocks</label>' +
          '<textarea id="lg_' +
          doc.key +
          '_closing" rows="2" style="' +
          TA +
          '">' +
          esc(w.closing || '') +
          '</textarea></div>'
        : '') +
      '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;align-items:center;">' +
      '<button data-lgadd="' +
      doc.key +
      '" style="' +
      BTN +
      '">Add ' +
      (w.kind === 'ARTICLES' ? 'article' : 'clause') +
      '</button>' +
      '<button data-lgpreview="' +
      doc.key +
      '" style="' +
      BTN +
      '">Preview</button>' +
      '<div style="flex:1;"></div>' +
      '<button data-lgrestore="' +
      doc.key +
      '" style="' +
      BTN +
      '">Restore shipped wording</button>' +
      (hasDraft
        ? '<button data-lgdiscard="' + doc.key + '" style="' + BTN + '">Discard draft</button>'
        : '') +
      '<button data-lgsave="' +
      doc.key +
      '" style="' +
      BTN +
      '">Save draft</button>' +
      '<button data-lgpublish="' +
      doc.key +
      '" style="' +
      PRIMARY +
      (hasDraft ? '' : 'opacity:.4;cursor:default;') +
      '"' +
      (hasDraft ? '' : ' disabled') +
      '>Publish</button>' +
      '</div>' +
      '<div id="lg_' +
      doc.key +
      '_msg" style="font-size:12px;margin-top:9px;"></div>' +
      '<div id="lg_' +
      doc.key +
      '_preview" style="margin-top:12px;"></div>' +
      '</div>'
    );
  }

  /* ------------------------------------------------------------------ reading the form */

  /**
   * Pull the edited document back out of the DOM.
   *
   * Read from the inputs rather than kept in a parallel model, so what is saved is what is
   * on screen — there is no second copy to fall out of step with.
   */
  function collect(doc) {
    var w = working(doc);
    var kind = w.kind;
    var out = { title: val('lg_' + doc.key + '_title', w.title), kind: kind };
    var blocks = kind === 'ARTICLES' ? w.articles || [] : w.sections || [];
    var read = [];

    for (var i = 0; i < blocks.length; i++) {
      var host = document.querySelector('[data-lgblock="' + i + '"]');
      if (!host) continue;
      var title = val('lg_' + doc.key + '_t_' + i, blocks[i].title);
      var body = val('lg_' + doc.key + '_b_' + i, bodyText(kind, blocks[i]));
      if (kind === 'ARTICLES') {
        var subs = (blocks[i].subs || [])
          .map(function (s, j) {
            return {
              numeral: val('lg_' + doc.key + '_sn_' + i + '_' + j, s.numeral),
              text: val('lg_' + doc.key + '_sb_' + i + '_' + j, s.text),
            };
          })
          .filter(function (s) {
            return s.text;
          });
        read.push({
          numeral: val('lg_' + doc.key + '_n_' + i, blocks[i].numeral),
          title: title,
          paragraphs: splitParas(body),
          subs: subs,
        });
      } else {
        read.push({ title: title, body: body });
      }
    }
    if (kind === 'ARTICLES') {
      out.articles = read;
      out.closing = val('lg_' + doc.key + '_closing', w.closing || '');
    } else {
      out.sections = read;
    }
    return out;
  }

  function splitParas(body) {
    var parts = String(body || '')
      .split(/\n\s*\n/)
      .map(function (p) {
        return p.trim();
      })
      .filter(Boolean);
    return parts.length ? parts : [''];
  }

  function val(id, fallback) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : fallback;
  }

  function say(key, text, bad) {
    var el = document.getElementById('lg_' + key + '_msg');
    if (el)
      el.innerHTML =
        '<span style="color:' + (bad ? '#a4262c' : '#3f6212') + ';">' + esc(text) + '</span>';
  }

  /* ------------------------------------------------------------------ actions */

  async function reload(host) {
    var r = await H.authed('/legal-documents');
    STATE = r && r.ok ? (await r.json()) || [] : [];
    draw(host);
  }

  async function save(key, host, then) {
    var doc = byKey(key);
    if (!doc) return;
    var body = collect(doc);
    var r = await H.authed('/legal-documents/' + key + '/draft', { method: 'PUT', body: body });
    if (!r.ok) {
      var msg = '';
      try {
        msg = ((await r.json()) || {}).message || '';
      } catch (e) {}
      say(key, msg || 'The draft could not be saved (' + r.status + ').', true);
      return;
    }
    var updated = await r.json();
    replace(updated);
    if (then) {
      await then();
      return;
    }
    draw(host);
    say(key, 'Draft saved. It is not printing yet — publish when it is ready.');
  }

  function byKey(key) {
    for (var i = 0; i < STATE.length; i++) if (STATE[i].key === key) return STATE[i];
    return null;
  }

  function replace(updated) {
    for (var i = 0; i < STATE.length; i++) if (STATE[i].key === updated.key) STATE[i] = updated;
  }

  /**
   * Preview through the real renderer.
   *
   * A sample customer, because the release substitutes one and an admin previewing the
   * wording has no proposal in hand. Named obviously so nobody mistakes it for real data.
   */
  function preview(key) {
    var doc = byKey(key);
    var box = document.getElementById('lg_' + key + '_preview');
    if (!doc || !box || !window.SSGContractPages) return;
    if (previewing[key]) {
      previewing[key] = false;
      box.innerHTML = '';
      return;
    }
    previewing[key] = true;
    var content = {};
    STATE.forEach(function (d) {
      content[d.key] = d.key === key ? collect(doc) : working(d);
    });
    var sample = {
      orgName: 'Sample Customer, LLC',
      meta: {
        contactName: 'Sample Contact',
        billTo: 'Sample Customer, LLC\n123 Example Street\nDenver, CO 80202',
        includeRelease: key === 'RELEASE',
        includeTerms: key === 'TERMS',
      },
    };
    var html = window.SSGContractPages.withContent(content, sample, {
      esc: esc,
      user: { name: 'Preview' },
    });
    box.innerHTML =
      '<div class="muted" style="font-size:11px;margin-bottom:6px;">' +
      'Rendered by the proposal document itself, with a sample customer.' +
      '</div>' +
      '<div style="border:1px solid #e6e9e1;border-radius:8px;background:#fff;padding:26px 30px;' +
      'max-height:520px;overflow:auto;">' +
      html +
      '</div>';
  }

  /* ------------------------------------------------------------------ mount */

  function draw(host) {
    if (!host) return;
    host.innerHTML =
      '<div class="muted" style="font-size:12px;line-height:1.6;">' +
      'These two documents print after the acceptance page on every proposal except the ' +
      'cover-only template. Saving a draft changes nothing about what prints; publishing ' +
      'does. A proposal already released keeps the wording it went out with.' +
      '</div>' +
      STATE.map(docCard).join('');
    bind(host);
  }

  function bind(host) {
    var on = function (attr, fn) {
      host.querySelectorAll('[data-' + attr + ']').forEach(function (b) {
        b.addEventListener('click', function () {
          fn(b.getAttribute('data-' + attr), b);
        });
      });
    };

    on('lgtoggle', function (key) {
      open[key] = !open[key];
      previewing[key] = false;
      draw(host);
    });
    on('lgpreview', function (key) {
      preview(key);
    });
    on('lgsave', function (key) {
      save(key, host);
    });
    on('lgdiscard', async function (key) {
      if (!confirm('Discard the unpublished draft and keep the wording that is printing?')) return;
      var r = await H.authed('/legal-documents/' + key + '/draft', { method: 'DELETE' });
      if (r.ok) {
        replace(await r.json());
        draw(host);
        say(key, 'Draft discarded.');
      }
    });
    on('lgrestore', async function (key) {
      if (
        !confirm(
          'Load the wording this release shipped with into the draft?\n\nNothing is published until you publish it.',
        )
      )
        return;
      var r = await H.authed('/legal-documents/' + key + '/restore-shipped', { method: 'POST' });
      if (r.ok) {
        replace(await r.json());
        open[key] = true;
        draw(host);
        say(key, 'Shipped wording loaded into the draft. Review it, then publish.');
      }
    });
    on('lgpublish', async function (key) {
      var doc = byKey(key);
      if (!doc) return;
      if (
        !confirm(
          'Publish this wording?\n\nEvery proposal released from now on prints it. ' +
            'Proposals already released keep the wording they went out with.',
        )
      )
        return;
      var r = await H.authed('/legal-documents/' + key + '/publish', { method: 'POST' });
      if (!r.ok) {
        var msg = '';
        try {
          msg = ((await r.json()) || {}).message || '';
        } catch (e) {}
        say(key, msg || 'Could not publish (' + r.status + ').', true);
        return;
      }
      replace(await r.json());
      draw(host);
      say(key, 'Published. New proposals will print this wording.');
      // The renderer caches the fetched text; refresh it so a preview elsewhere in this
      // session does not keep showing the superseded wording.
      if (window.SSGContractPages && window.SSGContractPages.load) {
        window.SSGContractPages.init({ authed: H.authed });
      }
    });

    // Structural edits save first, so the reorder or deletion is applied to text that is
    // already persisted rather than to a stale copy.
    var structural = function (attr, mutate) {
      on(attr, function (raw, b) {
        var key = b.getAttribute('data-lgkey') || raw;
        var doc = byKey(key);
        if (!doc) return;
        var next = collect(doc);
        mutate(next, parseInt(raw, 10));
        doc.draft = next;
        draw(host);
        save(key, host);
      });
    };
    var listOf = function (c) {
      return c.kind === 'ARTICLES' ? c.articles : c.sections;
    };
    structural('lgup', function (c, i) {
      var l = listOf(c);
      if (i > 0) l.splice(i - 1, 0, l.splice(i, 1)[0]);
    });
    structural('lgdown', function (c, i) {
      var l = listOf(c);
      if (i < l.length - 1) l.splice(i + 1, 0, l.splice(i, 1)[0]);
    });
    structural('lgdel', function (c, i) {
      var l = listOf(c);
      if (l.length > 1) l.splice(i, 1);
    });

    on('lgadd', function (key) {
      var doc = byKey(key);
      if (!doc) return;
      var next = collect(doc);
      if (next.kind === 'ARTICLES') {
        next.articles.push({
          numeral: roman(next.articles.length + 1),
          title: 'New article',
          paragraphs: [''],
          subs: [],
        });
      } else {
        next.sections.push({ title: 'New clause', body: '' });
      }
      doc.draft = next;
      open[key] = true;
      draw(host);
    });
  }

  /** Roman numerals for a new article, so it matches the ones above it. */
  function roman(n) {
    var map = [
      [10, 'X'],
      [9, 'IX'],
      [5, 'V'],
      [4, 'IV'],
      [1, 'I'],
    ];
    var out = '';
    for (var i = 0; i < map.length; i++) {
      while (n >= map[i][0]) {
        out += map[i][1];
        n -= map[i][0];
      }
    }
    return out || 'I';
  }

  window.SSGLegalAdmin = {
    init: function (helpers) {
      H = helpers;
    },
    /** Called by the Proposal content tab with its container element. */
    render: async function (host) {
      if (!H || !H.authed || !host) return;
      host.innerHTML = '<div class="muted" style="font-size:12px;">Loading&hellip;</div>';
      try {
        await reload(host);
      } catch (e) {
        host.innerHTML =
          '<div class="muted" style="font-size:12px;">The legal documents could not be loaded.</div>';
      }
    },
  };
})();
