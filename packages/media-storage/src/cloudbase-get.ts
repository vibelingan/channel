/** Raw COS GET with a deadline and stream cap; never expose its signed URL. */
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { CloudBaseStorageSdk } from './cloudbase.ts';
import { type MediaObjectReadOptions, MediaReadError } from './index.ts';
import { readMediaBytes } from './read-limits.ts';

export interface CloudBaseReadTransport {
  downloadRequest?: (
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
}

export async function readCloudBaseBytes(
  sdk: CloudBaseStorageSdk,
  fileId: string,
  options: MediaObjectReadOptions,
  transport: CloudBaseReadTransport = {},
): Promise<Buffer> {
  return readMediaBytes(async (signal) => {
    const result = await sdk.getTempFileURL({
      fileList: [{ fileID: fileId, maxAge: 60, urlType: 'COS_URL' }],
    });
    if (signal.aborted) throw new MediaReadError('timeout');
    const entry = result.fileList?.[0];
    if (
      result.fileList?.length !== 1 ||
      !entry ||
      entry.fileID !== fileId ||
      entry.code !== 'SUCCESS'
    )
      throw new MediaReadError('unavailable');
    const url = new URL(entry.tempFileURL);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new MediaReadError('unavailable');
    const request = transport.downloadRequest ?? httpsRequest;
    return new Promise<IncomingMessage>((resolve, reject) => {
      let incoming: IncomingMessage | undefined;
      const stop = () => {
        incoming?.destroy();
        // A completed response may already have released its socket to the agent.
        if (!incoming?.complete) outgoing.destroy();
        reject(new MediaReadError('timeout'));
      };
      const removeAbort = () => signal.removeEventListener('abort', stop);
      const outgoing = request(url, { method: 'GET' }, (response) => {
        incoming = response;
        response.on('error', () => {});
        response.once('close', removeAbort);
        if (signal.aborted || response.statusCode !== 200) {
          response.destroy();
          reject(new MediaReadError(signal.aborted ? 'timeout' : 'unavailable'));
          return;
        }
        resolve(response);
      });
      outgoing.on('error', () => reject(new MediaReadError('unavailable')));
      outgoing.once('close', removeAbort);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      else outgoing.end();
    });
  }, options);
}
