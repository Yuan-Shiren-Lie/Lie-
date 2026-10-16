import { isDegradableEvaluateTimeoutError, isNavigationTimeoutError } from "./captureTimeout.js";

export { isNavigationTimeoutError };

export const NETWORK_IDLE_ATTEMPT_MS = 30_000;

export type CaptureGotoWaitUntil = "networkidle2" | "domcontentloaded";

export interface CaptureGotoOptions {
  waitUntil: CaptureGotoWaitUntil;
  timeout: number;
}

export interface CaptureGotoPage<TResponse = unknown> {
  goto(url: string, options: CaptureGotoOptions): Promise<TResponse>;
}

export interface NavigateForCaptureResult<TResponse = unknown> {
  response: TResponse;
  waitUntil: CaptureGotoWaitUntil;
  networkIdleTimeoutMs: number;
  fellBackFromNetworkIdle: boolean;
}

export function networkIdleAttemptTimeoutMs(totalTimeoutMs: number): number {
  return Math.min(NETWORK_IDLE_ATTEMPT_MS, Math.max(0, totalTimeoutMs));
}

export async function navigateForCapture<TResponse>(
  page: CaptureGotoPage<TResponse>,
  url: string,
  totalTimeoutMs: number,
): Promise<NavigateForCaptureResult<TResponse>> {
  const networkIdleTimeoutMs = networkIdleAttemptTimeoutMs(totalTimeoutMs);
  try {
    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: networkIdleTimeoutMs,
    });
    return {
      response,
      waitUntil: "networkidle2",
      networkIdleTimeoutMs,
      fellBackFromNetworkIdle: false,
    };
  } catch (err) {
    if (!isNavigationTimeoutError(err) || networkIdleTimeoutMs >= totalTimeoutMs) {
      throw err;
    }
  }

  const fallbackTimeoutMs = totalTimeoutMs - networkIdleTimeoutMs;
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: fallbackTimeoutMs,
  });
  return {
    response,
    waitUntil: "domcontentloaded",
    networkIdleTimeoutMs,
    fellBackFromNetworkIdle: true,
  };
}

export interface PageReadyPage {
  waitForNetworkIdle?(options: {
    idleTime: number;
    timeout: number;
    concurrency?: number;
  }): Promise<unknown>;
  evaluate(fn: () => unknown): Promise<unknown>;
}

export interface WaitForPageReadyOptions {
  timeoutMs?: number;
  networkIdle?: "always" | "after-load";
}

export async function waitForPageReady(
  page: PageReadyPage,
  options: WaitForPageReadyOptions = {},
): Promise<void> {
  const { timeoutMs = 15_000, networkIdle = "always" } = options;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const idle = async () => {
    try {
      await page.waitForNetworkIdle?.({
        idleTime: 500,
        timeout: remaining(),
        concurrency: 2,
      });
    } catch {}
  };

  if (networkIdle === "always" && remaining() > 0) await idle();

  let waitedOutLoad = false;
  while (remaining() > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loading = await Promise.race([
      page
        .evaluate(() => document.readyState === "loading")
        .catch((err: unknown) => {
          if (isDegradableEvaluateTimeoutError(err)) throw err;
          return true;
        }),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), Math.max(1, remaining()));
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (loading !== true) break;
    waitedOutLoad = true;
    if (remaining() > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining())));
    }
  }

  if (waitedOutLoad && remaining() > 0) await idle();
}
