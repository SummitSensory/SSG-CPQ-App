/**
 * Prebuilt proposal titles: the dropdown on the New proposal form, and the list
 * editor under Administration → Proposal content → Proposal titles.
 *
 * The list is stored server-side (src/proposals/titlePresets.ts) — one ordered list,
 * each title active or retired. The dropdown shows the active ones in list order; a
 * rep can always type their own title instead, and picking one only fills the title
 * field, which stays editable.
 *
 * Two jobs in one file, the same split as reference-documents.js: `fetchActive()` for
 * the New proposal form (anyone who can start a proposal), and `render()` for the
 * Administration editor (PROPOSAL_REVIEW, enforced server-side — someone without it
 * gets the refusal message on Save, the same as the other admin panels).
 *
 * Registers itself on window.SSGProposalTitles. app.js calls init({ authed, esc }).
 */
(function () {
  'use strict';

  var H = null;

  function esc(s) {
    if (H && H.esc) return H.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function newId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  async function fetchList() {
    var r = await H.authed('/proposal-titles');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var d = await r.json();
    return { titles: Array.isArray(d.titles) ? d.titles : [], version: d.version || null };
  }

  /**
   * The active titles, in list order, for the New proposal dropdown. Fetched each time
   * the form opens rather than cached at sign-in, so a title an administrator just
   * added is there on the next New proposal. Never throws: a failed fetch is an empty
   * dropdown, and the rep types the title as before.
   */
  async function fetchActive() {
    if (!H || !H.authed) return [];
    try {
      var d = await fetchList();
      return d.titles
        .filter(function (t) {
          return t && t.active !== false && t.title;
        })
        .map(function (t) {
          return t.title;
        });
    } catch (e) {
      return [];
    }
  }

  /* ------------------------------------------------------------ admin editor */

  var IN =
    'padding:8px 10px;font-size:13px;border:1px solid #d9ddd3;border-radius:7px;font-family:inherit;box-sizing:border-box;';

  function editorHtml(st) {
    var rows = st.titles.length
      ? st.titles
          .map(function (t, i) {
            return (
              '<div data-row="' +
              i +
              '" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid #eef0ea;' +
              (t.active ? '' : 'opacity:.6;') +
              '">' +
              '<span style="width:22px;text-align:right;font-size:11.5px;color:#8a8f85;font-variant-numeric:tabular-nums;">' +
              (i + 1) +
              '</span>' +
              '<input class="ptTitle" data-i="' +
              i +
              '" value="' +
              esc(t.title) +
              '" maxlength="200" style="' +
              IN +
              'flex:1;min-width:0;">' +
              '<label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#5d6258;white-space:nowrap;" title="Only active titles appear on the New proposal form">' +
              '<input type="checkbox" class="ptActive" data-i="' +
              i +
              '"' +
              (t.active ? ' checked' : '') +
              '> Active</label>' +
              '<button type="button" class="link-btn ptUp" data-i="' +
              i +
              '" title="Move up" style="width:auto;padding:4px 8px;"' +
              (i === 0 ? ' disabled' : '') +
              '>↑</button>' +
              '<button type="button" class="link-btn ptDown" data-i="' +
              i +
              '" title="Move down" style="width:auto;padding:4px 8px;"' +
              (i === st.titles.length - 1 ? ' disabled' : '') +
              '>↓</button>' +
              '<button type="button" class="link-btn ptDel" data-i="' +
              i +
              '" title="Delete this title" style="width:auto;padding:4px 8px;color:#b3261e;">Delete</button>' +
              '</div>'
            );
          })
          .join('')
      : '<div class="muted" style="font-size:12.5px;padding:8px 0;">No titles yet. Add the ones your team uses most; a rep can still type any title on the New proposal form.</div>';

    return (
      '<div style="display:flex;gap:8px;margin-bottom:12px;max-width:760px;">' +
      '<input id="ptNew" placeholder="A new proposal title, e.g. Sensory Gym — Adventure Series" maxlength="200" style="' +
      IN +
      'flex:1;min-width:0;">' +
      '<button type="button" class="btn" id="ptAdd" style="width:auto;padding:9px 15px;">+ Add title</button>' +
      '</div>' +
      '<div style="max-width:760px;">' +
      rows +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px;margin-top:14px;">' +
      '<button type="button" class="btn" id="ptSave" style="width:auto;padding:9px 18px;"' +
      (st.dirty && !st.busy ? '' : ' disabled') +
      '>' +
      (st.busy ? 'Saving…' : 'Save titles') +
      '</button>' +
      (st.dirty
        ? '<button type="button" class="link-btn" id="ptRevert" style="width:auto;padding:9px 12px;">Discard changes</button>'
        : '') +
      '<span id="ptMsg" style="font-size:12.5px;color:' +
      (st.msgBad ? '#b3261e' : '#5d6258') +
      ';">' +
      esc(st.msg || (st.dirty ? 'Unsaved changes.' : '')) +
      '</span>' +
      '</div>'
    );
  }

  function mountEditor(host, st) {
    function paint() {
      host.innerHTML = editorHtml(st);
      wire();
    }
    function touch(msg) {
      st.dirty = true;
      st.msg = msg || '';
      st.msgBad = false;
    }
    function wire() {
      var add = host.querySelector('#ptAdd');
      var input = host.querySelector('#ptNew');
      function doAdd() {
        var v = (input.value || '').replace(/\s+/g, ' ').trim();
        if (v.length < 2) {
          st.msg = 'A proposal title needs at least 2 characters.';
          st.msgBad = true;
          paint();
          host.querySelector('#ptNew').focus();
          return;
        }
        var dup = st.titles.some(function (t) {
          return t.title.toLowerCase() === v.toLowerCase();
        });
        if (dup) {
          st.msg = '“' + v + '” is already on the list.';
          st.msgBad = true;
          paint();
          return;
        }
        st.titles.push({ id: newId(), title: v, active: true });
        touch('Added. Save to make it available on New proposal.');
        paint();
        host.querySelector('#ptNew').focus();
      }
      add.addEventListener('click', doAdd);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          doAdd();
        }
      });
      host.querySelectorAll('.ptTitle').forEach(function (el) {
        el.addEventListener('input', function () {
          var t = st.titles[Number(el.getAttribute('data-i'))];
          if (!t) return;
          t.title = el.value;
          if (!st.dirty) {
            touch();
            var save = host.querySelector('#ptSave');
            if (save) save.disabled = false;
            var msg = host.querySelector('#ptMsg');
            if (msg) msg.textContent = 'Unsaved changes.';
          }
        });
      });
      host.querySelectorAll('.ptActive').forEach(function (el) {
        el.addEventListener('change', function () {
          var t = st.titles[Number(el.getAttribute('data-i'))];
          if (!t) return;
          t.active = el.checked;
          touch();
          paint();
        });
      });
      function move(i, d) {
        var j = i + d;
        if (j < 0 || j >= st.titles.length) return;
        var tmp = st.titles[i];
        st.titles[i] = st.titles[j];
        st.titles[j] = tmp;
        touch();
        paint();
      }
      host.querySelectorAll('.ptUp').forEach(function (el) {
        el.addEventListener('click', function () {
          move(Number(el.getAttribute('data-i')), -1);
        });
      });
      host.querySelectorAll('.ptDown').forEach(function (el) {
        el.addEventListener('click', function () {
          move(Number(el.getAttribute('data-i')), 1);
        });
      });
      host.querySelectorAll('.ptDel').forEach(function (el) {
        el.addEventListener('click', function () {
          var i = Number(el.getAttribute('data-i'));
          var t = st.titles[i];
          if (!t) return;
          if (
            !confirm(
              'Delete “' +
                t.title +
                '”?\n\nProposals already using this title keep it. To hide it from New proposal without deleting it, untick Active instead.',
            )
          )
            return;
          st.titles.splice(i, 1);
          touch();
          paint();
        });
      });
      var revert = host.querySelector('#ptRevert');
      if (revert)
        revert.addEventListener('click', function () {
          reload(host);
        });
      var save = host.querySelector('#ptSave');
      if (save)
        save.addEventListener('click', async function () {
          var bad = st.titles.filter(function (t) {
            return (t.title || '').trim().length < 2;
          })[0];
          if (bad) {
            st.msg = 'Every title needs at least 2 characters — fill in or delete the empty one.';
            st.msgBad = true;
            paint();
            return;
          }
          st.busy = true;
          st.msg = '';
          paint();
          try {
            var r = await H.authed('/proposal-titles', {
              method: 'PUT',
              body: {
                version: st.version,
                titles: st.titles.map(function (t) {
                  return {
                    id: t.id,
                    title: t.title.replace(/\s+/g, ' ').trim(),
                    active: !!t.active,
                  };
                }),
              },
            });
            var d = null;
            try {
              d = await r.json();
            } catch (e) {
              /* no body */
            }
            st.busy = false;
            if (!r.ok) {
              st.msg =
                r.status === 403
                  ? 'Only a sales manager or administrator can change the proposal titles.'
                  : (d && d.message) || 'The titles could not be saved (' + r.status + ').';
              st.msgBad = true;
              paint();
              return;
            }
            st.titles = copy(d.titles || []);
            st.version = d.version || null;
            st.dirty = false;
            st.msg = 'Saved. New proposals offer these titles.';
            st.msgBad = false;
            paint();
          } catch (e) {
            st.busy = false;
            st.msg = 'Could not reach the server. Nothing was saved.';
            st.msgBad = true;
            paint();
          }
        });
    }
    paint();
  }

  function copy(titles) {
    return titles.map(function (t) {
      return { id: t.id, title: t.title, active: t.active !== false };
    });
  }

  async function reload(host) {
    var d = await fetchList();
    mountEditor(host, {
      titles: copy(d.titles),
      version: d.version,
      dirty: false,
      busy: false,
      msg: '',
      msgBad: false,
    });
  }

  window.SSGProposalTitles = {
    init: function (helpers) {
      H = helpers;
    },
    fetchActive: fetchActive,
    /** Called by the Proposal content tab with its container element. */
    render: async function (host) {
      if (!H || !H.authed || !host) return;
      host.innerHTML = '<div class="muted" style="font-size:12px;">Loading&hellip;</div>';
      try {
        await reload(host);
      } catch (e) {
        host.innerHTML =
          '<div class="muted" style="font-size:12px;">The proposal titles could not be loaded.</div>';
      }
    },
  };
})();
