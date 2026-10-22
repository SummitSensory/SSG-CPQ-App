/*
 * Reorderable sidebar tabs (window.SSGNavOrder).
 *
 * Each user puts the left-hand tabs in the order they want — drag a tab up or down
 * the sidebar, or use "Reorder tabs" at the foot of it for a keyboard-friendly list
 * with Move up / Move down and "Reset to default order". The order is saved to the
 * account (PATCH /auth/me { navOrder }), like the dashboard layout, so it follows the
 * user from browser to browser.
 *
 * Why this works on the DOM rather than on app.js's NAV array: several tabs are not
 * in NAV at all. Accounts Receivable, Insights, Goals and Strategic Partnerships each
 * install their own button into #nav once their script loads, at a moment app.js does
 * not control. So the saved order is (re)applied whenever #nav's children change,
 * and the rules for what to do with an id are:
 *
 *  - A saved id that is not in the sidebar (a tab this user's role cannot see, or one
 *    that has been removed) is ignored. Nothing is ever shown that would not be.
 *  - A tab that is in the sidebar but not in the saved order (a tab added after the
 *    order was saved) is placed at its default position: right after whichever tab
 *    precedes it in the default order.
 *
 * The "Mock Proposal" box at the foot of the nav is not a list row and is not moved.
 */
