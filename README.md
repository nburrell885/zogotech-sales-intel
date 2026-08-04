# ZogoTech Sales Intel

Pipedrive reporting with a live refresh, IPEDS enrichment and RFPSchoolWatch ingestion.

Built to be boring and portable. No platform-specific features, no database, no
build step. It runs the same on Railway, on ZogoTech infrastructure, or on a laptop.

## Run it

```bash
cp .env.example .env      # fill in the keys
npm install
npm run refresh           # one pull, writes data/snapshot.json
npm start                 # http://localhost:3000
```

## What it does

`POST /api/refresh` pulls three sources and writes a single snapshot to disk.
Reports read `GET /api/data`, so a page load never waits on Pipedrive.

**Pipedrive** — deals, activities, notes, organisations, stages, users and leads.
Uses the REST API rather than the MCP connector, which cannot reach leads.

**IPEDS** — the Urban Institute Education Data Portal. Open, unauthenticated, no key.
Matches your Pipedrive organisations to IPEDS unit IDs so accounts can be ranked by
completion and enrollment trend.

**RFPSchoolWatch** — reads the daily alert from Gmail, takes the CSV attachment,
dedupes on Doc ID and matches the institution against Pipedrive.

## Three things worth knowing

**ARR is not `value`.** Pipedrive stores ARR on the deal in `arr`, while `value`
is contract value and runs roughly three times higher. Never total `value` and
call it ARR. This is the single mistake that makes every downstream number wrong.

**Matching is never automatic.** `src/lib/match.js` returns matched, review and
unmatched. Anything below the accept threshold goes to a human. Three systems
spell the same college three different ways and a wrong match is worse than none.

**Gmail access is read-only and label-scoped.** The app cannot send, delete or
read anything outside the RFPSchoolWatch label. The mailbox belongs to ZogoTech,
so register the OAuth client in their Google Cloud project, not in yours. Expect
their Workspace admin to have to approve it.

## Setup notes

**Pipedrive token** — Settings, Personal preferences, API.

**Anthropic key** — use a separate workspace so spend and revocation are isolated
from other work.

**Google OAuth** — enable the Gmail API in the Google Cloud project that owns the
mailbox, create an OAuth client, then run `npm run auth:google` locally once and
put the printed refresh token in `.env`. Never run that script on the server.

**IPEDS endpoints** — names change between portal releases. Run
`npm run probe:ipeds 2022` to see which respond and what fields they return
before wiring a report to one.

## Moving it to ZogoTech

Nothing here is Railway-specific. Point their platform at this repo, or build the
Dockerfile and run it anywhere. Copy `data/` across and the history comes with it.
The only things that change are the environment variables.

## Attribution

IPEDS data is licensed ODC-By 1.0 and attribution is a condition of use. The
string in `src/lib/ipeds.js` must appear wherever that data is shown.
