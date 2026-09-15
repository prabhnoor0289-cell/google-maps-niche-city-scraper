import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();
const { niche, city, maxResults = 50 } = input;

if (!niche || !city) {
    throw new Error('Both "niche" and "city" are required inputs.');
}

const searchQuery = `${niche} in ${city}`;
const startUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}?hl=en`;

log.info(`Starting scrape for: "${searchQuery}"`);

const proxyConfiguration = await Actor.createProxyConfiguration();

let savedCount = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    headless: true,
    maxRequestsPerCrawl: 1,
    requestHandlerTimeoutSecs: 240,
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    async requestHandler({ page, request }) {
        log.info(`Loading ${request.url}`);
        await page.waitForLoadState('domcontentloaded');

        // --- Handle Google's cookie/consent popup if it appears ---
        try {
            const consentSelectors = [
                'button:has-text("Accept all")',
                'button:has-text("I agree")',
                'form[action*="consent"] button',
            ];
            for (const sel of consentSelectors) {
                const btn = await page.$(sel);
                if (btn) {
                    await btn.click();
                    log.info(`Dismissed consent popup using selector: ${sel}`);
                    await page.waitForTimeout(2000);
                    break;
                }
            }
        } catch (e) {
            log.info('No consent popup detected or already dismissed.');
        }

        // --- Wait for the results feed ---
        const feedSelector = 'div[role="feed"]';
        const feedAppeared = await page
            .waitForSelector(feedSelector, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);

        if (!feedAppeared) {
            log.warning('Feed selector not found. Saving a debug screenshot for inspection.');
            const screenshotBuffer = await page.screenshot({ fullPage: true });
            await Actor.setValue('DEBUG_SCREENSHOT', screenshotBuffer, { contentType: 'image/png' });
            return;
        }

        // --- Scroll the results feed to load more listings ---
        let previousHeight = 0;
        let sameHeightCount = 0;
        let cardCount = 0;

        while (cardCount < maxResults && sameHeightCount < 4) {
            const cards = await page.$$(`${feedSelector} div[role="article"]`);
            cardCount = cards.length;

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

        log.info(`Found ${cardCount} listing cards after scrolling.`);

        // --- Extract data from each listing card ---
        const limit = Math.min(cardCount, maxResults);

        for (let i = 0; i < limit; i++) {
            try {
                const freshCards = await page.$$(`${feedSelector} div[role="article"]`);
                if (i >= freshCards.length) break;

                // Fallback name straight from the card's own aria-label
                const cardFallbackName = await freshCards[i].evaluate((el) => {
                    const link = el.querySelector('a[aria-label]');
                    return link ? link.getAttribute('aria-label') : null;
                });

                await freshCards[i].scrollIntoViewIfNeeded();
                await page.waitForTimeout(300);
                await freshCards[i].click({ timeout: 10000 });

                await page.waitForSelector('div[role="main"]', { timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(1500);

                const data = await page.evaluate(() => {
                    const getText = (selectors) => {
                        for (const sel of selectors) {
                            const el = document.querySelector(sel);
                            if (el && el.textContent.trim()) return el.textContent.trim();
                        }
                        return null;
                    };

                    const name = getText([
                        'h1.DUwDvf',
                        'h1.fontHeadlineLarge',
                        'div[role="main"] h1',
                        'h1',
                    ]);

                    const addressEl = Array.from(document.querySelectorAll('button[data-item-id="address"]'))[0];
                    const address = addressEl ? addressEl.getAttribute('aria-label')?.replace('Address: ', '') : null;

                    const phoneEl = Array.from(document.querySelectorAll('button[data-item-id^="phone:tel:"]'))[0];
                    const phone = phoneEl ? phoneEl.getAttribute('aria-label')?.replace('Phone: ', '') : null;

                    const websiteEl = document.querySelector('a[data-item-id="authority"]');
                    const website = websiteEl ? websiteEl.href : null;

                    const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
                    const rating = ratingEl ? ratingEl.textContent.trim() : null;

                    const reviewsEl = document.querySelector('div.F7nice span[aria-label*="review"]');
                    const reviewsCount = reviewsEl
                        ? reviewsEl.getAttribute('aria-label').replace(/\D/g, '')
                        : null;

                    const categoryEl = document.querySelector('button.DkEaL');
                    const category = categoryEl ? categoryEl.textContent.trim() : null;

                    const panelHtmlSnippet = !name
                        ? (document.querySelector('div[role="main"]')?.outerHTML || '').slice(0, 1500)
                        : null;

                    return { name, address, phone, website, rating, reviewsCount, category, panelHtmlSnippet };
                });

                const finalName = data.name || cardFallbackName;

                if (finalName) {
                    await Actor.pushData({
                        name: finalName,
                        address: data.address,
                        phone: data.phone,
                        website: data.website,
                        rating: data.rating,
                        reviewsCount: data.reviewsCount,
                        category: data.category,
                        searchNiche: niche,
                        searchCity: city,
                        googleMapsUrl: page.url(),
                        scrapedAt: new Date().toISOString(),
                    });
                    savedCount++;
                    log.info(`Saved (${savedCount}): ${finalName}`);
                } else {
                    log.warning(`No name found for listing #${i}.`);
                    if (data.panelHtmlSnippet && savedCount === 0 && i < 2) {
                        await Actor.setValue(`DEBUG_PANEL_HTML_${i}`, data.panelHtmlSnippet);
                        log.warning(`Saved debug HTML snippet to key-value store as DEBUG_PANEL_HTML_${i}`);
                    }
                }
            } catch (err) {
                log.warning(`Failed to extract listing #${i}: ${err.message}`);
            }
        }
    },
    failedRequestHandler({ request }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run([startUrl]);

log.info(`Done. Saved ${savedCount} listings for "${searchQuery}" to the dataset.`);

await Actor.exit();
