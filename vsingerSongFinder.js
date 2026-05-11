import puppeteer from 'puppeteer';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import os_open from 'open';

const CACHE_BASE_DIR = './cache';
const LOAD_CHANNEL_ID_TIMEOUT = 10;
const LOAD_CHANNEL_ID_POLLING_PERIOD = 300;

let filterKeywords = [
    '歌', 'うた', '曲', 'カラオケ', 'karaoke', 'sing', 'song'
];

const aliasMap = {
    'HoushouMarine' : ['HoushouMarine', 'Houshou Marine', '宝鐘マリン']
};

const addrMap = {
    'HoushouMarine' : 'https://www.youtube.com/@homarine'
};

const channelID_cache = {
    'HoushouMarine' : 'UCCzUftO8KOVkV4wQG1vkUvg'
};

async function puppetSetup()
{
    const browser = await puppeteer.launch({headless : false});
    //const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // SET UP HEADERS FOR THE SESSION
    // ------------------------------------------------------------------------

    await page.setExtraHTTPHeaders({
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            'sec-ch-ua' : '\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Google Chrome\";v=\"146\"',

            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-GB,en;q=0.9,en;q=0.8'
        });

    await page.setViewport({
        width: 1920,
        height: 1280,
        deviceScaleFactor: 1
    });

    return [browser, page];
}

async function extractChannelId(page)
{
    let linkRelElems = await page.$$('link[rel="canonical"][href]');
    let metaElems = await page.$$('meta[property="og:url"][content]');

    let getChannelIdPos = async (elem, attrName) => {
        let attrContent = await page.evaluate(
            (elem, attrName) => elem.getAttribute(attrName), elem, attrName);
        let channelIdPos = attrContent.indexOf('channel') + 'channel/'.length;
        return attrContent.substr(channelIdPos);
    };

    if(linkRelElems.length > 0)
    {
        let linkRelChannelId = await getChannelIdPos(linkRelElems[0], 'href');
        if(linkRelChannelId)
        {
            return linkRelChannelId;
        }
    }

    if(metaElems.length > 0)
    {
        let metaElemChannelId = await getChannelIdPos(metaElems[0], 'content');
        if(metaElemChannelId)
        {
            return metaElemChannelId;
        }
    }

    return '';
}

// ============================================================================
// SERVER

function serverSetup()
{
    const app = express();
    const port = 8081;

    const clientPageFilename  = './clientPage.html';
    const clientPageScriptsFn = './clientPageScripts.js';
    const assetsDirectory     = './assets';

    const clientPageHTML      = fs.readFileSync(clientPageFilename);
    const clientPageScripts   = fs.readFileSync(clientPageScriptsFn);
    const clipboardCopySVG    = fs.readFileSync(assetsDirectory + '/copy-2-line.svg');

    // CONFIG
    // ------------------------------------------------------------------------

    app.use(bodyParser.json({limit: '2mb'}));

    app.get('/readAPIkey', (req, res) => {
        res.status(200);

        res.set('Content-Type', 'text/plain');
        res.send(JSON.stringify({'content' : process.env.YT_API_KEY ?? ''}));
    });

    // CLIENT PAGE ROUTES
    // ------------------------------------------------------------------------

    app.get('/clientPage', (req, res) => {
        res.status(200);

        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(clientPageHTML);
    });

    app.get('/clientPageScripts.js', (req, res) => {
        res.status(200);

        res.set('Content-Type', 'application/javascript');
        res.send(clientPageScripts);
    });

    app.get('/assets/copy-2-line.svg', (req, res) => {
        res.status(200);

        res.set('Content-Type', 'image/svg+xml');
        res.send(clipboardCopySVG);
    });

    app.post('/openVideoPage', async (req, res) => {
        openVideoPage(req.body['video-addr'], req.body['song-start-time']);

        res.status(204);
        res.send('');
    });

    app.post('/obtainChannelId', async (req, res) => {
        console.log(`Attempting to extract channel ID from ${req.body['vsinger-name']}`);
        let channelId = await obtainChannelId(req.body['vsinger-name']);

        res.status(200);
        res.send(channelId);
    });

    // SETLIST CACHE UPDATE
    // ------------------------------------------------------------------------

    app.post('/createSetlistCache', async (req, res) => {
        let wasScanned = await createSetlistCache(req.body['vsinger-name']);

        res.status(200);
        res.send(JSON.stringify({}));
    });

    app.post('/checkVideoWasScanned', async (req, res) => {
        let wasScanned = await checkVideoWasScanned(req.body['vsinger-name'], req.body['video-id']);

        res.status(200);
        res.send(JSON.stringify({'result' : wasScanned}));
    });

    app.post('/updateSetlistCache', async (req, res) => {
        let wasScanned = await updateSetlistCache(req.body['vsinger-name'], req.body['setlist-cache']);

        res.status(200);
        res.send(JSON.stringify({}));
    });

    // SEARCHING
    // ------------------------------------------------------------------------

    app.post('/songSearch', async (req, res) => {
        console.log(`Searching for ${req.body['song-title']} in setlists of:`);
        console.log('   - ' + req.body['vsinger-name']);

        let searchResults = await songSearch(req.body['vsinger-name'], req.body['song-title']);

        res.status(200);
        res.send(JSON.stringify({'results' : searchResults}));
    });

    app.listen(port, () => {
        console.log(`Vsinger song finder listening on port ${port}`);
        createGUI_page();
    });
}

