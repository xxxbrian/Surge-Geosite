import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { cache } from "hono/cache";

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
      const convert = (from: string, to: string) => {
        const line_chunks = line.split(" ");
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
        return convert("regexp:", "DOMAIN-KEYWORD,");
      }
      if (line.startsWith("include:")) {
        const subContentName = line.split(" ")[0].replace("include:", "");
        const subUpstreamContent = await getUpstream(subContentName).catch(
          (err) => {
            throw new HTTPException(500, err.message);
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
    throw new HTTPException(500, err.message);
  });
  const surgeList = await genSurgeList(upstreamContent, filter).catch((err) => {
    throw new HTTPException(500, err.message);
  });
  return c.text(surgeList);
});

export default app;