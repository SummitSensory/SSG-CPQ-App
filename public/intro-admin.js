/*
 * Admin → Proposal introductions.
 *
 * The introduction pages are marketing documents: the same photographs on every
 * Adventure proposal, the same on every Soar. So the pictures are managed here,
 * once, rather than attached to individual proposals — see routes/introTemplates.ts
 * for where they are stored and why they are stored as data URLs.
 *
 * What is editable and what is not:
 *
 *   Photography  — editable here. Each registered template lists its slots with the
 *                  size the page prints at; upload, replace or remove one at a time.
 *   Page wording — not editable here. The copy is designed typography-first (a pulled
 *                  quote, a ruled band, a ledger) and a text box per page would let
 *                  someone paste four paragraphs into a slot built for one line. Copy
 *                  changes go through a release, which is also what keeps the eight
 *                  pages fitting their sheets.
 *
 * Loaded after proposal-front-matter.js and its intro-*.js templates; app.js mounts
 * it inside renderAdmin.
 */
(function () {
  'use strict';

  var H = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  function approxKb(dataUrl) {
    if (!dataUrl) return 0;
    var i = dataUrl.indexOf(',');
    return Math.round(((dataUrl.length - i - 1) * 0.75) / 1024);
  }

  /** One slot: what it is, what is on it, and the two things you can do to it. */
  function slotRow(slot, current, managed) {
    var kb = managed ? approxKb(current) : 0;
    return (
      '<div data-ia-slot="' +
      esc(slot.id) +
      '" style="display:flex;gap:14px;align-items:center;padding:12px 0;border-top:1px solid #eef0ea;">' +
      '<div style="width:104px;height:74px;flex:none;border-radius:6px;overflow:hidden;background:#eef0ea;border:1px solid #e2e4dd;display:flex;align-items:center;justify-content:center;">' +
      (current
        ? '<img src="' +
          esc(current) +
          '" alt="" onerror="this.style.display=\'none\'" style="width:100%;height:100%;object-fit:cover;">'
        : '<span style="font-size:10.5px;color:#8a8f85;">No photo</span>') +
      '</div>' +
      '<div style="flex:1;min-width:0;">' +
      '<div style="font-size:13px;color:#20241f;line-height:1.45;">' +
      esc(slot.label) +
      '</div>' +
      '<div class="muted" style="font-size:11.5px;margin-top:3px;">' +
      (managed
        ? 'Uploaded \u00b7 ' + kb + ' KB'
        : current
          ? 'Using the deployed house file <code style="font-size:11px;">' +
            esc(slot.house || '') +
            '</code>'
          : 'Nothing uploaded \u2014 this area prints as white space') +
      '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;flex:none;">' +
      '<button type="button" class="link-btn iaPick" data-slot="' +
      esc(slot.id) +
      '" style="width:auto;padding:7px 13px;font-size:12px;">' +
      (managed ? 'Replace' : 'Upload') +
      '</button>' +
      (managed
        ? '<button type="button" class="link-btn iaClear" data-slot="' +
          esc(slot.id) +
          '" style="width:auto;padding:7px 13px;font-size:12px;color:#9c3327;">Remove</button>'
        : '') +
      '</div></div>'
    );
  }

  function templateBlock(t, art) {
    var rows = (t.slots || [])
      .map(function (s) {
        var managed = !!art[s.id];
        return slotRow(s, art[s.id] || s.house || '', managed);
      })
      .join('');
    return (
      '<div class="card" style="margin-bottom:14px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;">' +
      '<div style="font-size:14px;font-weight:600;color:#20241f;">' +
      esc(t.label) +
      '</div>' +
      '<div class="muted" style="font-size:12px;">' +
      (t.pages || []).length +
      ' pages \u00b7 ' +
      (t.slots || []).length +
      ' photos</div>' +
      '</div>' +
      (rows ||
        '<div class="muted" style="font-size:12px;padding-top:10px;">This introduction uses no photographs.</div>') +
      '</div>'
    );
  }

  function render(host, art) {
    var templates = window.SSGFrontMatter ? window.SSGFrontMatter.templates() : [];
    if (!templates.length) {
      host.innerHTML =
        '<div class="muted" style="padding:16px;">No introduction templates are installed.</div>';
      return;
    }
    host.innerHTML =
      templates
        .map(function (t) {
          return templateBlock(t, art);
        })
        .join('') +
      '<input type="file" id="iaFile" accept="image/jpeg,image/png,image/webp" style="display:none;">';
    bind(host, art);
  }

  function bind(host, art) {
    var file = host.querySelector('#iaFile');
    var pending = null;

    function reload() {
      window.SSGFrontMatter.loadArt(true).then(function (fresh) {
        render(host, fresh);
      });
    }

    function save(slot, dataUrl) {
      return H.authed('/intro-templates/art/' + encodeURIComponent(slot), {
        method: 'PUT',
        body: { image: dataUrl },
      });
    }

    host.querySelectorAll('.iaPick').forEach(function (b) {
      b.addEventListener('click', function () {
        pending = b.getAttribute('data-slot');
        if (file) {
          file.value = '';
          file.click();
        }
      });
    });

    if (file) {
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f || !pending) return;
        var slot = pending;
        var row = host.querySelector('[data-ia-slot="' + slot + '"]');
        if (row) row.style.opacity = '.55';
        // Downscaled in the browser before it is sent: the route refuses anything
        // over 2 MB, and an un-resized phone photo is well past that.
        window.SSGFrontMatter.prepareImage(f, function (dataUrl) {
          if (!dataUrl) {
            alert('That file could not be read as an image.');
            if (row) row.style.opacity = '';
            return;
          }
          save(slot, dataUrl)
            .then(async function (r) {
              if (!r.ok) {
                var d = null;
                try {
                  d = await r.json();
                } catch (e) {
                  /* no body */
                }
                alert((d && d.message) || 'The photo could not be saved (' + r.status + ').');
                if (row) row.style.opacity = '';
                return;
              }
              reload();
            })
            .catch(function () {
              alert('Could not reach the server.');
              if (row) row.style.opacity = '';
            });
        });
      });
    }

    host.querySelectorAll('.iaClear').forEach(function (b) {
      b.addEventListener('click', function () {
        var slot = b.getAttribute('data-slot');
        if (!confirm('Remove this photo from every proposal that uses this introduction?')) return;
        H.authed('/intro-templates/art/' + encodeURIComponent(slot), { method: 'DELETE' })
          .then(function (r) {
            if (!r.ok) {
              alert('Could not remove the photo (' + r.status + ').');
              return;
            }
            reload();
          })
          .catch(function () {
            alert('Could not reach the server.');
          });
      });
    });
  }

  function mountAdmin(hostId) {
    var host = document.getElementById(hostId);
    if (!host || !window.SSGFrontMatter) return;
    host.innerHTML = '<div class="muted" style="padding:16px;">Loading…</div>';
    window.SSGFrontMatter.loadArt(true).then(function (art) {
      render(host, art);
    });
  }

  window.SSGIntroAdmin = {
    init: function (helpers) {
      H = helpers;
    },
    mountAdmin: mountAdmin,
  };
})();
