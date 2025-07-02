import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { cache } from "hono/cache";

import { regexAstToWildcard } from "./wildcard";
import JSZip from "jszip";

const app = new Hono();
app.use(logger());

app.get(
  "*",
  cache({
    cacheName: "rulelist",
    cacheControl: "max-age=1800",
  })
);

const formatBytes = (bytes: number, decimals = 2) => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
};

const getZipETag = async (zipUrl: string): Promise<string | null> => {
  try {
    // Only fetch headers to get ETag without downloading the full ZIP
    const response = await fetch(zipUrl, { 
      method: 'HEAD',
      headers: {
        'User-Agent': 'Surge-Geosite-Worker/1.0'
      }
    });
    
    if (!response.ok) {
      console.warn(`Failed to get ZIP ETag: ${response.status} ${response.statusText}`);
      return null;
    }
    
    const etag = response.headers.get('etag');
    if (etag) {
      // Clean up ETag (remove quotes and W/ prefix if present)
      return etag.replace(/^W\/|"/g, '');
    }
    
    console.warn('No ETag found in ZIP response headers');
    return null;
  } catch (error) {
    console.warn('Failed to fetch ZIP ETag:', error);
    return null;
  }
};

const fetchAndUnzip = async () => {
  const startTime = Date.now();
  const zipUrl = `https://github.com/v2fly/domain-list-community/archive/refs/heads/master.zip`;

  // Get ZIP ETag for cache key, fallback to time-based caching
  const zipETag = await getZipETag(zipUrl);
  const cacheKey = zipETag
    ? new Request(`https://cache.local/zip-cache/${zipETag}`)
    : new Request(`https://cache.local/zip-cache/fallback-${Math.floor(Date.now() / (1000 * 60 * 30))}`);

  const cache = caches.default;

  // Try to get from cache first
  let cachedResponse = await cache.match(cacheKey);
  let zipBlob: ArrayBuffer;

  if (cachedResponse) {
    zipBlob = await cachedResponse.arrayBuffer();
    const cacheType = zipETag ? `ETag ${zipETag.substring(0, 8)}` : 'time-based cache';
    console.log(`Using cached ZIP file (${formatBytes(zipBlob.byteLength)}) from ${cacheType}`);
  } else {
    // Fetch from upstream
    const response = await fetch(zipUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch ZIP file: ${response.status} ${response.statusText}`);
    }

    zipBlob = await response.arrayBuffer();
    const fetchedTime = Date.now();

    // Cache the response
    const cacheResponse = new Response(zipBlob, {
      headers: {
        'Cache-Control': zipETag ? 'public, max-age=86400' : 'public, max-age=1800', // 24h for ETag-based, 30min for fallback
        'Content-Type': 'application/zip',
        'X-ETag': zipETag || 'fallback'
      }
    });
    await cache.put(cacheKey, cacheResponse);

    const cacheType = zipETag ? `ETag ${zipETag.substring(0, 8)}` : 'fallback cache';
    console.log(`Fetched and cached ZIP file (${formatBytes(zipBlob.byteLength)}) for ${cacheType} in ${fetchedTime - startTime}ms`);
  }

  const zip = await JSZip.loadAsync(zipBlob);
  console.log(`Unzipped ${Object.keys(zip.files).length} files in ${Date.now() - startTime}ms`);
  return zip;
};

const getUpstream = async (cachedZip: JSZip, name: string) => {
  // Find the file inside the unzipped directory
  const filePath = `domain-list-community-master/data/${name}`;
  const fileContent = await cachedZip.file(filePath)?.async("text");

  if (!fileContent) {
    throw new Error(`File not found in the ZIP archive: ${filePath}`);
  }

  return fileContent;
};

const genSurgeList = async (
  upstreamContent: string,
  filter: string | null = null,
  cachedZip: JSZip | null = null
): Promise<string> => {
  if (!cachedZip) {
    cachedZip = await fetchAndUnzip();
  }
  const lines = upstreamContent.split("\n");
  const convertedLines = await Promise.all(
    lines.map(async (line) => {
      line = line.trim();
      const convert = (from: string, to: string, specifyLine?: string) => {
        const line_chunks = specifyLine
          ? specifyLine.split(" ")
          : line.split(" ");
        const rest = line_chunks.slice(1).join(" ");
        if (filter) {
          const trimmedRest = rest.trim();
          const filterString = `@${filter}`;
          const commentIndex = trimmedRest.indexOf("#");
          const filterIndex = trimmedRest.indexOf(filterString);

          if (
            !trimmedRest.startsWith("@") ||
            filterIndex === -1 ||
            (commentIndex !== -1 && commentIndex < filterIndex)
          ) {
            return "";
          }
        }
        const rule =
          from.length !== 0
            ? line_chunks[0].replace(from, to)
            : to + line_chunks[0];
        return `${rule} ${
          !rest.startsWith("#") && rest.length !== 0 ? `# ${rest}` : rest
        }`;
      };

      if (line.startsWith("#") || line === "") {
        return line;
      }
      if (line.startsWith("domain:")) {
        return convert("domain:", "DOMAIN-SUFFIX,");
      }
      if (line.startsWith("full:")) {
        return convert("full:", "DOMAIN,");
      }
      if (line.startsWith("keyword:")) {
        return convert("keyword:", "DOMAIN-KEYWORD,");
      }
      if (line.startsWith("regexp:")) {
        const regexp = line.split(" ")[0].replace("regexp:", "");
        return convert(
          "regexp:",
          "DOMAIN-WILDCARD,",
          line.replace(regexp, regexAstToWildcard(regexp))
        );
      }
      if (line.startsWith("include:")) {
        const subContentName = line.split(" ")[0].replace("include:", "");
        const subUpstreamContent = await getUpstream(
          cachedZip,
          subContentName
        ).catch((err) => {
          throw new Error(
            `Failed to fetch sub-upstream content: ${err.message}`
          );
        });
        const subSurgeList = await genSurgeList(
          subUpstreamContent,
          filter,
          cachedZip
        );
        return "# " + line + "\n" + subSurgeList;
      }
      return convert("", "DOMAIN-SUFFIX,");
    })
  );

  return convertedLines.join("\n");
};

app.get("/geosite/:name_with_filter", async (c) => {
  const nameWithFilter = c.req.param("name_with_filter").toLowerCase().trim();

  // Validate input
  if (!nameWithFilter || nameWithFilter.length === 0) {
    throw new HTTPException(400, { message: "Invalid name parameter" });
  }

  const [name, filter] = nameWithFilter.includes("@")
    ? nameWithFilter.split("@", 2)  // Only split on first @
    : [nameWithFilter, null];

  // Validate name after splitting
  if (!name || name.length === 0) {
    throw new HTTPException(400, { message: "Invalid name parameter" });
  }

  try {
    // Try to get ZIP ETag for precise caching
    const zipUrl = `https://github.com/v2fly/domain-list-community/archive/refs/heads/master.zip`;
    const zipETag = await getZipETag(zipUrl);
    const cache = caches.default;

    // Create cache key for final result
    const resultCacheKey = zipETag
      ? new Request(`https://cache.local/result/${zipETag}/${nameWithFilter}`)
      : new Request(`https://cache.local/result/fallback-${Math.floor(Date.now() / (1000 * 60 * 30))}/${nameWithFilter}`);

    // Try to get cached result first
    const cachedResult = await cache.match(resultCacheKey);
    if (cachedResult) {
      const result = await cachedResult.text();
      console.log(`Cache hit for ${nameWithFilter} ${zipETag ? `(ETag ${zipETag.substring(0, 8)})` : '(fallback)'}`);
      return c.text(result);
    }

    console.log(`Cache miss for ${nameWithFilter}, generating new result...`);

    // Cache miss - need to generate result
    const cachedZip = await fetchAndUnzip();
    const upstreamContent = await getUpstream(cachedZip, name).catch((err) => {
      throw new HTTPException(500, {
        message: `Failed to fetch upstream content: ${err.message}`,
      });
    });

    const surgeList = await genSurgeList(
      upstreamContent,
      filter,
      cachedZip
    ).catch((err) => {
      throw new HTTPException(500, {
        message: `Failed to generate Surge list: ${err.message}`,
      });
    });

    // Cache the final result
    const resultResponse = new Response(surgeList, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': zipETag ? 'public, max-age=86400' : 'public, max-age=1800',
        'X-ETag': zipETag || 'fallback',
        'X-Generated-At': new Date().toISOString()
      }
    });

    // Don't await cache.put to avoid blocking response
    cache.put(resultCacheKey, resultResponse.clone()).catch(err => {
      console.warn('Failed to cache result:', err);
    });

    console.log(`Generated and cached result for ${nameWithFilter} ${zipETag ? `(ETag ${zipETag.substring(0, 8)})` : '(fallback)'}`);
    return c.text(surgeList);

  } catch (error) {
    console.error(`Error processing ${nameWithFilter}:`, error);
    throw new HTTPException(500, {
      message: `Failed to process request: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
});

app.get("/geosite", async (c) => {
  const githubRaw = await fetch(
    "https://raw.githubusercontent.com/xxxbrian/Surge-Geosite/main/index.json"
  )
    .then((res) => {
      if (res.ok) {
        return res.json() as Promise<Record<string, string>>;
      }
      throw new HTTPException(500, {
        message: `Failed to fetch content from GitHub: ${res.status} ${res.statusText}`,
      });
    })
    .catch((err) => {
      throw new HTTPException(500, {
        message: `Failed to fetch content from GitHub: ${err.message}`,
      });
    });
  return c.json(githubRaw);
});

app.get("/", async (c) => {
  // redirect to the GitHub repository
  return c.redirect("https://github.com/xxxbrian/Surge-Geosite");
});

app.get("/misc/:category/:name", async (c) => {
  const category = c.req.param("category").toLowerCase();
  const name = c.req.param("name").toLowerCase();
  const githubRaw = await fetch(
    `https://raw.githubusercontent.com/xxxbrian/Surge-Geosite/refs/heads/main/misc/${category}/${name}.list`
  )
    .then((res) => {
      if (res.ok) {
        return res.text();
      }
      throw new HTTPException(500, {
        message: `Failed to fetch content from GitHub: ${res.status} ${res.statusText}`,
      });
    })
    .catch((err) => {
      throw new HTTPException(500, {
        message: `Failed to fetch content from GitHub: ${err.message}`,
      });
    });
  return c.text(githubRaw);
});

export default app;