(function () {
  'use strict';

  /** The default order, as the sidebar has always shown it. Ids are each tab's data-view. */
  var DEFAULT_ORDER = [
    'dashboard',
    'crm',
    'catalog',
    'proposals',
    'strategic-partnerships',
    'reports',
    'insights',
    'goals',
    'orders',
    'receivables',
    'belts',
    'admin',
    'integrations',
  ];

  function uniqueStrings(list) {
    var out = [],
      seen = {};
    (Array.isArray(list) ? list : []).forEach(function (id) {
      if (typeof id !== 'string' || !id || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }

  /**
   * Order the tabs that are actually present (`present`, in their default order) by
   * the saved preference. Pure, so it is pinned by tests without a browser.
   *
   * Saved ids that are not present are dropped; present ids the preference does not
   * mention are inserted right after the nearest tab that precedes them in `present`
   * (or first, when nothing does).
   */
  function merge(saved, present) {
    present = uniqueStrings(present);
    var isPresent = {};
    present.forEach(function (id) {
      isPresent[id] = true;
    });
    var out = uniqueStrings(saved).filter(function (id) {
      return isPresent[id];
    });
    var placed = {};
    out.forEach(function (id) {
      placed[id] = true;
    });
    present.forEach(function (id, i) {
      if (placed[id]) return;
      var at = 0;
      for (var j = i - 1; j >= 0; j--) {
        var k = out.indexOf(present[j]);
        if (k !== -1) {
          at = k + 1;
          break;
        }
      }
      out.splice(at, 0, id);
      placed[id] = true;
    });
    return out;
  }

  /** The default order of whatever tabs are present, given their current DOM order. */
  function defaultOrderOf(domIds) {
    return merge(DEFAULT_ORDER, domIds);
  }

  var deps = { authed: null };
  var state = {
    user: null,
    saved: null,
    observer: null,
    applying: false,
    scheduled: false,
    dragId: null,
  };

  function navEl() {
    return document.getElementById('nav');
  }

  /** The reorderable rows: direct-child tab buttons, not the promoted Mock Proposal box. */
  function rows() {
    var nav = navEl();
    if (!nav) return [];
    return Array.prototype.filter.call(nav.children, function (el) {
      return el.classList && el.classList.contains('nav-item') && el.getAttribute('data-view');
    });
  }
  function domIds() {
    return rows().map(function (b) {
      return b.getAttribute('data-view');
    });
  }
  function labelOf(id) {
    var b = rows().filter(function (r) {
      return r.getAttribute('data-view') === id;
    })[0];
    return b ? (b.textContent || id).trim() : id;
  }

  /** Put the DOM in `order`. Touches nothing when it already is, so the observer settles. */
  function placeInDom(order) {
    var nav = navEl();
    if (!nav) return;
    if (order.join('|') === domIds().join('|')) return;
    var byId = {};
    rows().forEach(function (b) {
      byId[b.getAttribute('data-view')] = b;
    });
    var anchor = nav.querySelector(':scope > .nav-promo');
    state.applying = true;
    order.forEach(function (id) {
      if (byId[id]) nav.insertBefore(byId[id], anchor);
    });
    state.applying = false;
  }

  function apply() {
    state.scheduled = false;
    var ids = domIds();
    if (!ids.length) return;
    placeInDom(merge(state.saved, defaultOrderOf(ids)));
    makeDraggable();
  }

  function scheduleApply() {
    if (state.applying || state.scheduled) return;
    state.scheduled = true;
    setTimeout(apply, 0);
  }

  function save(order) {
    state.saved = order ? order.slice() : null;
    if (state.user) state.user.navOrder = state.saved;
    if (!deps.authed) return Promise.resolve(true);
    return deps
      .authed('/auth/me', { method: 'PATCH', body: { navOrder: state.saved } })
      .then(function (r) {
        if (!r.ok)
          toast(
            'Your tab order could not be saved (' +
              r.status +
              '). It will reset when you sign in again.',
            true,
          );
        return r.ok;
      })
      .catch(function () {
        toast('Your tab order could not be saved — the server did not answer.', true);
        return false;
      });
  }

  function toast(msg, bad) {
    if (window.SSGUI && window.SSGUI.toast) window.SSGUI.toast(msg, bad);
  }

  /* ---------------------------------------------------------------- drag in the sidebar */

  var STYLE_ID = 'ssgNavOrderStyle';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '#nav > .nav-item.nav-dragging{opacity:.45;}' +
      '#nav > .nav-item.nav-drop-before{box-shadow:inset 0 2px 0 #3d4a55;}' +
      '#nav > .nav-item.nav-drop-after{box-shadow:inset 0 -2px 0 #3d4a55;}' +
      '.nav-order-list{list-style:none;margin:0;padding:0;border:1px solid #e7e8e3;border-radius:10px;background:#fff;}' +
      '.nav-order-list li{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #f2f3ef;font-size:14px;background:#fff;}' +
      '.nav-order-list li:last-child{border-bottom:none;}' +
      '.nav-order-list li.nav-dragging{opacity:.45;}' +
      '.nav-order-list li.nav-drop-before{box-shadow:inset 0 2px 0 #3d4a55;}' +
      '.nav-order-list li.nav-drop-after{box-shadow:inset 0 -2px 0 #3d4a55;}' +
      '.nav-order-list .grip{cursor:grab;color:#8a8f85;user-select:none;font-size:15px;line-height:1;}' +
      '.nav-order-list .lbl{flex:1;}' +
      '.nav-order-list button{width:auto;padding:4px 9px;font-size:12px;}';
    document.head.appendChild(s);
  }

  function clearDropMarks(scope) {
    Array.prototype.forEach.call(
      scope.querySelectorAll('.nav-drop-before,.nav-drop-after'),
      function (el) {
        el.classList.remove('nav-drop-before', 'nav-drop-after');
      },
    );
  }

  /** Before or after `el`, by which half of it the pointer is over. */
  function dropSide(el, clientY) {
    var r = el.getBoundingClientRect();
    return clientY < r.top + r.height / 2 ? 'before' : 'after';
  }

  /**
   * Wire HTML5 drag-and-drop on one list of rows. `idOf` names a row; `onDrop` gets
   * the dragged id, the target id and the side. Shared by the sidebar and the dialog.
   */
  function wireDrag(container, rowSelector, idOf, onDrop) {
    if (container.__navOrderDrag) return;
    container.__navOrderDrag = true;
    container.addEventListener('dragstart', function (e) {
      var row = e.target.closest && e.target.closest(rowSelector);
      if (!row || row.parentNode !== container) return;
      state.dragId = idOf(row);
      row.classList.add('nav-dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', state.dragId);
      } catch (err) {}
    });
    container.addEventListener('dragover', function (e) {
      if (!state.dragId) return;
      var row = e.target.closest && e.target.closest(rowSelector);
      if (!row || row.parentNode !== container) return;
      e.preventDefault();
      clearDropMarks(container);
      if (idOf(row) !== state.dragId)
        row.classList.add(
          dropSide(row, e.clientY) === 'before' ? 'nav-drop-before' : 'nav-drop-after',
        );
    });
    container.addEventListener('dragleave', function (e) {
      if (e.target === container) clearDropMarks(container);
    });
    container.addEventListener('drop', function (e) {
      if (!state.dragId) return;
      var row = e.target.closest && e.target.closest(rowSelector);
      e.preventDefault();
      clearDropMarks(container);
      if (row && row.parentNode === container && idOf(row) !== state.dragId) {
        onDrop(state.dragId, idOf(row), dropSide(row, e.clientY));
      }
    });
    container.addEventListener('dragend', function () {
      Array.prototype.forEach.call(container.querySelectorAll('.nav-dragging'), function (el) {
        el.classList.remove('nav-dragging');
      });
      clearDropMarks(container);
      state.dragId = null;
    });
  }

  /** Move `id` to just before/after `targetId` in `order`; returns a new array. */
  function moveTo(order, id, targetId, side) {
    var out = order.filter(function (x) {
      return x !== id;
    });
    var t = out.indexOf(targetId);
    if (t === -1) return order.slice();
    out.splice(side === 'before' ? t : t + 1, 0, id);
    return out;
  }

  /** Move `id` one place up (-1) or down (+1); returns a new array. */
  function step(order, id, delta) {
    var out = order.slice();
    var i = out.indexOf(id),
      j = i + delta;
    if (i === -1 || j < 0 || j >= out.length) return out;
    out[i] = out[j];
    out[j] = id;
    return out;
  }

  function makeDraggable() {
    var nav = navEl();
    if (!nav) return;
    rows().forEach(function (b) {
      if (!b.hasAttribute('draggable')) {
        b.setAttribute('draggable', 'true');
        b.title = b.title || 'Drag to reorder your tabs';
      }
    });
    wireDrag(
      nav,
      '.nav-item',
      function (b) {
        return b.getAttribute('data-view');
      },
      function (id, targetId, side) {
        var next = moveTo(domIds(), id, targetId, side);
        placeInDom(next);
        save(next);
      },
    );
  }

  /* ------------------------------------------------------------- the Reorder dialog */

  function openDialog() {
    var UI = window.SSGUI;
    if (!UI || !UI.openModal) return;
    var esc = UI.esc;
    var order = domIds();
    var labels = {};
    order.forEach(function (id) {
      labels[id] = labelOf(id);
    });
    var resetTo = null;

    function listHtml() {
      return order
        .map(function (id, i) {
          return (
            '<li draggable="true" data-id="' +
            esc(id) +
            '">' +
            '<span class="grip" aria-hidden="true">\u2807\u2807</span>' +
            '<span class="lbl">' +
            esc(labels[id]) +
            '</span>' +
            '<button type="button" class="link-btn" data-up="' +
            esc(id) +
            '"' +
            (i === 0 ? ' disabled' : '') +
            ' aria-label="Move ' +
            esc(labels[id]) +
            ' up">\u2191 Up</button>' +
            '<button type="button" class="link-btn" data-down="' +
            esc(id) +
            '"' +
            (i === order.length - 1 ? ' disabled' : '') +
            ' aria-label="Move ' +
            esc(labels[id]) +
            ' down">\u2193 Down</button>' +
            '</li>'
          );
        })
        .join('');
    }

    var ov = UI.openModal(
      'Reorder tabs',
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">Drag a tab, or use Up and Down. Your order is saved to your account, so it is the same wherever you sign in. You can also drag tabs straight in the sidebar.</div>' +
        '<ul class="nav-order-list" id="navOrderList">' +
        listHtml() +
        '</ul>' +
        '<button type="button" class="link-btn" id="navOrderReset" style="width:auto;padding:8px 0;margin-top:8px;font-size:12.5px;">Reset to default order</button>',
      function (close) {
        var next = order.slice();
        placeInDom(next);
        // A reset that was not changed afterwards stores no preference at all, so the
        // user keeps following the default as it evolves.
        var isDefault = resetTo && next.join('|') === resetTo.join('|');
        return save(isDefault ? null : next).then(function () {
          close();
        });
      },
      'Save order',
    );

    var list = ov.querySelector('#navOrderList');
    function repaint(focusSel) {
      list.innerHTML = listHtml();
      if (focusSel) {
        var f = list.querySelector(focusSel);
        if (f && !f.disabled) f.focus();
        else if (f) {
          var row = f.closest('li');
          var other = row && row.querySelector('button:not([disabled])');
          if (other) other.focus();
        }
      }
    }
    list.addEventListener('click', function (e) {
      var up = e.target.closest('[data-up]'),
        down = e.target.closest('[data-down]');
      if (up) {
        var id = up.getAttribute('data-up');
        order = step(order, id, -1);
        repaint('[data-up="' + cssEsc(id) + '"]');
      }
      if (down) {
        var id2 = down.getAttribute('data-down');
        order = step(order, id2, 1);
        repaint('[data-down="' + cssEsc(id2) + '"]');
      }
    });
    wireDrag(
      list,
      'li',
      function (li) {
        return li.getAttribute('data-id');
      },
      function (id, targetId, side) {
        order = moveTo(order, id, targetId, side);
        repaint(null);
      },
    );
    ov.querySelector('#navOrderReset').addEventListener('click', function () {
      order = defaultOrderOf(order);
      resetTo = order.slice();
      repaint(null);
    });
  }

  function cssEsc(s) {
    return window.CSS && window.CSS.escape
      ? window.CSS.escape(s)
      : String(s).replace(/["\\]/g, '\\$&');
  }

  /** The "Reorder tabs" link in the sidebar's foot, above My Profile. */
  function installLink() {
    if (document.getElementById('navOrderBtn')) return;
    var anchor = document.getElementById('profBtn');
    if (!anchor || !anchor.parentNode) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'navOrderBtn';
    b.className = 'link-btn';
    b.style.marginBottom = '6px';
    b.textContent = 'Reorder Tabs';
    b.addEventListener('click', openDialog);
    anchor.parentNode.insertBefore(b, anchor);
  }

  /**
   * Called by app.js once the shell exists. Safe to call again after a re-login: the
   * previous observer is dropped and the new user's order applied.
   */
  function mount(user, opts) {
    deps.authed = (opts && opts.authed) || deps.authed;
    state.user = user || null;
    state.saved = user && Array.isArray(user.navOrder) ? uniqueStrings(user.navOrder) : null;
    if (state.observer) state.observer.disconnect();
    var nav = navEl();
    if (!nav) return;
    injectStyle();
    installLink();
    apply();
    if (window.MutationObserver) {
      state.observer = new MutationObserver(function () {
        if (!state.applying) scheduleApply();
      });
      state.observer.observe(nav, { childList: true });
    }
  }

  window.SSGNavOrder = {
    DEFAULT_ORDER: DEFAULT_ORDER,
    merge: merge,
    defaultOrderOf: defaultOrderOf,
    moveTo: moveTo,
    step: step,
    mount: mount,
    openDialog: openDialog,
  };
})();
