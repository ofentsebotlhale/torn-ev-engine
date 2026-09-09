// ==UserScript==
// @name         Torn Bookie EV Engine
// @namespace    http://tampermonkey.net/
// @version      0.0.7
// @description  Intercepts Torn Bookie XHR to calculate Expected Value (EV) and Kelly Criterion stakes using real-world API odds.
// @author       AI Studio
// @match        https://www.torn.com/bookie.php*
// @match        https://www.torn.com/loader.php?sid=bookie*
// @match        https://www.torn.com/page.php?sid=bookie*
// @updateURL    https://raw.githubusercontent.com/ofentsebotlhale/torn-ev-engine/main/torn-ev-engine.user.js
// @downloadURL  https://raw.githubusercontent.com/ofentsebotlhale/torn-ev-engine/main/torn-ev-engine.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';
    
    console.log("[EV Engine] Script initializing (v0.0.7) at document-start...");

    // ==============================================================================
    // CONFIGURATION & STATE
    // ==============================================================================
    
    // Get stored API key or prompt user
    let ODDS_API_KEY = window.localStorage.getItem('torn_ev_odds_api_key') || '';
    if (!ODDS_API_KEY) {
        ODDS_API_KEY = window.prompt("Torn Bookie EV Engine\n\nPlease enter your API key for The Odds API:\n(Get one at https://the-odds-api.com)");
        if (ODDS_API_KEY && ODDS_API_KEY.trim() !== '') {
            window.localStorage.setItem('torn_ev_odds_api_key', ODDS_API_KEY.trim());
        } else {
            console.warn("[EV Engine] No API key provided. External data fetching will fail.");
        }
    }
    
    // Current user bankroll (would ideally be parsed from the DOM or API)
    // For demonstration, we'll set a static bankroll or look for it on page
    let userBankroll = 10000000; // 10m default

    // Styles for injected UI (Brutalist / Dark)
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
            font-family: 'monospace';
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
            font-family: 'monospace';
        }
        .ev-kelly-amount {
            color: #eab308;
            font-weight: bold;
        }
    `;
        (document.head || document.documentElement).appendChild(style);
    };
    
    // Inject styles as soon as DOM is ready enough
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
        const ev = (trueProbability * potentialProfit) - (lossProbability * 1);
        return ev * 100;
    }

    function calculateKelly(tornOdds, trueProbability, fraction = 0.5) {
        const b = tornOdds - 1;
        const p = trueProbability;
        const q = 1 - p;
        const kellyFraction = (b * p - q) / b;
        const safeKelly = Math.max(0, Math.min(kellyFraction * fraction, 0.10));
        return safeKelly;
    }

    // ==============================================================================
    // EXTERNAL API FETCHING
    // ==============================================================================
    
    let oddsCache = null;
    let cacheTimestamp = 0;

    async function fetchRealWorldProbability(matchName, selectionName, tornOdds) {
        if (!ODDS_API_KEY) return calculateImpliedProbability(tornOdds);

        try {
            // 5-minute memory cache to protect your API limits
            if (!oddsCache || Date.now() - cacheTimestamp > 300000) {
                console.log("[EV Engine] Fetching fresh data from The Odds API...");
                const url = `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=eu,uk&markets=h2h`;
                
                const response = await window.fetch(url);
                if (!response.ok) {
                    console.error("[EV Engine] Odds API Error:", response.status);
                    return calculateImpliedProbability(tornOdds); 
                }
                oddsCache = await response.json();
                cacheTimestamp = Date.now();
            }

            // Attempt to find a matching event using basic string inclusion
            const matchLower = matchName.toLowerCase();
            const matchedEvent = oddsCache.find(event => 
                matchLower.includes(event.home_team.toLowerCase()) || 
                matchLower.includes(event.away_team.toLowerCase())
            );

            if (matchedEvent && matchedEvent.bookmakers.length > 0) {
                // Get odds from the first available real-world bookmaker
                const market = matchedEvent.bookmakers[0].markets[0];
                const outcome = market.outcomes.find(o => 
                    selectionName.toLowerCase().includes(o.name.toLowerCase()) ||
                    o.name.toLowerCase().includes(selectionName.toLowerCase())
                );

                if (outcome && outcome.price > 1) {
                    return 1 / outcome.price; // True implied probability
                }
            }
            
            // Fallback if no exact string match is found
            return calculateImpliedProbability(tornOdds);

        } catch (e) {
            console.error("[EV Engine] Failed to fetch external odds:", e);
            return calculateImpliedProbability(tornOdds);
        }
    }

    // ==============================================================================
    // XHR INTERCEPTION (RELIABLE REACT DATA CAPTURE)
    // ==============================================================================
    
    // We intercept the raw JSON data Torn sends to the frontend, rather than
    // fighting the React DOM which obfuscates classes and structures.
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    
    let latestMatchData = {};

    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function() {
        this.addEventListener('load', function() {
            // Intercept Bookie API calls
            if (this._url && this._url.includes('bookie.php') && this._url.includes('step=getMatches')) {
                try {
                    const response = JSON.parse(this.responseText);
                    console.log("[EV Engine] Intercepted match data payload:", response);
                    
                    // The payload structure depends on Torn's exact API, 
                    // but we store it to use when the DOM finally renders.
                    if (response && response.matches) {
                        // Very rough approximation - we just trigger the DOM scan shortly after data arrives
                        setTimeout(() => {
                             console.log("[EV Engine] Data arrived, triggering DOM scan...");
                             processBetCards();
                             injectStatusIndicator();
                        }, 1000);
                        
                        setTimeout(() => processBetCards(), 3000); // safety net scan
                    }
                } catch (e) {
                    console.error("[EV Engine] Failed to parse intercepted XHR:", e);
                }
            }
        });
        return originalSend.apply(this, arguments);
    };

    // ==============================================================================
    // DOM MANIPULATION & UI INJECTION
    // ==============================================================================

    async function injectEVPanel(betCardNode, matchData, selectionData) {
        if (betCardNode.querySelector('.ev-panel-container') || betCardNode.dataset.evInjected) return;
        betCardNode.dataset.evInjected = 'true';

        const tornOdds = selectionData.odds;
        const selectionName = selectionData.name;
        
        const trueProb = await fetchRealWorldProbability(matchData.title, selectionName, tornOdds);
        
        const tornImpliedProb = calculateImpliedProbability(tornOdds);
        const evPercent = calculateEV(tornOdds, trueProb);
        
        if (evPercent <= 0 && window.location.search.indexOf('showAllEV=1') === -1) {
             const btn = betCardNode.querySelector(`[title*="${selectionName}"]`) || betCardNode;
             if (btn && !btn.querySelector('.ev-negative')) {
                 const badge = document.createElement('span');
                 badge.className = 'ev-badge ev-negative';
                 badge.textContent = evPercent.toFixed(1) + '% EV';
                 btn.appendChild(badge);
             }
             return;
        }

        const kellyFraction = calculateKelly(tornOdds, trueProb, 0.25);
        const recommendedStake = userBankroll * kellyFraction;

        const panel = document.createElement('div');
        panel.className = 'ev-panel-container';
        
        const formatMoney = (amount) => {
            return '$' + amount.toLocaleString('en-US', { maximumFractionDigits: 0 });
        };

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
        
        // Append panel below the betting buttons
        betCardNode.appendChild(panel);
    }

    // ==============================================================================
    // MUTATION OBSERVER (WATCH FOR BET CARDS)
    // ==============================================================================
    
    function processBetCards() {
        console.log("[EV Engine] Scanning for betting cards...");
        
        // Let's use Torn's actual classes for Bookie if possible, but fallback extremely wide
        const matchBlocks = document.querySelectorAll(
            '[class^="matchWrap_"], [class*="matchContainer"], li[class*="match_"], .match-list > li, [class*="matchList"] > div, ul > li'
        );
        
        console.log(`[EV Engine] Found ${matchBlocks.length} potential match blocks.`);
        
        let totalInjected = 0;

        // Fallback: Scan every button on the page that has numbers. 
        // We do this globally because Torn's React classes change constantly.
        const allButtons = document.querySelectorAll('button, div[role="button"], a[role="button"]');
        let found = 0;
        
        allButtons.forEach(btn => {
            if (btn.dataset.evInjected || btn.closest('.ev-panel-container') || btn.closest('.ev-badge')) return;
            
            const text = btn.textContent.trim();
            
            // Look for odds at the end of the text: "Team Name 1.50" or just "1.50"
            const oddsMatch = text.match(/([\d.]+)$/);
            
            // Usually betting odds buttons have some text and a number, and ignore generic 'bet' buttons
            if (oddsMatch && text.length > oddsMatch[1].length && !text.toLowerCase().includes('bet') && !text.toLowerCase().includes('max')) {
                const odds = parseFloat(oddsMatch[1]);
                
                // Extract selection name from the button text
                const name = text.replace(oddsMatch[1], '').trim() || "Selection";
                
                // Attempt to find a parent match block to get the Match Title
                const parentBlock = btn.closest('[class^="matchWrap_"], [class*="matchContainer"], li');
                const titleEl = parentBlock ? parentBlock.querySelector('[class^="teamNames_"], .match-name, h3, .title, strong') : null;
                const matchTitle = titleEl ? titleEl.textContent.trim() : "Unknown Match";
                
                // Sanity check that it actually looks like an odds number
                if (odds > 1.01 && odds < 500) { 
                    found++;
                    totalInjected++;
                    injectEVPanel(btn.parentElement, { title: matchTitle }, { name: name, odds: odds });
                }
            }
        });
        
        console.log(`[EV Engine] Fallback button scan found and injected ${found} bet buttons.`);
        
        if (totalInjected === 0) {
            console.log("[EV Engine] Could not find any valid odds buttons. Will try again later.");
        }
    }

    // Add a floating status indicator so the user knows it's loaded
    function injectStatusIndicator() {
        if (document.getElementById('ev-status-indicator')) {
            document.getElementById('ev-status-indicator').textContent = 'EV ENGINE v0.0.7 LIVE (Click to rescan)';
            return;
        }
        const status = document.createElement('div');
        status.id = 'ev-status-indicator';
        status.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#10b981;color:#000;padding:5px 10px;border-radius:4px;font-size:10px;font-family:monospace;z-index:9999;font-weight:bold;cursor:pointer;box-shadow: 0 4px 6px rgba(0,0,0,0.3);';
        status.textContent = 'EV ENGINE v0.0.7 LIVE (Click to rescan)';
        status.onclick = () => {
            console.log("[EV Engine] Manual rescan triggered.");
            processBetCards();
        };
        document.body.appendChild(status);
    }

    // Start observer
    let timeoutId;
    const observer = new MutationObserver((mutations) => {
        // Debounce the observer to prevent it from firing too rapidly
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            processBetCards();
            injectStatusIndicator();
        }, 500);
    });

    // Wait for the main container to load, then observe it
    console.log("[EV Engine] Looking for Bookie app container...");
    const checkInterval = setInterval(() => {
        const bookieApp = document.getElementById('bookie-root') || document.querySelector('.bookie-app') || document.body;
        if (bookieApp) {
            clearInterval(checkInterval);
            observer.observe(bookieApp, { childList: true, subtree: true });
            console.log("[EV Engine] MutationObserver attached to", bookieApp.tagName || bookieApp.id);
            // Run once immediately
            setTimeout(processBetCards, 1000);
            injectStatusIndicator();
        }
    }, 1000);

})();
