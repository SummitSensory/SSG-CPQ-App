/**
 * Frame naming: Administration -> Proposal content.
 *
 * The Summit Adventure Series frame code (SQ-H2MBL2T2-10x10) as a system admin sets it:
 * where the shape, features and dimensions print, the letter each feature prints as,
 * whether its quantity follows the letter, and the order of the features. The server
 * (src/proposals/frameCode.ts) owns the rules; this screen only edits them, and every
 * keystroke is checked and previewed by the server against real configurations, so
 * what is shown here is exactly what a proposal will print.
 *
 * Saving writes a NEW version. Proposals already configured keep their names; the next
 * proposal configured (or revised through the configurator) is named by the new one.
 *
 * Registers on window.SSGFrameCodeAdmin. Needs authed and esc from the shell, same
 * contract as SSGMediaPartnershipAdmin.
 */
(function () {
  'use strict';

  var H = null;
  var STATE = null; // { convention, labels, active, history }
  var previewTimer = null;
  var previewSeq = 0;

  function esc(s) {
    if (!H || !H.esc) throw new Error('frame-code-admin: H.esc is required');
    return H.esc(s);
  }

  var IN =
    'box-sizing:border-box;padding:6px 8px;border:1px solid #d8dcd2;border-radius:6px;' +
    'font-family:inherit;font-size:13px;color:#20241f;background:#fff;';
  var PRIMARY =
    'border:1px solid #203060;background:#203060;color:#fff;border-radius:6px;padding:7px 15px;' +
    'font-family:inherit;font-size:12.5px;cursor:pointer;font-weight:600;white-space:nowrap;';
  var MOVE =
    'border:1px solid #d8dcd2;background:#fff;border-radius:5px;padding:2px 7px;font-size:12px;' +
    'cursor:pointer;color:#3d4a55;';
  var LABEL =
    'display:block;font-size:11.5px;font-weight:600;color:#3d4a55;text-transform:uppercase;' +
    'letter-spacing:.04em;margin:16px 0 6px;';
  var TH =
    'text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#7b8190;' +
    'padding:4px 8px;border-bottom:1px solid #e7e8e3;';
  var TD = 'padding:6px 8px;border-bottom:1px solid #f0f1ec;font-size:13px;vertical-align:middle;';
  var QTY_LABELS = { ALWAYS: 'Always', OVER_ONE: 'Only when more than 1', NEVER: 'Never' };

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function moveBtns(kind, i, n) {
    return (
      '<button type="button" style="' +
      MOVE +
      '" data-move="' +
      kind +
      '" data-i="' +
      i +
      '" data-d="-1"' +
      (i === 0 ? ' disabled' : '') +
      ' aria-label="Move up">&uarr;</button> ' +
      '<button type="button" style="' +
      MOVE +
      '" data-move="' +
      kind +
      '" data-i="' +
      i +
      '" data-d="1"' +
      (i === n - 1 ? ' disabled' : '') +
      ' aria-label="Move down">&darr;</button>'
    );
  }

  /* ---- the clarity pages' wording (convention.page) ----
   *
   * Everything the "What's Included" and "Before You Sign" pages print, edited here
   * because it is versioned with the letters it describes (src/proposals/clarityPages.ts).
   * Inputs carry the path they edit in data-path; one delegated listener writes them.
   */
  var FEATURE_ORDER = ['beams', 'monkeyBars', 'ladders', 'trolley', 'zipLine', 'ballRack'];
  var TEXT_FIELDS = [
    ['includedEyebrow', "What's Included — eyebrow"],
    ['includedHeading', "What's Included — heading"],
    ['includedIntro', "What's Included — intro", 'area'],
    ['includedFooter', "What's Included — footer name"],
    ['modelLabel', 'Code panel label'],
    ['frameSectionTitle', 'Section 01 title'],
    ['frameSectionNote', 'Section 01 note'],
    ['componentSectionTitle', 'Section 02 title'],
    ['componentSectionNote', 'Section 02 note'],
    ['signEyebrow', 'Before You Sign — eyebrow'],
    ['signHeading', 'Before You Sign — heading'],
    ['signIntro', 'Before You Sign — intro', 'area'],
    ['signFooter', 'Before You Sign — footer name'],
    ['investmentTitle', 'Investment title'],
    ['investmentNote', 'Investment note'],
    ['totalLabel', 'Total label'],
    ['depositLabel', 'Deposit label'],
    ['depositNote', 'Deposit note ({pct} = deposit %)'],
    ['notIncludedTitle', "What's Not Included title"],
    ['notIncludedNote', "What's Not Included note"],
    ['nextTitle', 'What Happens Next title'],
    ['nextNote', 'What Happens Next note'],
    ['contactHeading', 'Contact panel heading'],
    ['contactBody', 'Contact panel text', 'area'],
  ];

  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) {
      return o == null ? undefined : o[k];
    }, obj);
  }
  function setPath(obj, path, value) {
    var keys = path.split('.');
    var last = keys.pop();
    var o = keys.reduce(function (acc, k) {
      return acc[k];
    }, obj);
    o[last] = value;
  }

  /** One bound input. kind: text | area | int | bool | list (comma-separated) | variants. */
  function field(path, kind, width) {
    var v = getPath(STATE.convention, path);
    var attrs = ' data-path="' + esc(path) + '" data-kind="' + kind + '"';
    if (kind === 'bool') return '<input type="checkbox"' + attrs + (v ? ' checked' : '') + '>';
    if (kind === 'area' || kind === 'variants') {
      var text =
        kind === 'variants'
          ? (v || [])
              .map(function (x) {
                return (x.allSkus || []).join(', ') + ' | ' + (x.description || '');
              })
              .join('\n')
          : v || '';
      return (
        '<textarea' +
        attrs +
        ' rows="2" style="' +
        IN +
        'width:' +
        (width || '100%') +
        ';resize:vertical;">' +
        esc(text) +
        '</textarea>'
      );
    }
    var shown = kind === 'list' ? (v || []).join(', ') : v == null ? '' : String(v);
    return (
      '<input' +
      attrs +
      ' value="' +
      esc(shown) +
      '"' +
      (kind === 'int' ? ' inputmode="numeric"' : '') +
      ' style="' +
      IN +
      'width:' +
      (width || '100%') +
      ';">'
    );
  }

  function iconSelect(path) {
    var v = getPath(STATE.convention, path);
    return (
      '<select data-path="' +
      esc(path) +
      '" data-kind="text" style="' +
      IN +
      '">' +
      (STATE.labels.icons || [])
        .map(function (k) {
          return (
            '<option value="' +
            esc(k) +
            '"' +
            (k === v ? ' selected' : '') +
            '>' +
            esc(k) +
            '</option>'
          );
        })
        .join('') +
      '</select>'
    );
  }

  function th(labels) {
    return (
      '<thead><tr>' +
      labels
        .map(function (l) {
          return '<th style="' + TH + '">' + esc(l) + '</th>';
        })
        .join('') +
      '</tr></thead>'
    );
  }
  function td(inner, extra) {
    return '<td style="' + TD + (extra || '') + '">' + inner + '</td>';
  }
  function listBtns(kind, i, n) {
    return (
      moveBtns(kind, i, n) +
      ' <button type="button" style="' +
      MOVE +
      '" data-remove="' +
      kind +
      '" data-i="' +
      i +
      '" aria-label="Remove">&times;</button>'
    );
  }

  function pageHtml() {
    var p = STATE.convention.page;
    if (!p) return '';
    var L = STATE.labels;
    var TABLE = 'border-collapse:collapse;width:100%;';
    var shapes = L.shapes
      .map(function (k) {
        var b = 'page.shapes.' + k + '.';
        return (
          '<tr>' +
          td(esc(k), 'white-space:nowrap;') +
          td(field(b + 'displayName', 'text')) +
          td(field(b + 'shortLabel', 'text')) +
          td(field(b + 'description', 'text')) +
          '</tr>'
        );
      })
      .join('');
    var feats = FEATURE_ORDER.map(function (k) {
      var b = 'page.features.' + k + '.';
      return (
        '<tr>' +
        td(esc(L.features[k] || k)) +
        td(field(b + 'displayName', 'text')) +
        td(field(b + 'shortLabel', 'text')) +
        td(field(b + 'description', 'area')) +
        td(field(b + 'specTemplate', 'text')) +
        td(field(b + 'specTemplateMany', 'text')) +
        td(iconSelect(b + 'iconKey')) +
        td(field(b + 'pageOrder', 'int', '64px')) +
        '</tr>'
      );
    }).join('');
    var comps = p.components
      .map(function (c, i) {
        var b = 'page.components.' + i + '.';
        return (
          '<tr>' +
          td(field(b + 'key', 'text', '120px')) +
          td(field(b + 'displayName', 'text')) +
          td(field(b + 'description', 'area')) +
          td(field(b + 'skus', 'list')) +
          td(field(b + 'variants', 'variants')) +
          td(field(b + 'specTemplate', 'text', '90px')) +
          td(iconSelect(b + 'iconKey')) +
          td(field(b + 'pageOrder', 'int', '64px')) +
          td(field(b + 'active', 'bool'), 'text-align:center;') +
          td(listBtns('comp', i, p.components.length), 'white-space:nowrap;') +
          '</tr>'
        );
      })
      .join('');
    var scope = p.notIncluded
      .map(function (it, i) {
        var b = 'page.notIncluded.' + i + '.';
        return (
          '<tr>' +
          td(field(b + 'key', 'text', '120px')) +
          td(field(b + 'title', 'text')) +
          td(field(b + 'description', 'area')) +
          td(field(b + 'hideWhenLineMatches', 'text', '110px')) +
          td(field(b + 'placeholder', 'bool'), 'text-align:center;') +
          td(field(b + 'active', 'bool'), 'text-align:center;') +
          td(listBtns('scope', i, p.notIncluded.length), 'white-space:nowrap;') +
          '</tr>'
        );
      })
      .join('');
    var steps = p.steps
      .map(function (s, i) {
        var b = 'page.steps.' + i + '.';
        return (
          '<tr>' +
          td(String(i + 1), 'color:#7b8190;') +
          td(field(b + 'key', 'text', '110px')) +
          td(field(b + 'title', 'text')) +
          td(field(b + 'description', 'area')) +
          td(field(b + 'matsNote', 'text')) +
          td(field(b + 'placeholder', 'bool'), 'text-align:center;') +
          td(listBtns('step', i, p.steps.length), 'white-space:nowrap;') +
          '</tr>'
        );
      })
      .join('');
    var texts = TEXT_FIELDS.map(function (t) {
      return (
        '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:#5c6157;">' +
        esc(t[1]) +
        field('page.text.' + t[0], t[2] || 'text') +
        '</label>'
      );
    }).join('');
    var m = 'page.mats.';
    return (
      '<div style="margin-top:26px;padding-top:6px;border-top:2px solid #e7e8e3;">' +
      '<div style="font-size:15px;font-weight:600;color:#203060;margin-top:10px;">Proposal pages: What’s Included and Before You Sign</div>' +
      '<div style="font-size:12.5px;color:#5c6157;line-height:1.55;margin-top:4px;">What the two optional Adventure Series pages print. Saved with the letters above as part of the same version, so a proposal keeps the wording it was built with. ' +
      'Templates take {count}, {s} (plural s), {kind} (Dual/Single), {length} and {width}. Page order sets the row order on the page and can differ from the code order.</div>' +
      '<span style="' +
      LABEL +
      '">Frame row</span>' +
      '<table style="' +
      TABLE +
      '">' +
      th(['Shape', 'Name', 'Label under the code', 'Description']) +
      '<tbody>' +
      shapes +
      '</tbody></table>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:8px;">' +
      '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:#5c6157;">Spec' +
      field('page.frame.specTemplate', 'text') +
      '</label>' +
      '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:#5c6157;">Spec note ({heights})' +
      field('page.frame.specNote', 'text') +
      '</label>' +
      '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:#5c6157;">Frame heights' +
      field('page.heights', 'list') +
      '</label>' +
      '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:#5c6157;">Label under the dimensions' +
      field('page.dimensions.shortLabel', 'text') +
      '</label>' +
      '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:#5c6157;">Icon' +
      iconSelect('page.frame.iconKey') +
      '</label>' +
      '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:#5c6157;">Page order' +
      field('page.frame.pageOrder', 'int', '80px') +
      '</label>' +
      '</div>' +
      '<span style="' +
      LABEL +
      '">Code features</span>' +
      '<table style="' +
      TABLE +
      '">' +
      th([
        'Feature',
        'Name',
        'Label under the code',
        'Description',
        'Spec',
        'Spec when more than 1',
        'Icon',
        'Page order',
      ]) +
      '<tbody>' +
      feats +
      '</tbody></table>' +
      '<span style="' +
      LABEL +
      '">Components (shown when a listed part number is on the proposal)</span>' +
      '<table style="' +
      TABLE +
      '">' +
      th([
        'Key',
        'Name',
        'Description',
        'Part numbers',
        'More specific description (parts | text, one per line)',
        'Spec',
        'Icon',
        'Page order',
        'Active',
        '',
      ]) +
      '<tbody>' +
      comps +
      '</tbody></table>' +
      '<button type="button" class="link-btn" style="width:auto;margin-top:6px;" data-add="comp">+ Add component</button>' +
      '<span style="' +
      LABEL +
      '">Mat system row</span>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;">' +
      [
        ['displayName', 'Name', 'text'],
        ['description', 'Description', 'text'],
        ['matSpecTemplate', 'Mat spec ({length} {width} {thickness})', 'text'],
        ['columnWrapSkus', 'Column wrap part numbers', 'list'],
        ['ladderWrapSkus', 'Ladder wrap part numbers', 'list'],
        ['columnWrapLabel', 'Column wraps label', 'text'],
        ['ladderWrapLabel', 'Ladder wraps label', 'text'],
        ['pageOrder', 'Page order', 'int'],
      ]
        .map(function (f) {
          return (
            '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:#5c6157;">' +
            esc(f[1]) +
            field(m + f[0], f[2]) +
            '</label>'
          );
        })
        .join('') +
      '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:#5c6157;">Icon' +
      iconSelect(m + 'iconKey') +
      '</label>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#5c6157;">' +
      field(m + 'active', 'bool') +
      ' Active</label>' +
      '</div>' +
      '<span style="' +
      LABEL +
      '">What’s Not Included (in print order)</span>' +
      '<table style="' +
      TABLE +
      '">' +
      th([
        'Key',
        'Title',
        'Description',
        'Hide when a line contains',
        'Placeholder',
        'Active',
        '',
      ]) +
      '<tbody>' +
      scope +
      '</tbody></table>' +
      '<button type="button" class="link-btn" style="width:auto;margin-top:6px;" data-add="scope">+ Add item</button>' +
      '<span style="' +
      LABEL +
      '">What Happens Next (in print order, up to 6)</span>' +
      '<table style="' +
      TABLE +
      '">' +
      th([
        '#',
        'Key',
        'Title',
        'Description',
        'Added when mats are on the proposal',
        'Placeholder',
        '',
      ]) +
      '<tbody>' +
      steps +
      '</tbody></table>' +
      (p.steps.length < 6
        ? '<button type="button" class="link-btn" style="width:auto;margin-top:6px;" data-add="step">+ Add step</button>'
        : '') +
      '<span style="' +
      LABEL +
      '">Page text</span>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;">' +
      texts +
      '</div>' +
      '</div>'
    );
  }

  function readField(el) {
    var kind = el.getAttribute('data-kind');
    if (kind === 'bool') return !!el.checked;
    if (kind === 'int') return Number(el.value.trim()) || 0;
    if (kind === 'list') {
      return el.value
        .split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
    }
    if (kind === 'variants') {
      return el.value
        .split('\n')
        .map(function (line) {
          var bar = line.indexOf('|');
          if (bar < 0) return null;
          return {
            allSkus: line
              .slice(0, bar)
              .split(',')
              .map(function (s) {
                return s.trim();
              })
              .filter(Boolean),
            description: line.slice(bar + 1).trim(),
          };
        })
        .filter(function (v) {
          return v && v.allSkus.length;
        });
    }
    return el.value;
  }

  function newKey(prefix) {
    return prefix + '_' + Date.now().toString(36);
  }

  function wirePage(host) {
    var p = STATE.convention.page;
    if (!p) return;
    var onEdit = function (e) {
      var el = e.target;
      var path = el && el.getAttribute && el.getAttribute('data-path');
      if (!path) return;
      setPath(STATE.convention, path, readField(el));
      schedulePreview(host);
    };
    // The host outlives every render; one pair of listeners serves them all.
    if (!host.__fcPageWired) {
      host.__fcPageWired = true;
      host.addEventListener('input', onEdit);
      host.addEventListener('change', onEdit);
    }
    var lists = { comp: p.components, scope: p.notIncluded, step: p.steps };
    host.querySelectorAll('[data-remove]').forEach(function (b) {
      b.addEventListener('click', function () {
        lists[b.getAttribute('data-remove')].splice(Number(b.getAttribute('data-i')), 1);
        render(host);
      });
    });
    host.querySelectorAll('[data-add]').forEach(function (b) {
      b.addEventListener('click', function () {
        var kind = b.getAttribute('data-add');
        if (kind === 'comp') {
          var top = p.components.reduce(function (mx, c) {
            return Math.max(mx, c.pageOrder);
          }, p.mats.pageOrder);
          p.components.push({
            key: newKey('component'),
            displayName: '',
            description: '',
            variants: [],
            specTemplate: 'Included',
            iconKey: 'frame',
            pageOrder: top + 10,
            active: true,
            skus: [],
          });
        } else if (kind === 'scope') {
          p.notIncluded.push({
            key: newKey('item'),
            title: '',
            description: '',
            active: true,
            hideWhenLineMatches: '',
            placeholder: false,
          });
        } else {
          p.steps.push({
            key: newKey('step'),
            title: '',
            description: '',
            matsNote: '',
            placeholder: false,
          });
        }
        render(host);
      });
    });
  }

  function render(host) {
    if (!host) return;
    if (!STATE) {
      host.innerHTML = '<div class="muted" style="padding:16px;">Loading…</div>';
      load(host);
      return;
    }
    var c = STATE.convention,
      L = STATE.labels;
    var segRows = c.segments
      .map(function (s, i) {
        return (
          '<tr><td style="' +
          TD +
          'width:40px;color:#7b8190;">' +
          (i + 1) +
          '</td>' +
          '<td style="' +
          TD +
          '">' +
          esc(L.segments[s] || s) +
          '</td>' +
          '<td style="' +
          TD +
          'text-align:right;">' +
          moveBtns('seg', i, c.segments.length) +
          '</td></tr>'
        );
      })
      .join('');
    var shapeInputs = L.shapes
      .map(function (k) {
        return (
          '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;color:#5c6157;">' +
          esc(k) +
          '<input data-shape="' +
          esc(k) +
          '" value="' +
          esc(c.shapes[k] || '') +
          '" maxlength="3" style="' +
          IN +
          'width:80px;text-transform:uppercase;"></label>'
        );
      })
      .join('');
    var featRows = c.features
      .map(function (f, i) {
        return (
          '<tr><td style="' +
          TD +
          'width:40px;color:#7b8190;">' +
          (i + 1) +
          '</td>' +
          '<td style="' +
          TD +
          '">' +
          esc(L.features[f.key] || f.key) +
          '</td>' +
          '<td style="' +
          TD +
          '"><input data-letter="' +
          i +
          '" value="' +
          esc(f.letter) +
          '" maxlength="3" style="' +
          IN +
          'width:70px;text-transform:uppercase;"></td>' +
          '<td style="' +
          TD +
          '"><select data-qty="' +
          i +
          '" style="' +
          IN +
          'min-width:210px;">' +
          L.qtyModes
            .map(function (q) {
              return (
                '<option value="' +
                q +
                '"' +
                (f.qty === q ? ' selected' : '') +
                '>' +
                esc(QTY_LABELS[q] || q) +
                '</option>'
              );
            })
            .join('') +
          '</select></td>' +
          '<td style="' +
          TD +
          'text-align:right;">' +
          moveBtns('feat', i, c.features.length) +
          '</td></tr>'
        );
      })
      .join('');
    var hist = (STATE.history || [])
      .map(function (h) {
        return (
          '<tr><td style="' +
          TD +
          '">v' +
          h.version +
          (h.version === STATE.active.version ? ' <b style="color:#3f6212;">in force</b>' : '') +
          '</td>' +
          '<td style="' +
          TD +
          'font-family:ui-monospace,monospace;">' +
          esc(h.example || '') +
          '</td>' +
          '<td style="' +
          TD +
          'color:#5c6157;">' +
          (h.createdAt ? esc(new Date(h.createdAt).toLocaleDateString()) : 'Built-in default') +
          '</td>' +
          '<td style="' +
          TD +
          'color:#5c6157;">' +
          esc(h.note || '') +
          '</td></tr>'
        );
      })
      .join('');

    host.innerHTML =
      '<div style="padding:4px 2px 8px;">' +
      '<div style="font-size:12.5px;color:#5c6157;line-height:1.55;">In force: <b>version ' +
      STATE.active.version +
      '</b>. ' +
      'Saving creates a new version. Proposals already configured keep their names; the next proposal configured, or revised through the configurator, uses the new one. Changes also reach the PDF file name.</div>' +
      '<span style="' +
      LABEL +
      '">Segment order</span>' +
      '<table style="border-collapse:collapse;min-width:360px;"><tbody>' +
      segRows +
      '</tbody></table>' +
      '<span style="' +
      LABEL +
      '">Shape codes</span>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;">' +
      shapeInputs +
      '</div>' +
      '<span style="' +
      LABEL +
      '">Features (in print order)</span>' +
      '<table style="border-collapse:collapse;width:100%;max-width:720px;"><thead><tr>' +
      '<th style="' +
      TH +
      '">#</th><th style="' +
      TH +
      '">Feature</th><th style="' +
      TH +
      '">Letter</th><th style="' +
      TH +
      '">Quantity after the letter</th><th style="' +
      TH +
      '"></th>' +
      '</tr></thead><tbody>' +
      featRows +
      '</tbody></table>' +
      '<label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:#20241f;">' +
      '<input type="checkbox" id="fcMbBeam"' +
      (c.monkeyBarsCountAsBeam ? ' checked' : '') +
      '> Count monkey bars as a beam ' +
      '<span class="muted" style="font-size:12px;">(1 interior beam + monkey bars prints as beam 2)</span></label>' +
      '<span style="' +
      LABEL +
      '">Preview</span>' +
      '<div id="fcPreview" style="border:1px solid #e7e8e3;border-radius:8px;padding:10px 12px;background:#fbfbf9;font-size:13px;">Checking…</div>' +
      pageHtml() +
      '<span style="' +
      LABEL +
      '">Why it changed (optional)</span>' +
      '<input id="fcNote" maxlength="500" placeholder="e.g. Board decision 10/22: B for monkey bars" style="' +
      IN +
      'width:100%;max-width:720px;">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-top:14px;">' +
      '<button type="button" id="fcSave" style="' +
      PRIMARY +
      '">Save as new version</button>' +
      '<button type="button" id="fcRevert" class="link-btn" style="width:auto;">Discard changes</button>' +
      '<span id="fcMsg" style="font-size:12.5px;"></span></div>' +
      (hist
        ? '<span style="' +
          LABEL +
          '">History</span><table style="border-collapse:collapse;width:100%;max-width:720px;"><thead><tr>' +
          '<th style="' +
          TH +
          '">Version</th><th style="' +
          TH +
          '">Example</th><th style="' +
          TH +
          '">Saved</th><th style="' +
          TH +
          '">Note</th></tr></thead><tbody>' +
          hist +
          '</tbody></table>'
        : '') +
      '</div>';

    wire(host);
    schedulePreview(host, 0);
  }

  function wire(host) {
    var c = STATE.convention;
    host.querySelectorAll('[data-move]').forEach(function (b) {
      b.addEventListener('click', function () {
        var kind = b.getAttribute('data-move');
        var list =
          kind === 'seg'
            ? c.segments
            : kind === 'feat'
              ? c.features
              : kind === 'comp'
                ? c.page.components
                : kind === 'scope'
                  ? c.page.notIncluded
                  : c.page.steps;
        var i = Number(b.getAttribute('data-i')),
          j = i + Number(b.getAttribute('data-d'));
        if (j < 0 || j >= list.length) return;
        var t = list[i];
        list[i] = list[j];
        list[j] = t;
        render(host);
      });
    });
    host.querySelectorAll('[data-shape]').forEach(function (el) {
      el.addEventListener('input', function () {
        c.shapes[el.getAttribute('data-shape')] = el.value.trim().toUpperCase();
        schedulePreview(host);
      });
    });
    host.querySelectorAll('[data-letter]').forEach(function (el) {
      el.addEventListener('input', function () {
        c.features[Number(el.getAttribute('data-letter'))].letter = el.value.trim().toUpperCase();
        schedulePreview(host);
      });
    });
    host.querySelectorAll('[data-qty]').forEach(function (el) {
      el.addEventListener('change', function () {
        c.features[Number(el.getAttribute('data-qty'))].qty = el.value;
        schedulePreview(host);
      });
    });
    host.querySelector('#fcMbBeam').addEventListener('change', function (e) {
      c.monkeyBarsCountAsBeam = !!e.target.checked;
      schedulePreview(host);
    });
    host.querySelector('#fcRevert').addEventListener('click', function () {
      STATE.convention = clone(STATE.active.convention);
      render(host);
    });
    host.querySelector('#fcSave').addEventListener('click', function () {
      save(host);
    });
    wirePage(host);
  }

  function schedulePreview(host, delay) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(
      function () {
        preview(host);
      },
      delay == null ? 250 : delay,
    );
  }

  async function preview(host) {
    var box = host.querySelector('#fcPreview');
    if (!box) return;
    var seq = ++previewSeq;
    var d = null;
    try {
      var r = await H.authed('/frame-code/convention/preview', {
        method: 'POST',
        body: STATE.convention,
      });
      d = await r.json();
      if (!r.ok)
        d = { problems: [(d && d.message) || 'This convention is not valid.'], samples: [] };
    } catch (e) {
      d = { problems: ['Could not reach the server.'], samples: [] };
    }
    if (seq !== previewSeq) return;
    STATE.problems = d.problems || [];
    var save = host.querySelector('#fcSave');
    if (save) save.disabled = STATE.problems.length > 0;
    if (STATE.problems.length) {
      box.innerHTML =
        '<div style="color:#a4262c;line-height:1.6;">' +
        STATE.problems.map(esc).join('<br>') +
        '</div>';
      return;
    }
    box.innerHTML =
      '<table style="border-collapse:collapse;width:100%;"><tbody>' +
      (d.samples || [])
        .map(function (s) {
          return (
            '<tr><td style="padding:4px 8px 4px 0;font-family:ui-monospace,monospace;font-weight:600;white-space:nowrap;color:#203060;">' +
            esc(s.code || '—') +
            '</td>' +
            '<td style="padding:4px 0;color:#5c6157;font-size:12.5px;">' +
            esc(s.label) +
            (s.error ? ' <span style="color:#a4262c;">' + esc(s.error) + '</span>' : '') +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table>' +
      pageSampleHtml(d.pageSample);
  }

  /** The first sample's What's Included rows under the unsaved convention. */
  function pageSampleHtml(ps) {
    if (!ps) return '';
    var row = function (r) {
      return (
        '<tr><td style="padding:3px 8px 3px 0;font-weight:700;color:#203060;white-space:nowrap;">' +
        esc(r.badge || '—') +
        '</td><td style="padding:3px 8px 3px 0;">' +
        esc(r.name) +
        '</td><td style="padding:3px 0;color:#5c6157;text-align:right;">' +
        esc(r.spec) +
        '</td></tr>'
      );
    };
    return (
      '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #e0e2da;">' +
      '<div style="font-size:11.5px;color:#7b8190;margin-bottom:4px;">What’s Included for ' +
      esc(ps.code) +
      ': ' +
      (ps.parts || [])
        .map(function (p) {
          return esc(p.text) + ' = ' + esc(p.label);
        })
        .join(' · ') +
      '</div><table style="border-collapse:collapse;font-size:12.5px;"><tbody>' +
      (ps.frameRows || []).map(row).join('') +
      '</tbody></table></div>'
    );
  }

  async function save(host) {
    if (STATE.problems && STATE.problems.length) return;
    if (
      !window.confirm(
        'Save this as version ' +
          (STATE.active.version + 1) +
          '? Every proposal configured from now on is named this way. Proposals already configured keep their names.',
      )
    )
      return;
    var msg = host.querySelector('#fcMsg');
    var bt = host.querySelector('#fcSave');
    bt.disabled = true;
    try {
      var noteEl = host.querySelector('#fcNote');
      var r = await H.authed('/frame-code/convention', {
        method: 'PUT',
        body: { convention: STATE.convention, note: noteEl ? noteEl.value : '' },
      });
      var d = await r.json().catch(function () {
        return null;
      });
      if (!r.ok) {
        msg.innerHTML =
          '<span style="color:#a4262c;">' + esc((d && d.message) || 'Could not save.') + '</span>';
        bt.disabled = false;
        return;
      }
      STATE = null;
      render(host);
    } catch (e) {
      msg.innerHTML = '<span style="color:#a4262c;">Could not reach the server.</span>';
      bt.disabled = false;
    }
  }

  async function load(host) {
    try {
      var r = await H.authed('/frame-code/convention');
      if (r.status === 403) {
        host.innerHTML =
          '<div class="muted" style="padding:16px;">Only a system administrator can change frame naming.</div>';
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      var d = await r.json();
      STATE = {
        active: d.active,
        convention: clone(d.active.convention),
        labels: d.labels,
        history: d.history || [],
        problems: [],
      };
      render(host);
    } catch (e) {
      host.innerHTML =
        '<div class="muted" style="padding:16px;">Could not load frame naming.</div>';
    }
  }

  window.SSGFrameCodeAdmin = {
    init: function (h) {
      H = h;
    },
    render: function (host) {
      STATE = null;
      render(host);
    },
  };
})();
