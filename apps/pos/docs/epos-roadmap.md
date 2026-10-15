# Small-business EPOS integration roadmap

The initial market is independent cafés, corner stores, and owner-operated small businesses. The rollout should begin with local pilot merchants whose owners can choose their payment methods. Large grocery chains and enterprise retail integrations are outside the initial scope.

The first app version uses manual cashier amount entry. Production café checkout should show the original local-currency total and an explicit BSV quote before requesting payment; the initial technical build uses satoshis and does not yet provide an exchange-rate quote service. Never silently interpret a currency total as satoshis.

The next step is an integration with an EPOS platform commonly used by the target pilot merchants. Epos Now is an initial candidate identified by the product owner. No global market-share ranking has been established. Choose the first partner based on local merchant adoption, integration access, and the ability to launch an external payment flow and reconcile the result.

Evaluate an EPOS plugin or app that transfers the outstanding total, currency, sale reference, merchant/store identity and till identity into the payment app. It should return merchant-confirmed payment status against the same sale reference. A QR handoff may transfer the request where supported, but a QR carrying the total does not itself mark the EPOS order paid.

Before committing to a provider, verify its documented extension/API capabilities, external-tender rules, app approval requirements, commercial terms, refund support, and partial-payment behavior. These details remain to be researched for Epos Now and any other shortlisted platform.

The integration boundary should preserve the EPOS sale reference separately from our payment invoice, use integer minor currency units, carry quote expiry and rounding policy, and prevent duplicate settlement. A timeout must trigger a status lookup rather than a second charge. Payment success means merchant wallet acceptance; EPOS reconciliation is tracked separately so a failed update to the till never asks the customer to pay twice.

Pilot success is measured by setup time, checkout speed, amount-entry errors, duplicate-payment prevention, reliable receipts, and merchant reconciliation. Integration work follows feedback from these pilots.

## Initial research — October 14, 2026

Rollout priority: United States first; European Union second. The UK is not a substitute for EU market research.

There is no verified single global winner across startups, cafés, and local retail. The following evidence measures different populations and must not be combined into a single market-share ranking.

- **Square:** Block's 2025 annual filing reports more than 4.5 million Square ecosystem sellers. This is ecosystem reach, not the count of installed EPOS tills or café-specific market share. Joe Coffee's independent-café analysis finds Square frequently, but detects public ordering and e-commerce signatures; it is not a representative survey of installed counter POS systems. Its category shares overlap, so do not repeat its headline percentage as US café market share. Sources: https://d18rn0p25nwr6d.cloudfront.net/CIK-0001512673/c9d5d108-cbf1-40ce-8754-71638e17765a.pdf and https://joe.coffee/blog/posts/coffee-shop-pos-software/
- **Clover and Toast:** Restaurant Dive reports Baird's January 2026 estimate for restaurants below the top 250 chains: Clover 20% and Toast 17% of the small-restaurant POS card-processing market. This is broader than independent cafés and measures card-processing share. Source: https://www.restaurantdive.com/news/toast-clover-battle-for-small-eateries/809137/
- **Clover integration:** Official documentation describes custom tender apps launched from Register/Sale, with payment amount and order context and a result returned to the host. This is a promising fit for a BSV external-payment plugin. Hardware, native Android bridging, app review, permission, commercial and crypto-acceptance rules still need validation. Sources: https://docs.clover.com/dev/docs/custom-tenders and https://docs.clover.com/dev/docs/creating-custom-tender-apps
- **Square integration:** Square supports named custom payment methods for recording external transactions, and its Payments API records external payments. Neither establishes an automatic outgoing launch from the stock Square POS app into our app. The Point of Sale API instead lets another app launch Square to take Square payments. Validate the actual outbound handoff before promising a seamless plugin. Recording external orders through Square's Orders API can incur fees. Sources: https://squareup.com/help/us/en/article/8611-capture-external-transactions-using-custom-payment-methods and https://developer.squareup.com/docs/payments-api/take-payments/external-payments and https://developer.squareup.com/docs/pos-api/what-it-does
- **Toast integration:** Official APIs support alternative payment types, but an in-store checkout handoff and partner access require separate validation. Source: https://doc.toasttab.com/doc/devguide/apiSubmittingPaymentsIntro.html
- **EU follow-up:** SumUp reports more than four million businesses across 38 markets globally, which does not establish EU installed-POS dominance. Country-specific pilots should also evaluate local adoption and provider permissions. Source: https://www.sumup.com/en-gb/press/
- **Epos Now:** Its own site reports over 80,000 business locations globally, without establishing dominance in the US target segment. Source: https://www.eposnow.com/us/about-us/

Recommendation: interview local US pilot merchants to validate Square and Clover usage. Use Square as a leading adoption candidate for cafés; prioritize a Clover custom-tender feasibility spike for the first fully integrated plugin. Retain manual entry for the app's first technical version. No EPOS plugin is implemented in this change.
