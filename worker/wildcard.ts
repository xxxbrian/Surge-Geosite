import { parse, RootNode } from "regjsparser";

export const regexAstToWildcard = (regex: string): string => {
  // remove leading and trailing slashes
  const cleanRegex = regex.replace(/^\/|\/$/g, "");

  try {
    const ast = parse(cleanRegex, "", {
      lookbehind: true,
      namedGroups: true,
      unicodePropertyEscape: true,
      unicodeSet: true,
      modifiers: true,
    });
    return convertNodeToWildcard(ast);
  } catch (error) {
    console.error("Error parsing regex:", error);
    return "";
  }
};

const convertNodeToWildcard = (
  node: RootNode<{
    lookbehind: true;
    namedGroups: true;
    unicodePropertyEscape: true;
    unicodeSet: true;
    modifiers: true;
  }>
): string => {
  switch (node.type) {
    case "alternative":
      return node.body.map(convertNodeToWildcard).join("");
    case "anchor":
      return "";
    case "characterClass":
      return "?";
    case "characterClassEscape":
      return "?";
    case "disjunction":
      return "*";
    case "dot":
      return "?";
    case "group":
      return convertNodeToWildcard(node.body[0]);
    case "quantifier":
      return "*";
    case "reference":
      return "*";
    case "value":
      if (typeof node.codePoint === "number") {
        return String.fromCodePoint(node.codePoint);
      }
      return "?";
    case "unicodePropertyEscape":
      return "?";
  }
};
