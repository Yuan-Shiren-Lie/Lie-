import { describe, it, expect } from "vitest";
import { lintHyperframeHtml } from "../hyperframeLinter.js";

const code = "subcomposition_dimensions_mismatch";
const blockDimensions = 'data-width="1920" data-height="1080"';
const blockStyle = "position: absolute; left: 0; top: 0; width: 1920px; height: 1080px";

function mount(dimensions = blockDimensions, style = blockStyle): string {
  return `<div id="title" data-composition-id="lt-side-rule"
    data-composition-src="compositions/lt-side-rule.html"
    data-start="0" data-duration="4.8" data-track-index="1"
    ${dimensions} style="${style}"></div>`;
}

function composition(
  body = mount(),
  dimensions = 'data-width="3840" data-height="2160"',
  css = "",
): string {
  return `<!doctype html><html><head><style>${css}</style></head><body>
    <div id="root" data-composition-id="main" data-start="0"
      data-duration="4.8" data-no-timeline ${dimensions}>
      ${body}
    </div>
  </body></html>`;
}

async function mismatchFindings(html: string) {
  const result = await lintHyperframeHtml(html);
  return result.findings.filter((finding) => finding.code === code);
}

describe("sub-composition dimensions", () => {
  it("warns for an unscaled 1080p block mounted at the origin of a 4K root", async () => {
    const findings = await mismatchFindings(composition());

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.fixHint).toContain("scale(2)");
    expect(findings[0]?.fixHint).toMatch(/transform-origin:\s*0\s+0/);
  });

  it("stops warning after applying the documented scale and origin", async () => {
    const fixedMount = mount(
      blockDimensions,
      `${blockStyle}; transform: scale(2); transform-origin: 0 0`,
    );

    expect(await mismatchFindings(composition(fixedMount))).toEqual([]);
  });

  it("does not warn when the mount and root have equal dimensions", async () => {
    expect(await mismatchFindings(composition(mount(), blockDimensions))).toEqual([]);
  });

  it("does not recommend uniform scaling when aspect ratios differ", async () => {
    expect(
      await mismatchFindings(composition(mount(), 'data-width="1080" data-height="1920"')),
    ).toEqual([]);
  });

  it.each([
    "",
    'data-width="1920"',
    'data-height="1080"',
    'data-width="0" data-height="1080"',
    'data-width="-1920" data-height="1080"',
    'data-width="1920" data-height="0"',
    'data-width="wide" data-height="1080"',
    'data-width="1920px" data-height="1080"',
    'data-width="Infinity" data-height="1080"',
  ])("does not infer a block size from incomplete or invalid attributes: %s", async (attrs) => {
    expect(await mismatchFindings(composition(mount(attrs)))).toEqual([]);
  });

  it.each([
    "",
    'data-width="3840"',
    'data-width="3840" data-height="NaN"',
    'data-width="0" data-height="2160"',
  ])("does not infer a root size from incomplete or invalid attributes: %s", async (attrs) => {
    expect(await mismatchFindings(composition(mount(), attrs))).toEqual([]);
  });

  it.each(["left: 120px", "top: 80px", "right: 40px", "bottom: 30px"])(
    "does not assume a locally positioned block should fill the root: %s",
    async (offset) => {
      const style = `position: absolute; width: 1920px; height: 1080px; ${offset}`;
      expect(await mismatchFindings(composition(mount(blockDimensions, style)))).toEqual([]);
    },
  );

  it.each(["transform: scale(2)", "scale: 2", "zoom: 2"])(
    "does not warn on an inline scale declaration: %s",
    async (scaling) => {
      const style = `${blockStyle}; ${scaling}; transform-origin: 0 0`;
      expect(await mismatchFindings(composition(mount(blockDimensions, style)))).toEqual([]);
    },
  );

  it.each(["transform: scale(2)", "scale: 2", "zoom: 2"])(
    "does not warn on a stylesheet scale declaration: %s",
    async (scaling) => {
      const css = `#title { ${scaling}; transform-origin: 0 0; }`;
      expect(await mismatchFindings(composition(mount(), undefined, css))).toEqual([]);
    },
  );

  it("respects a scale supplied by a linked stylesheet", async () => {
    const html = composition().replace(
      "</head>",
      '<link rel="stylesheet" href="mount.css"></head>',
    );
    const result = await lintHyperframeHtml(html, {
      externalStyles: [
        { href: "mount.css", content: "#title { transform: scale(2); transform-origin: 0 0; }" },
      ],
    });

    expect(result.findings.filter((finding) => finding.code === code)).toEqual([]);
  });

  it("does not override an explicitly resized mount", async () => {
    const style = "position: absolute; left: 0; top: 0; width: 3840px; height: 2160px";
    expect(await mismatchFindings(composition(mount(blockDimensions, style)))).toEqual([]);
  });

  it("does not override dimensions set by a stylesheet", async () => {
    const css = "#title { width: 3840px !important; height: 2160px !important; }";
    expect(await mismatchFindings(composition(mount(), undefined, css))).toEqual([]);
  });

  it("does not add a second scale when a containing element already scales the block", async () => {
    const body = `<div style="transform: scale(2); transform-origin: 0 0">${mount()}</div>`;
    expect(await mismatchFindings(composition(body))).toEqual([]);
  });

  it("does not report a mount inside an HTML comment", async () => {
    expect(await mismatchFindings(composition(`<!-- ${mount()} -->`))).toEqual([]);
  });

  it.each([
    "@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }",
    "#unrelated::before { width: 20px; height: 20px; }",
  ])("still warns when unrelated CSS uses non-element selectors: %s", async (css) => {
    const findings = await mismatchFindings(composition(mount(), undefined, css));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("respects a mount scale in a selector list that also contains a pseudo-element", async () => {
    const css = "#title, #title::before { transform: scale(2); }";
    expect(await mismatchFindings(composition(mount(), undefined, css))).toEqual([]);
  });

  it("does not warn when a script explicitly manages the mount scale", async () => {
    const html = composition().replace(
      "</body>",
      '<script>gsap.set("#title", { scale: 2, transformOrigin: "0 0" });</script></body>',
    );
    expect(await mismatchFindings(html)).toEqual([]);
  });

  it("still warns when a script only registers the root timeline", async () => {
    const html = composition()
      .replace("data-no-timeline", "")
      .replace(
        "</body>",
        "<script>window.__timelines = { main: gsap.timeline({ paused: true }) };</script></body>",
      );
    expect(await mismatchFindings(html)).toHaveLength(1);
  });
});
