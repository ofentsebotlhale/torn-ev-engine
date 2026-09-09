// ==UserScript==
// @name         Torn Bookie EV Engine
// @namespace    http://tampermonkey.net/
// @version      0.0.16
// @description  Pure Vanilla JS Interceptor for Torn Bookie to calculate Expected Value (EV) and Kelly Criterion stakes using real-world API odds.
// @author       AI Studio
// @match        https://www.torn.com/bookie.php*
// @match        https://www.torn.com/loader.php?sid=bookie*
// @match        https://www.torn.com/page.php?sid=bookie*
// @updateURL    https://raw.githubusercontent.com/ofentsebotlhale/torn-ev-engine/main/torn-ev-engine.user.js
// @downloadURL  https://raw.githubusercontent.com/ofentsebotlhale/torn-ev-engine/main/torn-ev-engine.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.the-odds-api.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';
    
    console.log("[EV Engine] Vanilla JS Engine initializing (v0.0.16)...");

    // ==============================================================================
    // CONFIGURATION & PERSISTENCE
    // ==============================================================================
    
    const getSafeValue = (key, def) => {
        try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : (window.localStorage.getItem(key) || def); } 
        catch (e) { return window.localStorage.getItem(key) || def; }
    };
    
    const setSafeValue = (key, val) => {
        try { if (typeof GM_setValue === 'function') GM_setValue(key, val); else window.localStorage.setItem(key, val); }
        catch (e) { window.localStorage.setItem(key, val); }
    };
    
    let ODDS_API_KEY = getSafeValue('torn_ev_odds_api_key', '');
    if (!ODDS_API_KEY) {
        ODDS_API_KEY = window.prompt("Torn Bookie EV Engine\n\nEnter key for The Odds API (https://the-odds-api.com):");
        if (ODDS_API_KEY && ODDS_API_KEY.trim() !== '') {
            setSafeValue('torn_ev_odds_api_key', ODDS_API_KEY.trim());
        }
    }
    
    const userBankroll = 10000000;

    const injectStyles = () => {
        if (document.getElementById('ev-engine-styles')) return;
        const style = document.createElement('style');
        style.id = 'ev-engine-styles';
        style.innerHTML = `
        .ev-badge {
            display: inline-flex;
            align-items: center;
            padding: 2px 6px;
            font-family: 'Inter', -apple-system, sans-serif;
            font-weight: 800;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border-radius: 2px;
            margin-left: 8px;
            border: 1px solid currentColor;
            z-index: 10;
        }
        .ev-positive { background-color: #10b981; color: #000; border-color: #10b981; }
        .ev-negative { background-color: transparent; color: #ef4444; border-color: #ef4444; opacity: 0.8; }
        
        .ev-panel-wrapper {
            display: block;
            width: 100%;
            clear: both;
        }
        .ev-panel-container {
            background-color: #09090b;
            border: 1px solid #27272a;
            padding: 10px;
            margin-top: 6px;
            font-family: 'Inter', -apple-system, sans-serif;
            border-left: 3px solid #10b981;
            box-sizing: border-box;
        }
        .ev-panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #27272a;
            padding-bottom: 6px;
            margin-bottom: 6px;
        }
        .ev-panel-title {
            font-weight: 900;
            font-size: 11px;
            color: #f4f4f5;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .ev-stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 6px;
        }
        .ev-stat-box {
            display: flex;
            flex-direction: column;
        }
        .ev-stat-label {
            font-size: 9px;
            color: #a1a1aa;
            text-transform: uppercase;
            font-weight: 600;
        }
        .ev-stat-value {
            font-family: monospace;
            font-weight: 700;
            font-size: 13px;
            color: #f4f4f5;
        }
        .ev-stat-value.highlight { color: #10b981; }
        .ev-kelly-suggest {
            margin-top: 6px;
            padding: 5px;
            background: #18181b;
            border: 1px dashed #3f3f46;
            font-size: 10px;
            color: #d4d4d8;
            font-family: monospace;
        }
        .ev-kelly-amount { color: #eab308; font-weight: bold; }
    `;
        (document.head || document.documentElement).appendChild(style);
    };

    injectStyles();

    // ==============================================================================
    // MATH ENGINE
    // ==============================================================================

    function calculateImpliedProbability(decimalOdds) {
        if (!decimalOdds || decimalOdds <= 1) return 0;
        return 1 / decimalOdds;
    }

    function calculateEV(tornOdds, trueProbability) {
        const profit = tornOdds - 1;
        const lossProb = 1 - trueProbability;
        return ((trueProbability * profit) - lossProb) * 100;
    }

    function calculateKelly(tornOdds, trueProbability, fraction = 0.25) {
        const b = tornOdds - 1;
        const p = trueProbability;
        const q = 1 - p;
        const kellyFraction = (b * p - q) / b;
        return Math.max(0, Math.min(kellyFraction * fraction, 0.10));
    }

    // ==============================================================================
    // API FETCHING
    // ==============================================================================
    
    let oddsCache = null;
    let cacheTimestamp = 0;

    function makeGMRequest(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: url,
                    headers: { "Accept": "application/json" },
                    onload: (res) => {
                        if (res.status === 401 || res.status === 403) {
                            setSafeValue('torn_ev_odds_api_key', '');
                            reject(new Error(`HTTP ${res.status}`));
                        } else if (res.status >= 200 && res.status < 300) {
                            try { resolve(JSON.parse(res.responseText)); } 
                            catch (e) { reject(e); }
                        } else {
                            reject(new Error(`HTTP ${res.status}`));
                        }
                    },
                    onerror: (err) => reject(err)
                });
            } else {
                fetch(url)
                    .then(r => r.json())
                    .then(resolve)
                    .catch(reject);
            }
        });
    }

    async function fetchRealWorldProbability(matchName, selectionName, tornOdds) {
        if (!ODDS_API_KEY) return calculateImpliedProbability(tornOdds);

        try {
            if (!oddsCache || Date.now() - cacheTimestamp > 300000) {
                const url = `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=eu,uk&markets=h2h`;
                oddsCache = await makeGMRequest(url);
                cacheTimestamp = Date.now();
            }

            const matchLower = matchName.toLowerCase();
            const matchedEvent = oddsCache.find(event => 
                matchLower.includes(event.home_team.toLowerCase()) || 
                matchLower.includes(event.away_team.toLowerCase())
            );

            if (matchedEvent && matchedEvent.bookmakers.length > 0) {
                const market = matchedEvent.bookmakers[0].markets[0];
                const outcome = market.outcomes.find(o => 
                    selectionName.toLowerCase().includes(o.name.toLowerCase()) ||
                    o.name.toLowerCase().includes(selectionName.toLowerCase())
                );
                if (outcome && outcome.price > 1) return 1 / outcome.price;
            }
            return calculateImpliedProbability(tornOdds);
        } catch (e) {
            return calculateImpliedProbability(tornOdds);
        }
    }

    // ==============================================================================
    // NATIVE DOM INJECTION
    // ==============================================================================

    async function injectEVPanel(targetEl, matchData, selectionData) {
        if (targetEl.getAttribute('data-ev-injected') === 'true') return;
        
        const parentContainer = targetEl.parentElement;
        if (!parentContainer || parentContainer.querySelector('.ev-panel-container')) return;

        targetEl.setAttribute('data-ev-injected', 'true');

        const tornOdds = selectionData.odds;
        const selectionName = selectionData.name;
        
        const trueProb = await fetchRealWorldProbability(matchData.title, selectionName, tornOdds);
        const tornImpliedProb = calculateImpliedProbability(tornOdds);
        const evPercent = calculateEV(tornOdds, trueProb);
        
        if (evPercent <= 0 && window.location.search.indexOf('showAllEV=1') === -1) {
             if (!targetEl.querySelector('.ev-negative')) {
                 const badge = document.createElement('span');
                 badge.className = 'ev-badge ev-negative';
                 badge.textContent = evPercent.toFixed(1) + '% EV';
                 targetEl.appendChild(badge);
             }
             return;
        }

        const kellyFraction = calculateKelly(tornOdds, trueProb, 0.25);
        const recommendedStake = userBankroll * kellyFraction;

        const wrapper = document.createElement('div');
        wrapper.className = 'ev-panel-wrapper';

        const panel = document.createElement('div');
        panel.className = 'ev-panel-container';
        
        const formatMoney = (amount) => '$' + amount.toLocaleString('en-US', { maximumFractionDigits: 0 });

        panel.innerHTML = `
            <div class="ev-panel-header">
                <span class="ev-panel-title">⚠️ ARBITRAGE EDGE DETECTED</span>
                <span class="ev-badge ev-positive">+${evPercent.toFixed(2)}% EV</span>
            </div>
            <div class="ev-stats-grid">
                <div class="ev-stat-box">
                    <span class="ev-stat-label">Torn Implied</span>
                    <span class="ev-stat-value">${(tornImpliedProb * 100).toFixed(1)}%</span>
                </div>
                <div class="ev-stat-box">
                    <span class="ev-stat-label">True Prob</span>
                    <span class="ev-stat-value highlight">${(trueProb * 100).toFixed(1)}%</span>
                </div>
                <div class="ev-stat-box">
                    <span class="ev-stat-label">Edge</span>
                    <span class="ev-stat-value highlight">+${((trueProb - tornImpliedProb) * 100).toFixed(1)}%</span>
                </div>
            </div>
            <div class="ev-kelly-suggest">
                [Q-KELLY] Rec. Stake: <span class="ev-kelly-amount">${formatMoney(recommendedStake)}</span> 
                (${Math.round(kellyFraction * 100).toFixed(2)}% BR)
            </div>
        `;
        
        wrapper.appendChild(panel);
        parentContainer.insertAdjacentElement('afterend', wrapper);
    }

    // ==============================================================================
    // NATIVE DOM SCANNER
    // ==============================================================================

    function processBetCards() {
        const candidates = document.querySelectorAll('button, a, [role="button"], label, div');

        let count = 0;
        candidates.forEach(el => {
            if (el.getAttribute('data-ev-injected') === 'true' || el.closest('.ev-panel-container') || el.closest('.ev-badge')) return;

            const text = el.textContent.trim().replace(/\s+/g, ' ');
            const matches = text.match(/\b([1-9]\d*(?:\.\d{1,2})?)\b/g);
            if (!matches) return;

            const potentialOdds = parseFloat(matches[matches.length - 1]);

            if (!isNaN(potentialOdds) && potentialOdds > 1.01 && potentialOdds < 500) {
                if (el.tagName === 'INPUT' || el.querySelector('input')) return;

                const name = text.replace(potentialOdds.toString(), '').trim() || "Selection";
                const parentBlock = el.closest('li, div');
                const titleEl = parentBlock ? parentBlock.querySelector('h3, strong, span') : null;
                const matchTitle = titleEl ? titleEl.textContent.trim() : "Unknown Match";

                count++;
                injectEVPanel(el, { title: matchTitle }, { name: name, odds: potentialOdds });
            }
        });

        if (count > 0) {
            console.log(`[EV Engine] Scan complete. Injected ${count} panels via Native DOM.`);
        }
    }

    function injectStatusIndicator() {
        if (document.getElementById('ev-status-indicator')) return;
        const status = document.createElement('div');
        status.id = 'ev-status-indicator';
        status.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#10b981;color:#000;padding:5px 10px;border-radius:4px;font-size:10px;font-family:monospace;z-index:9999;font-weight:bold;cursor:pointer;box-shadow: 0 4px 6px rgba(0,0,0,0.3);';
        status.textContent = 'EV ENGINE v0.0.16 LIVE (Rescan)';
        status.onclick = () => processBetCards();
        document.body.appendChild(status);
    }

    let timeoutId;
    const observer = new MutationObserver(() => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            processBetCards();
            injectStatusIndicator();
        }, 400);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(processBetCards, 1000);
    injectStatusIndicator();

})();
