import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();
const { niche, city, maxResults = 50 } = input;

if (!niche || !city) {
    throw new Error('Both "niche" and "city" are required inputs.');
}

const searchQuery = `${niche} in ${city}`;
const startUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

log.info(`Starting scrape for: "${searchQuery}"`);

let resultsCount = 0;

const crawler = new PlaywrightCrawler({
    headless: true,
    maxRequestsPerCrawl: 1,
    requestHandlerTimeoutSecs: 180,
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    async requestHandler({ page, request }) {
        log.info(`Loading ${request.url}`);
        await page.waitForSelector('div[role="feed"]', { timeout: 30000 }).catch(() => {
            log.warning('Feed selector not found — Google Maps layout may have changed.');
        });

        const feedSelector = 'div[role="feed"]';
        let previousHeight = 0;
        let sameHeightCount = 0;

        while (resultsCount < maxResults && sameHeightCount < 4) {
            const cards = await page.$$(`${feedSelector} div[role="article"]`);
            resultsCount = cards.length;

            const newHeight = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.scrollHeight : 0;
            }, feedSelector);

            if (newHeight === previousHeight) {
                sameHeightCount++;
            } else {
                sameHeightCount = 0;
            }
            previousHeight = newHeight;

            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) el.scrollTop = el.scrollHeight;
            }, feedSelector);

            await page.waitForTimeout(1500);
        }

        const cards = await page.$$('div[role="feed"] div[role="article"]');
        const limit = Math.min(cards.length, maxResults);

        for (let i = 0; i < limit; i++) {
            try {
                const card = cards[i];
                await card.click();
                await page.waitForTimeout(2000);

                const data = await page.evaluate(() => {
                    const getText = (selector) => {
                        const el = document.querySelector(selector);
                        return el ? el.textContent.trim() : null;
                    };

                    const name = getText('h1.DUwDvf, h1.fontHeadlineLarge');

                    const addressEl = Array.from(document.querySelectorAll('button[data-item-id="address"]'))[0];
                    const address = addressEl ? addressEl.getAttribute('aria-label')?.replace('Address: ', '') : null;

                    const phoneEl = Array.from(document.querySelectorAll('button[data-item-id^="phone:tel:"]'))[0];
                    const phone = phoneEl ? phoneEl.getAttribute('aria-label')?.replace('Phone: ', '') : null;

                    const websiteEl = document.querySelector('a[data-item-id="authority"]');
                    const website = websiteEl ? websiteEl.href : null;

                    const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
                    const rating = ratingEl ? ratingEl.textContent.trim() : null;

                    const reviewsEl = document.querySelector('div.F7nice span[aria-label*="reviews"]');
                    const reviewsCount = reviewsEl
                        ? reviewsEl.getAttribute('aria-label').replace(/\D/g, '')
                        : null;

                    const categoryEl = document.querySelector('button.DkEaL');
                    const category = categoryEl ? categoryEl.textContent.trim() : null;

                    return { name, address, phone, website, rating, reviewsCount, category };
                });

                if (data.name) {
                    await Actor.pushData({
                        ...data,
                        searchNiche: niche,
                        searchCity: city,
                        googleMapsUrl: page.url(),
                        scrapedAt: new Date().toISOString(),
                    });
                    log.info(`Saved: ${data.name}`);
                }
            } catch (err) {
                log.warning(`Failed to extract a listing: ${err.message}`);
            }
        }
    },
    failedRequestHandler({ request }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run([startUrl]);

log.info(`Done. Scraped ${resultsCount} listings for "${searchQuery}".`);

await Actor.exit();
