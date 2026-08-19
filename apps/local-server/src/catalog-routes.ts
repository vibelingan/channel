import type { Server } from 'node:http';
import type { PublicCatalog } from '@vibelingan-channel/fn-public-api/handler';
import {
  type PublicHttpConfig,
  handlePublicApiEvent,
} from '@vibelingan-channel/fn-public-api/http-adapter';
import type express from 'express';

export function registerCatalogRoutes(
  app: express.Express,
  collection: PublicCatalog,
  basePath: string,
  config: PublicHttpConfig,
): void {
  const bridge = async (req: express.Request, res: express.Response): Promise<void> => {
    const response = await handlePublicApiEvent(
      {
        httpMethod: req.method,
        path: req.path,
        headers: req.headers,
        queryStringParameters: req.query,
      },
      config,
    );
    for (const [name, value] of Object.entries(response.headers)) {
      res.setHeader(name, value);
    }
    res.status(response.statusCode);
    if (response.statusCode === 204) res.end();
    else res.type('application/json').send(response.body);
  };
  app.all(basePath, bridge);
  app.all(`${basePath}/:id`, bridge);
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
