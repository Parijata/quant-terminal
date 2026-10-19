# Indian market data

The **Option chain** and **FII/DII & deals** panels first try the NSE/BSE public website data. NSE can rate-limit or block automated requests; the app shows the exchange response and keeps the page usable. Option-chain data can then be requested from an authenticated Upstox or Dhan account.

## Optional broker data

Open **Settings → Broker API settings**. Broker credentials are written to `data/broker.json`, which is inside the git-ignored `data/` folder and is not served by the local web server. The browser receives only whether credentials are configured and how many instrument mappings exist. The app does not log credential values. The file is plain text, so protect the computer account and do not copy the file when sharing the app folder.

Add a mapping per chart symbol. The key is the full symbol, for example `YAHOO:RELIANCE.NS`:

```json
{
  "YAHOO:RELIANCE.NS": {
    "instrumentToken": "738561",
    "exchange": "NSE",
    "tradingsymbol": "RELIANCE"
  }
}
```

Mapping fields depend on provider:

- Kite: `instrumentToken`, `exchange`, `tradingsymbol`
- Upstox: `instrumentKey` (for example `NSE_EQ|INE002A01018`)
- Angel One: `exchange`, `symbolToken`, `tradingsymbol`
- Dhan: `securityId`, `exchangeSegment`, `instrument`

Kite, Upstox, Angel One and Dhan mappings can supply chart candles and quote snapshots. Access, history depth, rate limits and quote freshness follow the broker account and plan. If a broker request fails, the chart falls back to the public data provider and shows the reason in the chart data note.

For the broker option-chain fallback, Upstox uses an underlying instrument key (Nifty and Bank Nifty have known defaults; other symbols need `optionInstrumentKey`) and Dhan uses `securityId`/`exchangeSegment` for the underlying. The app calculates PCR and max pain from the returned chain. Kite and Angel One do not currently provide this app with a native chain endpoint, so their data can still power charts while NSE public data supplies option chains when available.

## Public sources and broker API references

- [NSE FII/FPI & DII reports](https://www.nseindia.com/reports/fii-dii)
- [BSE bulk deal reports](https://www.bseindia.com/markets/equity/EQReports/bulk_deals.aspx)
- [Kite market quotes and instruments](https://kite.trade/docs/connect/v3/market-quotes/)
- [Upstox option chain API](https://upstox.com/developer/api-documentation/get-pc-option-chain/)
- [Dhan option-chain API](https://dhanhq.co/docs/v2/option-chain/)
- [Angel One SmartAPI documentation](https://smartapi.angelbroking.com/docs)
