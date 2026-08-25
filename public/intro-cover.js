/**
 * The plain cover — one page, no product.
 *
 * Every other introduction here speaks for a specific product line: Adventure, Soar,
 * Flex. A proposal that is a mix of things, or a piece of work that is not a series at
 * all, had no cover to open with and started on the pricing table.
 *
 * This is that cover, and nothing else. The same layout as the product covers — navy
 * bars, the logo lockup, a red rule, the headline in the serif, the customer, and the
 * proposal and rep details along the foot — with the product name and the product
 * paragraph taken out and a line about the company put in their place.
 *
 * It never claims a document. `matches` returns false on purpose: a template that
 * recognised "any proposal" would take documents away from the product covers, which
 * are more specific and always better when they apply. The rep picks this one under
 * Introduction on the proposal builder.
 *
 * No photography, so it lists no slots and adds nothing to Admin -> Proposal
 * introductions.
 */
(function () {
  'use strict';
  if (!window.SSGFrontMatter) return;

  var H = window.SSGFrontMatter;

  var PAGE =
    'width:816px;height:1056px;flex:none;background:#fff;border-bottom:10px solid #203060;' +
    'box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;color:#20241f;';
  var SERIF = "'Newsreader',Georgia,serif";

  H.register({
    id: 'COVER',
    label: 'Cover page only',
    matches: function () {
      return false;
    },
    slots: [],

    pages: [
      function (v) {
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
          '<div style="width:54px;height:3px;background:#d02030;"></div>' +
          // One sentence per line. The three-part rhythm carries the emphasis, so the
          // red stays on the rule alone rather than splitting the headline in two.
          '<div style="font-family:' +
          SERIF +
          ';font-size:43px;font-weight:700;color:#203060;letter-spacing:-.028em;line-height:1.16;margin-top:20px;max-width:620px;">Purposeful Solutions.<br>Thoughtfully Designed.<br>Built Around You.</div>' +
          '<div style="font-size:14.5px;color:#4b5468;line-height:1.68;margin-top:16px;max-width:596px;text-wrap:pretty;">Customized therapy equipment and solutions designed to support your space, your goals, and the people you serve.</div>' +
          '<div style="height:28px;"></div>' +
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
    ],
  });
})();
