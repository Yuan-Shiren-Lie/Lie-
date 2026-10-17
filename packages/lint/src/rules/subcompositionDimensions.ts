import { parseHTML } from "linkedom";
import postcss from "postcss";
import type { HyperframeLintFinding, LintContext } from "../context";
import { readAttr, readDecodedAttr, stripJsComments, truncateSnippet } from "../utils";

function positiveDimension(raw: string | null): number | null {
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function nativeDimension(value: string, dimension: number): boolean {
  const pixels = value.trim().match(/^(\d+(?:\.\d+)?)px$/i);
  return pixels !== null && Number(pixels[1]) === dimension;
}

function changesMountLayout(property: string, rawValue: string, width: number, height: number) {
  const value = rawValue
    .replace(/!\s*important\s*$/i, "")
    .trim()
    .toLowerCase();
  switch (property.toLowerCase()) {
    case "width":
      return !nativeDimension(value, width);
    case "height":
      return !nativeDimension(value, height);
    case "left":
    case "top":
      return !/^0(?:\.0+)?(?:px|%)?$/.test(value);
    case "position":
      return value !== "absolute";
    case "transform":
      return value !== "none";
    case "scale":
      return value !== "none" && value !== "1" && value !== "1 1";
    case "zoom":
      return value !== "normal" && value !== "1" && value !== "100%";
    default:
      return /^(?:all|inset(?:-.+)?|right|bottom|translate|rotate|(?:min|max)-(?:width|height)|(?:inline|block)-size|margin(?:-.+)?|animation(?:-.+)?)$/.test(
        property.toLowerCase(),
      );
  }
}

function hasLayoutOverride(
  element: Element,
  width: number,
  height: number,
  styles: postcss.Root[],
): boolean {
  let changed = false;
  const inspect = (declaration: postcss.Declaration) => {
    if (changesMountLayout(declaration.prop, declaration.value, width, height)) changed = true;
  };
  try {
    postcss.parse(`mount { ${element.getAttribute("style") ?? ""} }`).walkDecls(inspect);
    for (const style of styles) {
      style.walkRules((rule) => {
        if (rule.parent?.type === "atrule" && /(?:^|-)keyframes$/i.test(rule.parent.name)) {
          return;
        }
        let overridesLayout = false;
        rule.walkDecls((declaration) => {
          if (changesMountLayout(declaration.prop, declaration.value, width, height)) {
            overridesLayout = true;
          }
        });
        if (!overridesLayout) return;
        if (rule.parent?.type === "rule") {
          changed = true;
          return;
        }
        const selectors = rule.selectors.filter(
          (selector) => !/::|:(?:before|after|first-letter|first-line)\b/i.test(selector),
        );
        if (selectors.some((selector) => element.matches(selector))) changed = true;
      });
    }
  } catch {
    return true;
  }
  return changed;
}

function scriptManagesMount(element: Element, ctx: LintContext): boolean {
  const hooks = [
    element.id,
    element.getAttribute("data-composition-id"),
    ...element.classList,
    "data-composition-src",
  ].filter((hook): hook is string => Boolean(hook));
  return ctx.scripts.some(({ content }) => {
    const script = stripJsComments(content);
    return (
      /\b(?:scale[XY]?|transform|zoom|width|height|left|top|x|y|cssText)\b/.test(script) &&
      hooks.some((hook) => script.includes(hook))
    );
  });
}

export function subcompositionDimensionFindings(ctx: LintContext): HyperframeLintFinding[] {
  const { rootTag } = ctx;
  if (!rootTag) return [];
  const rootWidth = positiveDimension(readAttr(rootTag.raw, "data-width"));
  const rootHeight = positiveDimension(readAttr(rootTag.raw, "data-height"));
  if (rootWidth === null || rootHeight === null) return [];
  const mounts = ctx.tags.filter((tag) => readAttr(tag.raw, "data-composition-src"));
  if (mounts.length === 0) return [];

  const { document } = parseHTML(ctx.source);
  const roots = [...document.querySelectorAll("[data-composition-id]")].filter(
    (element) =>
      element.localName === rootTag.name &&
      element.getAttribute("data-composition-id") === ctx.rootCompositionId,
  );
  const root = roots.length === 1 ? roots[0] : undefined;
  if (!root) return [];
  let styles: postcss.Root[];
  try {
    styles = ctx.styles.map(({ content }) => postcss.parse(content));
  } catch {
    return [];
  }

  const findings: HyperframeLintFinding[] = [];
  for (const element of root.children) {
    const source = element.getAttribute("data-composition-src");
    if (!source) continue;
    const width = positiveDimension(element.getAttribute("data-width"));
    const height = positiveDimension(element.getAttribute("data-height"));
    if (width === null || height === null) continue;
    const scale = rootWidth / width;
    if (scale === 1 || Math.abs(scale - rootHeight / height) > 0.000001) continue;
    if (hasLayoutOverride(element, width, height, styles) || scriptManagesMount(element, ctx)) {
      continue;
    }
    const authoredTag = mounts.find((tag) =>
      [
        "id",
        "data-composition-id",
        "data-composition-src",
        "data-width",
        "data-height",
        "style",
      ].every((name) => readDecodedAttr(tag.raw, name) === element.getAttribute(name)),
    );
    findings.push({
      code: "subcomposition_dimensions_mismatch",
      severity: "warning",
      message: `Sub-composition "${source}" retains its ${width}x${height} canvas inside the ${rootWidth}x${rootHeight} root; mounts do not scale to the root automatically.`,
      elementId: element.id || undefined,
      fixHint: `If this block should fill the root canvas, keep the mount at width: ${width}px; height: ${height}px and add transform: scale(${Number(scale.toFixed(6))}); transform-origin: 0 0. Keep its current size if the smaller placement is intentional.`,
      snippet: truncateSnippet(authoredTag?.raw ?? ""),
    });
  }
  return findings;
}
