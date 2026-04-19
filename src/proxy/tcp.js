'use strict';

const net = require('node:net');
const logger = require('../logger');

const DUAL_BIND_OVERLAP_MS = 10_000;

class TcpProxyManager {
  constructor({ bindIp }) {
    this.bindIp = bindIp;
    this._listeners = new Map(); // id → { server, port, target }
  }

  listListenerPorts() {
    return [...this._listeners.values()].map(l => l.port).filter(Boolean);
  }

  async setRoutes(l4Routes) {
    const newIds = new Set(l4Routes.map(r => r.id));
    // Remove listeners no longer in config
    for (const [id, l] of this._listeners) {
      if (!newIds.has(id)) {
        await this._stopListener(id, l);
      }
    }
    // Add or update
    for (const route of l4Routes) {
      const existing = this._listeners.get(route.id);
      if (!existing) {
        await this._startListener(route);
      } else if (existing.target.port !== route.target_lan_port
              || existing.target.host !== route.target_lan_host
              || existing.listenPortRequested !== route.listen_port
              || route._forcePortChange) {
        // Port- or target-change → dual-bind overlap
        await this._transitionListener(route, existing);
      }
    }
  }

  async _startListener(route) {
    const server = net.createServer(socket => this._handleConnection(socket, route));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(route.listen_port, this.bindIp, () => { server.off('error', reject); resolve(); });
    });
    const port = server.address().port;
    logger.info({ routeId: route.id, port, target: `${route.target_lan_host}:${route.target_lan_port}` }, 'TCP listener started');
    this._listeners.set(route.id, {
      server, port,
      target: { host: route.target_lan_host, port: route.target_lan_port },
      listenPortRequested: route.listen_port,
    });
  }

  async _stopListener(id, l) {
    logger.info({ routeId: id, port: l.port }, 'TCP listener stopping');
    await new Promise(resolve => l.server.close(resolve));
    this._listeners.delete(id);
  }

  async _transitionListener(route, existing) {
    logger.info({ routeId: route.id }, 'TCP listener transition (dual-bind overlap)');
    // Start new listener BEFORE closing old
    const newServer = net.createServer(socket => this._handleConnection(socket, route));
    await new Promise((resolve, reject) => {
      newServer.once('error', reject);
      newServer.listen(route.listen_port, this.bindIp, () => { newServer.off('error', reject); resolve(); });
    });
    const newPort = newServer.address().port;

    // Store as new listener under a temp key, swap after overlap
    const oldL = existing;
    this._listeners.set(route.id, {
      server: newServer, port: newPort,
      target: { host: route.target_lan_host, port: route.target_lan_port },
      listenPortRequested: route.listen_port,
    });

    setTimeout(async () => {
      await new Promise(r => oldL.server.close(r));
      logger.info({ routeId: route.id, oldPort: oldL.port, newPort }, 'Dual-bind overlap expired, old listener closed');
    }, DUAL_BIND_OVERLAP_MS);
  }

  _handleConnection(clientSocket, route) {
    const upstream = net.connect(route.target_lan_port, route.target_lan_host);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    const onCloseOrError = () => { try { upstream.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
    clientSocket.on('error', onCloseOrError);
    upstream.on('error', onCloseOrError);
    clientSocket.on('close', onCloseOrError);
    upstream.on('close', onCloseOrError);
  }

  async stopAll() {
    for (const [id, l] of [...this._listeners]) {
      await this._stopListener(id, l);
    }
  }
}

module.exports = { TcpProxyManager, DUAL_BIND_OVERLAP_MS };
