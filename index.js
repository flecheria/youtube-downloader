const ytdl = require("@distube/ytdl-core");
const https = require("https");
const path = require("path");
const fs = require("fs");

/**
 * Sanitizes a string to make it safe for use as a filename
 * @param {string} title - The original filename or title
 * @param {boolean} [preserveSpaces=true] - Whether to preserve spaces or replace them with underscores
 * @param {string} [replacement='-'] - Character to use as replacement for invalid characters
 * @return {string} - A sanitized filename that's safe for most file systems
 */
function sanitizeFileTitle(title, preserveSpaces = true, replacement = "-") {
  if (!title) return "untitled";

  // Replace invalid file characters
  // Windows: < > : " / \ | ? * and control characters
  // macOS/Linux: / and NUL character
  // Also handles other problematic characters like #, %, &, etc.
  let sanitized = title
    .replace(/[<>:"\/\\|?*\x00-\x1F]/g, replacement) // Basic invalid chars
    .replace(/[#%&{}[\]~`$!:@=+;,^]/g, replacement) // Other problematic chars

    // Replace leading/trailing periods and spaces (problematic in Windows)
    .replace(/^\s+|\s+$|^\.+|\.+$/g, "")

    // Handle non-breaking spaces and other whitespace variants
    .replace(/\s+/g, preserveSpaces ? " " : replacement)

    // Replace consecutive replacement characters with a single one
    .replace(new RegExp(`${replacement}+`, "g"), replacement)

    // Remove emojis and other non-standard characters
    .replace(/[\u{10000}-\u{10FFFF}]/gu, "");

  // Check if the sanitized name is empty
  if (!sanitized) return "untitled";

  // Trim to a reasonable length (255 is max for many file systems)
  // Use a smaller number for safety with paths
  sanitized = sanitized.substring(0, 200);

  // Ensure it doesn't end with a replacement character
  sanitized = sanitized.replace(new RegExp(`${replacement}$`), "");

  // Handle reserved filenames in Windows
  const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reservedNames.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  return sanitized;
}

async function getAudioUrls(youtubeUrl) {
  try {
    const info = await ytdl.getInfo(youtubeUrl);
    const audioFormats = ytdl.filterFormats(info.formats, "audioonly");
    const formats128 = audioFormats.filter((af) => af.audioBitrate === 128);

    if (formats128.length === 0) {
      throw new Error("No 128 bitrate audio formats found");
    }

    return {
      urls: formats128.map((format) => format.url),
      title: info.videoDetails.title,
    };
  } catch (error) {
    console.error("Error getting audio URLs:", error);
    throw error;
  }
}

async function downloadAudioStream(audioUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fileStream = fs.createWriteStream(outputPath);
    let isResolved = false;

    const download = https.get(audioUrl, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        fileStream.close();
        downloadAudioStream(response.headers.location, outputPath)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        fileStream.close();
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      response.pipe(fileStream);

      fileStream.on("finish", () => {
        fileStream.close();
        if (!isResolved) {
          isResolved = true;
          resolve("Download completed");
        }
      });

      response.on("error", (error) => {
        fileStream.close();
        if (!isResolved) {
          isResolved = true;
          reject(error);
        }
      });

      fileStream.on("error", (error) => {
        fileStream.close();
        if (!isResolved) {
          isResolved = true;
          reject(error);
        }
      });
    });

    download.on("error", (error) => {
      fileStream.close();
      if (!isResolved) {
        isResolved = true;
        reject(error);
      }
    });

    // Add timeout to avoid hanging
    download.setTimeout(30000, () => {
      fileStream.close();
      download.destroy();
      if (!isResolved) {
        isResolved = true;
        reject(new Error("Download timeout"));
      }
    });
  });
}

async function tryDownloadFromAllUrls(urls, outputPath) {
  let lastError = null;

  for (let i = 0; i < urls.length; i++) {
    try {
      console.log(`Attempting download from URL ${i + 1}/${urls.length}`);
      await downloadAudioStream(urls[i], outputPath);
      console.log(`Successfully downloaded from URL ${i + 1}`);
      return true; // Successfully downloaded
    } catch (error) {
      console.log(`Failed to download from URL ${i + 1}:`, error.message);
      lastError = error;
      // Delete failed download if file exists
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      continue; // Try next URL
    }
  }

  throw new Error(`All downloads failed. Last error: ${lastError.message}`);
}

// Usage example:
const youtubeUrl = "https://www.youtube.com/watch?v=Zd4b-PnJaJo";

// First get all audio URLs, then try downloading from each until success
getAudioUrls(youtubeUrl)
  .then(async (audioInfo) => {
    const title = sanitizeFileTitle(audioInfo.title);
    console.log(`Found ${audioInfo.urls.length} audio URLs for: ${title}`);

    const outputPath = path.join(__dirname, "tracks/playlist", `${title}.mp4`);
    await tryDownloadFromAllUrls(audioInfo.urls, outputPath);
    console.log("Download completed successfully");
  })
  .catch((error) => console.error("Error:", error));
