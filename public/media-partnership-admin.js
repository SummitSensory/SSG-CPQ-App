/**
 * The Media Partnership Program editor: Administration -> Proposal content.
 *
 * One settings row (not a list of documents, unlike legal-admin.js) — active/inactive,
 * the two program names, the rebate dollar amount, the long-form program text a
 * proposal that offers the program prints, and a Layout panel. Saving here changes
 * what a NEW proposal offers; a proposal already released keeps the terms frozen onto
 * it at release (see src/mediaRebate/service.ts) and a signed proposal is never
 * affected at all.
 *
 * The Layout panel is deliberately the same control set as legal-admin.js's — same
 * FONT_OPTIONS/SIZE_OPTIONS/LH_OPTIONS/ALIGN_OPTIONS/TITLE_OPTIONS, same field()/sel()
 * layout, same `style` shape (`MediaProgramStyle` in src/mediaRebate/defaults.ts,
 * validated by the identical `Style` schema in src/routes/mediaPartnershipProgram.ts
 * that src/routes/legalDocuments.ts uses) — so this program's printed page gets the
 * same typesetting choices, and the same guarantees, as the release and terms.
 *
 * Registers on window.SSGMediaPartnershipAdmin. Needs authed and esc from the shell,
 * same contract as SSGLegalAdmin.
 */
