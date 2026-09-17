# Basket

A React + Vite frontend for launching a Pump.fun token and splitting its creator
fees between a basket of up to five X recipients.

This is a frontend preview. The forms, allocations, token preview and animations
work locally. Wallet connection, token creation and real payments are not connected.

## Run locally

Install Node.js 22.12 or newer, then:

```sh
git clone https://github.com/grubbyhat/basket-site.git
cd basket-site
npm ci
npm run dev
```

Open [localhost:5274](http://127.0.0.1:5274).
No API keys or environment variables are needed to run the frontend.

## What's included

- Home page with zero starting metrics and an interactive example basket.
- Launch form with token name, ticker, image, description and optional X link.
- Automatic website link using the current site's root URL.
- Up to five unique recipients, custom percentages and exact even splitting.
- Optional SOL dev buy, without bundle controls.
- Raised token preview and animated example payout cards.
- Animated capital flow: fee coins travel every stage, turn into dollars at conversion, split by
  share at X Money and land on each recipient. Stages are clickable, with a split calculator below.
- Payments page with empty states, documentation and dark/light themes.
- Responsive layouts, keyboard controls, a pausable payout preview and reduced-motion support.

Text drafts are saved in browser-local storage. Images stay in memory and need to
be selected again after a reload. Example payout animations are illustrative;
the displayed payment totals start at zero.

## Build

```sh
npm run build
npm run preview
```

The production output is in `dist/`. A static host must rewrite application routes
such as `/launch`, `/payments`, `/capital-flow` and `/docs` to `index.html`.
Publishing this repository does not deploy a live website.

## Checks

```sh
npm test
npm run build
```

With the local site running, browser and motion checks are also available:

```sh
npm run test:browser
npm run test:motion
```

These use an installed Chrome/Chromium executable. The default location is
Google Chrome's standard Windows installation; set `CHROME_PATH` to the executable
on your machine when needed. Set `BASKET_URL` to test a different local address.
Screenshots and reports are written to the ignored `artifacts/` directory.

The checks cover responsive routes, both themes, accessibility, validation,
image upload errors, draft persistence, keyboard behavior, coin movement through
every stage, payouts landing on recipients, offscreen freezing, artwork hover and
reduced motion. `npm run test:tail` screenshots the running flow and measures the pixel gap
between a trunk coin and the end of its tail; away from a node it should read 0.

## Backend work remains

Live operation needs an authenticated launch service, verified recipient identities,
fee collection and conversion, durable allocation and payment records, X Money
integration, and confirmed payment totals. The preview does not send funds or
connect to an external launch or payment API.

## Design and assets

The visual direction references [UsePaid](https://usepaid.app/), with guidance from
[Emil Kowalski's design engineering skill](https://github.com/emilkowalski/skills)
and [Taste Skill](https://github.com/leonxlnx/taste-skill).
Typography uses self-hosted Geist; icons use Phosphor.

The silver basket illustration is original AI-generated artwork included as
optimized WebP assets in `public/`. It depicts interlaced brushed-silver ribbons
holding three polished coin discs against a dark background.