// ============================================================================
// CLIENT

async function createGUI_page()
{
    const clientPageURI = 'http://localhost:8081/clientPage';
    const browser = await puppeteer.launch({headless : false});
    const clientPage = await browser.newPage();

    const context = browser.defaultBrowserContext();
    await context.overridePermissions('http://localhost', ['clipboard-read', 'clipboard-write']);

    await clientPage.setViewport({
        width: 960,
        height: 960,
        deviceScaleFactor: 1
    });

    await clientPage.goto(clientPageURI);
}

function openVideoPage(videoAddr, songStartTime)
{
    let resultingURL = videoAddr;
    if(songStartTime){
        resultingURL += `&t=${songStartTime}s`;
    }

    console.log(resultingURL);
    os_open(resultingURL);
}

async function obtainChannelId(currentVsinger)
{
    if(channelID_cache[currentVsinger])
    {
        console.log(`Cache hit - channel ID: ${channelID_cache[currentVsinger]}`);
        return channelID_cache[currentVsinger];
    }

    // Extract ID with puppeteer if cache miss

    let [browser, page] = await puppetSetup();
    if(addrMap[currentVsinger])
    {
        await page.goto(addrMap[currentVsinger]);
    }
    else
    {
        await page.goto(`https://www.youtube.com/@${currentVsinger}`);
    }


    await page.waitForSelector('span[jsname][class]');

    // TRACKING PROMPT REJECTION
    // ------------------------------------------------------------------------

    let promptRejected = false;
    while(!promptRejected)
    {
        let candElems = await page.$$('span[jsname][class]');

        for(let idx = 0; idx < candElems.length; ++idx)
        {
            // Scope of a root element. Here, the root is the candidate SPAN tag.
            // Select all its children.
            let childrenElems = await candElems[idx].$$(':scope > *');
            let elementText = await page.evaluate(_elem => _elem.textContent, candElems[idx]);

            if(childrenElems.length === 0 && elementText === 'Reject all')
            {
                let currComputedSize = await page.evaluate(
                    _elem => [getComputedStyle(_elem).width, getComputedStyle(_elem).height],
                    candElems[idx]);

                currComputedSize = currComputedSize.filter((elem) => (elem.indexOf('px') > -1));
                if(currComputedSize.length > 0)
                {
                    candElems[idx].click();
                    promptRejected = true;
                    break;
                }
            }
        }
    }

    await page.waitForNavigation();

    let channelIds = [await extractChannelId(page), ''];
    let pollingSteps = 0;

    channelIds[1] = channelIds[0];
    while(pollingSteps < LOAD_CHANNEL_ID_TIMEOUT){
        await new Promise((res) => {
            setTimeout(() => {res('');}, LOAD_CHANNEL_ID_POLLING_PERIOD);
        });

        channelIds[1] = channelIds[0];
        channelIds[0] = await extractChannelId(page);

        if(pollingSteps >= 2 && channelIds[0] === channelIds[1] && channelIds[0] !== '')
        {
            break;
        }

        pollingSteps++;
    }

    console.log(`Extracted channel ID: ${channelIds[0]}`);

    // Close the browser session
    await page.close();
    await browser.close();

    return channelIds[0];
}

async function checkVideoWasScanned(currentVsinger, videoId)
{
    let currentVsingerCachePath = createVsingerCachePath(currentVsinger);
    let searchResult = false;
    try{
        if(fs.existsSync(currentVsingerCachePath))
        {
            // TODO: escape currentSongTitle?
            const db = new DatabaseSync(currentVsingerCachePath);
            const query = db.prepare(`SELECT 1 FROM setlists WHERE videoId = '${videoId}'`);

            for(let result of query.iterate()){
                searchResult = true;
            }

            db.close();
        }
    }catch{
        console.warn(`WARN: Could not open the setlist database for ${currentVsinger}`);
    }

    return searchResult;
}

