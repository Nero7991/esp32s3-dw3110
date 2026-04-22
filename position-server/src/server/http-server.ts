/**
 * UWB Positioning System - HTTP Server
 *
 * Provides REST API and serves web dashboard.
 */

import express, { Express, Request, Response } from 'express';
import * as http from 'http';
import * as path from 'path';
import { apiRouter } from '../api/routes';

class HttpServer {
  private app: Express;
  private server: http.Server | null = null;

  constructor() {
    this.app = express();

    // Middleware
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../../public')));

    // API routes
    this.app.use('/api', apiRouter);

    // Serve dashboard for root
    this.app.get('/', (req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, '../../public/index.html'));
    });

    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
  }

  public start(port: number): http.Server {
    this.server = http.createServer(this.app);

    this.server.listen(port, () => {
      console.log(`HTTP server listening on port ${port}`);
      console.log(`Dashboard: http://localhost:${port}/`);
      console.log(`API: http://localhost:${port}/api`);
    });

    return this.server;
  }

  public getServer(): http.Server | null {
    return this.server;
  }

  public getApp(): Express {
    return this.app;
  }
}

export const httpServer = new HttpServer();
