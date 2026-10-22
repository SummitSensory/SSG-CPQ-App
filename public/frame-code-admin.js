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
        var list = b.getAttribute('data-move') === 'seg' ? c.segments : c.features;
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
      '</tbody></table>';
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
