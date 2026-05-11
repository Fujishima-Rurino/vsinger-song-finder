let YT_API_KEY = '<YOUR_API_KEY>';
const COMMENT_PER_VIDEO_MAX_REQUESTS = 10;
const PLAYLIST_MAX_REQUESTS = 100; // uploads playlist -> 50*100 = 5000 videos available
const COMMENT_MAX_REQUESTS = 2500;

const UPDATE_CHUNK_SIZE = 100;
const DETECT_SETLIST_THRESHOLD = 5;
const filterKeywords = [
    '歌', 'うた', '曲', 'カラオケ', 'karaoke', 'sing', 'song'
];
const songTimeRegex = new RegExp(/\d+:\d+/g);

async function scrapeSetlists()
{

    let vsingerNameInput = document.getElementById('vsinger-name');
    if(vsingerNameInput && vsingerNameInput.value)
    {

        let reqHeaders = new Headers(
            {
                'content-type' : 'application/json'
            }
        );

        // READ THE API KEY
        // ----------------------------------------------------------------------

        if(!YT_API_KEY || YT_API_KEY === '<YOUR_API_KEY>')
        {
            let YT_API_KEY_Resp = await fetch('http://localhost:8081/readAPIkey',
                {
                    headers: reqHeaders
                });
            YT_API_KEY_Resp = await YT_API_KEY_Resp.json();
            YT_API_KEY = YT_API_KEY_Resp['content'];

            if(YT_API_KEY === ''){
                window.alert('Incorrect YT API key!');
                return;
            }
        }

        // EXTRACT CHANNEL ID
        // ----------------------------------------------------------------------

        let channelIdResp = await fetch('http://localhost:8081/obtainChannelId',
            {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify({'vsinger-name' : vsingerNameInput.value})
            });


        let channelId = await channelIdResp.text();
        if(!channelId)
        {
            console.error('Could not extract the channel ID!');
            return;
        }

        // EXTRACT UPLOADS PLAYLIST
        // ----------------------------------------------------------------------

        let resp = await fetch(`https://www.googleapis.com/youtube/v3/channels?id=${channelId}&key=${YT_API_KEY}&part=contentDetails`);

        if(resp.status !== 200)
        {
            console.error(`Playlist ID request failed with code ${resp.status}`);
            return;
        }

        let respJSON = await resp.json();
        let uploadPlaylistId;
        try{
            uploadPlaylistId = respJSON.items[0].contentDetails.relatedPlaylists.uploads;
        }
        catch{
            console.error('Could not extract the uploads playlist ID from the response!');
            return;
        }

        // CREATE THE LOCAL DB IF NOT PRESENT
        // ----------------------------------------------------------------------

        let creationResp = await fetch('http://localhost:8081/createSetlistCache',
            {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify({'vsinger-name' : vsingerNameInput.value})
            });

        // SCAN THROUGH UPLOADS
        // ----------------------------------------------------------------------

        let setlistCache = {};
        let playlistRequests = -1, totalCommentRequests = 0;
        let videoRespJSON;

        do{
            playlistRequests++;

            if(playlistRequests > 0 && !videoRespJSON.nextPageToken){ break; }
            let videoResp = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?playlistId=${uploadPlaylistId}`+
                                        `${(playlistRequests > 0)?('&pageToken=' + videoRespJSON.nextPageToken):('')}`+
                                        `&key=${YT_API_KEY}&part=snippet&maxResults=50`);
            if(videoResp.status !== 200){ break; }
            videoRespJSON = await videoResp.json();

            for(let videoItem of videoRespJSON.items)
            {
                let currVideoId             = videoItem?.snippet?.resourceId?.videoId;
                let currVideoTitleRaw       = videoItem?.snippet?.title;
                let currVideoPublishedDate  = videoItem?.snippet?.publishedAt;
                let currVideoThumbSrc       = videoItem?.snippet?.thumbnails?.medium?.url;

                if(!currVideoId || !currVideoTitleRaw){ continue; }

                // Filter the streams by their titles -> use list of common keywords
                let currVideoTitle = currVideoTitleRaw.toLowerCase();
                let videoTitlePassed = filterKeywords.map(kword => currVideoTitle.indexOf(kword) > -1)
                                                    .reduce((acc, curr) => acc || curr, false);
                if(!videoTitlePassed){ continue; }

                let wasScanned = await fetch('http://localhost:8081/checkVideoWasScanned',
                    {
                        method: 'POST',
                        headers: reqHeaders,
                        body: JSON.stringify(
                            {
                                'vsinger-name'  : vsingerNameInput.value,
                                'video-id'      : currVideoId
                            }
                        )
                    });
                wasScanned = await wasScanned.json();
                wasScanned = wasScanned['result'];

                // Also skip videos already found in cache
                if(wasScanned){continue;}

                // Request the comments, handle 403 on disabled videos/streams with disabled comments,
                // like future streams.
                let commentResp = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?key=${YT_API_KEY}`+
                                                `&textFormat=plainText&part=snippet&videoId=${currVideoId}&maxResults=100`);
                totalCommentRequests++;
                if(commentResp.status !== 200)
                {
                    console.log(`Skipping upload ${currVideoId}, server response code ${commentResp.status}.`);
                    continue;
                }

                let commentRespJSON = await commentResp.json();
                let currVideoComments = [], commentRequests = -1;

                do{
                    commentRequests++;
                    for(let commentItem of commentRespJSON.items)
                    {
                        currVideoComments.push({
                            content : commentItem?.snippet?.topLevelComment?.snippet?.textDisplay,
                            likes   : commentItem?.snippet?.topLevelComment?.snippet?.likeCount
                        });
                    }

                    if(!commentRespJSON.nextPageToken){ break; }
                    commentResp = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?key=${YT_API_KEY}`+
                                                `&pageToken=${commentRespJSON.nextPageToken}`+
                                                `&textFormat=plainText&part=snippet&videoId=${currVideoId}&maxResults=100`);
                    totalCommentRequests++;
                    if(commentResp.status !== 200){ break; }
                    commentRespJSON = await commentResp.json();
                }while(commentRequests < COMMENT_PER_VIDEO_MAX_REQUESTS)

                // We have all the comments available, now sort them by likes and try to find the setlist
                if(currVideoComments.length >= 1)
                {
                    currVideoComments.sort((elem1, elem2) => elem2.likes - elem1.likes);
                    for(let cmtIdx = 0; cmtIdx < currVideoComments.length; ++cmtIdx)
                    {
                        let matchesCount = 0;
                        for(let match of currVideoComments[cmtIdx]['content'].matchAll(songTimeRegex)){matchesCount++;}

                        if(matchesCount > DETECT_SETLIST_THRESHOLD)
                        {
                            setlistCache[currVideoId] = {
                                'setlist'       : currVideoComments[cmtIdx]['content'],
                                'video-title'   : currVideoTitleRaw,
                                'uploaded-date' : currVideoPublishedDate ?? '',
                                'thumb-src'     : currVideoThumbSrc ?? ''
                            };
                            break;
                        }
                    }
                }

                // Assign an empty setlist for this video if no setlist was found.
                // This vid will be interpreted as previously searched,
                // so that comments for this will not be requested again.
                if(!setlistCache.hasOwnProperty(currVideoId))
                {
                    setlistCache[currVideoId] = {
                        'setlist'       : '',
                        'video-title'   : currVideoTitleRaw,
                        'uploaded-date' : currVideoPublishedDate ?? '',
                        'thumb-src'     : currVideoThumbSrc ?? ''
                    };
                }

                // Send the current vid<->setlist mapping chunk to the local server for it to update the DB.
                // Clear the current setlist cache afterwards.
                if(Object.keys(setlistCache).length >= UPDATE_CHUNK_SIZE)
                {
                    let updateResp = await fetch('http://localhost:8081/updateSetlistCache',
                        {
                            method: 'POST',
                            headers: reqHeaders,
                            body: JSON.stringify({
                                'vsinger-name'  : vsingerNameInput.value,
                                'setlist-cache' : setlistCache
                            })
                        });

                    setlistCache = {};
                }

            } // PER VIDEO
        }while(totalCommentRequests < COMMENT_MAX_REQUESTS && playlistRequests < PLAYLIST_MAX_REQUESTS)

        // Update with the remainder of setlists
        if(Object.keys(setlistCache).length >= 0)
        {
            let updateResp = await fetch('http://localhost:8081/updateSetlistCache',
                {
                    method: 'POST',
                    headers: reqHeaders,
                    body: JSON.stringify({
                        'vsinger-name'  : vsingerNameInput.value,
                        'setlist-cache' : setlistCache
                    })
                });

            setlistCache = {};
        }


        console.log(`Finished scraping the setlists from ${vsingerNameInput.value}.\n`+
                    `Made ${playlistRequests} video chunk requests.` +
                    `${(playlistRequests >= PLAYLIST_MAX_REQUESTS)?(' This is the configured maximum!'):('')}`);

        console.log(`Total of ${totalCommentRequests} comment requests made.`);

    } // NAME NON-EMPTY
} // SCRAPE SETLISTS


function _createTitleElem(videoId, videoTitle, songStartTime)
{
    function titleClickHandler(ev)
    {
        let reqHeaders = new Headers(
            {
                'content-type' : 'application/json'
            }
        );

        let reqBodyObj;
        if(songStartTime){
            reqBodyObj = {
                'video-addr' : ev.currentTarget.getAttribute('data-video-addr'),
                'song-start-time' : songStartTime
            }
        }
        else{
            reqBodyObj = {
                'video-addr' : ev.currentTarget.getAttribute('data-video-addr')
            }
        }

        fetch('http://localhost:8081/openVideoPage',
            {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify(reqBodyObj)
            });
    }

    let textDescription = document.createElement('span');
    textDescription.classList.add('thumbnail-result-title');
    textDescription.textContent = videoTitle;

    textDescription.setAttribute('data-video-addr', `https://www.youtube.com/watch?v=${videoId}`);
    textDescription.addEventListener('click', titleClickHandler);

    return textDescription;
}

function createTextResultElem(videoId, uploadedDate, videoTitle)
{
    function copyIconClickHandler(ev)
    {
        let videoAddr = ev.currentTarget.getAttribute('data-video-addr');

        if(videoAddr){
            navigator.clipboard.writeText(videoAddr);
        }
    }

    let resultContainer = document.createElement('div');
    resultContainer.style.display = 'flex';
    resultContainer.style.flexDirection = 'row';
    resultContainer.style.alignItems = 'center';

    let listMarker = document.createElement('span');
    listMarker.style.marginLeft = '-2px';
    listMarker.textContent = '●';

    let textDescription = _createTitleElem(videoId, videoTitle);

    let copyIcon = document.createElement('img');
    copyIcon.src = './assets/copy-2-line.svg';
    copyIcon.style.cursor        = 'pointer';
    copyIcon.style.display       = 'flex';
    copyIcon.style.marginTop     = '3px';
    copyIcon.style.marginLeft    = '3px';
    copyIcon.style.width         = '16px';
    copyIcon.style.height        = '16px';

    copyIcon.setAttribute('data-video-addr', `https://www.youtube.com/watch?v=${videoId}`);
    copyIcon.addEventListener('click', copyIconClickHandler);

    resultContainer.appendChild(listMarker);
    resultContainer.appendChild(textDescription);
    resultContainer.appendChild(copyIcon);

    return resultContainer;
}

function createThumbnailResultElem(videoId, songStartTime, uploadedDate, videoTitle, thumbSrc)
{
    function copyIconClickHandler(ev)
    {
        let videoAddr = ev.currentTarget.getAttribute('data-video-addr');

        if(videoAddr){
            navigator.clipboard.writeText(videoAddr);
        }
    }

    function formatDate(rawDate)
    {
        let parsedDate = new Date(rawDate);
        let datePart = rawDate.split('T')[0];
        let timePart = `${parsedDate.getHours().toString().padStart(2, '0')}:` +
                       `${parsedDate.getMinutes().toString().padStart(2, '0')}:` +
                       `${parsedDate.getSeconds().toString().padStart(2, '0')}`;

        return `${datePart} ${timePart}`;
    }

    // ------------------------------------------------------------------------
    let songTimingTextDesc = (songStartTime && songStartTime[0]) ?
        (`at ${songStartTime[0]}`) :
        (`Couldn't extract start time.`);

    let startTimeSeconds = '';
    if(songStartTime && songStartTime[0]){
        startTimeSeconds = songStartTime[0].split(':')
            .map((elem, idx, arr) => Number(elem)*(60**(arr.length-1-idx)))
            .reduce((curr, acc) => acc + curr, 0);
    }
    // ------------------------------------------------------------------------

    let resultContainer = document.createElement('div');
    resultContainer.classList.add('thumbnail-result-container');

    let videoThumbnail = document.createElement('img');
    videoThumbnail.classList.add('thumbnail-result-thumbnail-image');
    videoThumbnail.src = thumbSrc;


        let textDescContainer = document.createElement('div');
        textDescContainer.classList.add('text-description-container');

        let textDescription = _createTitleElem(videoId, videoTitle, startTimeSeconds);
            let entryDetailsContainer = document.createElement('div');
            entryDetailsContainer.classList.add('entry-details-container');
                let songTimingContainer = document.createElement('div');
                songTimingContainer.classList.add('song-timing-container');
                    let songTiming = document.createElement('span');
                    songTiming.textContent = songTimingTextDesc;

                songTimingContainer.appendChild(songTiming);

                let uploadedDateTextContainer = document.createElement('div');
                uploadedDateTextContainer.classList.add('uploaded-date-container');
                    let uploadedDateText = document.createElement('span');
                    uploadedDateText.classList.add('uploaded-date-text');
                    uploadedDateText.textContent = formatDate(uploadedDate);
                uploadedDateTextContainer.appendChild(uploadedDateText);

            entryDetailsContainer.appendChild(songTimingContainer);
            entryDetailsContainer.appendChild(uploadedDateTextContainer);


        textDescContainer.appendChild(textDescription);
        textDescContainer.appendChild(entryDetailsContainer);


    let copyIcon = document.createElement('img');
    copyIcon.classList.add('thumbnail-result-copy-icon');
    copyIcon.src = './assets/copy-2-line.svg';
    copyIcon.setAttribute('data-video-addr', `https://www.youtube.com/watch?v=${videoId}`);
    copyIcon.addEventListener('click', copyIconClickHandler);

    resultContainer.appendChild(videoThumbnail);
    resultContainer.appendChild(textDescContainer);
    resultContainer.appendChild(copyIcon);

    return resultContainer;
}

async function searchForSong()
{
    let songTitleInput = document.getElementById('song-title');
    let vsingerNameInput = document.getElementById('vsinger-name');
    let searchResultsList = document.getElementById('search-results');
    let showThumbnailsToggle = document.getElementById('show-thumbnails-toggle');

    if(!searchResultsList)
    {
        console.error('Could not locate search results element!');
        return;
    }

    if(vsingerNameInput && vsingerNameInput.value && songTitleInput && songTitleInput.value)
    {
        let reqHeaders = new Headers(
            {
                'content-type' : 'application/json'
            }
        );

        let searchResults = await fetch('http://localhost:8081/songSearch',
            {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify(
                    {'vsinger-name' : vsingerNameInput.value,
                     'song-title'   : songTitleInput.value}
                )
            });

        searchResults = await searchResults.json();
        searchResults = searchResults['results'];

        // Cleanup previous results
        while(searchResultsList?.children?.length > 0)
        {
            searchResultsList.children[0].remove();
        }

        // We have match(es) ->
        // Each 'searchResult' is an object with a 'videoId'
        for(let searchResult of searchResults)
        {
            let listElem;

            if(showThumbnailsToggle && showThumbnailsToggle.checked && searchResult['thumb-src']){
                listElem = createThumbnailResultElem(
                    searchResult['videoId'],
                    searchResult['song-start-time'],
                    searchResult['uploaded-date'],
                    searchResult['video-title'],
                    searchResult['thumb-src']
                );
            }else{
                listElem = createTextResultElem(
                    searchResult['videoId'],
                    searchResult['uploaded-date'],
                    searchResult['video-title']
                );
            }

            searchResultsList.appendChild(listElem);
        }
    }
}