/**
 * `deploySite` — upload a project directory to S3 and return a reusable handle.
 *
 * `renderToLambda` calls this implicitly when no `siteHandle` is passed,
 * but exposing it as a standalone verb lets adopters upload a project
 * ahead of time and reuse the handle across many renders.
 *
 * Every file goes into the bucket's shared content store under its SHA-256,
 * once: a file any earlier site or render already stored is skipped. The
 * site itself is a small `sites/<siteId>/files.json` listing path → hash,
 * where `siteId` is derived from a SHA-256 over the project files.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { hashProjectDir, listSiteFiles } from "@hyperframes/producer/distributed";
import {
  mapConcurrent,
  putContentStoreFile,
  sha256File,
  uploadContentAddressedFileToS3,
} from "../s3Transport.js";
import { serializeSiteManifest, siteManifestUri, type SiteFile } from "../siteManifest.js";

/** Options for {@link deploySite}. */
export interface DeploySiteOptions {
  /** Local project directory containing `index.html` (and any composition assets). */
  projectDir: string;
  /** S3 bucket the SAM stack / CDK construct provisioned. */
  bucketName: string;
  /** AWS region for the S3 client. Defaults to the SDK's default chain (env / config / IMDS). */
  region?: string;
  /**
   * Override the content-addressed site id. Useful when the caller has a
   * stable external identifier they want to use (e.g. a git SHA); if
   * unset, the hash of the project tree picks it.
   */
  siteId?: string;
  /** Injection seam for tests. Production callers leave unset. */
  s3?: S3Client;
}

/** Stable handle returned by {@link deploySite}. Pass back to {@link renderToLambda}. */
export interface SiteHandle {
  /** Content-addressed (or caller-supplied) identifier; stable across re-uploads of the same tree. */
  siteId: string;
  /** Bucket the site landed in. Surfaced separately so callers don't have to re-parse `projectS3Uri`. */
  bucketName: string;
  /** Full `s3://bucket/sites/<siteId>/files.json` URI; pass through to `renderToLambda`. */
  projectS3Uri: string;
  /** Total size of the project's files in bytes. */
  bytes: number;
  /** ISO timestamp of this `deploySite` call. */
  uploadedAt: string;
  /** `false` if every file and the site manifest were already in the bucket. */
  uploaded: boolean;
}

/** Handle for a site an earlier {@link deploySite} uploaded; `bytes` and `uploadedAt` are unknown. */
export function siteHandleFromId(bucketName: string, siteId: string): SiteHandle {
  const projectS3Uri = siteManifestUri(bucketName, siteId);
  return { siteId, bucketName, projectS3Uri, bytes: 0, uploadedAt: "", uploaded: false };
}

/** Upload `projectDir`'s files to the content store and write the site manifest. */
export async function deploySite(opts: DeploySiteOptions): Promise<SiteHandle> {
  const s3 = opts.s3 ?? new S3Client({ region: opts.region });
  if (!statSync(opts.projectDir).isDirectory()) {
    throw new Error(`[deploySite] projectDir is not a directory: ${opts.projectDir}`);
  }
  const files = listSiteFiles(opts.projectDir);
  const siteId = opts.siteId ?? hashProjectDir(opts.projectDir, files);
  const projectS3Uri = siteManifestUri(opts.bucketName, siteId);

  const stored: SiteFile[] = [];
  let uploaded = false;
  await mapConcurrent(files, 8, async (path) => {
    const localPath = join(opts.projectDir, path);
    const sha256 = await sha256File(localPath);
    stored.push({ path, sha256, sizeBytes: statSync(localPath).size });
    const outcome = await putContentStoreFile(s3, localPath, opts.bucketName, sha256);
    uploaded ||= outcome === "uploaded";
  });
  stored.sort((a, b) => (a.path < b.path ? -1 : 1));

  const workdir = mkdtempSync(join(tmpdir(), "hf-deploy-site-"));
  try {
    const manifestPath = join(workdir, "files.json");
    const manifest = serializeSiteManifest(stored);
    writeFileSync(manifestPath, manifest);
    const outcome = await uploadContentAddressedFileToS3(
      s3,
      manifestPath,
      projectS3Uri,
      await sha256File(manifestPath),
      "application/json",
    );
    uploaded ||= outcome === "uploaded";
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  return {
    siteId,
    bucketName: opts.bucketName,
    projectS3Uri,
    bytes: stored.reduce((sum, file) => sum + file.sizeBytes, 0),
    uploadedAt: new Date().toISOString(),
    uploaded,
  };
}
