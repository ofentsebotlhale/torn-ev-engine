// ==UserScript==
// @name         Torn Bookie EV Engine
// @namespace    http://tampermonkey.net/
// @version      0.0.14
// @description  Intercepts Torn Bookie XHR to calculate Expected Value (EV) and Kelly Criterion stakes using real-world API odds.
// @author       AI Studio
// @match        https://www.torn.com/bookie.php*
// @match        https://www.torn.com/loader.php?sid=bookie*
// @match        https://www.torn.com/page.php?sid=bookie*
// @updateURL    https://raw.githubusercontent.com/ofentsebotlhale/torn-ev-engine/main/torn-ev-engine.user.js
// @downloadURL  https://raw.githubusercontent.com/ofentsebotlhale/torn-ev-engine/main/torn-ev-engine.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';
    
    console.log("[EV Engine] Script initializing (v0.0.14) at document-start...");

    // Target the real page window context to catch page-level XHR/Fetch
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // ==============================================================================
    // CONFIGURATION & STATE
    // ==============================================================================
    
    let getSafeValue = (key, def) => {
        try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : (window.localStorage.getItem(key) || def); } 
        catch (e) { return window.localStorage.getItem(key) || def; }
    };
    
    let setSafeValue = (key, val) => {
        try { if (typeof GM_setValue === 'function') GM_setValue(key, val); else window.localStorage.setItem(key, val); }
        catch (e) { window.localStorage.setItem(key, val); }
    };
    
    let ODDS_API_KEY = getSafeValue('torn_ev_odds_api_key', '');
    if (!ODDS_API_KEY) {
        ODDS_API_KEY = window.prompt("Torn Bookie EV Engine\n\nPlease enter your API key for The Odds API:\n(Get one at https://the-odds-api.com)");
        if (ODDS_API_KEY && ODDS_API_KEY.trim() !== '') {
            setSafeValue('torn_ev_odds_api_key', ODDS_API_KEY.trim());
        }
    }
    
    let userBankroll = 10000000; // 10m default

    const injectStyles = () => {
        if (document.getElementById('ev-engine-styles')) return;
        const style = document.createElement('style');
        style.id = 'ev-engine-styles';
        style.innerHTML = `
        .ev-badge {
            display: inline-flex;
            align-items: center;
            padding: 2px 6px;
            font-family: 'Inter', sans-serif;
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
        
        .ev-panel-container {
            background-color: #09090b;
            border: 1px solid #27272a;
            padding: 12px;
            margin-top: 8px;
            font-family: 'Inter', sans-serif;
            border-left: 3px solid #10b981;
            width: 100%;
            box-sizing: border-box;
            clear: both;
        }
        .ev-panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #27272a;
            padding-bottom: 8px;
            margin-bottom: 8px;
        }
        .ev-panel-title {
            font-weight: 900;
            font-size: 12px;
            color: #f4f4f5;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .ev-stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
        }
        .ev-stat-box {
            display: flex;
            flex-direction: column;
        }
        .ev-stat-label {
            font-size: 10px;
            color: #a1a1aa;
            text-transform: uppercase;
            font-weight: 600;
        }
        .ev-stat-value {
            font-family: monospace;
            font-weight: 700;
            font-size: 14px;
            color: #f4f4f5;
        }
        .ev-stat-value.highlight {
            color: #10b981;
        }
        .ev-kelly-suggest {
            margin-top: 8px;
            padding: 6px;
            background: #18181b;
            border: 1px dashed #3f3f46;
            font-size: 11px;
            color: #d4d4d8;
            font-family: monospace;
        }
        .ev-kelly-amount {
            color: #eab308;
            font-weight: bold;
        }
    `;
        (document.head || document.documentElement).appendChild(style);
    };
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectStyles);
    } else {
        injectStyles();
    }

    // ==============================================================================
    // CORE MATH ENGINE
    // ==============================================================================

    function calculateImpliedProbability(decimalOdds) {
        if (!decimalOdds || decimalOdds <= 1) return 0;
        return 1 / decimalOdds;
    }

    function calculateEV(tornOdds, trueProbability) {
        const potentialProfit = tornOdds - 1;
        const lossProbability = 1 - trueProbability;
        return ((trueProbability * potentialProfit) - (lossProbability * 1)) * 100;
    }

    function calculateKelly(tornOdds, trueProbability, fraction = 0.25) {
        const b = tornOdds - 1;
        const p = trueProbability;
        const q = 1 - p;
        const kellyFraction = (b * p - q) / b;
        return Math.max(0, Math.min(kellyFraction * fraction, 0.10));
    }

    // ==============================================================================
    // EXTERNAL API FETCHING
    // ==============================================================================
    
    let oddsCache = null;
    let cacheTimestamp = 0;

    async function fetchRealWorldProbability(matchName, selectionName, tornOdds) {
        if (!ODDS_API_KEY) return calculateImpliedProbability(tornOdds);

        try {
            if (!oddsCache || Date.now() - cacheTimestamp > 300000) {
                const url = `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=eu,uk&markets=h2h`;
                
                const fetchWithGM = () => new Promise((resolve, reject) => {
                    if (typeof GM_xmlhttpRequest === 'undefined') reject("GM_xmlhttpRequest unavailable");
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: url,
                        onload: (res) => res.status >= 200 && res.status < 300 ? resolve({ ok: true, json: async () => JSON.parse(res.responseText) }) : resolve({ ok: false, status: res.status }),
                        onerror: (err) => reject(err)
                    });
                });

                let response;
                try { response = await fetchWithGM(); } 
                catch (e) { response = await pageWindow.fetch(url); }

                if (!response || !response.ok) return calculateImpliedProbability(tornOdds);
                oddsCache = await response.json();
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
    // PAGE-LEVEL INTERCEPTION (FETCH & XHR)
    // ==============================================================================
    
    const origFetch = pageWindow.fetch;
    pageWindow.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (url.includes('bookie') || url.includes('step=getMatches')) {
            setTimeout(processBetCards, 800);
        }
        return response;
    };

    const origOpen = pageWindow.XMLHttpRequest.prototype.open;
    const origSend = pageWindow.XMLHttpRequest.prototype.send;
    
    pageWindow.XMLHttpRequest.prototype.open = function(...args) {
        this._url = args[1];
        return origOpen.apply(this, args);
    };

    pageWindow.XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            if (this._url && this._url.includes('bookie.php') && this._url.includes('step=getMatches')) {
                setTimeout(processBetCards, 500);
            }
        });
        return origSend.apply(this, args);
    };

    // ==============================================================================
    // DOM MANIPULATION & UI INJECTION
    // ==============================================================================

    async function injectEVPanel(targetEl, matchData, selectionData) {
        if (targetEl.dataset.evInjected || targetEl.nextElementSibling?.classList.contains('ev-panel-container')) return;
        targetEl.dataset.evInjected = 'true';

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
        
        targetEl.insertAdjacentElement('afterend', panel);
    }

    // ==============================================================================
    // DOM SCANNER & PARSER
    // ==============================================================================
    
    function processBetCards() {
        console.log("[EV Engine] Scanning for betting selections...");
        
        // Expanded target scope for modern React/Torn structures
        const betCandidates = document.querySelectorAll(`
            button, 
            [role="button"], 
            [class*="option_"], 
            [class*="bet_"], 
            [class*="outcome_"],
            label[class*="bet"],
            div[class*="bets"] > div
        `);
        
        let found = 0;

        betCandidates.forEach(el => {
            if (el.dataset.evInjected || el.closest('.ev-panel-container') || el.closest('.ev-badge')) return;

            const text = el.textContent.trim().replace(/\s+/g, ' ');
            
            // Look specifically for buttons that have odds formats at the end
            const oddsMatch = text.match(/(?:(.+?)\s+)?(\d+(?:\.\d{1,2})?)$/);
            
            if (oddsMatch && !text.toLowerCase().includes('page') && !text.toLowerCase().includes('max')) {
                const potentialOdds = parseFloat(oddsMatch[2]);

                if (!isNaN(potentialOdds) && potentialOdds > 1.01 && potentialOdds < 500) {
                    // Ignore input boxes or bet amount fields
                    if (el.tagName === 'INPUT' || el.querySelector('input')) return;

                    const name = (oddsMatch[1] || "").trim() || "Selection";
                    
                    // Climb up DOM to isolate match context title
                    const parentBlock = el.closest('[class*="match"], [class*="wrapper"], li');
                    const titleEl = parentBlock ? parentBlock.querySelector('[class*="team"], [class*="title"], [class*="name"], h3, strong') : null;
                    const matchTitle = titleEl ? titleEl.textContent.trim() : "Unknown Match";

                    found++;
                    injectEVPanel(el, { title: matchTitle }, { name: name, odds: potentialOdds });
                }
            }
        });

        console.log(`[EV Engine] Scan finished. Injected ${found} bet buttons.`);
    }

    function injectStatusIndicator() {
        if (document.getElementById('ev-status-indicator')) return;
        const status = document.createElement('div');
        status.id = 'ev-status-indicator';
        status.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#10b981;color:#000;padding:5px 10px;border-radius:4px;font-size:10px;font-family:monospace;z-index:9999;font-weight:bold;cursor:pointer;box-shadow: 0 4px 6px rgba(0,0,0,0.3);';
        status.textContent = 'EV ENGINE v0.0.14 LIVE (Click to rescan)';
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

    const checkInterval = setInterval(() => {
        const bookieApp = document.querySelector('[class*="bookie"], #bookie-root, #mainContainer, .content-wrapper, [class*="content"]');
        if (bookieApp && bookieApp.children.length > 0) {
            clearInterval(checkInterval);
            observer.observe(bookieApp, { childList: true, subtree: true });
            setTimeout(processBetCards, 800);
            injectStatusIndicator();
        }
    }, 800);

})();
