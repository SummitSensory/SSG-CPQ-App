/**
 * Tips & Tricks — a page-by-page help bubble in the bottom-right corner.
 *
 * The launcher is a photo of whoever wrote the tip, masked into a speech-bubble
 * shape. Selecting it grows that same bubble in place into a taller panel, with
 * the photo growing into a real headshot at the top — no separate popover, no
 * swapped element, so the person stays recognisable through the motion.
 *
 * Two independent switches decide whether this shows at all:
 *   - the signed-in user's own User.tipsEnabled (self-service, see /auth/me and
 *     the "My profile" form in app.js) — a display preference, off is a click away
 *   - whether the current page has any tips queued for it (TIPS below) — a page
 *     with nothing to say is simply quiet rather than showing an empty bubble
 *
 * WHO appears on it — name, title, photo — is a company-wide setting under
 * Administration → People, not code, so the guide can change without a deploy.
 * See src/ui/tipsGuide.ts.
 *
 * A separate file for the same reason freight-trueup.js and belt-shipments.js
 * are: one small, replaceable concern, kept out of the 10,000-line application
 * shell. It borrows the shell's helpers via init(), so styling, auth and
 * escaping stay identical to everything around it.
 */
(function () {
  'use strict';

  var H = null; // host helpers, injected by app.js: esc, authed

  var NAVY = '#1c2c56';
  var GREEN = '#3f9d78';
  var SERIF = "'Newsreader', Georgia, serif";

  /**
   * What each page has to say. Keyed by the NAV id in app.js (see the nav
   * click handler and activateNav()) so a page with no entry here — Reports,
   * Belt Shipments, Integrations, the Mock Proposal tool — simply shows no
   * bubble rather than an empty one. Extending this to a new page is the whole
   * job: add an id here, nothing else needs to change.
   */
  var TIPS = {
    dashboard: [
      'The banner across the top only shows up when a job has freight that is priced but not yet on the invoice. No banner means every invoiced job is square.',
    ],
    catalog: [
      'Every part here is actually two records — a Product (name, category, tree spot) and a Sku (price, cost, vendor). If a price looks wrong, the Sku is where to look, not the Product.',
      'A part can carry more than one vendor in its sourcing. When several are marked primary, the Bill of Materials still follows whatever is set on the Sku — that is the ordering override.',
    ],
    proposals: [
      'The price on a line locks in the moment you add it. Move the catalog price next week and this proposal will not budge — a signed quote should never drift under someone.',
      'The heading a line prints under comes from its proposal group, not its catalog category. Renaming the group here does not touch the catalog.',
    ],
    crm: [
      'Editing a contact here pushes the change to Monday and QuickBooks for you — no need to update the same name in three places.',
      'A new contact does not get a Monday item automatically. That is deliberate, so an import never floods the board with duplicates.',
    ],
    orders: [
      'The Bill of Materials orders from whatever is set on the Sku, not from every vendor listed in its sourcing — that field is the override for what actually goes out to buy.',
    ],
    admin: [
      'Almost everything on this screen is company-wide and takes effect the moment you save — including this guide’s own name, title and photo.',
    ],
  };

  var PAGE_LABEL = {
    dashboard: 'Dashboard',
    crm: 'CRM',
    catalog: 'Catalog',
    proposals: 'Proposals',
    orders: 'Orders & Bill of Materials',
    admin: 'Administration',
  };

  var LIGHTBULB_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#0d2417" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 18h6"/><path d="M10 22h4"/>' +
    '<path d="M12 2a6 6 0 0 0-4 10.5c.6.55 1 1.4 1 2.2V16h6v-1.3c0-.8.4-1.65 1-2.2A6 6 0 0 0 12 2Z"/></svg>';
  var CLOSE_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var PREV_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>';
  var NEXT_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>';

  function esc(s) {
    return H.esc(String(s == null ? '' : s));
  }
  function el(id) {
    return document.getElementById(id);
  }
  async function errorText(r) {
    try {
      var j = await r.json();
      return j.message || j.error || 'Request failed (' + r.status + ')';
    } catch (e) {
      return 'Request failed (' + r.status + ')';
    }
  }

  /* ══════════════════════════ the bubble ══════════════════════════ */

  var guide = { name: 'Bryan', title: 'Founder', avatarImage: null };
  var state = { built: false, enabled: true, page: null, open: false, index: 0 };

  function initialsAvatar() {
    var i = (guide.name || '?').slice(0, 1).toUpperCase();
    return (
      '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(255,255,255,.12);color:#fff;font-family:' +
      SERIF +
      ';font-weight:600;font-size:26px;">' +
      esc(i) +
      '</div>'
    );
  }

  function paintAvatar() {
    var box = el('ssgTipsAvatar');
    if (!box) return;
    box.innerHTML = guide.avatarImage
      ? '<img src="' +
        esc(guide.avatarImage) +
        '" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">'
      : initialsAvatar();
  }

  function build() {
    if (state.built) return;
    state.built = true;

    var wrap = document.createElement('div');
    wrap.id = 'ssgTipsWidget';
    wrap.style.cssText =
      'position:fixed;right:22px;bottom:22px;width:84px;height:84px;' +
      'border-radius:32px 32px 8px 32px;background:' +
      NAVY +
      ';overflow:hidden;box-shadow:0 10px 26px -8px rgba(20,32,64,.55);' +
      'transition:width .34s cubic-bezier(.4,0,.2,1),height .34s cubic-bezier(.4,0,.2,1),' +
      'border-radius .34s cubic-bezier(.4,0,.2,1),box-shadow .34s ease;z-index:900;display:none;';

    wrap.innerHTML =
      '<button id="ssgTipsHit" aria-label="Open tips for this page" aria-expanded="false" ' +
      'style="position:absolute;inset:0;border:none;margin:0;padding:0;background:none;cursor:pointer;z-index:2;"></button>' +
      '<span id="ssgTipsBadge" style="position:absolute;top:-3px;left:-3px;width:26px;height:26px;border-radius:50%;' +
      'background:' +
      GREEN +
      ';display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 3px ' +
      NAVY +
      ';transition:opacity .2s ease,transform .2s ease;z-index:3;">' +
      '<span style="width:12px;height:12px;display:block;">' +
      LIGHTBULB_SVG +
      '</span></span>' +
      '<div id="ssgTipsAvatar" style="position:absolute;left:50%;transform:translateX(-50%);top:0;width:84px;height:84px;' +
      'border-radius:32px 32px 8px 32px;overflow:hidden;box-shadow:0 0 0 3px rgba(255,255,255,.12);' +
      'transition:top .34s cubic-bezier(.4,0,.2,1),width .34s cubic-bezier(.4,0,.2,1),' +
      'height .34s cubic-bezier(.4,0,.2,1),border-radius .34s cubic-bezier(.4,0,.2,1);z-index:1;"></div>' +
      '<span id="ssgTipsTail" style="position:absolute;right:12px;bottom:-8px;width:18px;height:18px;background:' +
      NAVY +
      ';clip-path:polygon(0 0,100% 0,0 100%);transition:opacity .18s ease,transform .18s ease;"></span>' +
      '<button id="ssgTipsClose" aria-label="Close tips" style="position:absolute;top:14px;right:14px;z-index:4;' +
      'width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);' +
      'color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;' +
      'transition:opacity .2s ease .06s;">' +
      CLOSE_SVG +
      '</button>' +
      '<div id="ssgTipsContent" style="position:absolute;left:0;right:0;top:158px;bottom:0;padding:0 22px 22px;' +
      'display:flex;flex-direction:column;opacity:0;transform:translateY(6px);pointer-events:none;' +
      'transition:opacity .22s ease .12s,transform .22s ease .12s;">' +
      '<div style="text-align:center;margin-bottom:8px;">' +
      '<b id="ssgTipsWho" style="display:block;font-size:15px;color:#fff;font-family:' +
      SERIF +
      ';"></b>' +
      '<span id="ssgTipsRole" style="font-size:11.5px;color:rgba(255,255,255,.62);"></span></div>' +
      '<span id="ssgTipsRef" style="display:block;text-align:center;font-size:10.5px;letter-spacing:.06em;' +
      'text-transform:uppercase;color:' +
      GREEN +
      ';margin-bottom:16px;font-weight:600;"></span>' +
      '<div id="ssgTipsBox" style="flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);' +
      'border-radius:12px;padding:15px;font-size:13.5px;line-height:1.62;color:rgba(255,255,255,.94);overflow-y:auto;"></div>' +
      '<div id="ssgTipsPager" style="display:flex;align-items:center;justify-content:center;gap:16px;margin-top:14px;">' +
      '<button id="ssgTipsPrev" aria-label="Previous tip" style="background:rgba(255,255,255,.09);' +
      'border:1px solid rgba(255,255,255,.16);color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;">' +
      PREV_SVG +
      '</button>' +
      '<div id="ssgTipsDots" style="display:flex;gap:5px;"></div>' +
      '<button id="ssgTipsNext" aria-label="Next tip" style="background:rgba(255,255,255,.09);' +
      'border:1px solid rgba(255,255,255,.16);color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;">' +
      NEXT_SVG +
      '</button></div></div>';

    document.body.appendChild(wrap);
    paintAvatar();

    el('ssgTipsHit').addEventListener('click', function () {
      setOpen(true);
    });
    el('ssgTipsClose').addEventListener('click', function () {
      setOpen(false);
    });
    el('ssgTipsPrev').addEventListener('click', function () {
      step(-1);
    });
    el('ssgTipsNext').addEventListener('click', function () {
      step(1);
    });
  }

  function setOpen(open) {
    if (!state.page) return;
    state.open = open;
    var wrap = el('ssgTipsWidget');
    var avatar = el('ssgTipsAvatar');
    var hit = el('ssgTipsHit');
    var badge = el('ssgTipsBadge');
    var tail = el('ssgTipsTail');
    var close = el('ssgTipsClose');
    var content = el('ssgTipsContent');
    if (!wrap) return;

    if (open) {
      wrap.style.width = '320px';
      wrap.style.height = '430px';
      wrap.style.borderRadius = '24px';
      wrap.style.boxShadow = '0 18px 46px -18px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06)';
      avatar.style.top = '26px';
      avatar.style.width = '120px';
      avatar.style.height = '120px';
      avatar.style.borderRadius = '50%';
      avatar.style.boxShadow = '0 0 0 4px rgba(255,255,255,.14),0 8px 20px -6px rgba(0,0,0,.4)';
      badge.style.opacity = '0';
      badge.style.transform = 'scale(.4)';
      tail.style.opacity = '0';
      tail.style.transform = 'translateY(8px)';
      close.style.opacity = '1';
      content.style.opacity = '1';
      content.style.transform = 'translateY(0)';
      content.style.pointerEvents = 'auto';
      hit.style.pointerEvents = 'none';
      hit.setAttribute('aria-expanded', 'true');
    } else {
      wrap.style.width = '84px';
      wrap.style.height = '84px';
      wrap.style.borderRadius = '32px 32px 8px 32px';
      wrap.style.boxShadow = '0 10px 26px -8px rgba(20,32,64,.55)';
      avatar.style.top = '0';
      avatar.style.width = '84px';
      avatar.style.height = '84px';
      avatar.style.borderRadius = '32px 32px 8px 32px';
      avatar.style.boxShadow = '0 0 0 3px rgba(255,255,255,.12)';
      badge.style.opacity = '1';
      badge.style.transform = 'none';
      tail.style.opacity = '1';
      tail.style.transform = 'none';
      close.style.opacity = '0';
      content.style.opacity = '0';
      content.style.transform = 'translateY(6px)';
      content.style.pointerEvents = 'none';
      hit.style.pointerEvents = 'auto';
      hit.setAttribute('aria-expanded', 'false');
    }
  }

  function renderTip() {
    var tips = TIPS[state.page] || [];
    var who = el('ssgTipsWho'),
      role = el('ssgTipsRole'),
      ref = el('ssgTipsRef'),
      box = el('ssgTipsBox'),
      dots = el('ssgTipsDots');
    if (!who) return;
    who.textContent = guide.name || '';
    role.textContent = guide.title || '';
    ref.textContent =
      (PAGE_LABEL[state.page] || '') + ' · Tip ' + (state.index + 1) + ' of ' + tips.length;
    box.textContent = tips[state.index] || '';
    dots.innerHTML = tips
      .map(function (_, i) {
        return (
          '<i style="width:5px;height:5px;border-radius:50%;display:block;background:' +
          (i === state.index ? GREEN : 'rgba(255,255,255,.28)') +
          ';"></i>'
        );
      })
      .join('');
    var pager = el('ssgTipsPager');
    if (pager) pager.style.display = tips.length > 1 ? 'flex' : 'none';
  }

  function step(dir) {
    var tips = TIPS[state.page] || [];
    if (!tips.length) return;
    state.index = (state.index + dir + tips.length) % tips.length;
    renderTip();
  }

  /** Called on every page switch — the nav click handler and activateNav()
   *  both funnel through here. Hides the bubble on a page with nothing queued,
   *  and always closes back to the collapsed bubble on a fresh page. */
  function onNavigate(pageId) {
    if (!state.built) return;
    var tips = TIPS[pageId] || [];
    state.page = pageId;
    state.index = 0;
    state.open = false;
    var wrap = el('ssgTipsWidget');
    if (!wrap) return;
    if (!state.enabled || !tips.length) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'block';
    setOpen(false);
    renderTip();
  }

  function setEnabled(enabled) {
    state.enabled = !!enabled;
    if (state.page) onNavigate(state.page);
  }

  async function mount(user) {
    build();
    state.enabled = !!user.tipsEnabled;
    try {
      var r = await H.authed('/tips/guide');
      if (r.ok) {
        var d = await r.json();
        guide = d.profile || guide;
        paintAvatar();
        if (state.page) renderTip();
      }
    } catch (e) {}
    onNavigate('dashboard');
  }

  /* ══════════════════════════ upload: resize + encode ══════════════════════════ */

  /**
   * Shrink a picked photo to something the bubble can use.
   *
   * 480px is generous for the 120px the expanded panel shows it at on a retina
   * screen, and lands well under the 400 KB the API accepts. JPEG rather than
   * PNG — unlike a signature, this is a photograph, and PNG on a photo runs
   * several times larger for no visible gain at this size.
   */
  function avatarDataUri(file, maxWidth) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () {
        reject(new Error('That file could not be read.'));
      };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () {
          reject(new Error('That file is not an image.'));
        };
        img.onload = function () {
          var scale = Math.min(1, (maxWidth || 480) / (img.width || 1));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  /* ══════════════════════════ admin panel ══════════════════════════ */

  /**
   * Administration → People → Tips & Tricks guide.
   *
   * Name, title and photo — nothing here decides which pages have tips or what
   * they say; that is TIPS above, in code, because it is written content that
   * changes with the release, not a brand asset. This is the part somebody
   * should be able to change without waiting on a deploy.
   */
  async function mountAdmin(hostId, user) {
    var host = typeof hostId === 'string' ? el(hostId) : hostId;
    if (!host) return;
    if (!user || user.role !== 'SYSTEM_ADMIN') {
      host.innerHTML =
        '<div class="muted" style="padding:14px 0;font-size:12.5px;">Only a system administrator can change the Tips &amp; Tricks guide.</div>';
      return;
    }
    host.innerHTML = '<div class="muted" style="padding:14px 0;">Loading…</div>';

    var data = null;
    try {
      var r = await H.authed('/tips/guide');
      if (r.ok) data = await r.json();
    } catch (e) {}
    if (!data) {
      host.innerHTML = '<div class="err">Could not load the guide.</div>';
      return;
    }

    var draft = {
      name: data.profile.name,
      title: data.profile.title,
      avatarImage: data.profile.avatarImage,
    };
    // undefined = unchanged; '' = remove; a data URI = set. Tracked apart from
    // draft.avatarImage so a name edit never re-sends a 400 KB photo that has
    // not actually changed.
    var avatarNext;

    var IN =
      'width:100%;padding:9px 11px;border:1px solid #dcded7;border-radius:8px;font-size:13.5px;background:#fff;outline:none;';
    var LABEL =
      'display:block;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;margin-bottom:5px;';
    var BTN_DARK =
      'padding:9px 15px;border:none;border-radius:8px;background:#1e2f5c;color:#fff;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;';
    var BTN_PLAIN =
      'padding:9px 15px;border:1px solid #dcded7;border-radius:8px;background:#fff;color:#3d4a55;font:inherit;font-size:12.5px;cursor:pointer;';

    function preview() {
      var img = avatarNext !== undefined ? avatarNext : draft.avatarImage;
      return img
        ? '<img src="' +
            esc(img) +
            '" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">'
        : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#e8ebef;color:#3d4a55;font-family:' +
            SERIF +
            ';font-weight:600;font-size:22px;">' +
            esc((draft.name || '?').slice(0, 1).toUpperCase()) +
            '</div>';
    }

    function paint() {
      var hasPhoto = (avatarNext !== undefined ? avatarNext : draft.avatarImage) ? true : false;
      host.innerHTML =
        '<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;">' +
        '<div style="flex:none;">' +
        '<div id="tgaPreview" style="width:88px;height:88px;border-radius:50%;overflow:hidden;border:1px solid #dcded7;background:#fff;">' +
        preview() +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:8px;">' +
        '<button type="button" id="tgaPick" style="' +
        BTN_PLAIN +
        'padding:7px 10px;font-size:11.5px;">Choose photo…</button>' +
        (hasPhoto
          ? '<button type="button" id="tgaClear" style="' +
            BTN_PLAIN +
            'padding:7px 10px;font-size:11.5px;color:#9c3327;">Remove</button>'
          : '') +
        '</div>' +
        '<input type="file" id="tgaFile" accept="image/png,image/jpeg" style="display:none;">' +
        '</div>' +
        '<div style="flex:1 1 260px;min-width:220px;display:grid;gap:12px;">' +
        '<label><span style="' +
        LABEL +
        '">Name</span><input id="tgaName" style="' +
        IN +
        '" value="' +
        esc(draft.name) +
        '"></label>' +
        '<label><span style="' +
        LABEL +
        '">Title</span><input id="tgaTitle" style="' +
        IN +
        '" value="' +
        esc(draft.title) +
        '"></label>' +
        '</div>' +
        '</div>' +
        '<div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:16px;">' +
        '<button type="button" id="tgaSave" style="' +
        BTN_DARK +
        '">Save</button>' +
        '<button type="button" id="tgaReset" style="' +
        BTN_PLAIN +
        '">Back to the default</button>' +
        '<span id="tgaNote" class="muted" style="font-size:12.5px;"></span>' +
        '</div>' +
        '<div class="muted" style="font-size:12px;margin-top:9px;max-width:640px;line-height:1.6;">' +
        'Shown on the tips bubble on every page that has one queued. Saving applies to everyone the next time they open the app.' +
        '</div>';
      bind();
    }

    function note(text, bad) {
      var n = el('tgaNote');
      if (!n) return;
      n.textContent = text || '';
      n.style.color = bad ? '#9c3327' : '#8a8f85';
    }

    function bind() {
      el('tgaName').addEventListener('input', function () {
        draft.name = this.value;
      });
      el('tgaTitle').addEventListener('input', function () {
        draft.title = this.value;
      });
      el('tgaPick').addEventListener('click', function () {
        el('tgaFile').click();
      });
      var clear = el('tgaClear');
      if (clear)
        clear.addEventListener('click', function () {
          avatarNext = '';
          paint();
        });
      el('tgaFile').addEventListener('change', async function () {
        var f = this.files && this.files[0];
        if (!f) return;
        if (f.type !== 'image/png' && f.type !== 'image/jpeg') {
          note('Use a PNG or a JPEG.', true);
          this.value = '';
          return;
        }
        try {
          avatarNext = await avatarDataUri(f, 480);
          paint();
        } catch (err) {
          note(err.message || 'Could not read that file.', true);
        }
      });

      el('tgaSave').addEventListener('click', async function () {
        var name = String(el('tgaName').value || '').trim();
        if (!name) return note('Enter a name.', true);
        var body = { name: name, title: String(el('tgaTitle').value || '').trim() };
        if (avatarNext !== undefined) body.avatarImage = avatarNext;
        this.disabled = true;
        note('Saving…');
        var r = await H.authed('/tips/guide', { method: 'PATCH', body: body });
        this.disabled = false;
        if (!r.ok) return note(await errorText(r), true);
        var d = await r.json();
        draft = d.profile;
        avatarNext = undefined;
        guide = d.profile;
        paintAvatar();
        if (state.page) renderTip();
        note('Saved.');
        paint();
      });

      el('tgaReset').addEventListener('click', async function () {
        this.disabled = true;
        var r = await H.authed('/tips/guide/reset', { method: 'POST' });
        this.disabled = false;
        if (!r.ok) return note(await errorText(r), true);
        var d = await r.json();
        draft = d.profile;
        avatarNext = undefined;
        guide = d.profile;
        paintAvatar();
        if (state.page) renderTip();
        note('Back to the default.');
        paint();
      });
    }

    paint();
  }

  /* ══════════════════════════ exports ══════════════════════════ */

  window.SSGTips = {
    init: function (helpers) {
      H = helpers;
    },
    mount: mount,
    onNavigate: onNavigate,
    setEnabled: setEnabled,
    mountAdmin: mountAdmin,
  };
})();
