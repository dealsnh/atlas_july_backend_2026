# Tina Atlas — County Lead Status
**Report date:** 2026-06-15  
**Production URL:** https://web-production-62118.up.railway.app

## Summary
- **Complete leads in portal:** 231
- **Pending (scraped, awaiting enrichment):** 173
- **Lead types live:** Tax Delinquent (223), Sheriff Sale (8)
- **Counties with complete leads:** 4 of 19

## County overview
| County | State | Complete leads | Pending | Configured types | Overall |
|--------|-------|----------------|---------|------------------|---------|
| Jackson | MO | 99 | 0 | 4 | **Live** |
| Clay | MO | 0 | 5 | 4 | Scraped — pending only |
| Platte | MO | 0 | 0 | 4 | Next up (SC/WI/remaining MO) |
| Cass | MO | 17 | 10 | 4 | **Live** |
| Hamilton | OH | 99 | 1 | 4 | **Live** |
| Jefferson | AL | 0 | 27 | 4 | Partial — enrichment in progress |
| Madison | AL | 16 | 47 | 4 | **Live** |
| Shelby | AL | 0 | 16 | 4 | Partial — enrichment in progress |
| Morgan | AL | 0 | 17 | 4 | Partial — enrichment in progress |
| Limestone | AL | 0 | 18 | 4 | Partial — enrichment in progress |
| Montgomery | AL | 0 | 13 | 4 | Partial — enrichment in progress |
| Autauga | AL | 0 | 9 | 4 | Scraped — pending only |
| Elmore | AL | 0 | 10 | 4 | Partial — enrichment in progress |
| Horry | SC | 0 | 0 | 5 | Next up (SC/WI/remaining MO) |
| Georgetown | SC | 0 | 0 | 5 | Next up (SC/WI/remaining MO) |
| Marion | SC | 0 | 0 | 5 | Next up (SC/WI/remaining MO) |
| Dane | WI | 0 | 0 | 5 | Next up (SC/WI/remaining MO) |
| Rock | WI | 0 | 0 | 5 | Next up (SC/WI/remaining MO) |
| Door | WI | 0 | 0 | 5 | Next up (SC/WI/remaining MO) |

