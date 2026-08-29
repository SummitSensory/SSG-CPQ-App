// Standard proposal notes — window.SSGStandardNotes.
//
// The reusable note blocks a proposal is built from: the list, the editor, and the
// rich-text field the note text is typed into. Lifted out of public/app.js under
// AUD-003.
//
// Why this is its own file rather than part of either screen that shows it
// ----------------------------------------------------------------------
// It was rendered from TWO places — Catalog → Proposal notes, and Administration →
// Proposal content — and lived in the Administration half of app.js because that is
// where it happened to be written. So Catalog had to reach 13,000 lines up the file to
// call loadStandardNotes() and openStandardNoteForm(), and that single coupling was one
// of only four things standing between the Catalog screen and its own file.
//
// It is not Administration's panel that Catalog borrows. It is a shared panel with no
// home. This is the home.
//
// The rich-text editor came with it
// --------------------------------
// mdToEditHtml, editHtmlToMd, richTextField, readRichText and wireRichText — about a
// hundred lines — sat near the top of app.js looking like general-purpose form
// primitives. They are not: the note form below was their ONLY caller, all three
// entry points, and nothing else in the application typed formatted text. So they moved
// here rather than into ssg-ui.js, and app.js is a hundred lines shorter for it.
//
// They also have to stay next to what reads them. The editor writes the same
// lightweight **bold** / *italic* markup that SSGUI.rt prints on the customer
// document; mdToEditHtml is rt's inverse. Two implementations of that pair and the
// editor stops matching the printed page, which is the one thing a note editor must
// never do.
//
// What it needs
// -------------
// SSGUI for esc, rt, td, tableShell, openModal, fieldRow and IN — read directly off
// the global, because ssg-ui.js is the first script in index.html and cannot be
// absent. And `authed` from the shell, injected through init(), because it carries the
// session and the token-refresh retry.

