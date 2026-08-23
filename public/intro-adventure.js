/*
 * Summit Adventure Series — the eight introduction pages that print ahead of the
 * itemized proposal: the cover, the president's letter, and six story pages.
 *
 * Registers itself with proposal-front-matter.js, which owns the merge fields, the
 * photo handling and the builder panel. Load this file after that one.
 *
 * Photos are attached per proposal in the builder. The house files named below are
 * the fallback for a proposal that has none; drop them into /public/proposal/ using
 * exactly these names, at the sizes given in the slot labels. Until a file exists
 * the area prints as white space rather than a broken image.
 */
(function () {
  'use strict';
  if (!window.SSGFrontMatter) return;

  window.SSGFrontMatter.register({
    id: 'ADVENTURE',
    label: 'Summit Adventure Series',

    /**
     * The configurator writes its answers into meta, which is the reliable signal.
     * A hand-built proposal is recognised by its line naming instead.
     */
    matches: function (doc) {
      if (doc.meta && doc.meta.advAnswers) return true;
      return (doc.lines || []).some(function (l) {
        return /adventure/i.test(String(l.name || '') + ' ' + String(l.group || ''));
      });
    },

    slots: [
      {
        id: 'p3b-photo',
        label: 'Page 3 \u2014 clinician working with a patient (wide, 1384 \u00d7 536)',
        house: '/proposal/adventure-p3-activity.jpg',
      },
      {
        id: 'p4-photo',
        label: 'Page 4 \u2014 mid-activity (tall column, 472 \u00d7 2112)',
        house: '/proposal/adventure-p4-vertical.jpg',
      },
      {
        id: 'p5-photo',
        label: 'Page 5 \u2014 full installation, room-scale (banner, 1632 \u00d7 528)',
        house: '/proposal/adventure-p5-installation.jpg',
      },
      {
        id: 'p6-photo',
        label: 'Page 6 \u2014 structural detail or clinic setting (684 \u00d7 456)',
        house: '/proposal/adventure-p6-detail.jpg',
      },
      {
        id: 'p7-photo',
        label: 'Page 7 left \u2014 the frame configured one way (674 \u00d7 420)',
        house: '/proposal/adventure-p7-config-a.jpg',
      },
      {
        id: 'p7b-photo',
        label: 'Page 7 right \u2014 the same frame configured differently (674 \u00d7 420)',
        house: '/proposal/adventure-p7-config-b.jpg',
      },
    ],

    pages: [
      // 1 · cover
      function (v, art, h) {
        return `<div class="ssg-fm-page" style="width:816px;height:1056px;flex:none;background:#fff;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;color:#20241f;">
      <div style="height:14px;background:#203060;"></div>
      <div style="flex:1;padding:60px 58px 46px;box-sizing:border-box;display:flex;flex-direction:column;">
        <div style="display:flex;gap:20px;align-items:center;">
          <img src="logo.png" alt="Summit Sensory Gym" style="width:112px;height:112px;display:block;flex:none;">
          <div style="font-family:'Newsreader',Georgia,serif;font-size:37px;font-weight:700;color:#203060;letter-spacing:-.02em;line-height:1.1;">Summit Sensory Gym</div>
        </div>
        <div style="flex:1;"></div>
        <div style="width:54px;height:3px;background:#d02030;"></div>
        <div style="font-family:'Newsreader',Georgia,serif;font-size:40px;font-weight:700;color:#203060;letter-spacing:-.025em;line-height:1.22;margin-top:20px;max-width:620px;">Engineered for Movement. Designed for Limitless Possibilities.</div>
        <div style="font-size:15px;color:#4b5468;line-height:1.65;margin-top:16px;max-width:560px;">Every Summit structure is free-standing and carries an Engineer of Record — designed and load-analyzed by a licensed professional engineer, and sealed against recognized structural design standards.</div>
        <div style="height:32px;"></div>
        <div style="font-family:'Newsreader',Georgia,serif;font-size:29px;font-weight:600;color:#20241f;letter-spacing:.02em;">${v.model}</div>
        <div style="font-size:17px;color:#4b5468;margin-top:4px;">${v.org}</div>
        <div style="flex:1;"></div>
        <div style="display:flex;justify-content:space-between;font-size:11.5px;color:#7b8190;line-height:1.7;padding-top:20px;border-top:1px solid #dfe3ec;">
          <div><span style="color:#20241f;font-weight:600;">${v.numberRev}</span><br>${v.issuedLine}</div>
          <div style="text-align:right;"><span style="color:#20241f;font-weight:600;">${v.repName}</span><br>${v.repContact}</div>
        </div>
      </div>
      <div style="height:14px;background:#203060;"></div>
    </div>`;
      },
      // 2 · executive letter
      function (v, art, h) {
        return `<div class="ssg-fm-page" style="width:816px;height:1056px;flex:none;background:#fff;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;color:#20241f;">
      <div style="flex:1;padding:46px 70px 30px;box-sizing:border-box;display:flex;flex-direction:column;">

        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:18px;border-bottom:1px solid #dfe3ec;">
          <div style="display:flex;gap:14px;align-items:center;">
            <img src="logo.png" alt="Summit Sensory Gym" style="width:58px;height:58px;display:block;flex:none;">
            <div>
              <div style="font-family:'Newsreader',Georgia,serif;font-size:19px;font-weight:700;color:#203060;letter-spacing:-.01em;">Summit Sensory Gym</div>
              <div style="font-size:10.5px;color:#7b8190;line-height:1.5;margin-top:2px;">6150 S Geneva Ct, Englewood, CO 80111 · SummitSensory.com</div>
            </div>
          </div>
          <div style="text-align:right;font-size:10.5px;color:#7b8190;line-height:1.7;">${v.letterDate}<br>${v.number}</div>
        </div>

        <div style="width:54px;height:3px;background:#d02030;margin-top:26px;"></div>
        <div style="font-family:'Newsreader',Georgia,serif;font-size:33px;font-weight:700;color:#203060;letter-spacing:-.025em;line-height:1.2;margin-top:14px;">Your Vision. Our Commitment.</div>

        <div style="font-size:11.5px;color:#20241f;line-height:1.62;margin-top:18px;max-width:664px;text-wrap:pretty;">
          <p style="margin:0 0 8px;">Dear ${v.firstName},</p>
          <p style="margin:0 0 8px;">Thank you for the opportunity to partner with ${v.org} in creating a therapy environment designed to support your team, the individuals you serve, and the work you do every day.</p>
          <p style="margin:0 0 8px;">Investing in a sensory therapy gym is about far more than purchasing equipment. It is about creating an environment that gives clinicians greater flexibility, expands therapeutic possibilities, and provides the organization with a resource that can continue to deliver value for years to come.</p>
          <p style="margin:0 0 8px;">That philosophy is at the heart of the Summit Adventure Series.</p>
          <p style="margin:0 0 8px;">We designed the Adventure Series to be more than a traditional therapy frame. It is a highly adaptable therapeutic platform built to evolve alongside the needs of your clinicians and the individuals they serve. Rather than limiting therapy to a predetermined set of activities or fixed configurations, the Adventure Series gives your team the freedom to continually reimagine the space around changing treatment goals, developmental levels, abilities, and therapeutic approaches.</p>
          <p style="margin:0 0 8px;">The result is a therapy environment that can continually become something new.</p>
          <div style="margin:2px 0 10px;padding-left:16px;border-left:2px solid #d02030;font-family:'Newsreader',Georgia,serif;font-size:14px;line-height:1.5;color:#203060;">A place to move.<br>A place to challenge.<br>A place to explore.<br>A place to build confidence.<br>And a place where clinicians can create new possibilities every day.</div>
          <p style="margin:0 0 8px;">Your proposed Adventure Series system has been thoughtfully designed for ${v.org}, taking into consideration your available space, therapeutic objectives, selected equipment, safety considerations, and how your team intends to use the environment.</p>
          <p style="margin:0 0 8px;">As you review this proposal, our goal is to show you more than a list of equipment and costs. We want you to understand the purpose behind the design, the flexibility built into the system, and the long-term value this investment can bring to your organization.</p>
          <p style="margin:0 0 8px;">Choosing the right therapy environment is an important decision. We want you to feel confident that the system you select will not only meet the needs of your organization today, but will continue to create new opportunities as your programs, clinicians, and the individuals you serve grow and evolve.</p>
          <p style="margin:0;">We appreciate the opportunity to earn your trust and would be honored to help bring your vision to life.</p>
        </div>

        <div style="flex:1;"></div>

        <div>
          <img src="bryan-signature.png" alt="Bryan Shepherd" style="width:132px;height:auto;display:block;margin:0 0 -10px -10px;">
          <div style="width:220px;height:1px;background:#dfe3ec;"></div>
          <div style="font-size:13px;font-weight:600;color:#20241f;margin-top:9px;">Bryan Shepherd, MBA</div>
          <div style="font-size:12px;color:#4b5468;line-height:1.6;">President<br>Summit Sensory Gym</div>
        </div>
      </div>
      <div style="height:10px;background:#203060;flex:none;"></div>
    </div>`;
      },
      // 3 · one system, endless possibilities
      function (v, art, h) {
        return `<div class="ssg-fm-page" style="width:816px;height:1056px;flex:none;background:#fff;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;color:#20241f;">
      <div style="flex:1;padding:52px 62px 30px;box-sizing:border-box;display:flex;flex-direction:column;">

        <div style="width:54px;height:3px;background:#d02030;"></div>
        <div style="font-family:'Newsreader',Georgia,serif;font-size:34px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.16;margin-top:14px;">One System. Endless Possibilities.</div>

        <div style="display:flex;gap:30px;margin-top:22px;align-items:flex-start;">
          <div style="width:330px;flex:none;">
            <div style="font-size:11.5px;color:#4b5468;line-height:1.6;">The Adventure Series was created around a simple idea:</div>
            <div style="font-family:'Newsreader',Georgia,serif;font-size:19px;font-weight:600;color:#203060;line-height:1.4;margin-top:8px;padding-left:14px;border-left:2px solid #d02030;">Your therapy environment should adapt to the patient—not require the patient to adapt to the environment.</div>
            <div style="font-family:'Newsreader',Georgia,serif;font-size:20px;font-weight:700;color:#20241f;line-height:1.35;margin-top:18px;">Every patient is different.<br>Every treatment plan is different.</div>
            <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:8px;">And what a clinician needs from a therapy space today may be very different from what they need tomorrow.</div>
          </div>
          <div style="flex:1;min-width:0;font-size:12px;color:#20241f;line-height:1.75;text-wrap:pretty;">
            <p style="margin:0 0 10px;">That is why the Summit Adventure Series is designed as a flexible therapeutic platform rather than a single-purpose piece of equipment.</p>
            <p style="margin:0;">Through its extensive network of attachment and connection opportunities, the Adventure Series can support a broad range of therapeutic activities, suspended equipment, movement challenges, sensory experiences, strengthening activities, motor-planning exercises, and progressive treatment configurations.</p>
          </div>
        </div>

        <div style="display:flex;align-items:baseline;gap:16px;margin-top:28px;padding-top:16px;border-top:1px solid #dfe3ec;">
          <div style="font-family:'Newsreader',Georgia,serif;font-size:24px;font-weight:700;color:#203060;letter-spacing:-.02em;flex:none;">More Ways to Move</div>
          <div style="font-size:11.5px;color:#4b5468;line-height:1.6;">Depending upon the selected configuration, clinicians can incorporate activities involving:</div>
        </div>

        <div style="display:flex;gap:26px;margin-top:16px;align-items:flex-start;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#203060;font-weight:700;padding-bottom:8px;border-bottom:1px solid #dfe3ec;">Sensory input</div>
            <div style="margin-top:8px;"><div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Swinging and suspended movement</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Vestibular input</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Proprioceptive input</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Sensory-motor exploration</div></div>
          </div>
          <div style="flex:1;min-width:0;padding-left:26px;border-left:1px solid #dfe3ec;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#203060;font-weight:700;padding-bottom:8px;border-bottom:1px solid #dfe3ec;">Movement and strength</div>
            <div style="margin-top:8px;"><div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Climbing</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Crawling</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Hanging</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Reaching</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Pulling and pushing</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Strength development</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Upper-extremity activity</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Dynamic movement challenges</div></div>
          </div>
          <div style="flex:1;min-width:0;padding-left:26px;border-left:1px solid #dfe3ec;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#203060;font-weight:700;padding-bottom:8px;border-bottom:1px solid #dfe3ec;">Coordination and control</div>
            <div style="margin-top:8px;"><div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Balance</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Bilateral coordination</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Motor planning</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Postural control</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Functional movement</div>
            <div style="font-size:13.5px;color:#20241f;line-height:1.5;padding:4px 0 4px 15px;position:relative;"><span style="position:absolute;left:0;top:11px;width:4.5px;height:4.5px;border-radius:50%;background:#d02030;"></span>Obstacle-course activities</div></div>
          </div>
        </div>

        <div style="position:relative;height:268px;flex:none;margin-top:26px;border-radius:6px;overflow:hidden;">
          ${h.img(art, 'p3b-photo')}
        </div>

        

        
      </div>
      <div style="height:10px;background:#203060;flex:none;"></div>
    </div>`;
      },
      // 4 · give your team more than equipment
      function (v, art, h) {
        return `<div class="ssg-fm-page" style="width:816px;height:1056px;flex:none;background:#fbfaf6;border-bottom:10px solid #203060;box-sizing:border-box;display:flex;overflow:hidden;color:#20241f;">
      <div style="flex:1;min-width:0;padding:56px 40px 34px 58px;box-sizing:border-box;display:flex;flex-direction:column;">

        <div style="font-family:'Newsreader',Georgia,serif;font-size:31px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.16;">Give Your Team More Than Equipment.<br><span style="color:#d02030;">Give Them Possibility.</span></div>

        <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:18px;text-wrap:pretty;">A great therapy environment should expand what clinicians can do—not dictate it.</div>
        <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:8px;text-wrap:pretty;">The Summit Adventure Series gives therapists a highly configurable physical platform they can adapt around individual goals, treatment plans, patient capabilities, and therapeutic creativity.</div>

        <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.16em;color:#d02030;font-weight:700;margin-top:26px;padding-bottom:8px;border-bottom:2px solid #203060;">Built Around Clinical Flexibility</div>

        <div style="display:flex;gap:16px;margin-top:18px;">
            <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#d02030;width:26px;flex:none;line-height:1.3;">01</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#203060;line-height:1.3;">Hundreds of Connection Opportunities</div>
              <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">The Adventure Series provides an extensive network of potential attachment locations throughout the structure, allowing clinicians to reposition equipment and create new configurations rather than being limited to only a handful of fixed suspension locations.</div>
            </div>
          </div>

        <div style="display:flex;gap:16px;margin-top:18px;">
            <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#d02030;width:26px;flex:none;line-height:1.3;">02</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#203060;line-height:1.3;">Change the Activity Without Changing the Space</div>
              <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">A single environment can support dramatically different treatment activities throughout the day.</div><div style="margin-top:10px;">
                <div style="font-size:12.5px;color:#203060;line-height:1.5;padding:3px 0 3px 18px;position:relative;font-weight:600;"><span style="position:absolute;left:4px;top:12px;width:8px;height:1.5px;background:#d02030;"></span>The space can evolve from swinging and vestibular input…</div>
                <div style="font-size:12px;color:#20241f;line-height:1.5;padding:3px 0 3px 32px;position:relative;"><span style="position:absolute;left:18px;top:12px;width:8px;height:1.5px;background:#d02030;"></span>to climbing and motor planning…</div>
                <div style="font-size:12px;color:#20241f;line-height:1.5;padding:3px 0 3px 46px;position:relative;"><span style="position:absolute;left:32px;top:12px;width:8px;height:1.5px;background:#d02030;"></span>to strengthening…</div>
                <div style="font-size:12px;color:#20241f;line-height:1.5;padding:3px 0 3px 60px;position:relative;"><span style="position:absolute;left:46px;top:12px;width:8px;height:1.5px;background:#d02030;"></span>to balance…</div>
                <div style="font-size:12px;color:#20241f;line-height:1.5;padding:3px 0 3px 74px;position:relative;"><span style="position:absolute;left:60px;top:12px;width:8px;height:1.5px;background:#d02030;"></span>to an obstacle course…</div>
                <div style="font-size:12.5px;color:#203060;line-height:1.5;padding:3px 0 3px 88px;position:relative;font-weight:600;"><span style="position:absolute;left:74px;top:12px;width:8px;height:1.5px;background:#d02030;"></span>to a completely different therapeutic experience for the next patient.</div>
              </div>
            </div>
          </div>

        <div style="display:flex;gap:16px;margin-top:18px;">
            <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#d02030;width:26px;flex:none;line-height:1.3;">03</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#203060;line-height:1.3;">Designed for Progression</div>
              <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Activities can be modified as ability, confidence, strength, coordination, and treatment objectives change.</div>
            </div>
          </div>

        <div style="display:flex;gap:16px;margin-top:18px;">
            <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#d02030;width:26px;flex:none;line-height:1.3;">04</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#203060;line-height:1.3;">Designed for Creativity</div>
              <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">The Adventure Series gives clinicians the infrastructure. Their expertise determines what happens within it.</div>
            </div>
          </div>

        <div style="flex:1;"></div>
        <div style="font-size:10.5px;color:#9aa1b0;letter-spacing:.04em;padding-top:14px;border-top:1px solid #e6e1d5;">Summit Sensory Gym · SummitSensory.com</div>
      </div>

      <div style="width:236px;flex:none;position:relative;border-radius:6px;overflow:hidden;">
        ${h.img(art, 'p4-photo')}
      </div>
    </div>`;
      },
      // 5 · a platform for therapy, movement and exploration
      function (v, art, h) {
        return `<div class="ssg-fm-page" style="width:816px;height:1056px;flex:none;background:#fff;border-bottom:10px solid #203060;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;color:#20241f;">
      <div style="height:264px;flex:none;position:relative;">
        ${h.img(art, 'p5-photo')}
      </div>
      <div style="flex:1;padding:40px 58px 30px;box-sizing:border-box;display:flex;flex-direction:column;">

        <div style="font-family:'Newsreader',Georgia,serif;font-size:31px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.18;max-width:640px;">A Platform for Therapy, Movement, and Exploration</div>

        <div style="display:flex;gap:30px;margin-top:16px;">
          <div style="flex:1;min-width:0;font-size:12px;color:#20241f;line-height:1.7;text-wrap:pretty;">A Summit Adventure Series system is intentionally designed to support multiple therapeutic objectives within the same environment.</div>
          <div style="flex:1;min-width:0;font-size:12px;color:#20241f;line-height:1.7;text-wrap:pretty;">Rather than dedicating valuable clinical space to numerous isolated pieces of equipment, the Adventure Series creates a centralized platform capable of supporting many different activities.</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px 34px;margin-top:28px;padding-top:26px;border-top:1px solid #dfe3ec;">
          <div>
            <div style="width:26px;height:2.5px;background:#d02030;"></div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#203060;font-weight:700;margin-top:10px;">Sensory Integration</div>
            <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Create opportunities for controlled vestibular, proprioceptive, tactile, and movement-based experiences using a broad range of suspended and floor-based equipment.</div>
          </div>
          <div>
            <div style="width:26px;height:2.5px;background:#d02030;"></div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#203060;font-weight:700;margin-top:10px;">Gross Motor Development</div>
            <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Support activities involving climbing, crawling, reaching, hanging, jumping, navigating obstacles, and whole-body movement.</div>
          </div>
          <div>
            <div style="width:26px;height:2.5px;background:#d02030;"></div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#203060;font-weight:700;margin-top:10px;">Motor Planning</div>
            <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Create changing routes, challenges, sequences, and obstacle configurations that require planning, execution, adaptation, and problem solving.</div>
          </div>
          <div>
            <div style="width:26px;height:2.5px;background:#d02030;"></div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#203060;font-weight:700;margin-top:10px;">Strength &amp; Endurance</div>
            <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Incorporate climbing, hanging, pulling, pushing, suspended activities, and progressive challenges into therapy.</div>
          </div>
          <div>
            <div style="width:26px;height:2.5px;background:#d02030;"></div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#203060;font-weight:700;margin-top:10px;">Balance &amp; Coordination</div>
            <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Build activities requiring postural control, bilateral coordination, dynamic balance, body awareness, and controlled movement.</div>
          </div>
          <div>
            <div style="width:26px;height:2.5px;background:#d02030;"></div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#203060;font-weight:700;margin-top:10px;">Confidence Through Progression</div>
            <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Give clinicians the ability to modify activities so patients can experience challenge while working progressively toward new goals.</div>
          </div>
        </div>

        <div style="flex:1;"></div>
        <div style="font-size:10.5px;color:#9aa1b0;letter-spacing:.04em;padding-top:14px;border-top:1px solid #eceef4;">Summit Sensory Gym · SummitSensory.com</div>
      </div>
    </div>`;
      },
      // 6 · amazing therapy starts with a strong foundation
      function (v, art, h) {
        return `<div class="ssg-fm-page" style="width:816px;height:1056px;flex:none;background:#fff;border-bottom:10px solid #203060;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;color:#20241f;">
      <div style="flex:1;padding:52px 58px 30px;box-sizing:border-box;display:flex;flex-direction:column;">

        <div style="display:flex;gap:34px;align-items:flex-start;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.16em;color:#d02030;font-weight:700;">Engineering</div>
            <div style="font-family:'Newsreader',Georgia,serif;font-size:32px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.16;margin-top:12px;">Amazing Therapy Starts With a Strong Foundation.</div>
          </div>
          <div style="width:300px;flex:none;border-left:2px solid #d02030;padding-left:20px;">
            <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#20241f;line-height:1.4;">Clinical versatility matters.</div>
            <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:8px;">But when an organization invests in a large therapy structure, versatility alone is not enough. The system also needs to inspire confidence in the people responsible for approving, installing, maintaining, and using it.</div>
            <div style="font-size:12px;color:#203060;font-weight:600;line-height:1.7;margin-top:8px;">That is why engineering is an integral part of the Summit Adventure Series.</div>
          </div>
        </div>

        <div style="display:flex;gap:16px;margin-top:30px;align-items:stretch;">

          <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:16px;">
            <div style="border:1px solid #dfe3ec;border-top:2.5px solid #203060;padding:16px 18px;box-sizing:border-box;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:16px;font-weight:700;color:#203060;line-height:1.3;">Designed With Purpose</div>
              <div style="font-size:11.5px;color:#20241f;line-height:1.68;margin-top:7px;text-wrap:pretty;">The Adventure Series combines commercial-grade structural components, engineered connection points, purpose-built hardware, and a configurable structural system designed for demanding therapy environments.</div>
            </div>
            <div style="border:1px solid #dfe3ec;border-top:2.5px solid #203060;padding:16px 18px;box-sizing:border-box;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:16px;font-weight:700;color:#203060;line-height:1.3;">Purpose-Built Structural Components</div>
              <div style="font-size:11.5px;color:#20241f;line-height:1.68;margin-top:7px;text-wrap:pretty;">The Adventure Series is not assembled from improvised recreational equipment. Structural members, connection components, hardware, attachment locations, and supporting systems are selected and configured specifically for the intended therapy environment.</div>
            </div>
            <div style="position:relative;flex:1;min-height:200px;border-radius:6px;overflow:hidden;">
              ${h.img(art, 'p6-photo')}
            </div>
          </div>

          <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:16px;">
            <div style="border:1px solid #dfe3ec;border-top:2.5px solid #203060;padding:16px 18px;box-sizing:border-box;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:16px;font-weight:700;color:#203060;line-height:1.3;">Third-Party Engineering</div>
              <div style="font-size:11.5px;color:#20241f;line-height:1.68;margin-top:7px;text-wrap:pretty;">Summit Sensory Gym incorporates third-party engineering review/approval into the Adventure Series program where applicable, providing another level of professional confidence in the structural system.</div>
            </div>
            <div style="border:1px solid #dfe3ec;border-top:2.5px solid #203060;padding:16px 18px;box-sizing:border-box;flex:1;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:16px;font-weight:700;color:#203060;line-height:1.3;">Designed for Professional Environments</div>
              <div style="font-size:11.5px;color:#20241f;line-height:1.68;margin-top:7px;text-wrap:pretty;">The system is intended for frequent use within:</div>
              <div style="margin-top:10px;">
                <div style="font-size:11.5px;color:#20241f;line-height:1.5;padding:3px 0 3px 13px;position:relative;"><span style="position:absolute;left:0;top:10px;width:4px;height:4px;border-radius:50%;background:#d02030;"></span>Pediatric therapy clinics</div>
                <div style="font-size:11.5px;color:#20241f;line-height:1.5;padding:3px 0 3px 13px;position:relative;"><span style="position:absolute;left:0;top:10px;width:4px;height:4px;border-radius:50%;background:#d02030;"></span>Hospitals</div>
                <div style="font-size:11.5px;color:#20241f;line-height:1.5;padding:3px 0 3px 13px;position:relative;"><span style="position:absolute;left:0;top:10px;width:4px;height:4px;border-radius:50%;background:#d02030;"></span>Rehabilitation programs</div>
                <div style="font-size:11.5px;color:#20241f;line-height:1.5;padding:3px 0 3px 13px;position:relative;"><span style="position:absolute;left:0;top:10px;width:4px;height:4px;border-radius:50%;background:#d02030;"></span>Schools</div>
                <div style="font-size:11.5px;color:#20241f;line-height:1.5;padding:3px 0 3px 13px;position:relative;"><span style="position:absolute;left:0;top:10px;width:4px;height:4px;border-radius:50%;background:#d02030;"></span>Universities</div>
                <div style="font-size:11.5px;color:#20241f;line-height:1.5;padding:3px 0 3px 13px;position:relative;"><span style="position:absolute;left:0;top:10px;width:4px;height:4px;border-radius:50%;background:#d02030;"></span>Behavioral health programs</div>
                <div style="font-size:11.5px;color:#20241f;line-height:1.5;padding:3px 0 3px 13px;position:relative;"><span style="position:absolute;left:0;top:10px;width:4px;height:4px;border-radius:50%;background:#d02030;"></span>Specialized treatment centers</div>
                <div style="font-size:11.5px;color:#20241f;line-height:1.5;padding:3px 0 3px 13px;position:relative;"><span style="position:absolute;left:0;top:10px;width:4px;height:4px;border-radius:50%;background:#d02030;"></span>Other professional therapy environments</div>
              </div>
            </div>
          </div>

        </div>

        <div style="flex:1;"></div>
        <div style="margin-top:20px;padding:18px 0;border-top:1px solid #dfe3ec;border-bottom:1px solid #dfe3ec;text-align:center;">
          <div style="font-family:'Newsreader',Georgia,serif;font-size:22px;font-weight:700;color:#203060;letter-spacing:-.02em;line-height:1.3;">Engineered for Movement.&nbsp;<span style="color: rgb(208, 32, 48);">Designed for Limitless Possibilities.</span></div>
        </div>
      </div>
    </div>`;
      },
      // 7 · today's therapy space should not limit tomorrow's ideas
      function (v, art, h) {
        return `<div class="ssg-fm-page" style="width:816px;height:1056px;flex:none;background:#fff;border-bottom:10px solid #203060;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;color:#20241f;">
      <div style="flex:1;padding:64px 62px 34px;box-sizing:border-box;display:flex;flex-direction:column;">

        <div style="width:54px;height:3px;background:#d02030;"></div>
        <div style="font-family:'Newsreader',Georgia,serif;font-size:31px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.18;margin-top:16px;max-width:600px;">Today's Therapy Space Should Not Limit Tomorrow's Ideas.</div>

        <div style="display:flex;gap:44px;margin-top:38px;align-items:flex-start;">
          <div style="width:340px;flex:none;">
            <div style="font-family:'Newsreader',Georgia,serif;font-size:19px;font-weight:600;color:#203060;line-height:1.35;margin-bottom:10px;">Organizations change.</div>
            <div style="font-family:'Newsreader',Georgia,serif;font-size:19px;font-weight:600;color:#203060;line-height:1.35;margin-bottom:10px;">Programs expand.</div>
            <div style="font-family:'Newsreader',Georgia,serif;font-size:19px;font-weight:600;color:#203060;line-height:1.35;margin-bottom:10px;">Clinicians discover new treatment approaches.</div>
            <div style="font-family:'Newsreader',Georgia,serif;font-size:19px;font-weight:600;color:#203060;line-height:1.35;margin-bottom:10px;">New equipment becomes available.</div>
            <div style="font-family:'Newsreader',Georgia,serif;font-size:19px;font-weight:600;color:#203060;line-height:1.35;margin-bottom:10px;">Patient populations evolve.</div>
          </div>
          <div style="flex:1;min-width:0;padding-top:4px;">
            <div style="font-size:12.5px;color:#20241f;line-height:1.75;text-wrap:pretty;">The Adventure Series was created with that reality in mind.</div>
            <div style="font-size:12.5px;color:#20241f;line-height:1.75;margin-top:12px;text-wrap:pretty;">Its modular design and extensive attachment opportunities allow the therapy environment to remain useful beyond the initial equipment configuration.</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:26px 44px;margin-top:44px;padding-top:30px;border-top:1px solid #dfe3ec;">
          <div>
            <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.13em;color:#203060;font-weight:700;">Add New Activities</div>
            <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Introduce additional compatible therapeutic equipment as your needs evolve.</div>
          </div>
          <div>
            <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.13em;color:#203060;font-weight:700;">Reconfigure Existing Activities</div>
            <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Move equipment between attachment locations and create different treatment environments.</div>
          </div>
          <div>
            <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.13em;color:#203060;font-weight:700;">Adapt Around Different Patients</div>
            <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Create different levels of challenge and support for varying abilities and therapy objectives.</div>
          </div>
          <div>
            <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.13em;color:#203060;font-weight:700;">Expand Program Capabilities</div>
            <div style="font-size:12px;color:#20241f;line-height:1.7;margin-top:6px;text-wrap:pretty;">Use the same foundational structure to support new treatment ideas, programs, clinicians, and therapeutic applications.</div>
          </div>
        </div>

        <div style="display:flex;gap:18px;margin-top:40px;flex:none;">
          <div style="flex:1;min-width:0;position:relative;height:210px;border-radius:6px;overflow:hidden;">
            ${h.img(art, 'p7-photo')}
          </div>
          <div style="flex:1;min-width:0;position:relative;height:210px;border-radius:6px;overflow:hidden;">
            ${h.img(art, 'p7b-photo')}
          </div>
        </div>

        <div style="flex:1;"></div>

        <div style="font-family:'Newsreader',Georgia,serif;font-size:15px;font-weight:600;color:#203060;line-height:1.4;padding-top:22px;border-top:1px solid #dfe3ec;text-align:center;white-space:nowrap;">Your Investment Should Create Possibilities Today—Without Closing the Door on Tomorrow.</div>
      </div>
    </div>`;
      },
      // 8 · one investment, value across your organization
      function (v, art, h) {
        return `<div class="ssg-fm-page" style="width:816px;height:1056px;flex:none;background:#fbfaf6;border-bottom:10px solid #203060;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;color:#20241f;">

      <div style="background:#fff;padding:52px 58px 34px;box-sizing:border-box;flex:none;border-bottom:1px solid #e4e0d4;">
        <div style="font-family:'Newsreader',Georgia,serif;font-size:32px;font-weight:700;color:#203060;letter-spacing:-.026em;line-height:1.18;max-width:600px;">One Investment. Value Across Your Organization.</div>
        <div style="display:flex;gap:34px;margin-top:18px;">
          <div style="flex:1;min-width:0;font-size:12.5px;color:#20241f;line-height:1.7;">The strongest capital purchases create value beyond the product itself.</div>
          <div style="flex:1;min-width:0;font-size:12.5px;color:#20241f;line-height:1.7;">The Summit Adventure Series can support multiple organizational priorities simultaneously.</div>
        </div>
      </div>

      <div style="flex:1;padding:14px 58px 30px;box-sizing:border-box;display:flex;flex-direction:column;">
        <div>
          <div style="display:flex;gap:26px;align-items:flex-start;padding:18px 0;border-bottom:1px solid #e4e0d4;">
            <div style="width:186px;flex:none;font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:#d02030;font-weight:700;line-height:1.5;padding-top:3px;">For clinicians</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#203060;line-height:1.3;">More therapeutic flexibility</div>
              <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:5px;text-wrap:pretty;">A configurable environment provides more opportunities to adapt activities around individual treatment goals.</div>
            </div>
          </div>
          <div style="display:flex;gap:26px;align-items:flex-start;padding:18px 0;border-bottom:1px solid #e4e0d4;">
            <div style="width:186px;flex:none;font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:#d02030;font-weight:700;line-height:1.5;padding-top:3px;">For patients &amp; families</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#203060;line-height:1.3;">A therapy environment designed to engage</div>
              <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:5px;text-wrap:pretty;">A dynamic space can create opportunities for movement, exploration, challenge, success, and progression.</div>
            </div>
          </div>
          <div style="display:flex;gap:26px;align-items:flex-start;padding:18px 0;border-bottom:1px solid #e4e0d4;">
            <div style="width:186px;flex:none;font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:#d02030;font-weight:700;line-height:1.5;padding-top:3px;">For clinical leadership</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#203060;line-height:1.3;">Expanded program capability</div>
              <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:5px;text-wrap:pretty;">Provide teams with an infrastructure capable of supporting numerous therapy activities within one environment.</div>
            </div>
          </div>
          <div style="display:flex;gap:26px;align-items:flex-start;padding:18px 0;border-bottom:1px solid #e4e0d4;">
            <div style="width:186px;flex:none;font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:#d02030;font-weight:700;line-height:1.5;padding-top:3px;">For administration</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#203060;line-height:1.3;">Long-term utility</div>
              <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:5px;text-wrap:pretty;">Rather than investing in a single-purpose piece of equipment, the organization invests in a platform that can support numerous configurations and applications.</div>
            </div>
          </div>
          <div style="display:flex;gap:26px;align-items:flex-start;padding:18px 0;border-bottom:1px solid #e4e0d4;">
            <div style="width:186px;flex:none;font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:#d02030;font-weight:700;line-height:1.5;padding-top:3px;">For facilities</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#203060;line-height:1.3;">A planned installation</div>
              <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:5px;text-wrap:pretty;">Summit works with the organization to address frame configuration, room conditions, access, delivery, installation, padding, and other physical considerations.</div>
            </div>
          </div>
          <div style="display:flex;gap:26px;align-items:flex-start;padding:18px 0;border-bottom:2px solid #203060;">
            <div style="width:186px;flex:none;font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;color:#d02030;font-weight:700;line-height:1.5;padding-top:3px;">For purchasing &amp; finance</div>
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Newsreader',Georgia,serif;font-size:17px;font-weight:700;color:#203060;line-height:1.3;">A clearly defined investment</div>
              <div style="font-size:11.5px;color:#20241f;line-height:1.7;margin-top:5px;text-wrap:pretty;">Detailed equipment, pricing, freight treatment, payment requirements, and project terms provide transparency for organizational review and approval.</div>
            </div>
          </div>
        </div>
        <div style="flex:1;"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:20px;padding-top:16px;">
          <div style="font-size:10.5px;color:#9aa1b0;letter-spacing:.04em;">Summit Sensory Gym · SummitSensory.com</div>
          <img src="logo.png" alt="Summit Sensory Gym" style="width:44px;height:44px;display:block;flex:none;">
        </div>
      </div>
    </div>`;
      },
    ],
  });
})();