## Lead type detail (validation sample)
| County | State | Lead type | Scrape test | Portal |
|--------|-------|-----------|-------------|--------|
| Jackson | MO | Tax Delinquent | PASS | Live (validated) |
| Jackson | MO | Sheriff Sale | FAIL | Partial |
| Jackson | MO | Probate | FAIL | Needs work |
| Jackson | MO | Pre-Foreclosure | FAIL | Needs work |
| Clay | MO | Tax Delinquent | SCRAPE_ONLY | Pending enrichment |
| Clay | MO | Sheriff Sale | SCRAPE_ONLY | Pending enrichment |
| Clay | MO | Probate | FAIL | In progress |
| Clay | MO | Pre-Foreclosure | FAIL | In progress |
| Platte | MO | Tax Delinquent | FAIL | Needs work |
| Platte | MO | Sheriff Sale | FAIL | Needs work |
| Platte | MO | Probate | FAIL | Needs work |
| Platte | MO | Pre-Foreclosure | FAIL | Needs work |
| Cass | MO | Tax Delinquent | PASS | Live (validated) |
| Cass | MO | Sheriff Sale | FAIL | Partial |
| Cass | MO | Probate | FAIL | In progress |
| Cass | MO | Pre-Foreclosure | FAIL | In progress |
| Hamilton | OH | Tax Delinquent | PASS | Live (validated) |
| Hamilton | OH | Sheriff Sale | FAIL | Partial |
| Hamilton | OH | Probate | FAIL | In progress |
| Hamilton | OH | Pre-Foreclosure | FAIL | In progress |
| Jefferson | AL | Tax Delinquent | FAIL | In progress |
| Jefferson | AL | Sheriff Sale | FAIL | In progress |
| Jefferson | AL | Probate | FAIL | In progress |
| Jefferson | AL | FSBO | SCRAPE_ONLY | Pending enrichment |
| Madison | AL | Tax Delinquent | PASS | Live (validated) |
| Madison | AL | Sheriff Sale | PASS | Live (validated) |
| Madison | AL | Probate | FAIL | In progress |
| Madison | AL | FSBO | SCRAPE_ONLY | Pending enrichment |
| Shelby | AL | Tax Delinquent | FAIL | In progress |
| Shelby | AL | Sheriff Sale | FAIL | In progress |
| Shelby | AL | Probate | FAIL | In progress |
| Shelby | AL | FSBO | SCRAPE_ONLY | Pending enrichment |
| Morgan | AL | Tax Delinquent | FAIL | In progress |
| Morgan | AL | Sheriff Sale | FAIL | In progress |
| Morgan | AL | Probate | FAIL | In progress |
| Morgan | AL | FSBO | SCRAPE_ONLY | Pending enrichment |
| Limestone | AL | Tax Delinquent | FAIL | In progress |
| Limestone | AL | Sheriff Sale | FAIL | In progress |
| Limestone | AL | Probate | FAIL | In progress |
| Limestone | AL | FSBO | SCRAPE_ONLY | Pending enrichment |
| Montgomery | AL | Tax Delinquent | FAIL | In progress |
| Montgomery | AL | Sheriff Sale | FAIL | In progress |
| Montgomery | AL | Probate | FAIL | In progress |
| Montgomery | AL | FSBO | SCRAPE_ONLY | Pending enrichment |
| Autauga | AL | Tax Delinquent | FAIL | In progress |
| Autauga | AL | Sheriff Sale | — | Pending enrichment |
| Autauga | AL | Probate | — | Pending enrichment |
| Autauga | AL | FSBO | — | Pending enrichment |
| Elmore | AL | Tax Delinquent | — | Pending enrichment |
| Elmore | AL | Sheriff Sale | — | Pending enrichment |
| Elmore | AL | Probate | — | Pending enrichment |
| Elmore | AL | FSBO | — | Pending enrichment |
| Horry | SC | Pre-Foreclosure | — | Needs work |
| Horry | SC | Tax Delinquent | — | Needs work |
| Horry | SC | Sheriff Sale | — | Needs work |
| Horry | SC | Probate | — | Needs work |
| Horry | SC | Foreclosure | — | Needs work |
| Georgetown | SC | Pre-Foreclosure | — | Needs work |
| Georgetown | SC | Tax Delinquent | — | Needs work |
| Georgetown | SC | Sheriff Sale | — | Needs work |
| Georgetown | SC | Probate | — | Needs work |
| Georgetown | SC | Foreclosure | — | Needs work |
| Marion | SC | Pre-Foreclosure | — | Needs work |
| Marion | SC | Tax Delinquent | — | Needs work |
| Marion | SC | Sheriff Sale | — | Needs work |
| Marion | SC | Probate | — | Needs work |
| Marion | SC | Foreclosure | — | Needs work |
| Dane | WI | Tax Delinquent | — | Needs work |
| Dane | WI | Sheriff Sale | — | Needs work |
| Dane | WI | Probate | — | Needs work |
| Dane | WI | Pre-Foreclosure | — | Needs work |
| Dane | WI | FSBO | — | Needs work |
| Rock | WI | Tax Delinquent | — | Needs work |
| Rock | WI | Sheriff Sale | — | Needs work |
| Rock | WI | Probate | — | Needs work |
| Rock | WI | Pre-Foreclosure | — | Needs work |
| Rock | WI | FSBO | — | Needs work |
| Door | WI | Tax Delinquent | — | Needs work |
| Door | WI | Sheriff Sale | — | Needs work |
| Door | WI | Probate | — | Needs work |
| Door | WI | Pre-Foreclosure | — | Needs work |
| Door | WI | FSBO | — | Needs work |

## Notes
- **Live** = saveable leads in the main `leads` table (owner + address + mailing).
- **Pending** = scraped records visible with `?include_pending=true` until enrichment completes.
- Tax Delinquent is strongest nationwide; Probate/FSBO/Pre-Foreclosure need assessor cross-reference.
- SC and WI counties configured; next scrape cycle will populate after recent WI scraper fix.