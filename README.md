# StartUpWinner keyless Action

Reads Stripe, App Store Connect, Google Play and RevenueCat with keys kept in **your** repository's secrets, and sends [StartUpWinner](https://start-up-winner.vercel.app) only the results (revenue numbers, review and release status). Your keys never leave GitHub Actions.

Copy the ready-made workflow from your project's **Connections → Keyless mode** in StartUpWinner: it has your project's address filled in and this Action pinned to an exact commit, so your keys only ever meet code you chose.

```yaml
- uses: IoDev1/startupwinner-action@<commit>   # pin to a commit, never a branch
  with:
    token: ${{ secrets.STARTUPWINNER_TOKEN }}   # Connections → Keyless mode → New token
    api-url: https://start-up-winner.vercel.app
    stripe-key: ${{ secrets.STRIPE_RESTRICTED_KEY }}             # read-only restricted key; refused if it can write
    app-store-key-id: ${{ secrets.ASC_KEY_ID }}                   # Developer role, never Admin
    app-store-issuer-id: ${{ secrets.ASC_ISSUER_ID }}
    app-store-private-key: ${{ secrets.ASC_PRIVATE_KEY }}
    play-service-account: ${{ secrets.PLAY_SERVICE_ACCOUNT }}     # only "View app information"
    revenuecat-key: ${{ secrets.REVENUECAT_KEY }}                 # V2 secret key with only charts_metrics:overview:read
    revenuecat-project-id: proj1a2b3c4d
    revenuecat-currency: USD
```

`dist/index.mjs` is the bundled Action that runs; it's built from the StartUpWinner repository and published here unchanged.
