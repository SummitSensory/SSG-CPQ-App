/*
 * Summit Flex: Universal Exercise Unit — the introduction pages that print ahead of
 * the itemized proposal.
 *
 * Registers itself with proposal-front-matter.js, which owns the merge fields, the
 * photo handling and the builder panel. Load this file after that one.
 *
 * Same vocabulary as the Adventure Series and Soar introductions — navy #203060, a
 * red #d02030 rule opening each page, Newsreader for display type, a 10px navy foot
 * on every sheet — and the cover is the shared cover layout with Flex copy. Every
 * page after the cover has its own layout, so the document never reads the same way
 * twice.
 *
 * Copy on the letter, the platform page and the "Why Choose Summit Flex" pages is
 * the marketing text as written; nothing is claimed here that is not claimed there.
 *
 * Five photo slots. House files go in /public/proposal/ under exactly the names
 * below; until a file exists the area prints as white space, and an upload made
 * under Admin -> Proposal introductions always wins.
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

  /** A small caps label, used to open a section. */
  function eyebrow(text, color) {
    return (
      '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.16em;font-weight:700;' +
      'color:' +
      (color || '#d02030') +
      ';">' +
      text +
      '</div>'
    );
  }

  /** A dotted list item, matching the Adventure and Soar pages. */
  function bullet(text, size) {
    var s = size || 11.5;
    return (
      '<div style="font-size:' +
      s +
      'px;color:#20241f;line-height:1.5;padding:2px 0 2px 12px;position:relative;text-wrap:pretty;">' +
      '<span style="position:absolute;left:0;top:' +
      (s > 12 ? 10 : 9) +
      'px;width:3.5px;height:3.5px;border-radius:50%;background:#d02030;"></span>' +
      text +
      '</div>'
    );
  }

  /** A photo area with an optional caption beneath it. */
  function plate(h, art, id, height, caption, radius) {
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

  /**
   * One numbered reason: number and label on a rule, the claim in the serif, then
   * the supporting prose. Used on the "Why Choose Summit Flex" spread.
   */
  function reason(r) {
    return (
      '<div style="padding:10px 0 0;border-top:1px solid #dfe3ec;margin-top:10px;">' +
      '<div style="display:flex;gap:9px;align-items:baseline;">' +
      '<div style="font-family:' +
      SERIF +
      ';font-size:13px;font-weight:700;color:#d02030;flex:none;">' +
      r[0] +
      '</div>' +
      '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.13em;font-weight:700;color:#203060;line-height:1.45;">' +
      r[1] +
      '</div>' +
      '</div>' +
      '<div style="font-family:' +
      SERIF +
      ';font-size:12.5px;font-weight:600;color:#20241f;line-height:1.36;margin-top:5px;text-wrap:pretty;">' +
      r[2] +
      '</div>' +
      '<div style="font-size:10px;color:#20241f;line-height:1.55;margin-top:5px;text-wrap:pretty;">' +
      r[3] +
      '</div>' +
      '</div>'
    );
  }

  H.register({
    id: 'FLEX',
    label: 'Summit Flex: Universal Exercise Unit',

    /**
     * Recognise the product from the structure section — the first group on the
     * proposal — rather than from any line anywhere. Adventure and Soar proposals
     * routinely carry Flex belts and accessories, so only the frame group decides
     * the template.
     */
    matches: function (doc) {
      if (doc.meta && doc.meta.flexAnswers) return true;
      var first = (doc.lines || []).filter(function (l) {
        return (l.lineType || '') === 'GROUP';
      })[0];
      return !!first && /\bflex\b/i.test(String(first.name || ''));
    },

    slots: [
      {
        id: 'flex-p3-unit',
        label:
          'Page 3 \u2014 the unit in a treatment room, patient in the belt (tall, 760 \u00d7 1240)',
        house: '/proposal/flex-p3-unit.jpg',
        maxEdge: 1800,
        quality: 0.84,
      },
      {
        id: 'flex-p4-engineering',
        label:
          'Page 4 \u2014 structural detail: corner, trolley rail or panel joint (1160 \u00d7 700)',
        house: '/proposal/flex-p4-engineering.jpg',
      },
      {
        id: 'flex-p5-config-a',
        label: 'Page 5 left \u2014 the unit set up for standing and gait work (700 \u00d7 470)',
        house: '/proposal/flex-p5-config-a.jpg',
      },
      {
        id: 'flex-p5-config-b',
        label: 'Page 5 right \u2014 the unit set up for prone or supine swinging (700 \u00d7 470)',
        house: '/proposal/flex-p5-config-b.jpg',
      },
      {
        id: 'flex-p6-banner',
        label: 'Page 6 \u2014 therapist and patient mid-session (banner, 1632 \u00d7 620)',
        house: '/proposal/flex-p6-banner.jpg',
      },
    ],

    pages: [
      // 1 · cover — the shared cover layout, Flex copy
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
          ';font-size:43px;font-weight:700;color:#203060;letter-spacing:-.028em;line-height:1.16;margin-top:20px;max-width:620px;">Transforming Therapy.&nbsp;<span style="color:#d02030;">One Movement at a Time.</span></div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:19px;font-weight:600;color:#20241f;line-height:1.4;margin-top:14px;max-width:600px;">Summit Flex: Universal Exercise Unit</div>' +
          '<div style="font-size:14.5px;color:#4b5468;line-height:1.68;margin-top:12px;max-width:596px;text-wrap:pretty;">Unleash your patient&rsquo;s potential, one movement at a time. The Summit Flex is a versatile therapy tool designed to help individuals build strength, improve mobility, and develop functional movement skills &mdash; professionally designed, load-analyzed, and carrying an Engineer of Record.</div>' +
          '<div style="height:28px;"></div>' +
          // The customer name, in the same treatment the other templates use.
          '<div style="font-size:17px;color:#4b5468;">' +
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
        var p = 'margin:0 0 9px;';
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          '<div style="flex:1;padding:48px 74px 30px;box-sizing:border-box;display:flex;flex-direction:column;">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:16px;border-bottom:1px solid #dfe3ec;">' +
          '<div style="display:flex;gap:14px;align-items:center;">' +
          '<img src="logo.png" alt="Summit Sensory Gym" style="width:56px;height:56px;display:block;flex:none;">' +
          '<div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:18px;font-weight:700;color:#203060;letter-spacing:-.01em;">Summit Sensory Gym</div>' +
          '<div style="font-size:10px;color:#7b8190;line-height:1.5;margin-top:2px;">6150 S Geneva Ct, Englewood, CO 80111 &middot; SummitSensory.com</div>' +
          '</div>' +
          '</div>' +
          '<div style="text-align:right;font-size:10px;color:#7b8190;line-height:1.7;">' +
          v.letterDate +
          '<br>' +
          v.number +
          '</div>' +
          '</div>' +
          '<div style="width:54px;height:3px;background:#d02030;margin-top:30px;"></div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:32px;font-weight:700;color:#203060;letter-spacing:-.025em;line-height:1.2;margin-top:14px;">Your Patients. Our Engineering.</div>' +
          '<div style="font-size:12px;color:#20241f;line-height:1.68;margin-top:22px;max-width:640px;text-wrap:pretty;">' +
          '<p style="' +
          p +
          '">Dear ' +
          v.firstName +
          ',</p>' +
          '<p style="' +
          p +
          '">Thank you for the opportunity to partner with ' +
          v.org +
          ' and to help create an environment that expands what your clinicians can make possible for the individuals they serve.</p>' +
          '<p style="' +
          p +
          '">A Universal Exercise Unit should do more than occupy space in a therapy room. It should give a clinician more ways to help a patient move, more ways to provide support without removing independence, and more ways to challenge strength, balance, posture, coordination, and functional movement. Just as importantly, it should allow the therapist to continually change the environment as the needs of the person in front of them change.</p>' +
          '<p style="' +
          p +
          '">That is why we created the Summit Flex: a highly adaptable therapeutic platform that brings body-weight support, pulley-based exercise, resistance, suspension, positioning, and functional movement activities together within one system. Its extensive grid of connection points allows therapists to modify where and how support or resistance is applied. One session may focus on supported standing and weight shifting. Another may center on isolated strengthening or range of motion. The next may involve kneeling, transitions, stepping, trunk control, or dynamic movement.</p>' +
          '<div style="margin:2px 0 11px;padding-left:16px;border-left:2px solid #d02030;font-family:' +
          SERIF +
          ';font-size:15px;line-height:1.44;color:#203060;">The structure stays the same. What the clinician can create within it continually changes.</div>' +
          '<p style="' +
          p +
          '">When patients are being supported from a structure, the engineering behind that structure matters. Summit Flex is not simply fabricated equipment accompanied by a manufacturer&rsquo;s load claim. The system has been professionally designed and load-analyzed, carries an Engineer of Record, and is fabricated in accordance with the engineered drawing set. Clinical versatility should never come at the expense of structural confidence.</p>' +
          '<p style="' +
          p +
          '">The Summit Flex proposed for ' +
          v.org +
          ' has been configured around your available space, selected equipment and accessories, anticipated clinical applications, and the long-term needs of your program. We hope you see more than a list of components: a place to build strength, to practice standing, to explore movement with support, to challenge balance and coordination, and to practice skills before they are attempted independently &mdash; and a platform your clinicians can continue finding new ways to use for years to come.</p>' +
          '<p style="margin:0;">Thank you for giving Summit Sensory Gym the opportunity to earn your trust. We would be honored to help bring this environment to life.</p>' +
          '</div>' +
          '<div style="flex:1;min-height:14px;"></div>' +
          '<div>' +
          '<div style="font-size:12px;color:#4b5468;">Sincerely,</div>' +
          '<img src="bryan-signature.png" alt="Bryan Shepherd" style="width:132px;height:auto;display:block;margin:2px 0 -10px -10px;">' +
          '<div style="width:220px;height:1px;background:#dfe3ec;"></div>' +
          '<div style="font-size:13px;font-weight:600;color:#20241f;margin-top:9px;">Bryan Shepherd, MBA</div>' +
          '<div style="font-size:12px;color:#4b5468;line-height:1.6;">President<br>Summit Sensory Gym</div>' +
          '</div>' +
          '</div>' +
          '</div>'
        );
      },

      // 3 · what the unit does — tall photograph left, the clinical case right
      function (v, art, h) {
        var caps = [
          [
            'Muscle Strengthening &amp; Motor Control',
            'Using an adjustable system of pulleys, straps, and splints, the UEU enables low-weight, high-repetition exercises to enhance strength, endurance, and muscle isolation.',
          ],
          [
            'Improved Range of Motion',
            'Whether for passive or active movement exercises, the UEU helps users achieve and maintain greater flexibility and freedom of motion.',
          ],
          [
            'Prone &amp; Supine Swinging',
            'Integrated support slings allow for controlled swinging, promoting head, neck, and trunk control while providing vestibular input for improved balance and coordination.',
          ],
          [
            'Dynamic Support for Functional Skills',
            'A specialized bungee and belt system offers assisted support, helping users practice essential movements with greater independence. This setup also allows therapists to guide movement without the need for constant manual support, fostering confidence and skill progression in a safe, controlled environment.',
          ],
        ];
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          '<div style="flex:1;display:flex;min-height:0;">' +
          // The photograph runs the full height of the sheet, flush to the left edge.
          '<div style="width:302px;flex:none;position:relative;background:#eceef4;">' +
          h.img(art, 'flex-p3-unit') +
          '</div>' +
          '<div style="flex:1;min-width:0;padding:50px 50px 26px 34px;box-sizing:border-box;display:flex;flex-direction:column;">' +
          rule() +
          '<div style="font-family:' +
          SERIF +
          ';font-size:30px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.16;margin-top:15px;">One Unit. Four Kinds of Therapy.</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.65;margin-top:12px;text-wrap:pretty;">The <b style="font-weight:700;">Summit Flex: Universal Exercise Unit (UEU)</b> is a versatile therapy tool designed to help individuals build strength, improve mobility, and develop functional movement skills. Engineered for flexibility, the UEU supports a wide range of therapeutic applications, making it an essential resource for rehabilitation and motor skill development.</div>' +
          '<div style="margin-top:6px;">' +
          caps
            .map(function (c) {
              return (
                '<div style="padding:12px 0 0;border-top:1px solid #dfe3ec;margin-top:12px;">' +
                '<div style="font-family:' +
                SERIF +
                ';font-size:15px;font-weight:700;color:#203060;line-height:1.32;">' +
                c[0] +
                '</div>' +
                '<div style="font-size:10.5px;color:#20241f;line-height:1.6;margin-top:5px;text-wrap:pretty;">' +
                c[1] +
                '</div>' +
                '</div>'
              );
            })
            .join('') +
          '</div>' +
          '<div style="flex:1;min-height:12px;"></div>' +
          '<div style="padding-left:14px;border-left:2px solid #d02030;">' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:14px;font-weight:600;color:#203060;line-height:1.44;text-wrap:pretty;">Designed to support both clinical and at-home therapy settings, the Summit Flex UEU empowers individuals to reach their functional goals while ensuring a dynamic and engaging therapy experience.</div>' +
          '</div>' +
          '<div style="height:16px;"></div>' +
          foot() +
          '</div>' +
          '</div>' +
          '</div>'
        );
      },

      // 4 · the engineering — a navy band, then the review record and a detail photo
      function (v, art, h) {
        var facts = [
          [
            'Engineer of Record',
            'A licensed professional engineer is named on the design. The structure has been professionally designed and load-analyzed, and is fabricated in accordance with the engineered drawing set.',
          ],
          [
            'Documented, not claimed',
            'Summit Flex is not simply fabricated equipment accompanied by a manufacturer&rsquo;s load claim. The engineering exists on paper, and you can hold it.',
          ],
          [
            'Welded and powder-coated steel',
            'Built from steel throughout, welded and finished for the load and the wear of daily clinical use rather than for display.',
          ],
          [
            'Documentation you can hand over',
            'For healthcare organizations, schools, architects, facilities teams, and administrators: documented engineering behind the structure supporting your patients.',
          ],
        ];
        var asks = [
          'Who engineered this, and are they licensed?',
          'What load was it analyzed for?',
          'Is it fabricated to the engineered drawing set?',
          'What can we give our facilities team?',
        ];
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          '<div style="background:#203060;color:#fff;padding:44px 58px 38px;box-sizing:border-box;flex:none;">' +
          rule(54, 3) +
          '<div style="font-family:' +
          SERIF +
          ';font-size:33px;font-weight:700;letter-spacing:-.026em;line-height:1.16;margin-top:16px;max-width:640px;">Engineering You Can Document.</div>' +
          '<div style="font-size:12.5px;color:#c8cfe0;line-height:1.7;margin-top:13px;max-width:660px;text-wrap:pretty;">When a structure may be used to support a patient, strength should be more than a manufacturer&rsquo;s claim. Summit Flex carries an <b style="color:#fff;font-weight:700;">Engineer of Record</b>. The structure has been professionally designed and load-analyzed by a licensed professional engineer and is fabricated in accordance with the engineered drawing set.</div>' +
          '</div>' +
          '<div style="flex:1;padding:26px 58px 24px;box-sizing:border-box;display:flex;flex-direction:column;min-height:0;">' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;column-gap:32px;">' +
          facts
            .map(function (f) {
              return (
                '<div style="padding:12px 0 0;border-top:1px solid #dfe3ec;margin-top:12px;">' +
                '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.14em;font-weight:700;color:#d02030;">' +
                f[0] +
                '</div>' +
                '<div style="font-size:10.5px;color:#20241f;line-height:1.6;margin-top:6px;text-wrap:pretty;">' +
                f[1] +
                '</div>' +
                '</div>'
              );
            })
            .join('') +
          '</div>' +
          '<div style="display:flex;gap:26px;margin-top:24px;flex:1;min-height:0;align-items:stretch;">' +
          '<div style="flex:1;min-width:0;display:flex;">' +
          plate(h, art, 'flex-p4-engineering', 'fill') +
          '</div>' +
          '<div style="width:258px;flex:none;display:flex;flex-direction:column;">' +
          eyebrow('Questions worth asking any vendor') +
          '<div style="margin-top:9px;padding:12px 14px;background:#f6f7f9;box-sizing:border-box;">' +
          asks
            .map(function (t) {
              return (
                '<div style="font-family:' +
                SERIF +
                ';font-size:12.5px;color:#4b5468;line-height:1.46;padding:3px 0;">' +
                t +
                '</div>'
              );
            })
            .join('') +
          '</div>' +
          '<div style="font-size:11px;color:#20241f;line-height:1.62;margin-top:12px;text-wrap:pretty;">We answer all four in writing. Ask us for the engineering documentation at any point in your review &mdash; before purchase, during facilities approval, or years from now.</div>' +
          '<div style="flex:1;min-height:10px;"></div>' +
          '<img src="proposal/engineer-of-record-badge.png" alt="Engineer of Record" style="width:150px;height:auto;display:block;margin:8px auto 6px;">' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:16px;font-weight:700;color:#203060;line-height:1.36;padding-top:14px;border-top:1px solid #dfe3ec;">Clinical versatility should never come at the expense of structural confidence.</div>' +
          '</div>' +
          '</div>' +
          '<div style="height:16px;"></div>' +
          foot() +
          '</div>' +
          '</div>'
        );
      },

      // 5 · a platform, not a method — the application list, then two configurations
      function (v, art, h) {
        var apps = [
          'Body-weight support',
          'Spider Cage activities',
          'Pulley and resistance exercises',
          'Strengthening',
          'Supported standing',
          'Weight shifting',
          'Balance and postural activities',
          'Functional transitions',
          'Range-of-motion activities',
          'Gait preparation',
          'Suspension activities',
          'Sensory-motor experiences',
        ];
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          '<div style="flex:1;padding:48px 58px 24px;box-sizing:border-box;display:flex;flex-direction:column;">' +
          rule() +
          '<div style="font-family:' +
          SERIF +
          ';font-size:31px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.16;margin-top:15px;max-width:660px;">Designed as a Platform, <span style="color:#d02030;">Not a Single Therapy Method.</span></div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:15px;font-weight:600;color:#20241f;line-height:1.42;margin-top:11px;">Your clinicians should determine how the equipment is used.</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.65;margin-top:9px;max-width:690px;text-wrap:pretty;">Summit Flex can support a broad range of Universal Exercise Unit applications, including:</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;column-gap:26px;margin-top:10px;padding:12px 16px;background:#f6f7f9;box-sizing:border-box;">' +
          apps
            .map(function (t) {
              return bullet(t, 11);
            })
            .join('') +
          '</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.65;margin-top:11px;max-width:690px;text-wrap:pretty;">It can also be incorporated into programs using established UEU and suit-therapy approaches.</div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:17px;font-weight:700;color:#203060;line-height:1.38;margin-top:12px;padding-left:14px;border-left:2px solid #d02030;">One structure. Many clinicians. Many patients. Many possibilities.</div>' +
          '<div style="margin-top:24px;padding-top:18px;border-top:2px solid #203060;">' +
          eyebrow('Configured around the way your team wants to work') +
          '<div style="font-family:' +
          SERIF +
          ';font-size:22px;font-weight:700;color:#203060;letter-spacing:-.022em;line-height:1.24;margin-top:10px;max-width:660px;">Your UEU should fit your clinical program &mdash; not force your program to fit the equipment.</div>' +
          '<div style="font-size:11.5px;color:#20241f;line-height:1.65;margin-top:10px;max-width:700px;text-wrap:pretty;">Summit Flex can be configured with the equipment and accessories that make sense for your organization, including belts, bungees, pulleys, straps, splints, slings, safety padding, equipment storage, and additional therapeutic accessories. An <b style="font-weight:700;">integrated suspension tracking rail is also available</b>, expanding the platform for activities involving supported movement and progression through the length of the UEU.</div>' +
          '</div>' +
          '<div style="display:flex;gap:22px;margin-top:18px;">' +
          '<div style="flex:1;min-width:0;">' +
          plate(h, art, 'flex-p5-config-a', 196) +
          '</div>' +
          '<div style="flex:1;min-width:0;">' +
          plate(h, art, 'flex-p5-config-b', 196) +
          '</div>' +
          '</div>' +
          '<div style="flex:1;min-height:12px;"></div>' +
          '<div style="font-size:11.5px;color:#203060;font-weight:600;line-height:1.6;text-wrap:pretty;">Instead of purchasing a fixed solution, your organization can build the system around how your clinicians intend to use it.</div>' +
          '<div style="height:16px;"></div>' +
          foot() +
          '</div>' +
          '</div>'
        );
      },

      // 6 · why choose Summit Flex — banner, then the reasons that are not the frame
      function (v, art, h) {
        var reasons = [
          [
            '01',
            'No required training purchase',
            'You should not have to purchase training simply for the right to purchase the equipment.',
            'Summit Sensory Gym does not require customers to purchase training or certification as a condition of purchasing the Summit Flex. If your team would benefit from additional education or advanced clinical application training, those options remain available. You decide what your team needs.',
          ],
          [
            '02',
            'Built to evolve with your program',
            'The Summit Flex you purchase today should still be valuable years from now.',
            'Caseloads change. Clinicians change. Treatment approaches evolve. Summit Flex was designed as an adaptable platform, so your organization can keep modifying how the system is used rather than outgrowing it.',
          ],
          [
            '03',
            'A complete ecosystem',
            'A Universal Exercise Unit is only as useful as what your clinicians can do with it.',
            'Belts in multiple sizes, TheraBungee systems, pulley and resistance equipment, straps, prone and supine suspension, integrated tracking, custom-fit padding, storage, and implementation support.',
          ],
          [
            '04',
            'Built for a working clinic',
            'Clinical equipment needs to work for the therapist as well as the patient.',
            'Multiple attachment locations and configurable accessories let therapists change the environment through the day rather than dedicating the equipment to a single activity.',
          ],
          [
            '05',
            'Customized to belong in your facility',
            'Professional rehabilitation equipment does not have to look institutional.',
            'Select from available frame finishes and a wide variety of vinyl safety-padding colors &mdash; to match your brand, an existing therapy space, an energetic pediatric room, or a hospital aesthetic.',
          ],
          [
            '06',
            'Trusted in serious clinical environments',
            'The organizations choosing Summit Flex tell an important part of the story.',
            'Used by rehabilitation hospitals, health systems, schools, pediatric therapy organizations, and private practices throughout North America, including <b style="font-weight:700;">Memorial Health</b>, <b style="font-weight:700;">Shirley Ryan AbilityLab</b>, <b style="font-weight:700;">Blanchard Valley Health System</b> and <b style="font-weight:700;">Let&rsquo;s Move Mountains</b>.',
          ],
        ];
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          '<div style="height:206px;flex:none;position:relative;background:#eceef4;">' +
          h.img(art, 'flex-p6-banner') +
          '</div>' +
          '<div style="flex:1;padding:28px 58px 22px;box-sizing:border-box;display:flex;flex-direction:column;min-height:0;">' +
          rule() +
          '<div style="font-family:' +
          SERIF +
          ';font-size:29px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.15;margin-top:13px;">Not All Universal Exercise Units Are Created Equal.</div>' +
          '<div style="font-size:11px;color:#20241f;line-height:1.6;margin-top:10px;text-wrap:pretty;">At first glance, many Universal Exercise Units may appear similar: a steel frame, connection points, pulleys, belts, and bungees. But the real difference is not simply what the equipment looks like. It is how the system was engineered, how easily clinicians can adapt it, what options are available as your program grows, what is required before your team can begin using it, and whether the company behind it understands the realities of a working therapy environment.</div>' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:14.5px;font-weight:700;color:#d02030;line-height:1.4;margin-top:9px;">Summit Flex was designed around the entire clinical experience &mdash; not simply the frame.</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;column-gap:32px;margin-top:2px;">' +
          reasons
            .map(function (r) {
              return reason(r);
            })
            .join('') +
          '</div>' +
          '<div style="flex:1;min-height:10px;"></div>' +
          foot() +
          '</div>' +
          '</div>'
        );
      },

      // 7 · the Summit Flex difference — the questions, a customer, the close
      function (v, art, h) {
        var qs = [
          'Who engineered it?',
          'How adaptable is it?',
          'Can it grow with our program?',
          'Are we forced into unnecessary purchases?',
          'Can our clinicians configure it around different patients and goals?',
          'What equipment and support will be available after we purchase it?',
          'And who stands behind the system once it is in our facility?',
        ];
        var eco = [
          'UEU belts in multiple sizes',
          'TheraBungee systems',
          'Pulley and resistance equipment',
          'Straps and attachment accessories',
          'Prone and supine suspension options',
          'Integrated tracking systems',
          'Custom-fit safety padding',
          'Equipment organization and storage',
          'Clinical training and implementation support',
        ];
        return (
          '<div class="ssg-fm-page" style="' +
          PAGE +
          '">' +
          '<div style="flex:1;padding:52px 58px 24px;box-sizing:border-box;display:flex;flex-direction:column;">' +
          rule() +
          '<div style="font-family:' +
          SERIF +
          ';font-size:34px;font-weight:700;color:#203060;letter-spacing:-.028em;line-height:1.14;margin-top:16px;max-width:640px;">The Summit Flex Difference</div>' +
          '<div style="font-size:12.5px;color:#20241f;line-height:1.7;margin-top:12px;max-width:690px;text-wrap:pretty;">Choosing a Universal Exercise Unit should not come down to which steel cage looks similar on a specification sheet. The better questions are:</div>' +
          '<div style="display:flex;gap:30px;margin-top:20px;align-items:flex-start;">' +
          '<div style="flex:1;min-width:0;">' +
          qs
            .map(function (t, i) {
              return (
                '<div style="font-family:' +
                SERIF +
                ';font-size:15px;font-weight:600;color:#203060;line-height:1.4;padding:9px 0;' +
                (i ? 'border-top:1px solid #dfe3ec;' : '') +
                'text-wrap:pretty;">' +
                t +
                '</div>'
              );
            })
            .join('') +
          '</div>' +
          '<div style="width:250px;flex:none;padding:16px 18px;background:#f6f7f9;box-sizing:border-box;">' +
          eyebrow('The ecosystem behind it') +
          '<div style="margin-top:9px;">' +
          eco
            .map(function (t) {
              return bullet(t, 10.5);
            })
            .join('') +
          '</div>' +
          '<div style="font-size:10.5px;color:#20241f;line-height:1.58;margin-top:11px;padding-top:11px;border-top:1px solid #dfe3ec;text-wrap:pretty;">Purchase the system you need today and expand its capabilities over time.</div>' +
          '</div>' +
          '</div>' +
          '<div style="font-size:12px;color:#20241f;line-height:1.68;margin-top:20px;padding-top:16px;border-top:1px solid #dfe3ec;max-width:700px;text-wrap:pretty;">Those are the questions Summit Flex was designed to answer. Purchasing a UEU is not simply an equipment decision. It is an investment in what your clinicians will be able to do with it for years to come.</div>' +
          '<div style="flex:1;min-height:16px;"></div>' +
          // A customer in their own words, immediately before the pricing document.
          '<div style="padding-left:18px;border-left:3px solid #d02030;">' +
          '<div style="font-size:10.5px;color:#20241f;line-height:1.6;text-wrap:pretty;">&ldquo;The Summit Flex changed how I run my sessions. I can support a child in standing and still have both hands free to work on alignment, and I can go straight from gait practice to prone suspension without leaving the room or waiting on another piece of equipment. The build quality is obvious the first time you load it &mdash; nothing shifts, nothing flexes, and my families notice that too. It is the piece of equipment in my clinic I would replace first if I lost it.&rdquo;</div>' +
          '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.15em;color:#7b8190;font-weight:700;margin-top:8px;">Pediatric Physical Therapist</div>' +
          '</div>' +
          '<div style="height:18px;"></div>' +
          '<div style="padding:16px 20px;box-sizing:border-box;background:#203060;">' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:19px;font-weight:700;color:#fff;line-height:1.34;text-wrap:pretty;">Engineered with purpose. Built for flexibility. Designed around therapy.</div>' +
          '</div>' +
          '<div style="height:16px;"></div>' +
          foot() +
          '</div>' +
          '</div>'
        );
      },
    ],
  });
})();
