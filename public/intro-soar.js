/*
 * Summit Soar — the introduction pages that print ahead of the itemized proposal.
 *
 * Registers itself with proposal-front-matter.js, which owns the merge fields, the
 * photo handling and the builder panel. Load this file after that one.
 *
 * The pages follow the Adventure Series vocabulary exactly — navy #203060, a red
 * #d02030 rule opening each page, Newsreader for display type, and a 10px navy foot
 * on every sheet — but no two pages share a layout, so the document does not read the
 * same way twice.
 *
 * Language is deliberately audience-neutral. A Soar proposal goes to private clinics,
 * school districts, hospitals, universities, community programs and families, so the
 * copy says "your team" and "the people you serve" rather than naming one profession.
 *
 * Twelve photo slots. Product claims and specifications on these pages come from the
 * Summit Soar product page; nothing is stated here that is not stated there.
 */
(function () {
  'use strict';
  if (!window.SSGFrontMatter) return;

  var H = window.SSGFrontMatter;

  var PAGE =
    'width:816px;height:1056px;flex:none;background:#fff;border-bottom:10px solid #203060;' +
    'box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;color:#20241f;';
  var SERIF = "'Newsreader',Georgia,serif";

  /** A red rule — the mark that opens a page or a section. */
  function rule(w, t) {
    return (
      '<div style="width:' + (w || 54) + 'px;height:' + (t || 3) + 'px;background:#d02030;"></div>'
    );
  }

  /** The line that closes a page that is not the cover. */
  function foot(border) {
    return (
      '<div style="font-size:10.5px;color:#9aa1b0;letter-spacing:.04em;padding-top:14px;' +
      'border-top:1px solid ' +
      (border || '#eceef4') +
      ';">Summit Sensory Gym &middot; SummitSensory.com</div>'
    );
  }

  /** A dotted list item, matching the Adventure pages. */
  function bullet(text, size) {
    var s = size || 11.5;
    return (
      '<div style="font-size:' +
      s +
      'px;color:#20241f;line-height:1.5;padding:3px 0 3px 13px;position:relative;">' +
      '<span style="position:absolute;left:0;top:' +
      (s > 12 ? 11 : 10) +
      'px;width:4px;height:4px;border-radius:50%;background:#d02030;"></span>' +
      text +
      '</div>'
    );
  }

  /**
   * One numbered reason: rule, number and label on one line, the claim set in the
   * serif, then the supporting prose. Used on both halves of the six-reason spread.
   */
  function reason(r) {
    return (
      '<div style="padding:11px 0 0;border-top:1px solid #dfe3ec;margin-top:11px;">' +
      '<div style="display:flex;gap:9px;align-items:baseline;">' +
      '<div style="font-family:' +
      SERIF +
      ';font-size:13.5px;font-weight:700;color:#d02030;flex:none;">' +
      r[0] +
      '</div>' +
      '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.14em;font-weight:700;color:#203060;line-height:1.45;">' +
      r[1] +
      '</div>' +
      '</div>' +
      '<div style="font-family:' +
      SERIF +
      ';font-size:13.5px;font-weight:600;color:#20241f;line-height:1.38;margin-top:6px;text-wrap:pretty;">' +
      r[2] +
      '</div>' +
      '<div style="font-size:10.5px;color:#20241f;line-height:1.58;margin-top:6px;text-wrap:pretty;">' +
      r[3] +
      '</div>' +
      '</div>'
    );
  }

  /** A photo area with a caption beneath it. */
  function plate(h, art, id, height, caption, radius) {
    // height 'fill' makes the plate stretch to its container — used where the photograph
    // should take whatever vertical space the rest of the page has not claimed.
    var fill = height === 'fill';
    return (
      '<div' +
      (fill ? ' style="flex:1;min-height:0;display:flex;flex-direction:column;"' : '') +
      '>' +
      '<div style="position:relative;' +
      (fill ? 'flex:1;min-height:0;' : 'height:' + height + 'px;') +
      'border-radius:' +
      (radius == null ? 6 : radius) +
      'px;overflow:hidden;background:#eceef4;">' +
      h.img(art, id) +
      '</div>' +
      (caption
        ? '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#7b8190;font-weight:700;margin-top:8px;line-height:1.5;">' +
          caption +
          '</div>'
        : '') +
      '</div>'
    );
  }

  H.register({
    id: 'SOAR',
    label: 'Summit Soar',

    /**
     * Recognise the product from the structure section — the first group on the
     * proposal — rather than from any line anywhere. A Soar proposal routinely carries
     * an Adventure mat system, and matching on any mention of a series name would let
     * whichever template loaded first claim the document.
     */
    matches: function (doc) {
      if (doc.meta && doc.meta.soarAnswers) return true;
      var first = (doc.lines || []).filter(function (l) {
        return (l.lineType || '') === 'GROUP';
      })[0];
      return !!first && /soar/i.test(String(first.name || ''));
    },

    slots: [
      {
        id: 'soar-p3-banner',
        label: 'Page 3 banner \u2014 the whole frame in the room (1632 \u00d7 980)',
        house: '/proposal/soar-p3-banner.jpg',
      },
      {
        id: 'soar-p4-mobility',
        label: 'Page 4 \u2014 caster and levelling pad detail (1160 \u00d7 800)',
        house: '/proposal/soar-p4-mobility.jpg',
      },
    ],

    pages: [
      // 1 · cover — the Adventure Series cover layout, Soar copy
      function (v, art, h) {
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          '<div style="height:14px;background:#203060;"></div>' +
          '<div style="flex:1;padding:60px 58px 46px;box-sizing:border-box;display:flex;flex-direction:column;">' +
          '<div style="display:flex;gap:20px;align-items:center;">' +
          '<img src="logo.png" alt="Summit Sensory Gym" style="width:112px;height:112px;display:block;flex:none;">' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:37px;font-weight:700;color:#203060;letter-spacing:-.02em;line-height:1.1;">Summit Sensory Gym</div>' +
          '</div>' +
          '<div style="flex:1;"></div>' +
          rule() +
          '<div style="font-family:' +
          SERIF +
          ';font-size:43px;font-weight:700;color:#203060;letter-spacing:-.028em;line-height:1.16;margin-top:20px;max-width:600px;">Freedom to Move.&nbsp;<span style="color:#d02030;">Engineered to Perform.</span></div>' +
          '<div style="font-size:14.5px;color:#4b5468;line-height:1.68;margin-top:16px;max-width:596px;text-wrap:pretty;">Summit Soar is a versatile, free-standing therapeutic platform designed to bring movement, suspension, and sensory experiences into virtually any environment &mdash; without the need for a permanently dedicated sensory gym.</div>' +
          '<div style="height:28px;"></div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:29px;font-weight:600;color:#20241f;letter-spacing:.02em;">' +
          v.model +
          '</div>' +
          '<div style="font-size:17px;color:#4b5468;margin-top:4px;">' +
          v.org +
          '</div>' +
          '<div style="flex:1;"></div>' +
          '<div style="display:flex;justify-content:space-between;font-size:11.5px;color:#7b8190;line-height:1.7;padding-top:20px;border-top:1px solid #dfe3ec;">' +
          '<div><span style="color:#20241f;font-weight:600;">' +
          v.numberRev +
          '</span><br>' +
          v.issuedLine +
          '</div>' +
          '<div style="text-align:right;"><span style="color:#20241f;font-weight:600;">' +
          v.repName +
          '</span><br>' +
          v.repContact +
          '</div>' +
          '</div>' +
          '</div>' +
          '<div style="height:14px;background:#203060;"></div>' +
          '</div>'
        );
      },

      // 2 · executive letter — no photography, by design
      function (v, art, h) {
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          '<div style="flex:1;padding:46px 70px 30px;box-sizing:border-box;display:flex;flex-direction:column;">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:18px;border-bottom:1px solid #dfe3ec;">' +
          '<div style="display:flex;gap:14px;align-items:center;">' +
          '<img src="logo.png" alt="Summit Sensory Gym" style="width:58px;height:58px;display:block;flex:none;">' +
          '<div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:19px;font-weight:700;color:#203060;letter-spacing:-.01em;">Summit Sensory Gym</div>' +
          '<div style="font-size:10.5px;color:#7b8190;line-height:1.5;margin-top:2px;">6150 S Geneva Ct, Englewood, CO 80111</div>' +
          '</div>' +
          '</div>' +
          '<div style="text-align:right;font-size:10.5px;color:#7b8190;line-height:1.7;">' +
          v.letterDate +
          '<br>' +
          v.number +
          '</div>' +
          '</div>' +
          '<div style="width:54px;height:3px;background:#d02030;margin-top:26px;"></div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:33px;font-weight:700;color:#203060;letter-spacing:-.025em;line-height:1.2;margin-top:14px;">Your Vision. Our Commitment.</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.62;margin-top:18px;max-width:664px;text-wrap:pretty;">' +
          '<p style="margin:0 0 8px;">Dear ' +
          v.firstName +
          ',</p>' +
          '<p style="margin:0 0 8px;">Thank you for the opportunity to partner with ' +
          v.org +
          ' in creating a therapy environment designed to support your team, the individuals you serve, and the work you do every day.</p>' +
          '<p style="margin:0 0 8px;">Investing in a sensory therapy gym is about far more than purchasing equipment. It is about creating an environment that gives your team greater flexibility, expands therapeutic possibilities, and provides the organization with a resource that can continue to deliver value for years to come.</p>' +
          '<p style="margin:0 0 8px;">That philosophy is at the heart of the Summit Soar.</p>' +
          '<p style="margin:0 0 8px;">We designed the Soar to be more than a traditional therapy frame. It is a free-standing therapeutic platform built to evolve alongside the needs of your team and the individuals they serve. Rather than limiting therapy to a predetermined set of activities or fixed configurations, the Soar gives your team the freedom to continually reimagine the space around changing goals, developmental levels, abilities, and therapeutic approaches.</p>' +
          '<p style="margin:0 0 8px;">The result is a therapy environment that can continually become something new.</p>' +
          '<div style="margin:2px 0 10px;padding-left:16px;border-left:2px solid #d02030;font-family:' +
          SERIF +
          ';font-size:14px;line-height:1.5;color:#203060;">A place to move.<br>A place to challenge.<br>A place to explore.<br>A place to build confidence.<br>And a place where your team can create new possibilities every day.</div>' +
          '<p style="margin:0 0 8px;">Your proposed Soar system has been thoughtfully designed for ' +
          v.org +
          ', taking into consideration your available space, objectives, selected equipment, safety considerations, and how your team intends to use the environment.</p>' +
          '<p style="margin:0 0 8px;">As you review this proposal, our goal is to show you more than a list of equipment and costs. We want you to understand the purpose behind the design, the flexibility built into the system, and the long-term value this investment can bring to your organization.</p>' +
          '<p style="margin:0 0 8px;">Choosing the right therapy environment is an important decision. We want you to feel confident that the system you select will not only meet the needs of your organization today, but will continue to create new opportunities as your programs, your team, and the individuals you serve grow and evolve.</p>' +
          '<p style="margin:0;">We appreciate the opportunity to earn your trust and would be honored to help bring your vision to life.</p>' +
          '</div>' +
          '<div style="flex:1;"></div>' +
          '<div>' +
          '<img src="bryan-signature.png" alt="Bryan Shepherd" style="width:132px;height:auto;display:block;margin:0 0 -10px -10px;">' +
          '<div style="width:220px;height:1px;background:#dfe3ec;"></div>' +
          '<div style="font-size:13px;font-weight:600;color:#20241f;margin-top:9px;">Bryan Shepherd, MBA</div>' +
          '<div style="font-size:12px;color:#4b5468;line-height:1.6;">President<br>Summit Sensory Gym</div>' +
          '</div>' +
          '</div>' +
          '</div>'
        );
      },

      // 3 · the space argument — banner across the top, two columns beneath
      function (v, art, h) {
        var q = [
          'What is above the ceiling?',
          'Can we structurally attach to it?',
          'Can we penetrate the walls?',
          'What will facilities approve?',
          'What happens if we move locations?',
          'What if this is leased space?',
          'What if the room needs to serve several purposes?',
        ];
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          // object-position pushes the crop down so the frame is visible rather than
          // the ceiling above it.
          // The banner is the flexible element: the text below it is only as tall as it
          // needs to be, and every remaining pixel goes to the photograph. The house
          // crop is cut to this shape, so the whole frame stays in view.
          '<div style="flex:1;min-height:262px;position:relative;background:#eceef4;">' +
          h.img(art, 'soar-p3-banner') +
          '</div>' +
          '<div style="flex:none;padding:26px 58px 24px;box-sizing:border-box;">' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:29px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.18;max-width:660px;">Big Therapeutic Possibilities. <span style="color:#d02030;">Smaller Commitment to the Room.</span></div>' +
          '<div style="font-size:12.5px;color:#20241f;line-height:1.7;margin-top:13px;max-width:690px;text-wrap:pretty;">The Summit Soar turns everyday space into an adaptable sensory and movement environment &mdash; giving your team more ways to use a room without permanently defining what that room has to be.</div>' +
          '<div style="display:flex;gap:24px;margin-top:16px;padding-top:16px;border-top:1px solid #dfe3ec;align-items:flex-start;">' +
          '<div style="width:290px;flex:none;">' +
          '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.16em;color:#d02030;font-weight:700;">It makes the room more useful</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.6;margin-top:8px;text-wrap:pretty;">A traditional installation can effectively turn a room into the sensory gym. The Summit Soar can help turn a room into a sensory gym when you need it &mdash; and something else when you don\'t.</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.68;margin-top:7px;text-wrap:pretty;">That matters wherever every square foot counts. Instead of asking:</div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:15px;font-weight:600;color:#7b8190;line-height:1.42;margin-top:9px;padding-left:13px;border-left:2px solid #dfe3ec;">&ldquo;Do we have a room we can dedicate to a sensory gym?&rdquo;</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.68;margin-top:9px;">the conversation becomes:</div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:16px;font-weight:700;color:#203060;line-height:1.4;margin-top:9px;padding-left:13px;border-left:2px solid #d02030;">&ldquo;Where could we create sensory and movement opportunities within the space we already have?&rdquo;</div>' +
          '</div>' +
          '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.16em;color:#d02030;font-weight:700;">Free-standing design reduces dependence on the building</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.68;margin-top:9px;text-wrap:pretty;">One of the biggest barriers to adding suspension equipment is often the building itself:</div>' +
          '<div style="margin-top:8px;padding:10px 14px;background:#f6f7f9;box-sizing:border-box;">' +
          q
            .map(function (t) {
              return (
                '<div style="font-family:' +
                SERIF +
                ';font-size:12.5px;color:#4b5468;line-height:1.48;padding:2px 0;">' +
                t +
                '</div>'
              );
            })
            .join('') +
          '</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.68;margin-top:10px;text-wrap:pretty;">A free-standing system changes that conversation. You get a therapeutic platform, rather than a building that has to become part of the equipment.</div>' +
          '<div style="font-size:11.5px;color:#203060;font-weight:600;line-height:1.68;margin-top:7px;text-wrap:pretty;">That is particularly valuable for schools, leased clinics, hospitals, universities, community programs, and homes where structural modification is not an option.</div>' +
          '</div>' +
          '</div>' +
          foot() +
          '</div>' +
          '</div>'
        );
      },

      // 4 · strength, features and mobility
      function (v, art, h) {
        var specs = [
          [
            '2,000 lb',
            'Rated capacity',
            'Enough to carry a wheelchair swing platform with its occupant, not only a seat and a child.',
          ],
          [
            '35+',
            'Connection points',
            'Linear and rotational swings, single and double point suspension, and standard suspended equipment.',
          ],
          [
            'Zero',
            'Ceiling or wall attachment',
            'Nothing penetrates the building. Placed in leased space and existing rooms without structural modification.',
          ],
          [
            'Sealed',
            'Engineer of Record',
            'Designed, load-analyzed, and sealed by a licensed professional engineer against recognized structural standards.',
          ],
        ];
        var ways = [
          'Reposition the equipment as needs change',
          'Adapt spaces for different programs',
          'Preserve flexibility during renovations or expansion',
          'Make better use of multipurpose rooms',
        ];
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          '<div style="flex:1;padding:50px 58px 26px;box-sizing:border-box;display:flex;flex-direction:column;">' +
          rule() +
          '<div style="font-family:' +
          SERIF +
          ';font-size:33px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.16;margin-top:15px;max-width:600px;">Built to Carry More Than a Swing.</div>' +
          '<div style="font-size:12.5px;color:#20241f;line-height:1.7;margin-top:12px;max-width:690px;text-wrap:pretty;">Built from durable powder-coated steel, Summit Soar provides more than 35 connection points and a 2,000-pound rated capacity, giving clinicians the flexibility to continually adapt the structure around different activities, equipment, treatment goals, and users.</div>' +
          // The numbers first, in one row: what the structure is rated to do.
          '<div style="display:flex;gap:20px;margin-top:24px;padding-top:16px;border-top:2px solid #203060;">' +
          specs
            .map(function (sp, i) {
              return (
                '<div style="flex:1;min-width:0;' +
                (i ? 'padding-left:20px;border-left:1px solid #dfe3ec;' : '') +
                '">' +
                '<div style="font-family:' +
                SERIF +
                ';font-size:26px;font-weight:700;color:#203060;letter-spacing:-.022em;line-height:1;">' +
                sp[0] +
                '</div>' +
                '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.14em;color:#d02030;font-weight:700;margin-top:8px;line-height:1.5;">' +
                sp[1] +
                '</div>' +
                '<div style="font-size:11px;color:#20241f;line-height:1.6;margin-top:6px;text-wrap:pretty;">' +
                sp[2] +
                '</div>' +
                '</div>'
              );
            })
            .join('') +
          '</div>' +
          // Then mobility, which is the feature the numbers alone do not explain: a
          // locking caster and a levelling pad on every leg.
          '<div style="margin-top:26px;padding-top:20px;border-top:1px solid #dfe3ec;">' +
          '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.16em;color:#d02030;font-weight:700;">Built-in mobility</div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:27px;font-weight:700;color:#203060;letter-spacing:-.024em;line-height:1.2;margin-top:11px;max-width:620px;">The Investment Is Not Tied to One Room.</div>' +
          '<div style="font-size:12.5px;color:#20241f;line-height:1.7;margin-top:11px;max-width:690px;text-wrap:pretty;">Integrated mobility wheels let your own staff relocate the frame between rooms and buildings. Levelling pads on every leg take the load once it is in position, and non-slip feet keep it stable across floor surfaces.</div>' +
          '</div>' +
          '<div style="display:flex;gap:24px;margin-top:18px;flex:1;min-height:0;align-items:stretch;">' +
          '<div style="flex:1;min-width:0;display:flex;">' +
          plate(
            h,
            art,
            'soar-p4-mobility',
            'fill',
            'Locking caster and levelling pad on every leg',
          ) +
          '</div>' +
          '<div style="width:266px;flex:none;">' +
          '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.15em;color:#203060;font-weight:700;padding-top:2px;">That gives an organization the ability to</div>' +
          '<div style="margin-top:9px;">' +
          ways
            .map(function (w) {
              return bullet(w, 12);
            })
            .join('') +
          '</div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:16px;font-weight:700;color:#203060;line-height:1.36;margin-top:16px;padding-top:14px;border-top:1px solid #dfe3ec;">Change the activity&mdash;not the equipment.</div>' +
          '</div>' +
          '</div>' +
          '<div style="margin-top:22px;padding-top:15px;border-top:1px solid #dfe3ec;">' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:19px;font-weight:700;color:#203060;letter-spacing:-.02em;line-height:1.34;">Flexible enough to transform a space.&nbsp;<span style="color:#d02030;">Engineered to give your organization confidence in what supports it.</span></div>' +
          '</div>' +
          '<div style="height:14px;"></div>' +
          foot() +
          '</div>' +
          '</div>'
        );
      },

      // 5 · why organizations choose Summit Soar
      function (v, art, h) {
        var reasons = [
          [
            '01',
            'Make better use of your space',
            'Create suspended movement experiences without dedicating an entire room to a permanent sensory gym.',
            'Therapy spaces, multipurpose rooms, gyms, and classrooms can support suspended activities while remaining available for other uses.',
          ],
          [
            '02',
            'Work around facility limitations',
            'Bring suspension-based activities to spaces where ceiling or wall attachment may be difficult, impractical, or unavailable.',
            'Because Summit Soar is free-standing, organizations have greater flexibility when dealing with building construction, ceiling limitations, or leased facilities.',
          ],
          [
            '03',
            'Create more from one platform',
            'More than 35 connection points give your team the flexibility to continually change the experience.',
            'Clinicians can change equipment, attachment locations, activities, and therapeutic challenges based on the individual or the treatment goal.',
          ],
          [
            '04',
            'Engineered for confidence',
            'Designed to support the activities happening beneath it &mdash; with engineering documentation to support the structure itself.',
            'Every Summit Soar carries an <b style="font-weight:700;">Engineer of Record</b>, with powder-coated steel construction and a <b style="font-weight:700;">rated capacity of 2,000 pounds</b>.',
          ],
          [
            '05',
            'Support more people',
            'Create movement experiences for a wider range of users, abilities, and therapeutic goals.',
            'The open, adaptable design includes applications designed to improve access for individuals who use wheelchairs or require additional physical support.',
          ],
          [
            '06',
            'Invest in a platform that can evolve',
            'Your program will change. Your equipment will change. Summit Soar is designed to change with you.',
            'Not designed around one activity or one configuration &mdash; a flexible foundation your organization can continue adapting over time.',
          ],
        ];
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          '<div style="flex:1;padding:46px 58px 24px;box-sizing:border-box;display:flex;flex-direction:column;">' +
          rule() +
          '<div style="font-family:' +
          SERIF +
          ';font-size:30px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.15;margin-top:14px;">Why Organizations Choose Summit Soar</div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:16px;font-weight:600;color:#d02030;line-height:1.4;margin-top:9px;">More therapeutic possibilities. Fewer limitations on where they can happen.</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.62;margin-top:11px;text-wrap:pretty;">Summit Soar gives organizations a professionally engineered, free-standing platform for swinging, suspension, movement, and sensory activities &mdash; without requiring a permanently dedicated sensory gym or traditional ceiling-mounted suspension points. The result is a flexible system that helps your team <b style="font-weight:700;">make better use of available space, create more therapeutic experiences, and adapt as your program grows.</b></div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;column-gap:34px;margin-top:6px;">' +
          reasons
            .map(function (r) {
              return reason(r);
            })
            .join('') +
          '</div>' +
          '<div style="flex:1;min-height:14px;"></div>' +
          '<div style="padding:15px 20px;box-sizing:border-box;background:#f6f7f9;border-top:2px solid #203060;">' +
          '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.16em;color:#d02030;font-weight:700;">One platform. More possibilities.</div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:15.5px;font-weight:600;color:#20241f;line-height:1.42;margin-top:7px;text-wrap:pretty;">Summit Soar gives your organization the freedom to create the movement and sensory experiences your team wants &mdash; without allowing the limitations of the building to determine what is possible.</div>' +
          '</div>' +
          '<div style="height:16px;"></div>' +
          // A customer in their own words, immediately before the pricing document.
          '<div style="padding-left:18px;border-left:3px solid #d02030;">' +
          '<div style="font-size:10.5px;color:#20241f;line-height:1.6;text-wrap:pretty;">&ldquo;Summit Soar has been a game changer for our occupational therapy program. I work in a small space, and for years I struggled to find a swing frame that could provide the sensory experiences my students needed without taking over the entire room. Summit Soar gives my students access to meaningful swinging and movement activities, but I can also move the frame when I&rsquo;m not using it and reclaim the space for other therapy activities. It gave me the flexibility I had been looking for without forcing me to choose between a swing system and a functional therapy room.&rdquo;</div>' +
          '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.15em;color:#7b8190;font-weight:700;margin-top:8px;">School-Based Occupational Therapist</div>' +
          '</div>' +
          '<div style="height:14px;"></div>' +
          foot() +
          '</div>' +
          '</div>'
        );
      },
    ],
  });
})();
