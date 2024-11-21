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

const fetchAndUnzip = async () => {
  const startTime = Date.now();
  const zipUrl = `https://github.com/v2fly/domain-list-community/archive/refs/heads/master.zip`;
  const zipBlob = await fetch(zipUrl).then((res) => {
    if (res.ok) {
      return res.arrayBuffer();
    }
    throw new Error(
      `Failed to fetch ZIP file: ${res.status} ${res.statusText}`
    );
  });
  const fetchedTime = Date.now();

  const zip = await JSZip.loadAsync(zipBlob);
  console.log(
    `Fetched ZIP file (${formatBytes(zipBlob.byteLength)}) in ${
      startTime - fetchedTime
    }ms, unzipped ${Object.keys(zip.files).length} files in ${
      Date.now() - fetchedTime
    }ms`
  );
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
  const nameWithFilter = c.req.param("name_with_filter").toLowerCase();
  const [name, filter] = nameWithFilter.includes("@")
    ? nameWithFilter.split("@")
    : [nameWithFilter, null];
  const cachedZip = await fetchAndUnzip();

  // const type = c.req.query("type") || "surge";
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
  return c.text(surgeList);
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
