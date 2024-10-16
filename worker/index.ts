import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { cache } from "hono/cache";

import { regexAstToWildcard } from "./wildcard";

const app = new Hono();
app.use(logger());

app.get(
  "*",
  cache({
    cacheName: "rulelist",
    cacheControl: "max-age=1800",
  })
);

const getUpstream = async (name: string) => {
  const url = `https://raw.githubusercontent.com/v2fly/domain-list-community/master/data/${name}`;
  const content = await fetch(url).then((res) => {
    if (res.ok) {
      return res.text();
    }
    throw new Error(`Failed to fetch content: ${res.status} ${res.statusText}`);
  });
  return content;
};

const genSurgeList = async (
  upstreamContent: string,
  filter: string | null = null
): Promise<string> => {
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
        const subUpstreamContent = await getUpstream(subContentName).catch(
          (err) => {
            throw new Error(
              `Failed to fetch sub-upstream content: ${err.message}`
            );
          }
        );
        const subSurgeList = await genSurgeList(subUpstreamContent, filter);
        return "# " + line + "\n" + subSurgeList;
      }
      return convert("", "DOMAIN-SUFFIX,");
    })
  );

  return convertedLines.join("\n");
};

app.get("/geosite/:name_with_filter", async (c) => {
  const nameWithFilter = c.req.param("name_with_filter");
  const [name, filter] = nameWithFilter.includes("@")
    ? nameWithFilter.split("@")
    : [nameWithFilter, null];

  // const type = c.req.query("type") || "surge";
  const upstreamContent = await getUpstream(name).catch((err) => {
    throw new HTTPException(500, {
      message: `Failed to fetch upstream content: ${err.message}`,
    });
  });
  const surgeList = await genSurgeList(upstreamContent, filter).catch((err) => {
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

export default app;