(function () {
  'use strict';

  var H = null;
  var STATE = null;

  function esc(s) {
    if (!H || !H.esc) throw new Error('media-partnership-admin: H.esc is required');
    return H.esc(s);
  }

  var IN =
    'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d8dcd2;border-radius:6px;' +
    'font-family:inherit;font-size:13px;color:#20241f;background:#fff;';
  var TA = IN + 'line-height:1.55;resize:vertical;';
  var PRIMARY =
    'border:1px solid #203060;background:#203060;color:#fff;border-radius:6px;padding:7px 15px;' +
    'font-family:inherit;font-size:12.5px;cursor:pointer;font-weight:600;white-space:nowrap;';
  var LABEL =
    'display:block;font-size:11.5px;font-weight:600;color:#3d4a55;text-transform:uppercase;' +
    'letter-spacing:.04em;margin:14px 0 5px;';

  function say(host, text, bad) {
    var el = host.querySelector('#mpMsg');
    if (el)
      el.innerHTML =
        '<span style="color:' + (bad ? '#a4262c' : '#3f6212') + ';">' + esc(text) + '</span>';
  }

  function field(id, labelText, value, rows) {
    return (
      '<label style="' +
      LABEL +
      '" for="' +
      id +
      '">' +
      esc(labelText) +
      '</label>' +
      '<textarea id="' +
      id +
      '" rows="' +
      (rows || 4) +
      '" style="' +
      TA +
      '">' +
      esc(value || '') +
      '</textarea>'
    );
  }

  /** A labelled select. Curated options only — same reasoning as legal-admin.js's:
   *  this is a closed set of layout choices, not free-form CSS. */
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

  function labelledField(labelText, control, hint) {
    return (
      '<div style="flex:1;min-width:150px;">' +
      '<label style="display:block;font-size:12px;color:#5c6157;margin-bottom:4px;">' +
      esc(labelText) +
      '</label>' +
      control +
      (hint
        ? '<div class="muted" style="font-size:11px;margin-top:3px;">' + esc(hint) + '</div>'
        : '') +
      '</div>'
    );
  }

  // Identical to legal-admin.js's FONT_OPTIONS/SIZE_OPTIONS/LH_OPTIONS/ALIGN_OPTIONS/
  // TITLE_OPTIONS — this program's page and the release/terms are laid out by the same
  // renderer conventions (public/proposal-document.js and public/contract-pages.js),
  // so the same curated choices apply for the same reasons.
  var FONT_OPTIONS = [
    ['plex', 'IBM Plex Sans (default) — matches the rest of the software'],
    ['georgia', 'Georgia — serif'],
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
   * Layout: typeface, body size, line spacing, paragraph alignment, heading size.
   * Same panel as legal-admin.js's layoutPanel(), applied to this program's page
   * instead of the release/terms.
   */
  function layoutPanel(st) {
    st = st || {};
    return (
      '<div style="border:1px solid #e6e9e1;border-radius:8px;padding:13px;margin-top:16px;background:#fcfdfb;">' +
      '<div style="font-weight:600;font-size:13px;margin-bottom:10px;">Layout</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
      labelledField('Typeface', sel('mpStFont', FONT_OPTIONS, st.font || 'plex')) +
      labelledField('Body size', sel('mpStSize', SIZE_OPTIONS, st.sizePt || 9)) +
      labelledField('Line spacing', sel('mpStLh', LH_OPTIONS, st.lineHeight || 1.35)) +
      '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">' +
      labelledField('Paragraphs', sel('mpStAlign', ALIGN_OPTIONS, st.align || 'justify')) +
      labelledField('Heading size', sel('mpStTitle', TITLE_OPTIONS, st.titlePt || 15)) +
      '<div style="flex:1;min-width:150px;"></div>' +
      '</div>' +
      '</div>'
    );
  }

  function numField(id, labelText, value, hint) {
    return (
      '<label style="' +
      LABEL +
      '" for="' +
      id +
      '">' +
      esc(labelText) +
      (hint
        ? ' <span style="text-transform:none;font-weight:400;color:#8a9099;">(' +
          esc(hint) +
          ')</span>'
        : '') +
      '</label>' +
      '<input id="' +
      id +
      '" type="number" min="1" style="' +
      IN +
      '" value="' +
      esc(String(value)) +
      '"/>'
    );
  }

  function draw(host) {
    if (!host || !STATE) return;
    var s = STATE;
    var t = s.content.timeframes;
    var dollars = (s.rebateAmountMinor / 100).toFixed(2);

    host.innerHTML =
      '<div class="muted" style="font-size:12px;line-height:1.6;margin-bottom:8px;">' +
      'Offers a post-installation media rebate on a proposal where a rep turns it on. It never ' +
      'changes the Project Price or any amount due before shipment. Off by default.' +
      '</div>' +
      '<div class="muted" style="font-size:11.5px;line-height:1.6;margin-bottom:8px;">' +
      'The merge field <b>{{customer}}</b> works in every text box below and is replaced with ' +
      'the proposal’s customer name when printed — the same token the release and terms use.' +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:10px 0 4px;">' +
      '<input id="mpActive" type="checkbox" ' +
      (s.active ? 'checked' : '') +
      '/> Program is Active (reps may offer it on new proposals)' +
      '</label>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px;">' +
      '<div>' +
      '<label style="' +
      LABEL +
      '" for="mpCustomerName">Customer-facing program name</label>' +
      '<input id="mpCustomerName" style="' +
      IN +
      '" value="' +
      esc(s.customerFacingName) +
      '"/>' +
      '</div>' +
      '<div>' +
      '<label style="' +
      LABEL +
      '" for="mpInternalName">Internal program name</label>' +
      '<input id="mpInternalName" style="' +
      IN +
      '" value="' +
      esc(s.internalName) +
      '"/>' +
      '</div>' +
      '</div>' +
      '<label style="' +
      LABEL +
      '" for="mpAmount">Rebate amount (USD)</label>' +
      '<input id="mpAmount" type="number" min="0" step="0.01" style="' +
      IN +
      ';max-width:160px;" value="' +
      esc(dollars) +
      '"/>' +
      field('mpIntro', 'Introductory description', s.content.introduction, 5) +
      field('mpRequirements', 'Media requirements', s.content.mediaRequirements, 8) +
      field('mpAcceptance', 'Media acceptance standards', s.content.acceptanceStandards, 6) +
      field('mpUsage', 'Media usage rights', s.content.usageRights, 5) +
      field('mpPrivacy', 'Privacy / identifiable individuals', s.content.privacyRestrictions, 4) +
      field('mpPayment', 'Rebate payment terms', s.content.paymentTerms, 8) +
      field(
        'mpParticipation',
        'Customer participation language',
        s.content.participationLanguage,
        2,
      ) +
      field(
        'mpSignature',
        'Signature acknowledgment language',
        s.content.signatureAcknowledgment,
        2,
      ) +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px;">' +
      numField(
        'mpSubmissionDays',
        'Customer submission period',
        t.submissionDays,
        'calendar days',
      ) +
      numField('mpReviewDays', 'Summit review period', t.reviewBusinessDays, 'business days') +
      numField(
        'mpCorrectionDays',
        'Customer correction period',
        t.correctionDays,
        'calendar days',
      ) +
      numField('mpPaymentDays', 'Rebate payment period', t.paymentDays, 'calendar days') +
      '</div>' +
      layoutPanel(s.content.style) +
      '<div style="margin-top:16px;display:flex;align-items:center;gap:12px;">' +
      '<button data-mpsave style="' +
      PRIMARY +
      '">Save</button>' +
      '<span id="mpMsg" style="font-size:12.5px;"></span>' +
      '</div>';

    host.querySelector('[data-mpsave]').addEventListener('click', function () {
      save(host);
    });
  }

  function collect(host) {
    var val = function (id) {
      return (host.querySelector('#' + id) || {}).value || '';
    };
    var num = function (id, fallback) {
      var n = parseInt(val(id), 10);
      return isFinite(n) && n > 0 ? n : fallback;
    };
    var floatVal = function (id, fallback) {
      var n = parseFloat(val(id));
      return isFinite(n) ? n : fallback;
    };
    var dollars = parseFloat(val('mpAmount'));
    var rebateAmountMinor = isFinite(dollars) ? Math.round(dollars * 100) : STATE.rebateAmountMinor;
    var st = STATE.content.style || {};

    return {
      active: !!(host.querySelector('#mpActive') || {}).checked,
      customerFacingName: val('mpCustomerName').trim() || STATE.customerFacingName,
      internalName: val('mpInternalName').trim() || STATE.internalName,
      rebateAmountMinor: rebateAmountMinor,
      content: {
        introduction: val('mpIntro'),
        mediaRequirements: val('mpRequirements'),
        acceptanceStandards: val('mpAcceptance'),
        usageRights: val('mpUsage'),
        privacyRestrictions: val('mpPrivacy'),
        paymentTerms: val('mpPayment'),
        participationLanguage: val('mpParticipation'),
        signatureAcknowledgment: val('mpSignature'),
        timeframes: {
          submissionDays: num('mpSubmissionDays', STATE.content.timeframes.submissionDays),
          reviewBusinessDays: num('mpReviewDays', STATE.content.timeframes.reviewBusinessDays),
          correctionDays: num('mpCorrectionDays', STATE.content.timeframes.correctionDays),
          paymentDays: num('mpPaymentDays', STATE.content.timeframes.paymentDays),
        },
        style: {
          font: val('mpStFont').trim() || st.font || 'plex',
          sizePt: num('mpStSize', st.sizePt || 9),
          lineHeight: floatVal('mpStLh', st.lineHeight || 1.35),
          align: val('mpStAlign').trim() || st.align || 'justify',
          titlePt: num('mpStTitle', st.titlePt || 15),
        },
      },
    };
  }

  async function save(host) {
    var body = collect(host);
    var r = await H.authed('/media-partnership-program', { method: 'PUT', body: body });
    if (!r.ok) {
      var msg = '';
      try {
        msg = ((await r.json()) || {}).message || '';
      } catch (e) {}
      say(host, msg || 'Could not save (' + r.status + ').', true);
      return;
    }
    STATE = await r.json();
    draw(host);
    say(host, 'Saved. New proposals will offer this version of the program.');
    // The proposal builder and document renderer cache the live program
    // (public/media-rebate-program.js) rather than re-fetching it on every render.
    // Force it to refresh so a proposal open in this same session sees the change
    // immediately instead of the pre-save answer until the next sign-in.
    if (window.SSGMediaRebateProgram && window.SSGMediaRebateProgram.load) {
      window.SSGMediaRebateProgram.load(true);
    }
  }

  window.SSGMediaPartnershipAdmin = {
    init: function (helpers) {
      H = helpers;
    },
    /** Called by the Administration screen with its container element. */
    render: async function (host) {
      if (!H || !H.authed || !host) return;
      host.innerHTML = '<div class="muted" style="font-size:12px;">Loading&hellip;</div>';
      try {
        var r = await H.authed('/media-partnership-program');
        STATE = r && r.ok ? await r.json() : null;
        if (!STATE) throw new Error('no data');
        draw(host);
      } catch (e) {
        host.innerHTML =
          '<div class="muted" style="font-size:12px;">The Media Partnership Program could not be loaded.</div>';
      }
    },
  };
})();
