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
  // `white-space:nowrap`: without it "Save draft" and "Add article" wrap onto two lines
  // inside the wrapping button row, which reads as a broken control rather than a button.
  var BTN =
    'border:1px solid #d8dcd2;background:#fff;border-radius:6px;padding:7px 13px;font-family:inherit;' +
    'font-size:12.5px;cursor:pointer;color:#3d4a55;white-space:nowrap;';
  var PRIMARY =
    'border:1px solid #203060;background:#203060;color:#fff;border-radius:6px;padding:7px 15px;' +
    'font-family:inherit;font-size:12.5px;cursor:pointer;font-weight:600;white-space:nowrap;';

  function esc(s) {
    return H && H.esc ? H.esc(s) : String(s == null ? '' : s);
  }

  /** The copy being edited: the draft if there is one, otherwise the published text. */
  function working(doc) {
    return doc.draft || doc.published;
  }

  /**
   * What to call a document in this panel.
   *
   * Its own title, because the title is editable and a fixed label goes stale the moment
   * it is used: the first slot now holds a Product Use, Safety & Responsibility
   * Acknowledgment, and a card headed with the old name above it is simply wrong.
   */
  function label(doc) {
    var w = working(doc);
    return w.title || (doc.key === 'RELEASE' ? 'First document' : 'Second document');
  }

  /* ------------------------------------------------------------------ rendering */

  function blockEditor(key, kind, i, block, total) {
    var isArticle = kind === 'ARTICLES';
    var titleId = 'lg_' + key + '_t_' + i;
    var bodyId = 'lg_' + key + '_b_' + i;
    var numeral = isArticle ? block.numeral : String(i + 1);

    // Both kinds, not only articles. A numbered clause takes a list, sub-sections and
    // trailing text on exactly the same terms — the two documents are no longer different
    // kinds of thing, only differently numbered.
    var subs = '';
    if ((block.subs || []).length) {
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

    /*
     * Lettered sub-sections: a heading of its own, then its own paragraphs.
     *
     * The level between an article and a bare list item. A list item is a numeral and a
     * run of text; a sub-section is a block with a title, which is how a long article
     * divides itself into A, B, C.
     */
    var subsecs = '';
    if (true) {
      var list = block.subsections || [];
      subsecs =
        '<div style="margin-top:11px;padding-left:12px;border-left:2px solid #dce4d4;">' +
        '<div class="muted" style="font-size:11px;margin-bottom:6px;">' +
        'Sub-sections &mdash; each prints its own heading, lettered A, B, C.' +
        '</div>' +
        list
          .map(function (ss, j) {
            var body = (ss.paragraphs || []).join('\n\n');
            return (
              '<div style="border:1px solid #e6e9e1;border-radius:7px;padding:10px;margin-top:7px;background:#fff;">' +
              '<div style="display:flex;gap:7px;align-items:center;">' +
              '<input value="' +
              esc(ss.letter) +
              '" id="lg_' +
              key +
              '_ssl_' +
              i +
              '_' +
              j +
              '" style="' +
              IN +
              'width:48px;flex:none;text-align:center;font-weight:600;">' +
              '<input value="' +
              esc(ss.title) +
              '" id="lg_' +
              key +
              '_sst_' +
              i +
              '_' +
              j +
              '" style="' +
              IN +
              'font-weight:600;">' +
              '<div style="display:flex;gap:3px;flex:none;">' +
              ssBtn('&#9650;', 'lgssup', key, i, j, j === 0) +
              ssBtn('&#9660;', 'lgssdown', key, i, j, j === list.length - 1) +
              ssBtn('&#10005;', 'lgssdel', key, i, j, false) +
              '</div></div>' +
              '<textarea id="lg_' +
              key +
              '_ssb_' +
              i +
              '_' +
              j +
              '" rows="' +
              Math.min(14, Math.max(3, Math.ceil(body.length / 95))) +
              '" style="' +
              TA +
              'margin-top:7px;">' +
              esc(body) +
              '</textarea>' +
              '</div>'
            );
          })
          .join('') +
        '<div style="display:flex;gap:6px;margin-top:8px;">' +
        '<button data-lgaddsub="' +
        i +
        '" data-lgkey="' +
        key +
        '" style="' +
        BTN +
        'font-size:12px;">+ List item</button>' +
        '<button data-lgaddss="' +
        i +
        '" data-lgkey="' +
        key +
        '" style="' +
        BTN +
        'font-size:12px;">+ Sub-section</button>' +
        '</div>' +
        '</div>';
    }

    /*
     * Paragraphs that print AFTER the lists.
     *
     * The part that used to be impossible. A qualification such as "Nothing herein
     * releases Summit from..." has to follow the list of claims it qualifies; with
     * nowhere to put it, it had to be appended to the last list item, where it reads as
     * part of that item rather than as applying to all of them.
     */
    var trail = '';
    if (true) {
      var after = (block.trailing || []).join('\n\n');
      trail =
        '<div style="margin-top:10px;">' +
        '<label style="display:block;font-size:12px;color:#5c6157;margin-bottom:4px;">' +
        'Paragraphs after the list <span class="muted" style="font-weight:400;">' +
        '&mdash; optional; prints below everything above</span></label>' +
        '<textarea id="lg_' +
        key +
        '_tr_' +
        i +
        '" rows="' +
        Math.min(10, Math.max(2, Math.ceil(after.length / 95))) +
        '" style="' +
        TA +
        '">' +
        esc(after) +
        '</textarea></div>';
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
      subsecs +
      trail +
      '</div>'
    );
  }

  /**
   * A button that has to name both the article and the sub-section it acts on.
   *
   * Encoded as "i:j" in one attribute rather than two, so the click handler reads one
   * value and cannot pick up a stale index from a redrawn sibling.
   */
  function ssBtn(glyph, act, key, i, j, disabled) {
    return (
      '<button data-' +
      act +
      '="' +
      i +
      ':' +
      j +
      '" data-lgkey="' +
      key +
      '"' +
      (disabled ? ' disabled' : '') +
      ' style="' +
      BTN +
      'padding:5px 8px;line-height:1;font-size:11px;' +
      (disabled ? 'opacity:.32;cursor:default;' : '') +
      '">' +
      glyph +
      '</button>'
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
    var preambleText = (w.preamble || []).join('\n\n');
    var isOpen = !!open[doc.key];
    var hasDraft = !!doc.draft;

    var head =
      '<div style="display:flex;align-items:baseline;gap:10px;">' +
      '<div class="section-title" style="margin:0;">' +
      esc(label(doc)) +
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
      (doc.key === 'RELEASE'
        ? 'Prints first, before the terms &mdash; it names the parties the terms rely on. '
        : 'Prints last. ') +
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
      /*
       * Unnumbered opening prose.
       *
       * Above the clause list because that is where it prints. An opening line like "This
       * Agreement is entered into between the parties named below" is not a term of the
       * agreement, and before this it had to be typed as clause 1 — numbering a sentence
       * that is not a clause and pushing every real one down by one.
       */
      '<div style="margin-top:14px;">' +
      '<label style="display:block;font-size:12px;color:#5c6157;margin-bottom:4px;">' +
      'Opening paragraphs <span class="muted" style="font-weight:400;">' +
      '&mdash; optional; print under the title with no number</span></label>' +
      '<textarea id="lg_' +
      doc.key +
      '_pre" rows="' +
      Math.min(10, Math.max(2, Math.ceil(preambleText.length / 95))) +
      '" style="' +
      TA +
      '">' +
      esc(preambleText) +
      '</textarea>' +
      '<div class="muted" style="font-size:11px;margin-top:4px;">' +
      'Leave a blank line between paragraphs.' +
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
      layoutPanel(doc) +
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
      /*
       * Read for both kinds before the branch.
       *
       * These used to live inside the ARTICLES arm, because only an article had them.
       * Numbered clauses now do too, and computing them in one place is what stops the
       * two arms drifting into two slightly different readers of the same fields.
       */
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
      var subsections = (blocks[i].subsections || [])
        .map(function (ss, j) {
          return {
            letter: val('lg_' + doc.key + '_ssl_' + i + '_' + j, ss.letter),
            title: val('lg_' + doc.key + '_sst_' + i + '_' + j, ss.title),
            paragraphs: splitParas(
              val('lg_' + doc.key + '_ssb_' + i + '_' + j, (ss.paragraphs || []).join('\n\n')),
            ),
          };
        })
        // A sub-section with neither heading nor text is one somebody added and thought
        // better of. Dropped rather than saved as an empty block that fails validation.
        .filter(function (ss) {
          return ss.title || ss.paragraphs.length;
        });
      if (kind === 'ARTICLES') {
        read.push({
          numeral: val('lg_' + doc.key + '_n_' + i, blocks[i].numeral),
          title: title,
          paragraphs: splitParas(body),
          subs: subs,
          subsections: subsections,
          trailing: splitParas(
            val('lg_' + doc.key + '_tr_' + i, (blocks[i].trailing || []).join('\n\n')),
          ),
        });
      } else {
        /*
         * `body` stays the prose for a numbered clause, and the new parts sit beside it.
         *
         * Not converted to `paragraphs`: the renderer reads `body` when `paragraphs` is
         * absent and the two produce identical output, so leaving it alone means an
         * untouched terms document is byte-for-byte what it was.
         */
        read.push({
          title: title,
          body: body,
          subs: subs,
          subsections: subsections,
          trailing: splitParas(
            val('lg_' + doc.key + '_tr_' + i, (blocks[i].trailing || []).join('\n\n')),
          ),
        });
      }
    }
    if (kind === 'ARTICLES') {
      out.articles = read;
      out.closing = val('lg_' + doc.key + '_closing', w.closing || '');
      out.signature = {
        leftRole: val('lg_' + doc.key + '_sg_left', (w.signature || {}).leftRole || 'Customer'),
        rightRole: val(
          'lg_' + doc.key + '_sg_right',
          (w.signature || {}).rightRole || 'Summit Sensory Gym',
        ),
        title: checked('lg_' + doc.key + '_sg_title', !!(w.signature || {}).title),
      };
    } else {
      out.sections = read;
    }
    // Absent means absent: an empty box saves no preamble rather than one blank paragraph.
    out.preamble = splitParas(val('lg_' + doc.key + '_pre', (w.preamble || []).join('\n\n')));
    var st = w.style || {};
    out.style = {
      font: val('lg_' + doc.key + '_st_font', st.font || 'plex'),
      sizePt: Number(val('lg_' + doc.key + '_st_size', st.sizePt || 9)),
      lineHeight: Number(val('lg_' + doc.key + '_st_lh', st.lineHeight || 1.35)),
      align: val('lg_' + doc.key + '_st_align', st.align || 'justify'),
      titlePt: Number(val('lg_' + doc.key + '_st_title', st.titlePt || 15)),
    };
    return out;
  }

  function splitParas(body) {
    var parts = String(body || '')
      .split(/\n\s*\n/)
      .map(function (p) {
        return p.trim();
      })
      .filter(Boolean);
    // `[]`, not `['']`. An empty paragraph fails validation with "String must contain at
    // least 1 character", which names neither the article nor the fix. Returning none lets
    // the server's own refinement say "Article III has no text" instead.
    return parts;
  }

  function val(id, fallback) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : fallback;
  }

  /** Checkboxes report `checked`, not `value`; absent means keep what was stored. */
  function checked(id, fallback) {
    var el = document.getElementById(id);
    return el ? !!el.checked : fallback;
  }

  /** A labelled select. Curated options only — see the note on the layout panel. */
  function sel(id, options, current) {
    return (
      '<select id="' +
      id +
      '" style="' +
      IN +
      '">' +
      options
        .map(function (o) {
          return (
            '<option value="' +
            esc(o[0]) +
            '"' +
            (String(o[0]) === String(current) ? ' selected' : '') +
            '>' +
            esc(o[1]) +
            '</option>'
          );
        })
        .join('') +
      '</select>'
    );
  }

  function field(labelText, control, hint) {
    return (
      '<div style="flex:1;min-width:150px;">' +
      '<label style="display:block;font-size:12px;color:#5c6157;margin-bottom:4px;">' +
      labelText +
      '</label>' +
      control +
      (hint ? '<div class="muted" style="font-size:11px;margin-top:3px;">' + hint + '</div>' : '') +
      '</div>'
    );
  }

  var FONT_OPTIONS = [
    ['plex', 'IBM Plex Sans (default) — matches the rest of the software'],
    ['georgia', 'Georgia — serif'],
    // Kept so a document already set to it is not silently re-typeset, but honest about
    // why it is not the default: the render container does not ship Aptos.
    ['aptos', 'Aptos — may not render in the PDF'],
  ];
  var SIZE_OPTIONS = [
    [8, '8 pt — most text per page'],
    [9, '9 pt (default)'],
    [10, '10 pt'],
    [11, '11 pt — easiest to read'],
  ];
  var LH_OPTIONS = [
    [1.25, 'Tight'],
    [1.35, 'Normal (default)'],
    [1.5, 'Airy'],
  ];
  var ALIGN_OPTIONS = [
    ['justify', 'Justified (default)'],
    ['left', 'Left, ragged right'],
  ];
  var TITLE_OPTIONS = [
    [13, '13 pt'],
    [15, '15 pt (default)'],
    [18, '18 pt'],
  ];

  /**
   * Layout and signer wording.
   *
   * A closed set of choices, not a stylesheet field. These documents print onto a fixed
   * 816x1056 sheet packed by the proposal paginator, and a free size or leading would let
   * one setting push a signature block onto a page of its own with the article it belongs
   * to two pages back. Every option here has been laid out and fits.
   */
  function layoutPanel(doc) {
    var w = working(doc);
    var st = w.style || {};
    var sg = w.signature || {};
    var k = doc.key;
    var isArticles = w.kind === 'ARTICLES';
    return (
      '<div style="border:1px solid #e6e9e1;border-radius:8px;padding:13px;margin-top:16px;background:#fcfdfb;">' +
      '<div style="font-weight:600;font-size:13px;margin-bottom:10px;">Layout</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
      field('Typeface', sel('lg_' + k + '_st_font', FONT_OPTIONS, st.font || 'plex')) +
      field('Body size', sel('lg_' + k + '_st_size', SIZE_OPTIONS, st.sizePt || 9)) +
      field('Line spacing', sel('lg_' + k + '_st_lh', LH_OPTIONS, st.lineHeight || 1.35)) +
      '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">' +
      field('Paragraphs', sel('lg_' + k + '_st_align', ALIGN_OPTIONS, st.align || 'justify')) +
      field('Heading size', sel('lg_' + k + '_st_title', TITLE_OPTIONS, st.titlePt || 15)) +
      '<div style="flex:1;min-width:150px;"></div>' +
      '</div>' +
      (isArticles
        ? '<div style="font-weight:600;font-size:13px;margin:18px 0 4px;">Signature blocks</div>' +
          '<div class="muted" style="font-size:11px;margin-bottom:9px;line-height:1.55;">' +
          'What each party is called above its signature. These were &ldquo;Releasor&rdquo; ' +
          'and &ldquo;Releasee&rdquo;, which suit a release and nothing else.' +
          '</div>' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
          field(
            'Customer side',
            '<input id="lg_' +
              k +
              '_sg_left" value="' +
              esc(sg.leftRole || 'Customer') +
              '" style="' +
              IN +
              '">',
          ) +
          field(
            'Summit side',
            '<input id="lg_' +
              k +
              '_sg_right" value="' +
              esc(sg.rightRole || 'Summit Sensory Gym') +
              '" style="' +
              IN +
              '">',
          ) +
          '</div>' +
          '<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;' +
          'color:#3d4a55;margin-top:10px;cursor:pointer;">' +
          '<input type="checkbox" id="lg_' +
          k +
          '_sg_title"' +
          (sg.title ? ' checked' : '') +
          '> Include a <b>Title:</b> line &mdash; a person signs for an entity, and ' +
          'their authority to do so is their title' +
          '</label>'
        : '') +
      '</div>'
    );
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
    /*
     * Shown as the sheets a customer will actually receive.
     *
     * The proposal is not printed by the browser's own pagination — it is measured and
     * packed onto fixed 816x1056 sheets by `paginateProposalArea`, each stamped with the
     * "Page 1 of 3" footer every sheet is required to state. This preview borrows that
     * exact function rather than approximating it, because a second implementation would
     * be a second set of page breaks to disagree with the first.
     *
     * The element has to be in the document before it can be paginated: the paginator
     * measures real rendered heights, which do not exist for a detached node.
     */
    box.innerHTML =
      '<div class="muted" style="font-size:11px;margin-bottom:6px;line-height:1.55;">' +
      'The printed sheets, with a sample customer. Page numbers count this document on ' +
      'its own &mdash; inside a proposal it continues the proposal&rsquo;s numbering.' +
      '</div>';

    var frame = document.createElement('div');
    frame.style.cssText =
      'background:#eef0ea;border:1px solid #e6e9e1;border-radius:8px;padding:14px;' +
      'max-height:640px;overflow:auto;';
    var holder = document.createElement('div');
    holder.style.cssText = 'position:relative;';
    var stage = document.createElement('div');
    stage.style.cssText = 'transform-origin:top left;';
    stage.innerHTML =
      '<div id="propPrintArea" data-foot-left="' +
      esc(sample.orgName) +
      '" data-foot-right="' +
      esc(working(doc).title) +
      '">' +
      html +
      '</div>';
    holder.appendChild(stage);
    frame.appendChild(holder);
    box.appendChild(frame);

    if (window.SSGPaginate) {
      window.SSGPaginate(stage);
      // Sheets butt against each other in print, which is correct on paper and unreadable
      // on screen. Separated here only, by inline style, so no rule leaks into the print.
      Array.prototype.forEach.call(stage.querySelectorAll('.ssg-sheet'), function (sh, n) {
        sh.style.boxShadow = '0 1px 4px rgba(20,30,20,.14)';
        if (n) sh.style.marginTop = '16px';
      });
    }

    /*
     * Scaled with a transform rather than a width, so the sheet is never re-laid-out at a
     * different size and the page breaks on screen cannot differ from the printed ones.
     *
     * A transform does not affect layout, so the wrapper is given the scaled height
     * explicitly or the scroll container would reserve the full 816-wide height.
     */
    var avail = frame.clientWidth - 28;
    var k = Math.min(1, avail > 0 ? avail / 816 : 1);
    stage.style.transform = 'scale(' + k + ')';
    holder.style.width = 816 * k + 'px';
    holder.style.height = stage.getBoundingClientRect().height + 'px';
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

    /*
     * Sub-section moves and deletions, addressed by "article:sub-section".
     *
     * Same save-first discipline as the article handlers above: the edit is applied to
     * text already read out of the form, so a reorder cannot silently discard a
     * paragraph typed a moment earlier and not yet saved.
     */
    var ssStructural = function (attr, mutate) {
      on(attr, function (raw, b) {
        var key = b.getAttribute('data-lgkey');
        var doc = byKey(key);
        if (!doc) return;
        var parts = String(raw).split(':');
        var i = parseInt(parts[0], 10);
        var j = parseInt(parts[1], 10);
        var next = collect(doc);
        var art = (listOf(next) || [])[i];
        if (!art) return;
        art.subsections = art.subsections || [];
        mutate(art.subsections, j);
        doc.draft = next;
        draw(host);
        save(key, host);
      });
    };
    ssStructural('lgssup', function (l, j) {
      if (j > 0) l.splice(j - 1, 0, l.splice(j, 1)[0]);
    });
    ssStructural('lgssdown', function (l, j) {
      if (j < l.length - 1) l.splice(j + 1, 0, l.splice(j, 1)[0]);
    });
    ssStructural('lgssdel', function (l, j) {
      l.splice(j, 1);
    });

    /*
     * Adding a list item or a sub-section.
     *
     * Not saved immediately, unlike a reorder: a block with no text yet would fail
     * validation, and an error the instant you press "+" reads as a fault rather than as
     * something still to type. It saves with the rest when you press Save draft.
     */
    var adder = function (attr, mutate) {
      on(attr, function (raw, b) {
        var key = b.getAttribute('data-lgkey');
        var doc = byKey(key);
        if (!doc) return;
        var next = collect(doc);
        var art = (listOf(next) || [])[parseInt(raw, 10)];
        if (!art) return;
        mutate(art);
        doc.draft = next;
        open[key] = true;
        draw(host);
      });
    };
    adder('lgaddsub', function (art) {
      art.subs = art.subs || [];
      // Lower-case roman, matching the lists these documents already use for parties and
      // for enumerated claims.
      art.subs.push({ numeral: roman(art.subs.length + 1).toLowerCase(), text: '' });
    });
    adder('lgaddss', function (art) {
      art.subsections = art.subsections || [];
      art.subsections.push({
        letter: String.fromCharCode(65 + Math.min(25, art.subsections.length)),
        title: 'New sub-section',
        paragraphs: [],
      });
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
