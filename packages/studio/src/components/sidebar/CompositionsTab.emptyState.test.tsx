// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompositionsTab } from "./CompositionsTab";
import { useDockLayoutStore } from "../dock/dockLayoutStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompositionsTab empty state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows one sentence and a keyboard-accessible action that opens the catalog", () => {
    const activatePanel = vi.spyOn(useDockLayoutStore.getState(), "activatePanel");
    act(() => {
      root.render(
        <CompositionsTab
          projectId="demo"
          compositions={[]}
          activeComposition={null}
          onSelect={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("No compositions yet");
    const button = container.querySelector("button");
    expect(button?.textContent).toContain("Browse starter scenes");
    // A native button is keyboard-focusable and activatable by default.
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.tabIndex).toBe(0);

    act(() => {
      button?.click();
    });
    expect(activatePanel).toHaveBeenCalledWith("catalog");
  });
});
