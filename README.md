# vsinger-song-finder
## Utility to search through vsinger/tuber streams for specific songs made in node.js.

Currently this is more of a dev-friendly gig, with plans to make a standalone app that can be used by anyone in the future.

## Installation
Prerequisites:
  - node.js
  - npm

Clone the repo, then install the node modules as normal:
```
npm install
```

Once you have the dependencies, run the launcher script with node:
```
node vsingerSongFinder.js
```

or like this if you use the `.env` file for storing the API key:

```
node --env-file=.env vsingerSongFinder.js
```

This relies heavily on official YouTube API, so you will need to obtain an API key from Google Cloud Console. It's free and gives you 10k quota units daily, which in my experience in quite enough, unless you're planning on scraping setlists from dozens of Vtubers in a single session. If you're lagging like fck on Google Cloud Console pages trying to generate the API key, it's not just you. That site is optimized like someone run 120x frame gen on a 1FPS source, I kid you not.

-----------

If you have YouTube API key, congrats. For now, you can put that into `.env` file in the root directory, or declare a YT_API_KEY environment variable.

You can create a db of setlists with `Scrape setlists` and search for songs of a vsinger with `Search`. The channel name that you have to put into `Vsinger channel name` is the name that goes after `@` in the channel URL. Go to the channel page and copy that part of the address. The channel address will most often look like this: "https://www.youtube.com/@<CHANNEL_NAME>". You would then put in CHANNEL_NAME in `Scrape setlists`.