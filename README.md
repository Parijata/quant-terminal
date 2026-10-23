# Quant Terminal

Quant Terminal is a free trading charts app that runs on your computer. It is for learning and research. It does not place real trades.

## What it includes

- Charts for stocks, indices, crypto, forex and other symbols supported by the data sources
- Indicators and drawing tools
- Watchlists, alerts, news and market calendars
- Screener, heatmap and company information
- Paper trading, replay and strategy testing

Some markets and timeframes have limited free data. See [Data sources and limits](#data-sources-and-limits).

## Start on Windows

1. Install [Node.js 18 or newer](https://nodejs.org/). The LTS version is fine.
2. Download this repository from GitHub, or clone it with GitHub Desktop.
3. Open the downloaded folder.
4. Double-click **`start.bat`**.
5. The app opens in your browser. If it does not, go to **http://localhost:3777**.

To open it again later, double-click **`start.bat`** again.

There is no `npm install` step.

## Start on Mac or Linux

Install Node.js 18 or newer, open a terminal in this folder, and run:

```sh
./start.sh
```

## Get updates from GitHub

On another computer, install GitHub Desktop and choose **File → Clone repository**. Search for **Parijata/quant-terminal**, choose a folder, and clone it. Then follow the Windows steps above.

To get code updates later, close the app, open the repository in GitHub Desktop, choose **Fetch origin**, then **Pull origin**, and start the app again.

## Your data stays on your computer

Watchlists, chart settings, drawings, alerts and paper-trading records are saved in the `data/` folder. This folder is not uploaded to GitHub. To move your data to another computer, close the app and copy that folder separately. Do not upload API keys or private data.

## Data sources and limits

Quant Terminal uses public data sources, which can be delayed, rate-limited or unavailable. What symbols and timeframes work depends on the source. Indian and US stocks, indices, crypto and other markets may have different history limits. Free sources do not provide historical seconds candles for Indian stocks.

Optional provider credentials and setup notes are in [Indian market data setup](docs/india-market-data.md). Keep credentials in local files under `data/` and never commit them to GitHub.

## Useful commands

Run these from a terminal opened in the app folder:

| Command | What it does |
|---|---|
| `npm start` | Start the app and open the browser |
| `npm run serve` | Start without opening the browser |
| `npm run doctor` | Check Node.js and public data connections |
| `npm test` | Run the automated tests |

## More information

- [How to add your own indicators](docs/custom-indicators.md)
- [Local API guide](docs/api.md)
- [Deployment notes](DEPLOY.md)
- [License](LICENSE)

Quant Terminal is independent software and is not affiliated with any exchange or charting platform. Nothing in the app is financial advice.
