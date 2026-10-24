/** Raw COS PUT, pinned to node-sdk 3.17.2 uploadFile by verify:cloudbase-sdk. */
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PutMediaObjectInput, UploadCredential } from './index.ts';

export interface CloudBasePutOptions {
  /** Injectable HTTP request seam; production always uses Node's HTTPS sender. */
  request?: (
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
  uploadTimeoutMs?: number;
}

export function checkedUploadUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('media-storage(cloudbase): invalid upload target');
  }
  return url;
}

export async function putCloudBaseBytes(
  credential: UploadCredential,
  content: PutMediaObjectInput['content'],
  options: CloudBasePutOptions,
): Promise<void> {
  const url = checkedUploadUrl(credential.uploadUrl);
  const timeoutMs = options.uploadTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('media-storage(cloudbase): invalid upload timeout');
  }
  const request = options.request ?? httpsRequest;
  let outgoing: ClientRequest | undefined;
  const acknowledged = new Promise<void>((resolve, reject) => {
    outgoing = request(url, { method: 'PUT', headers: credential.headers }, (response) => {
      // COS PUT Object returns HTTP 200 with an empty body. A redirect, XML
      // error, or unexpected success shape is an unknown outcome, never success.
      response.on('error', reject);
      response.on('aborted', () =>
        reject(new Error('media-storage(cloudbase): upload response aborted')),
      );
      if (response.statusCode !== 200) {
        reject(
          new Error(`media-storage(cloudbase): unconfirmed upload (HTTP ${response.statusCode})`),
        );
        response.destroy();
        return;
      }
      response.on('data', () => {
        reject(new Error('media-storage(cloudbase): unexpected upload response body'));
        response.destroy();
      });
      response.on('end', resolve);
    });
    outgoing.on('error', reject);
  });
  if (!outgoing) {
    // Consume a synchronous request-construction rejection before returning.
    await acknowledged;
    throw new Error('media-storage(cloudbase): upload request not created');
  }
  const destination = outgoing;
  const timer = setTimeout(
    () => destination.destroy(new Error('media-storage(cloudbase): upload timed out')),
    timeoutMs,
  );
  const source = content instanceof Uint8Array ? Readable.from([content]) : content;
  try {
    await Promise.all([pipeline(source, destination), acknowledged]);
  } catch (error) {
    destination.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
