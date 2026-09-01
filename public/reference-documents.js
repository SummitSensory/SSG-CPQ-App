/**
 * The reference-document library: pre-made PDFs (a W9, a certificate of insurance)
 * kept in the CRM and optionally attached to a proposal.
 *
 * Deliberately not the same mechanism as public/contract-pages.js. A contract
 * document is text authored here and rendered into HTML pages; one of these is an
 * uploaded file, kept and merged in as real PDF pages elsewhere (src/lib/pdfMerge.ts)
 * so it prints exactly as uploaded rather than being re-typeset.
 *
 * Two jobs in one file, the same split as contract-pages.js / legal-admin.js except
 * combined: `list()` for the builder's checklist (any staff member who can open a
 * proposal), and `render()` for the Administration upload/manage panel (LEGAL_MANAGE
 * only, enforced server-side — a non-admin sees the empty container, same as every
 * other admin panel). Combined into one file because, unlike the legal documents,
 * there is no rich-text editor here to justify a second file: managing this library
 * is upload, rename, retire, delete.
 *
 * Registers itself on window.SSGReferenceDocuments. app.js calls init({ authed, esc })
 * alongside the other modules.
 */
(function () {
  'use strict';

  var H = null;
  /** Active documents, for the builder checklist. Null until the fetch resolves. */
  var ACTIVE = null;
  var loading = null;

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * Fetch the active library.
   *
   * Fire-and-forget by design, same reasoning as contract-pages.js's load(): the
   * builder's card renders synchronously, and in practice this resolves at sign-in,
   * long before anyone opens a proposal. Nothing prints if it has not — an absent
   * reference document is a missing checkbox, not a wrong one.
   */
  function load() {
    if (!H || !H.authed) return Promise.resolve(false);
    if (loading) return loading;
    loading = H.authed('/reference-documents/active')
      .then(function (r) {
        return r && r.ok ? r.json() : null;
      })
      .then(function (d) {
        ACTIVE = (d && d.documents) || [];
        return true;
      })
      .catch(function () {
        ACTIVE = ACTIVE || [];
        return false;
      });
    return loading;
  }

  /* ------------------------------------------------------------- admin panel */

  var listCache = null;

  async function failureText(r, fallback) {
    var d = null;
    try {
      d = await r.json();
    } catch (e) {
      /* not JSON */
    }
    return (d && d.message) || fallback;
  }

  function toast(msg, isError) {
    if (window.SSGUI && window.SSGUI.toast) window.SSGUI.toast(msg, isError);
  }

  async function reload(host) {
    var r = await H.authed('/reference-documents');
    if (!r.ok) throw new Error('load failed');
    listCache = await r.json();
    paint(host);
  }

  function paint(host) {
    var esc = H.esc;
    var rows = (listCache || [])
      .map(function (d) {
        return (
          '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #eceef4;">' +
          '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:600;font-size:13px;' +
          (d.active ? '' : 'color:#9aa1b0;text-decoration:line-through;') +
          '">' +
          esc(d.title) +
          '</div>' +
          '<div class="muted" style="font-size:11.5px;margin-top:1px;">' +
          esc(d.filename) +
          ' &middot; ' +
          fmtBytes(d.byteSize) +
          '</div></div>' +
          '<button class="link-btn" data-act="download" data-id="' +
          esc(d.id) +
          '" style="width:auto;padding:6px 10px;font-size:12px;">Download</button>' +
          '<button class="link-btn" data-act="rename" data-id="' +
          esc(d.id) +
          '" style="width:auto;padding:6px 10px;font-size:12px;">Rename</button>' +
          '<button class="link-btn" data-act="toggle" data-id="' +
          esc(d.id) +
          '" data-active="' +
          (d.active ? '1' : '0') +
          '" style="width:auto;padding:6px 10px;font-size:12px;">' +
          (d.active ? 'Retire' : 'Reinstate') +
          '</button>' +
          '<button class="link-btn" data-act="delete" data-id="' +
          esc(d.id) +
          '" style="width:auto;padding:6px 10px;font-size:12px;color:#9c3327;">Delete</button>' +
          '</div>'
        );
      })
      .join('');

    host.innerHTML =
      '<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px;">' +
      '<label style="flex:1;min-width:180px;font-size:11.5px;color:#5b6478;">Title' +
      '<input id="rdTitle" type="text" placeholder="e.g. W9" style="display:block;width:100%;margin-top:3px;padding:8px 10px;border:1px solid #d7dae2;border-radius:6px;font-size:13px;">' +
      '</label>' +
      '<input id="rdFile" type="file" accept="application/pdf" style="font-size:12.5px;">' +
      '<button class="btn" id="rdUpload" style="width:auto;padding:9px 15px;">Upload</button>' +
      '</div>' +
      (rows ||
        '<div class="muted" style="font-size:12.5px;padding:8px 0;">No reference documents uploaded yet.</div>');

    host.querySelectorAll('button[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var act = btn.getAttribute('data-act');
        if (act === 'download') {
          H.authed('/reference-documents/' + encodeURIComponent(id) + '/download').then(
            async function (r) {
              if (!r.ok) {
                toast(await failureText(r, 'That document could not be opened.'), true);
                return;
              }
              var blob = await r.blob();
              var url = URL.createObjectURL(blob);
              window.open(url, '_blank');
              setTimeout(function () {
                URL.revokeObjectURL(url);
              }, 4000);
            },
          );
        } else if (act === 'rename') {
          var current = (listCache || []).find(function (d) {
            return d.id === id;
          });
          var next = window.prompt('Rename document', current ? current.title : '');
          if (!next || !next.trim()) return;
          H.authed('/reference-documents/' + encodeURIComponent(id), {
            method: 'PATCH',
            body: { title: next.trim() },
          }).then(async function (r) {
            if (!r.ok) {
              toast(await failureText(r, 'That could not be renamed.'), true);
              return;
            }
            reload(host);
          });
        } else if (act === 'toggle') {
          var active = btn.getAttribute('data-active') === '1';
          H.authed('/reference-documents/' + encodeURIComponent(id), {
            method: 'PATCH',
            body: { active: !active },
          }).then(async function (r) {
            if (!r.ok) {
              toast(await failureText(r, 'That could not be updated.'), true);
              return;
            }
            load(); // refresh the builder's cached active list too
            reload(host);
          });
        } else if (act === 'delete') {
          if (!window.confirm('Delete this document? This cannot be undone.')) return;
          H.authed('/reference-documents/' + encodeURIComponent(id), { method: 'DELETE' }).then(
            async function (r) {
              if (!r.ok) {
                toast(await failureText(r, 'That could not be deleted.'), true);
                return;
              }
              load();
              reload(host);
            },
          );
        }
      });
    });

    var uploadBtn = host.querySelector('#rdUpload');
    if (uploadBtn) {
      uploadBtn.addEventListener('click', function () {
        var titleEl = host.querySelector('#rdTitle');
        var fileEl = host.querySelector('#rdFile');
        var title = (titleEl.value || '').trim();
        var file = fileEl.files && fileEl.files[0];
        if (!title) {
          toast('Give the document a title.', true);
          return;
        }
        if (!file) {
          toast('Choose a PDF to upload.', true);
          return;
        }
        if (file.type && file.type !== 'application/pdf') {
          toast('Only a PDF can be uploaded here.', true);
          return;
        }
        if (file.size > 5 * 1024 * 1024) {
          toast('That file is ' + fmtBytes(file.size) + '. The limit is 5 MB.', true);
          return;
        }
        uploadBtn.disabled = true;
        var reader = new FileReader();
        reader.onload = async function () {
          var base64 = String(reader.result || '').split(',')[1] || '';
          var r = await H.authed('/reference-documents', {
            method: 'POST',
            body: {
              title: title,
              filename: file.name,
              contentType: file.type || 'application/pdf',
              base64: base64,
            },
          });
          uploadBtn.disabled = false;
          if (!r.ok) {
            toast(await failureText(r, 'That document was not uploaded.'), true);
            return;
          }
          toast('Uploaded.');
          load();
          reload(host);
        };
        reader.onerror = function () {
          uploadBtn.disabled = false;
          toast('That file could not be read.', true);
        };
        reader.readAsDataURL(file);
      });
    }
  }

  window.SSGReferenceDocuments = {
    init: function (helpers) {
      H = helpers;
      load();
    },
    load: load,
    /** Active documents, {key, title, filename, byteSize}[] — for the builder checklist. */
    list: function () {
      return ACTIVE || [];
    },
    /** Called by the Proposal content tab with its container element. */
    render: async function (host) {
      if (!H || !H.authed || !host) return;
      host.innerHTML = '<div class="muted" style="font-size:12px;">Loading&hellip;</div>';
      try {
        await reload(host);
      } catch (e) {
        host.innerHTML =
          '<div class="muted" style="font-size:12px;">The reference documents could not be loaded.</div>';
      }
    },
  };
})();