(function () {
  'use strict';

  var H = null; // host helpers, injected by app.js
  var U = null; // resolved lazily so load order cannot bite

  function ui() {
    if (!U) U = window.SSGUI;
    return U;
  }

  /* ---- the rich-text field ----------------------------------------------
     Notes are stored as the same lightweight markup the printer already reads
     (**bold**, *italic*, line breaks) so nothing downstream changes; the editor
     just gives you a normal formatting surface over it. */

  function mdToEditHtml(s) {
    return ui()
      .esc(s == null ? '' : s)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\n/g, '<br>');
  }

  /** Walk the editor DOM back into **bold** / *italic* markup. */
  function editHtmlToMd(root) {
    var out = '';
    (function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var c = node.childNodes[i];
        if (c.nodeType === 3) {
          out += c.nodeValue;
          continue;
        }
        if (c.nodeType !== 1) continue;
        var tag = c.tagName.toLowerCase();
        if (tag === 'br') {
          out += '\n';
          continue;
        }
        if ((tag === 'div' || tag === 'p') && out && !/\n$/.test(out)) out += '\n';
        var st = (c.getAttribute('style') || '') + ' ';
        var bold = tag === 'b' || tag === 'strong' || /font-weight:\s*(bold|[6-9]00)/i.test(st);
        var ital = tag === 'i' || tag === 'em' || /font-style:\s*italic/i.test(st);
        var inner = out.length;
        if (bold) out += '**';
        if (ital) out += '*';
        walk(c);
        // An empty wrapper would leave dangling markers behind.
        if (out.length === inner + (bold ? 2 : 0) + (ital ? 1 : 0)) {
          out = out.slice(0, inner);
          continue;
        }
        if (ital) out += '*';
        if (bold) out += '**';
      }
    })(root);
    return out
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Contenteditable field + B/I toolbar. Returns the markup via editHtmlToMd(). */
  function richTextField(id, label, value, hint) {
    var esc = ui().esc;
    var btn =
      'border:1px solid #dcded7;background:#fff;border-radius:6px;width:30px;height:28px;' +
      'font-size:13px;cursor:pointer;color:#20241f;';
    return (
      '<div class="field"><label>' +
      esc(label) +
      '</label>' +
      '<div style="border:1px solid #dcded7;border-radius:8px;overflow:hidden;background:#fff;">' +
      '<div style="display:flex;gap:5px;align-items:center;padding:6px 7px;border-bottom:1px solid #ece9db;background:#fafaf7;">' +
      '<button type="button" data-rtcmd="bold" data-rt="' +
      id +
      '" title="Bold (\u2318B)" style="' +
      btn +
      'font-weight:700;">B</button>' +
      '<button type="button" data-rtcmd="italic" data-rt="' +
      id +
      '" title="Italic (\u2318I)" style="' +
      btn +
      'font-style:italic;font-family:Georgia,serif;">I</button>' +
      '<button type="button" data-rtcmd="removeFormat" data-rt="' +
      id +
      '" title="Clear formatting" style="' +
      btn +
      'width:auto;padding:0 9px;font-size:11.5px;">Clear</button>' +
      // The escape hatch for what the toolbar cannot do — lists, links, anything
      // needing real markup. Switching views hands the text over verbatim.
      '<button type="button" id="' +
      id +
      '__htmlBtn" style="' +
      btn +
      'width:auto;padding:0 9px;font-size:11.5px;margin-left:auto;">HTML</button>' +
      '</div>' +
      '<div id="' +
      id +
      '" contenteditable="true" style="min-height:120px;padding:10px 12px;font-size:14px;line-height:1.55;outline:none;">' +
      mdToEditHtml(value) +
      '</div>' +
      '<textarea id="' +
      id +
      '__html" spellcheck="false" style="display:none;width:100%;box-sizing:border-box;min-height:150px;padding:10px 12px;border:none;outline:none;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.6;">' +
      esc(value == null ? '' : value) +
      '</textarea>' +
      '</div>' +
      (hint
        ? '<div class="muted" style="font-size:11.5px;margin-top:3px;">' + hint + '</div>'
        : '') +
      '</div>'
    );
  }

  /**
   * Which view a rich-text field is showing, by field id. The HTML view is
   * authoritative while it is open: readRichText reads the textarea verbatim rather
   * than walking the editor DOM, so hand-written tags are never flattened by a
   * round-trip through the toolbar.
   */
  var rtHtmlMode = {};

  function readRichText(id) {
    if (rtHtmlMode[id]) {
      var ta = document.getElementById(id + '__html');
      return ta ? ta.value.trim() : '';
    }
    var el = document.getElementById(id);
    return el ? editHtmlToMd(el) : '';
  }

  /** Wire the toolbar + keyboard shortcuts + plain-text paste for a rich-text field. */
  function wireRichText(id) {
    var el = document.getElementById(id);
    if (!el) return;
    rtHtmlMode[id] = false;
    var ta = document.getElementById(id + '__html');
    var hb = document.getElementById(id + '__htmlBtn');
    if (ta && hb) {
      hb.addEventListener('click', function () {
        var toHtml = !rtHtmlMode[id];
        if (toHtml) ta.value = editHtmlToMd(el);
        else el.innerHTML = mdToEditHtml(ta.value);
        rtHtmlMode[id] = toHtml;
        el.style.display = toHtml ? 'none' : 'block';
        ta.style.display = toHtml ? 'block' : 'none';
        hb.style.background = toHtml ? '#eef0ea' : '#fff';
        hb.textContent = toHtml ? 'Formatted' : 'HTML';
        (toHtml ? ta : el).focus();
      });
    }
    document.querySelectorAll('[data-rt="' + id + '"]').forEach(function (b) {
      // mousedown so the selection inside the editor survives the click.
      b.addEventListener('mousedown', function (e) {
        e.preventDefault();
        el.focus();
        document.execCommand(b.getAttribute('data-rtcmd'), false, null);
      });
    });
    el.addEventListener('keydown', function (e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      var k = String(e.key).toLowerCase();
      if (k === 'b' || k === 'i') {
        e.preventDefault();
        document.execCommand(k === 'b' ? 'bold' : 'italic', false, null);
      }
    });
    el.addEventListener('paste', function (e) {
      e.preventDefault();
      var t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    });
  }

  /* ---- the list ---- */

  async function load() {
    var box = document.getElementById('snList');
    if (!box) return;
    var esc = ui().esc,
      td = ui().td,
      rt = ui().rt,
      tableShell = ui().tableShell;
    try {
      var r = await H.authed('/standard-notes');
      if (!r.ok) {
        box.innerHTML =
          '<div class="err">Could not load standard notes (' +
          r.status +
          '). Run the 0019 migration if this persists.</div>';
        return;
      }
      var notes = await r.json();
      var rows = (notes || [])
        .map(function (n) {
          var preview = rt(String(n.body).slice(0, 160)) + (String(n.body).length > 160 ? '…' : '');
          return (
            '<tr>' +
            td(
              '<b style="font-weight:600;">' +
                esc(n.title) +
                '</b><div class="muted" style="font-size:12px;max-width:520px;line-height:1.45;">' +
                preview +
                '</div>',
            ) +
            td(
              n.placement === 'FOOTER'
                ? '<span class="chip">Below signatures</span>'
                : '<span class="chip">In line items</span>',
            ) +
            td(
              n.autoInclude
                ? '<span style="display:inline-block;background:#eaf3ee;border:1px solid #cfe3d7;color:#2f7d5d;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;">Always</span>'
                : '<span class="muted">On request</span>',
            ) +
            td(
              n.active ? '<span class="chip">Active</span>' : '<span class="muted">Hidden</span>',
            ) +
            td(
              '<div style="display:flex;gap:6px;justify-content:flex-end;"><button class="link-btn snEdit" data-id="' +
                n.id +
                '" style="width:auto;padding:6px 11px;">Edit</button>' +
                '<button class="link-btn snDel" data-id="' +
                n.id +
                '" style="width:auto;padding:6px 11px;color:#9c3327;">Delete</button></div>',
            ) +
            '</tr>'
          );
        })
        .join('');
      box.innerHTML = tableShell(
        ['Note', 'Prints', 'Include', 'Status', ''],
        rows,
        5,
        'No standard notes yet.',
      );
      box.querySelectorAll('.snEdit').forEach(function (b) {
        b.addEventListener('click', function () {
          openForm(
            (notes || []).filter(function (n) {
              return n.id === b.getAttribute('data-id');
            })[0],
          );
        });
      });
      box.querySelectorAll('.snDel').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!confirm('Delete this standard note?')) return;
          var rr = await H.authed('/standard-notes/' + b.getAttribute('data-id'), {
            method: 'DELETE',
          });
          if (!rr.ok && rr.status !== 204) {
            alert('Could not delete (' + rr.status + ').');
            return;
          }
          load();
        });
      });
    } catch (e) {
      box.innerHTML = '<div class="err">Could not reach the server.</div>';
    }
  }

  /* ---- the editor ---- */

  function openForm(note) {
    var esc = ui().esc,
      fieldRow = ui().fieldRow,
      IN = ui().IN;
    var n = note || {
      title: '',
      body: '',
      placement: 'TABLE',
      autoInclude: false,
      sortOrder: 0,
      active: true,
      triggerParts: '',
      condition: null,
      emphasis: false,
    };
    ui().openModal(
      note ? 'Edit standard note' : 'New standard note',
      fieldRow('Title', '<input id="snTitle" style="' + IN + '" value="' + esc(n.title) + '">') +
        richTextField(
          'snBody',
          'Note text',
          n.body,
          'Line breaks are kept. Bold and italic print on the customer proposal.',
        ) +
        fieldRow(
          'Where it prints',
          '<select id="snPlace" style="' +
            IN +
            '"><option value="TABLE"' +
            (n.placement === 'TABLE' ? ' selected' : '') +
            '>Inside the line items</option><option value="FOOTER"' +
            (n.placement === 'FOOTER' ? ' selected' : '') +
            '>Below the signature lines</option></select>',
        ) +
        fieldRow(
          'Order',
          '<input id="snOrder" type="number" style="' +
            IN +
            '" value="' +
            (Number(n.sortOrder) || 0) +
            '">',
        ) +
        fieldRow(
          'When it applies',
          '<select id="snCond" style="' +
            IN +
            '">' +
            '<option value=""' +
            (!n.condition ? ' selected' : '') +
            '>Always</option>' +
            '<option value="DEPOSIT_SHOWN"' +
            (n.condition === 'DEPOSIT_SHOWN' ? ' selected' : '') +
            '>Only when the deposit is shown on the proposal</option>' +
            '<option value="DEPOSIT_HIDDEN"' +
            (n.condition === 'DEPOSIT_HIDDEN' ? ' selected' : '') +
            '>Only when the deposit is NOT shown</option>' +
            '</select>' +
            '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.5;">Write the two versions of a paragraph as two notes, one for each case, and tick “always include” on both. Unticking the deposit on a proposal then swaps the wording rather than leaving a note that contradicts the totals.</div>',
        ) +
        fieldRow(
          'Add this note when these parts are on the proposal',
          '<input id="snParts" style="' +
            IN +
            '" value="' +
            esc(n.triggerParts || '') +
            '" placeholder="SSUSP67, SSCW67, SSUSP72">' +
            '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.5;">Part numbers, comma separated. The note is added once, at the end of the section the part is in, and can still be deleted from a proposal. Leave blank for a note that is always included or picked by hand.</div>',
        ) +
        '<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin:4px 0;cursor:pointer;"><input type="checkbox" id="snEmph"' +
        (n.emphasis ? ' checked' : '') +
        '> Print in an outlined box</label>' +
        '<div class="muted" style="font-size:12px;margin:-2px 0 8px 26px;line-height:1.5;">For wording the customer has to read. Use it sparingly — three boxed notes on one proposal emphasise nothing.</div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin:4px 0;cursor:pointer;"><input type="checkbox" id="snAuto"' +
        (n.autoInclude ? ' checked' : '') +
        '> Always include on new proposals</label>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" id="snActive"' +
        (n.active !== false ? ' checked' : '') +
        '> Available in the builder</label>',
      async function (close, showErr) {
        var body = {
          title: document.getElementById('snTitle').value.trim(),
          body: readRichText('snBody'),
          placement: document.getElementById('snPlace').value,
          sortOrder: Number(document.getElementById('snOrder').value) || 0,
          triggerParts: document.getElementById('snParts').value.trim(),
          condition: document.getElementById('snCond').value || null,
          autoInclude: document.getElementById('snAuto').checked,
          emphasis: document.getElementById('snEmph').checked,
          active: document.getElementById('snActive').checked,
        };
        if (!body.title || !body.body) return showErr('Title and note text are both required.');
        var r = note
          ? await H.authed('/standard-notes/' + note.id, { method: 'PATCH', body: body })
          : await H.authed('/standard-notes', { method: 'POST', body: body });
        if (!r.ok) return showErr('Could not save (' + r.status + ').');
        close();
        load();
      },
      note ? 'Save changes' : 'Create note',
    );
    wireRichText('snBody');
  }

  /* ---- mounting ----
   *
   * Two hosts, two entry points, and the difference is who owns the markup.
   *
   * Administration draws its own #snNew button and #snList container as part of a
   * larger tab, so it calls mount(): wire the button, load the list.
   *
   * Catalog's Proposal notes tab is nothing BUT this panel, so it calls renderTab():
   * the panel draws its own heading, button and container into #catBody, then mounts.
   * That description text is the panel's own — it was duplicated, nearly but not
   * exactly, in both screens before this.
   */

  /** Wire an #snNew button and load an #snList the host has already drawn. */
  function mount() {
    var btn = document.getElementById('snNew');
    // Not an error if it is absent: Administration renders every tab's markup on open
    // and only shows one, so this runs whether or not the notes tab is the visible one.
    if (btn)
      btn.addEventListener('click', function () {
        openForm(null);
      });
    load();
  }

  var BLURB =
    'Reusable note blocks for proposals. “Always include” notes are added to ' +
    'every new proposal automatically, and a note can name the parts that pull it in; the ' +
    'rest are picked from <b style="font-weight:600;">+ Standard note…</b> in the builder. ' +
    'Table notes print inside the line items; footer notes print below the signature lines.';

  /** The whole Catalog → Proposal notes tab, drawn into #catBody. */
  function renderTab() {
    var host = document.getElementById('catBody');
    if (!host) return;
    host.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px;">' +
      '<div class="muted" style="font-size:12.5px;max-width:640px;line-height:1.5;">' +
      BLURB +
      '</div>' +
      '<button class="btn" id="snNew" style="width:auto;padding:9px 15px;white-space:nowrap;">+ New note</button></div>' +
      '<div id="snList"><div class="muted" style="padding:16px;">Loading…</div></div>';
    mount();
  }

  window.SSGStandardNotes = {
    /** `authed` from the shell. Called once during boot. */
    init: function (host) {
      H = host;
    },
    mount: mount,
    renderTab: renderTab,
    load: load,
    openForm: openForm,
  };
})();
