/*
 * Adventure Series proposal front matter — the cover page and the four
 * introduction pages that print ahead of the itemized proposal.
 *
 * Loaded before app.js and exposed as window.SSGFrontMatter. app.js asks two
 * questions of it:
 *
 *     SSGFrontMatter.applies(doc)              → is this an Adventure proposal?
 *     SSGFrontMatter.adventureIntroHtml(doc,o) → the pages, as one HTML string
 *
 * Kept in its own file on purpose. The front matter is marketing copy that will
 * be edited far more often than the pricing document, and every other product
 * line gets its own cover later — a separate module per series keeps those edits
 * away from the proposal engine.
 *
 * Everything is inline-styled and self-contained: the same markup is printed by
 * the browser, rendered to PDF by headless Chromium and inlined into DocuSeal,
 * and only inline styles survive all three.
 *
 * PHOTOGRAPHY
 * -----------
 * The three photo areas are empty until real images are dropped in. Put the
 * files in /public/proposal/ and name them here (or set window.SSG_FRONT_MATTER_ART
 * before app.js loads). An empty string means the page renders without that
 * photo rather than with a broken image box, so nothing has to change to ship.
 */
(function () {
  'use strict';

  var ART = window.SSG_FRONT_MATTER_ART || {
    /** Wide photo of an installed Adventure Series gym in use. */
    hero: '',
    /** The steel frame — mid-install, or an empty frame showing the structure. */
    frame: '',
    /** Close detail — welded gusset, base plate, padding on an upright. */
    detail: '',
  };

  var NAVY = '#203060';
  var RED = '#d02030';
  var INK = '#20241f';
  var GREY = '#4b5468';
  var RULE = '#dfe3ec';
  var SANS = "'IBM Plex Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
  var SERIF = "'Newsreader',Georgia,serif";

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  /** Aug 17, 2026 — matches the date format on the itemized proposal. */
  function fmtDate(iso) {
    if (!iso) return '';
    var p = String(iso).slice(0, 10).split('-');
    if (p.length !== 3) return String(iso);
    var months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    var mi = Number(p[1]) - 1;
    if (!months[mi]) return String(iso);
    return months[mi] + ' ' + Number(p[2]) + ', ' + p[0];
  }

  /**
   * The model code, read off the itemized frame heading the builder writes
   * ("SQ-2MBL2TZ — Itemized"). Same derivation as the save-as-PDF file name, so
   * an edited heading is respected and a proposal without a frame simply prints
   * no model line.
   */
  function modelCode(doc) {
    var model = '';
    (doc.lines || []).forEach(function (l) {
      if ((l.lineType || '') !== 'GROUP' || model) return;
      if (/itemized/i.test(l.name || '')) {
        model = String(l.name)
          .replace(/\s*[-\u2013\u2014]\s*itemized.*$/i, '')
          .trim();
      }
    });
    return model;
  }

  /**
   * True when the document is an Adventure Series proposal. The Adventure
   * configurator writes its answers into meta, which is the reliable signal;
   * a hand-built proposal is recognised by its frame heading instead.
   */
  function applies(doc) {
    if (!doc) return false;
    if (doc.meta && doc.meta.advAnswers) return true;
    return (doc.lines || []).some(function (l) {
      return /adventure/i.test(String(l.name || '') + ' ' + String(l.group || ''));
    });
  }

  /** One printed sheet. Screen shows a page; print puts it on its own sheet. */
  function page(inner, bg) {
    return (
      '<div class="ssg-fm-page" style="width:816px;max-width:100%;margin:0 auto 18px;background:' +
      (bg || '#fff') +
      ';box-shadow:0 2px 24px rgba(32,48,96,.13);box-sizing:border-box;' +
      'display:flex;flex-direction:column;overflow:hidden;color:' +
      INK +
      ';font-family:' +
      SANS +
      ';' +
      'min-height:1056px;">' +
      inner +
      '</div>'
    );
  }

  function photo(src, height, alt) {
    if (!src) return '';
    return (
      '<div style="height:' +
      height +
      'px;overflow:hidden;border-radius:12px;">' +
      '<img src="' +
      esc(src) +
      '" alt="' +
      esc(alt || '') +
      '" style="width:100%;height:100%;object-fit:cover;display:block;">' +
      '</div>'
    );
  }

  function footer(line) {
    return (
      '<div style="font-size:10.5px;color:#9aa1b0;padding-top:14px;margin-top:14px;border-top:1px solid #eceef4;">' +
      (line || 'Summit Sensory Gym · SummitSensory.com') +
      '</div>'
    );
  }

  function eyebrow(text) {
    return (
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.16em;color:' +
      RED +
      ';font-weight:700;">' +
      esc(text) +
      '</div>'
    );
  }

  function heading(text, maxWidth) {
    return (
      '<div style="font-family:' +
      SERIF +
      ';font-size:31px;font-weight:700;color:' +
      NAVY +
      ';letter-spacing:-.022em;line-height:1.25;margin-top:10px;' +
      (maxWidth ? 'max-width:' + maxWidth + 'px;' : '') +
      '">' +
      esc(text) +
      '</div>'
    );
  }

  /* ---------------------------------------------------------------- 1 · cover */

  function coverPage(doc, opts) {
    var m = doc.meta || {};
    var u = (opts && opts.user) || {};
    var rev = (Number(doc.version) || 1) > 1 ? ' · Revision ' + (Number(doc.version) - 1) : '';
    var dates = [];
    if (m.proposalDate) dates.push('Issued ' + fmtDate(m.proposalDate));
    if (m.expiration) dates.push('valid through ' + fmtDate(m.expiration));
    var repLine = [u.phone, u.email].filter(Boolean).join(' · ');
    var model = modelCode(doc);

    return page(
      '<div style="height:14px;background:' +
        NAVY +
        ';flex:none;"></div>' +
        '<div style="flex:1;padding:60px 58px 46px;box-sizing:border-box;display:flex;flex-direction:column;">' +
        '<div style="display:flex;gap:20px;align-items:center;">' +
        '<img src="logo.png" alt="Summit Sensory Gym" width="112" height="112" style="width:112px;height:112px;display:block;flex:none;">' +
        '<div style="font-family:' +
        SERIF +
        ';font-size:37px;font-weight:700;color:' +
        NAVY +
        ';letter-spacing:-.02em;line-height:1.1;">Summit Sensory Gym</div>' +
        '</div>' +
        '<div style="flex:1;"></div>' +
        '<div style="width:54px;height:3px;background:' +
        RED +
        ';"></div>' +
        '<div style="font-family:' +
        SERIF +
        ';font-size:40px;font-weight:700;color:' +
        NAVY +
        ';letter-spacing:-.025em;line-height:1.22;margin-top:20px;max-width:620px;">Engineered for Movement. Designed for Limitless Possibilities.</div>' +
        '<div style="font-size:15px;color:' +
        GREY +
        ';line-height:1.65;margin-top:16px;max-width:560px;">Every Summit structure is free-standing and carries an Engineer of Record — designed and load-analyzed by a licensed professional engineer, and sealed against recognized structural design standards.</div>' +
        '<div style="height:32px;"></div>' +
        (model
          ? '<div style="font-family:' +
            SERIF +
            ';font-size:29px;font-weight:600;color:' +
            INK +
            ';letter-spacing:.02em;">' +
            esc(model) +
            '</div>'
          : '') +
        '<div style="font-size:17px;color:' +
        GREY +
        ';margin-top:4px;">' +
        esc(doc.orgName || '') +
        '</div>' +
        '<div style="flex:1;"></div>' +
        '<div style="display:flex;justify-content:space-between;gap:24px;font-size:11.5px;color:#7b8190;line-height:1.7;padding-top:20px;border-top:1px solid ' +
        RULE +
        ';">' +
        '<div><span style="color:' +
        INK +
        ';font-weight:600;">' +
        esc(doc.number || '') +
        rev +
        '</span>' +
        (dates.length ? '<br>' + esc(dates.join(' · ')) : '') +
        '</div>' +
        '<div style="text-align:right;"><span style="color:' +
        INK +
        ';font-weight:600;">' +
        esc([u.name || u.email || '', u.title].filter(Boolean).join(', ')) +
        '</span>' +
        (repLine ? '<br>' + esc(repLine) : '') +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div style="height:14px;background:' +
        NAVY +
        ';flex:none;"></div>',
    );
  }

  /* ---------------------------------------------------------- 2 · positioning */

  function positioningPage() {
    var hero = ART.hero
      ? '<div style="height:410px;flex:none;overflow:hidden;"><img src="' +
        esc(ART.hero) +
        '" alt="Adventure Series gym in use" style="width:100%;height:100%;object-fit:cover;display:block;"></div>'
      : // No photo on file yet: a navy band carries the page instead of a hole.
        '<div style="height:210px;flex:none;background:' +
        NAVY +
        ';display:flex;align-items:flex-end;padding:0 58px 30px;box-sizing:border-box;">' +
        '<div style="font-family:' +
        SERIF +
        ';font-size:26px;font-weight:600;color:#fff;letter-spacing:-.01em;">Adventure Series</div></div>';

    function stat(figure, text, style) {
      return (
        '<div style="flex:1;' +
        style +
        '">' +
        '<div style="font-family:' +
        SERIF +
        ';font-size:25px;font-weight:700;color:' +
        NAVY +
        ';">' +
        figure +
        '</div>' +
        '<div style="font-size:12px;color:' +
        GREY +
        ';line-height:1.55;margin-top:3px;">' +
        text +
        '</div></div>'
      );
    }

    return page(
      hero +
        '<div style="flex:1;padding:44px 58px 40px;box-sizing:border-box;display:flex;flex-direction:column;">' +
        eyebrow('Why Summit') +
        heading(
          'We design and manufacture the most versatile sensory therapy gyms in the world.',
          640,
        ) +
        '<div style="font-size:13.5px;color:' +
        INK +
        ';line-height:1.75;margin-top:14px;max-width:660px;text-wrap:pretty;">Every Adventure Series structure is commercial-grade and free-standing, built to give people of all ages and abilities a safe place to develop sensory processing skills. One frame carries linear and rotational swings, climbing elements and platforms across more than thirty-five connection points, so a single installation supports an entire caseload rather than a single protocol.</div>' +
        '<div style="display:flex;margin-top:26px;border-top:1px solid ' +
        RULE +
        ';">' +
        stat(
          '35+',
          'connection points for linear and rotational swings at single or double attachment',
          'padding:16px 20px 0 0;',
        ) +
        stat(
          '1,500 lb',
          'rated capacity on powder-coated, non-corrosive steel',
          'padding:16px 20px;border-left:1px solid ' + RULE + ';',
        ) +
        stat(
          'Zero',
          'ceiling or wall connections required — nothing is transferred to your building',
          'padding:16px 0 0 20px;border-left:1px solid ' + RULE + ';',
        ) +
        '</div>' +
        '<div style="flex:1;"></div>' +
        footer() +
        '</div>',
    );
  }

  /* ----------------------------------------------------- 3 · engineering case */

  function engineeringPage() {
    function column(title, paras) {
      return (
        '<div style="flex:1;">' +
        '<div style="width:40px;height:3px;background:' +
        NAVY +
        ';"></div>' +
        '<div style="font-family:' +
        SERIF +
        ';font-size:20px;font-weight:700;color:' +
        NAVY +
        ';line-height:1.3;margin-top:14px;">' +
        title +
        '</div>' +
        paras
          .map(function (p, i) {
            return (
              '<div style="font-size:12.5px;color:' +
              INK +
              ';line-height:1.75;margin-top:' +
              (i ? 10 : 9) +
              'px;text-wrap:pretty;">' +
              p +
              '</div>'
            );
          })
          .join('') +
        '</div>'
      );
    }

    return page(
      '<div style="flex:1;padding:52px 58px 42px;box-sizing:border-box;display:flex;flex-direction:column;">' +
        eyebrow('What architects and engineers specify') +
        heading('Steel, and standing on its own.', 640) +
        '<div style="font-size:13.5px;color:' +
        GREY +
        ';line-height:1.7;margin-top:12px;max-width:660px;text-wrap:pretty;">Two decisions determine whether a therapy gym is an asset or a liability. Both are settled questions among the people who sign off on buildings.</div>' +
        '<div style="display:flex;gap:34px;margin-top:30px;">' +
        column('Built from high-quality steel', [
          "Steel's strength-to-weight ratio is what makes a large, open therapy space possible without columns interrupting the floor. That matters more over time than it does on day one: rooms get reconfigured, caseloads change, and a frame that carries its own loads can be moved and re-equipped rather than rebuilt.",
          'It also lasts. Steel resists pests, mold and rot, holds up under conditions that degrade other materials, and keeps maintenance cost close to nothing across the life of the investment.',
        ]) +
        column('Free-standing, never anchored to your building', [
          'Non-load-bearing walls divide space; they are not designed to carry loads. Ceiling mounts are only as sound as their integration with the building\u2019s primary structure. Hanging therapy equipment from either one puts dynamic loads into elements that were never engineered to receive them.',
          'A free-standing frame carries a complete load path of its own — its own weight, the equipment, and the people using it. Nothing is transferred to your walls or roof, and nothing about your facility has to be modified to accept it.',
        ]) +
        '</div>' +
        '<div style="flex:1;"></div>' +
        photo(ART.frame, 250, 'Adventure Series steel frame') +
        footer() +
        '</div>',
      '#fbfaf6',
    );
  }

  /* --------------------------------------------------- 4 · engineer of record */

  function engineerOfRecordPage() {
    function card(label, text) {
      return (
        '<div style="flex:1;background:#f3f6fb;border-radius:11px;padding:18px 20px;">' +
        '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:' +
        NAVY +
        ';font-weight:700;">' +
        label +
        '</div>' +
        '<div style="font-size:12.5px;color:' +
        INK +
        ';line-height:1.65;margin-top:6px;">' +
        text +
        '</div></div>'
      );
    }

    return page(
      '<div style="flex:1;padding:56px 58px 42px;box-sizing:border-box;display:flex;flex-direction:column;">' +
        eyebrow('The difference that survives review') +
        heading('Every Adventure Series frame carries an Engineer of Record.', 620) +
        '<div style="font-size:13.5px;color:' +
        INK +
        ';line-height:1.75;margin-top:14px;max-width:660px;text-wrap:pretty;">It is the only free-standing therapeutic swing frame on the market that does. The structure is designed and load-analyzed by a licensed professional engineer, sealed against recognized structural design standards, and fabricated to that stamped drawing set — so it can be reviewed, submitted and approved like any other engineered building component.</div>' +
        '<div style="display:flex;gap:16px;margin-top:26px;">' +
        card(
          'For your facilities team',
          "A sealed drawing set to review, rather than a manufacturer's assurance to take on faith.",
        ) +
        card(
          'For permitting',
          'Documentation in the form plan review already expects, which is what keeps a project on schedule.',
        ) +
        card(
          'For your risk carrier',
          'A structure whose loads were calculated and signed by a professional engineer, on record.',
        ) +
        '</div>' +
        '<div style="margin-top:26px;padding:20px 22px;border-left:3px solid ' +
        RED +
        ';background:#fbfaf6;border-radius:0 11px 11px 0;">' +
        '<div style="font-family:' +
        SERIF +
        ';font-size:17px;font-weight:700;color:' +
        NAVY +
        ';line-height:1.4;">Ask any other supplier for the seal.</div>' +
        '<div style="font-size:12.5px;color:' +
        INK +
        ';line-height:1.7;margin-top:6px;text-wrap:pretty;">A capacity rating printed in a catalogue is a claim. A stamped drawing set is a licensed engineer putting their name to it. The stamped set for your configuration is available on request, and we will send it directly to your architect, facilities director or plan reviewer.</div>' +
        '</div>' +
        '<div style="flex:1;"></div>' +
        photo(ART.detail, 230, 'Adventure Series structural detail') +
        footer() +
        '</div>',
    );
  }

  /* ------------------------------------------------------ 5 · what happens next */

  function nextStepsPage(doc, opts) {
    var u = (opts && opts.user) || {};
    var pct = (opts && opts.depositPct) || 50;
    var contact = [u.name || u.email || '', u.phone, u.email].filter(Boolean).join(' · ');

    var steps = [
      [
        'Acceptance',
        'Sign and return the proposal. A ' +
          pct +
          '% deposit releases the order into production; the balance is due prior to shipment.',
      ],
      [
        'Drawings and submittals',
        'We issue the sealed drawing set for your configuration and work directly with your architect or facilities team through review.',
      ],
      [
        'Fabrication',
        'Your frame is cut, welded and powder-coated to the stamped drawings. Mats, padding and accessories are produced alongside it.',
      ],
      [
        'Crating and delivery',
        'Crating and freight are calculated at time of shipment on actual cost. We confirm delivery access and scheduling with your site contact before the truck is booked.',
      ],
      [
        'Installation and handover',
        'The frame is assembled on site. Nothing anchors to your walls or ceiling, so there is no building work to coordinate and the room is usable the same day.',
      ],
    ];

    var rows = steps
      .map(function (s, i) {
        var last = i === steps.length - 1;
        return (
          '<div style="display:flex;gap:18px;align-items:flex-start;padding:16px 0;border-top:1px solid ' +
          RULE +
          ';' +
          (last ? 'border-bottom:1px solid ' + RULE + ';' : '') +
          '">' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:18px;font-weight:700;color:' +
          RED +
          ';width:28px;flex:none;">0' +
          (i + 1) +
          '</div>' +
          '<div style="flex:1;">' +
          '<div style="font-size:14px;font-weight:600;color:' +
          NAVY +
          ';">' +
          s[0] +
          '</div>' +
          '<div style="font-size:12.5px;color:' +
          INK +
          ';line-height:1.7;margin-top:3px;">' +
          s[1] +
          '</div>' +
          '</div></div>'
        );
      })
      .join('');

    return page(
      '<div style="flex:1;padding:56px 58px 40px;box-sizing:border-box;display:flex;flex-direction:column;">' +
        eyebrow('What happens next') +
        heading('From signature to first session.') +
        '<div style="margin-top:26px;">' +
        rows +
        '</div>' +
        '<div style="flex:1;"></div>' +
        '<div style="display:flex;gap:18px;align-items:center;padding:20px 22px;background:#f3f6fb;border-radius:12px;">' +
        '<img src="logo.png" alt="Summit Sensory Gym" width="64" height="64" style="width:64px;height:64px;display:block;flex:none;">' +
        '<div style="flex:1;">' +
        '<div style="font-family:' +
        SERIF +
        ';font-size:18px;font-weight:700;color:' +
        NAVY +
        ';">Questions before you sign?</div>' +
        '<div style="font-size:12.5px;color:' +
        INK +
        ';line-height:1.6;margin-top:2px;">' +
        esc(contact) +
        '</div>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div style="height:14px;background:' +
        NAVY +
        ';flex:none;"></div>',
    );
  }

  /**
   * The five pages, in order. `opts.user` is the preparer (name, title, phone,
   * email) and `opts.depositPct` the deposit percentage in force, both passed in
   * by app.js so this module never reaches into builder state.
   */
  function adventureIntroHtml(doc, opts) {
    doc = doc || {};
    opts = opts || {};
    return (
      '<div class="ssg-front-matter">' +
      coverPage(doc, opts) +
      positioningPage() +
      engineeringPage() +
      engineerOfRecordPage() +
      nextStepsPage(doc, opts) +
      '</div>'
    );
  }

  window.SSGFrontMatter = {
    applies: applies,
    adventureIntroHtml: adventureIntroHtml,
    modelCode: modelCode,
    art: ART,
  };
})();
