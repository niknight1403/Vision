# eBay Browse API (read-only)

The API has an optional eBay Browse adapter in `src/providers/ebay-browse-adapter.ts`.
It uses the official Buy Browse API keyword search endpoint and the OAuth client-credentials
application token flow. The default marketplace is Germany (`EBAY_DE`).

Configure these values only in the API server's secret environment:

- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- optional `EBAY_MARKETPLACE_ID` (defaults to `EBAY_DE`)

If both credentials are absent, the adapter is not configured. Supplying only one is a
startup/configuration error. Never place the client secret in Expo/mobile variables or source
control.

This adapter intentionally implements only `PRODUCT_SEARCH`. It does not place bids, buy,
contact sellers, publish listings, or change orders. Browse results are active listing asking
prices, not completed-sale evidence and not a verified resale valuation. Do not use them alone
to claim a bargain or expected profit. A separate sold-comparables provider and cost/risk
analysis are required.

The adapter requests up to 50 results, caches the OAuth application token in process memory,
checks response shape, currency, item URLs, and integer minor-unit price conversion. It is
not globally enabled until credentials are provisioned and the deployment explicitly registers
the adapter. Sandbox and production credentials are distinct; this implementation targets
the production API host. Verify API eligibility, marketplace access, and eBay Buy API terms
for the application before production use.

Official references:
- https://developer.ebay.com/develop/api/buy/browse_api
- https://developer.ebay.com/api-docs/static/oauth-credentials.html