async function songSearch(currentVsinger, currentSongTitle)
{
    let currentVsingerCachePath = createVsingerCachePath(currentVsinger);
    const songTimeRegex = new RegExp(/(\d+:\d+(?![\d:]))|(\d+:\d+:\d+)/g);
    let searchResults = [];

    function extractSongTiming(setlistResult)
    {
        let songTiming, songTimingContext;
        setlistResult = setlistResult.split('\n');

        for(let setlistLine of setlistResult)
        {
            let songTitlePosition = setlistLine.toLowerCase().indexOf(currentSongTitle.toLowerCase());
            if(!setlistLine){continue;}
            if(songTitlePosition < 0){continue;}

            let matchesCount = 0;
            for(let match of setlistLine.matchAll(songTimeRegex)){matchesCount++;}

            if(matchesCount === 1 || matchesCount === 2)
            {
                let remainder = setlistLine.substr(songTitlePosition + currentSongTitle.length);
                let _matchesCount = 0;
                for(let match of remainder.matchAll(songTimeRegex)){_matchesCount++;}
                if(_matchesCount > 0){continue;}
            }

            songTiming = setlistLine.match(songTimeRegex)[0];
            songTimingContext = setlistLine;
            break;
        }

        return [songTiming, songTimingContext];
    }

    // ------------------------------------------------------------------------

    try{
        if(fs.existsSync(currentVsingerCachePath))
        {
            // TODO: escape currentSongTitle
            const db = new DatabaseSync(currentVsingerCachePath);

            let startTime = performance.now();
            const query = db.prepare(
                `SELECT videoId, setlist, dateUploaded, videoTitle, thumbSrc FROM setlists WHERE setlist LIKE @currentSongTitle`
            );

            for(let result of query.iterate({'currentSongTitle' : `%${currentSongTitle}%`})){
                let songTiming;

                searchResults.push(
                    {
                        'videoId'         : result['videoId'],
                        'song-start-time' : extractSongTiming(result['setlist']),
                        'uploaded-date'   : result['dateUploaded'],
                        'video-title'     : result['videoTitle'],
                        'thumb-src'       : result['thumbSrc']
                    }
                );
            }

            console.log(`Took ${performance.now() - startTime} ms`);

            db.close();
        }
        else
        {
            console.warn(`WARN: Could not find the setlist database for ${currentVsinger}`);
        }
    }catch (err) {
        console.warn(`WARN: Could not complete the search for ${currentSongTitle} in setlists `+
                     `of ${currentVsinger}.\nDetails: ${err}\n`);
    }

    return searchResults;
}

async function createSetlistCache(currentVsinger)
{
    let currentVsingerCachePath = createVsingerCachePath(currentVsinger);

    try{
        if(!fs.existsSync(currentVsingerCachePath))
        {
            const db = new DatabaseSync(currentVsingerCachePath);
            db.exec(`
                CREATE TABLE IF NOT EXISTS
                            setlists(videoId      TEXT PRIMARY KEY,
                                    setlist       TEXT NOT NULL,
                                    dateUploaded  TEXT DEFAULT "",
                                    videoTitle    TEXT DEFAULT "",
                                    thumbSrc      TEXT DEFAULT "",
                                    algoVer       INTEGER DEFAULT 1,
                                    extraInfo     TEXT DEFAULT ""
                );
            `);
            db.close();
        }
    }catch{
        console.warn(`WARN: Could not create the local cache for ${currentVsinger}`);
        return false;
    }

    return true;
}

async function updateSetlistCache(currentVsinger, setlistCache)
{
    let currentVsingerCachePath = createVsingerCachePath(currentVsinger);
    try{
        if(fs.existsSync(currentVsingerCachePath))
        {
            const db = new DatabaseSync(currentVsingerCachePath);

            // Perform the updates per video ID
            for(let vidId in setlistCache)
            {
                if(setlistCache[vidId]['setlist'] !== '')
                {
                    // SETLIST FOUND
                    const query = db.prepare(
                        `INSERT INTO setlists (videoId, setlist, dateUploaded, videoTitle, thumbSrc, algoVer) `+
                        `VALUES (?, ?, ?, ?, ?, ?)`
                    );

                    query.run(
                        vidId,
                        setlistCache[vidId]['setlist'],
                        setlistCache[vidId]['uploaded-date'],
                        setlistCache[vidId]['video-title'],
                        setlistCache[vidId]['thumb-src'],
                        1
                    );
                }
                else
                {
                    // NO SETLIST
                    const query = db.prepare(
                        `INSERT INTO setlists (videoId, setlist, dateUploaded, videoTitle, thumbSrc, algoVer, extraInfo) `+
                        `VALUES (?, ?, ?, ?, ?, ?, ?)`
                    );

                    query.run(
                        vidId,
                        '',
                        setlistCache[vidId]['uploaded-date'],
                        setlistCache[vidId]['video-title'],
                        setlistCache[vidId]['thumb-src'],
                        1,
                        'NO_SETLIST,'
                    );
                }
            }

            db.close();
        }
    }catch (e){
        console.warn(`WARN: Could not update the local cache for ${currentVsinger}`);
        console.warn(`${e}`);
        return false;
    }

    return true;
}

function createVsingerCachePath(currentVsinger)
{
    // Overwrite to the preferred alias if found in the known Vsingers list
    for(let [preferredName, aliasList] of Object.entries(aliasMap))
    {
        let matchIndex = aliasList.findIndex((alias) => alias === currentVsinger);
        if(matchIndex > -1)
        {
            currentVsinger = preferredName;
            break;
        }
    }

    if(!fs.existsSync(CACHE_BASE_DIR))
    {
        fs.mkdirSync(CACHE_BASE_DIR);
    }

    let currentVsingerCachePath = CACHE_BASE_DIR + `/${currentVsinger}.db`;
    return currentVsingerCachePath;
}

serverSetup();